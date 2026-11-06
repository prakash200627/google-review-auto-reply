import mongoose from "mongoose";

/**
 * Server-only MongoDB connection helper.
 * Does not connect at import time — call `connectToDatabase()` from Route Handlers
 * or Server Components when you need the database.
 *
 * This foundation does not open a connection during `next build`.
 *
 * Development URI policy (intended architecture: local Next.js + MongoDB Atlas):
 * - Allow localhost / loopback
 * - Allow explicit MongoDB Atlas hosts (`*.mongodb.net`)
 * - Refuse other remote hosts unless ALLOW_REMOTE_MONGO=1
 * Production does not apply this development host filter.
 */

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  /** URI used for the cached connection (detect test/env swaps). */
  uri: string | null;
}

declare global {
  var mongooseCache: MongooseCache | undefined;
}

const cached: MongooseCache = global.mongooseCache ?? {
  conn: null,
  promise: null,
  uri: null,
};

global.mongooseCache = cached;

function readMongoUri(): string | undefined {
  return process.env.MONGODB_URI;
}

/** Classify URI host without exposing credentials. */
export function classifyMongoUri(uri: string): {
  host: string;
  db: string;
  isLocalhost: boolean;
  isAtlas: boolean;
} {
  const normalized = uri.replace(/^mongodb\+srv/, "mongodb");
  const u = new URL(normalized);
  const host = u.hostname;
  const db = (u.pathname || "/").slice(1).split("?")[0] || "(none)";
  const isLocalhost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost");
  const isAtlas = /\.mongodb\.net$/i.test(host);
  return { host, db, isLocalhost, isAtlas };
}

/**
 * Development-only host allowlist: localhost or Atlas.
 * Does not connect; only validates configuration shape.
 */
export function assertDevelopmentMongoUri(uri: string): void {
  const nodeEnv = process.env.NODE_ENV || "development";
  if (nodeEnv === "production") return;
  if (process.env.ALLOW_REMOTE_MONGO === "1") return;

  let classified;
  try {
    classified = classifyMongoUri(uri);
  } catch {
    throw new Error(
      "MONGODB_URI could not be parsed. Expected mongodb+srv://…mongodb.net/… (Atlas) or mongodb://127.0.0.1:27017/…."
    );
  }

  if (classified.isLocalhost || classified.isAtlas) return;

  throw new Error(
    `Refusing unrecognized MongoDB host in development (host=${classified.host}). ` +
      `Use MongoDB Atlas (*.mongodb.net) or localhost. ` +
      `ALLOW_REMOTE_MONGO=1 allows other hosts (escape hatch only).`
  );
}

export async function connectToDatabase(): Promise<typeof mongoose> {
  const uri = readMongoUri();
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Add it to .env.local (see .env.example)."
    );
  }

  assertDevelopmentMongoUri(uri);

  if (cached.conn && cached.uri === uri) {
    return cached.conn;
  }

  if (cached.conn && cached.uri !== uri) {
    await mongoose.disconnect().catch(() => undefined);
    cached.conn = null;
    cached.promise = null;
    cached.uri = null;
  }

  if (!cached.promise) {
    cached.uri = uri;
    cached.promise = mongoose.connect(uri, {
      bufferCommands: false,
    });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}
