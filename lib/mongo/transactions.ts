/**
 * MongoDB multi-document transactions for ownership changes.
 * Requires a replica set / Atlas (mongos). Standalone Mongo fails closed.
 */

import mongoose, { type ClientSession } from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";

export class MongoTransactionError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code, status }: { code: string; status: number }
  ) {
    super(message);
    this.name = "MongoTransactionError";
    this.code = code;
    this.status = status;
  }
}

/** True when the deployment cannot run multi-document transactions. */
export function isTransactionUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || "");
  const code =
    err && typeof err === "object" && "code" in err
      ? Number((err as { code?: number }).code)
      : NaN;
  // IllegalOperation (20) / Transaction numbers are only allowed on a replica set member
  if (code === 20) return true;
  if (/Transaction numbers are only allowed on a replica set/i.test(message)) {
    return true;
  }
  if (/transactions are not supported/i.test(message)) return true;
  if (/replica set/i.test(message) && /transaction/i.test(message)) return true;
  return false;
}

export function isMongoDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: number }).code;
  if (code === 11000) return true;
  const message = err instanceof Error ? err.message : "";
  return /E11000 duplicate key/i.test(message);
}

/**
 * Run work inside a MongoDB transaction. Rolls back on throw.
 * Fail closed if transactions are unavailable — never silently continues
 * with non-atomic ownership mutations that detach then recreate.
 */
export async function withMongoTransaction<T>(
  work: (session: ClientSession) => Promise<T>
): Promise<T> {
  await connectToDatabase();
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (err) {
    if (isTransactionUnsupportedError(err)) {
      throw new MongoTransactionError(
        "This MongoDB deployment does not support multi-document transactions (replica set / Atlas required). Ownership changes that move locations are blocked until transactions are available.",
        { code: "transactions_required", status: 503 }
      );
    }
    throw err;
  } finally {
    await session.endSession();
  }
}
