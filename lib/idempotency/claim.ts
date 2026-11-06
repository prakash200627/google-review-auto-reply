/**
 * Generic durable idempotency claim/replay using IdempotencyRecord.
 * Concurrency is enforced by the unique (orgId, operation, scopeId, key) index.
 */

import mongoose, { type ClientSession } from "mongoose";
import { isMongoDuplicateKeyError } from "@/lib/mongo/transactions";
import {
  IDEMPOTENCY_RETENTION_DAYS,
  IdempotencyRecord,
  type IdempotencyOperation,
} from "@/models/IdempotencyRecord";

export type IdempotencyClaim<T> =
  | { kind: "execute"; recordId: string }
  | { kind: "replay"; result: T; reusedIdempotentResult: true };

export class IdempotencyClaimError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code, status }: { code: string; status: number }
  ) {
    super(message);
    this.name = "IdempotencyClaimError";
    this.code = code;
    this.status = status;
  }
}

function expiresAtFromNow(): Date {
  return new Date(
    Date.now() + IDEMPOTENCY_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
}

export async function claimIdempotencySlot<T>(input: {
  orgId: string;
  operation: IdempotencyOperation;
  /** Empty string for org-scoped ops; locationId for location-scoped. */
  scopeId?: string;
  key: string;
  payloadHash: string;
  parseResult: (raw: unknown) => T | null;
}): Promise<IdempotencyClaim<T>> {
  const scopeId = String(input.scopeId || "");
  const { orgId, operation, key, payloadHash, parseResult } = input;

  try {
    const created = await IdempotencyRecord.create({
      orgId,
      operation,
      scopeId,
      key,
      payloadHash,
      status: "pending",
      result: null,
      errorCode: "",
      errorMessage: "",
      expiresAt: expiresAtFromNow(),
    });
    return { kind: "execute", recordId: String(created._id) };
  } catch (err) {
    if (!isMongoDuplicateKeyError(err)) throw err;
  }

  const existing = await IdempotencyRecord.findOne({
    orgId,
    operation,
    scopeId,
    key,
  }).lean();

  if (!existing) {
    const retry = await IdempotencyRecord.create({
      orgId,
      operation,
      scopeId,
      key,
      payloadHash,
      status: "pending",
      result: null,
      expiresAt: expiresAtFromNow(),
    });
    return { kind: "execute", recordId: String(retry._id) };
  }

  if (existing.payloadHash !== payloadHash) {
    throw new IdempotencyClaimError(
      "This idempotency key was already used with a different payload.",
      { code: "idempotency_payload_conflict", status: 409 }
    );
  }

  if (existing.status === "succeeded") {
    const result = parseResult(existing.result);
    if (result) {
      return { kind: "replay", result, reusedIdempotentResult: true };
    }
    throw new IdempotencyClaimError(
      "Idempotency record succeeded but stored result is missing.",
      { code: "idempotency_orphan", status: 409 }
    );
  }

  if (existing.status === "pending") {
    throw new IdempotencyClaimError(
      "A request with this idempotency key is already in progress.",
      { code: "idempotency_in_progress", status: 409 }
    );
  }

  // failed + same payload: reclaim for explicit retry of the same attempt.
  const reclaimed = await IdempotencyRecord.findOneAndUpdate(
    {
      _id: existing._id,
      status: "failed",
      payloadHash,
    },
    {
      $set: {
        status: "pending",
        errorCode: "",
        errorMessage: "",
        result: null,
        expiresAt: expiresAtFromNow(),
      },
    },
    { returnDocument: "after" }
  ).lean();

  if (reclaimed && reclaimed.status === "pending") {
    return { kind: "execute", recordId: String(reclaimed._id) };
  }

  const again = await IdempotencyRecord.findById(existing._id).lean();
  if (again?.status === "succeeded") {
    const result = parseResult(again.result);
    if (result) {
      return { kind: "replay", result, reusedIdempotentResult: true };
    }
  }
  if (again?.status === "pending") {
    throw new IdempotencyClaimError(
      "A request with this idempotency key is already in progress.",
      { code: "idempotency_in_progress", status: 409 }
    );
  }

  throw new IdempotencyClaimError(
    "Could not reclaim idempotency key for retry.",
    { code: "idempotency_conflict", status: 409 }
  );
}

export async function markIdempotencySucceeded(input: {
  recordId: string;
  result: unknown;
  session?: ClientSession | null;
}): Promise<void> {
  if (!mongoose.isValidObjectId(input.recordId)) return;
  const q = IdempotencyRecord.updateOne(
    { _id: input.recordId, status: "pending" },
    {
      $set: {
        status: "succeeded",
        result: input.result,
        errorCode: "",
        errorMessage: "",
      },
    }
  );
  if (input.session) q.session(input.session);
  await q;
}

export async function markIdempotencyFailed(input: {
  recordId: string;
  code: string;
  message: string;
}): Promise<void> {
  if (!mongoose.isValidObjectId(input.recordId)) return;
  await IdempotencyRecord.updateOne(
    { _id: input.recordId, status: "pending" },
    {
      $set: {
        status: "failed",
        errorCode: input.code.slice(0, 64),
        errorMessage: input.message.slice(0, 500),
        result: null,
      },
    }
  );
}
