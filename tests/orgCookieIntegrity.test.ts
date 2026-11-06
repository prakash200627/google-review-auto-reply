import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

describe("signed organization cookie integrity", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-auth-secret-value-32chars!!";
  });

  it("encodes and decodes a valid org session", async () => {
    const { encodeOrgSession, decodeOrgSession } = await import(
      "@/lib/org/session"
    );
    const orgId = new mongoose.Types.ObjectId().toString();
    const token = encodeOrgSession({
      orgId,
      exp: Date.now() + 60_000,
    });
    expect(token).toContain(".");
    expect(token).not.toBe(orgId);
    expect(decodeOrgSession(token)).toEqual({
      orgId,
      exp: expect.any(Number),
    });
  });

  it("rejects tampered signatures and bare ObjectIds", async () => {
    const { encodeOrgSession, decodeOrgSession } = await import(
      "@/lib/org/session"
    );
    const orgId = new mongoose.Types.ObjectId().toString();
    const token = encodeOrgSession({
      orgId,
      exp: Date.now() + 60_000,
    });
    const [body] = token.split(".");
    expect(decodeOrgSession(`${body}.forgedsignaturevalue`)).toBeNull();
    expect(decodeOrgSession(orgId)).toBeNull();
    expect(decodeOrgSession("")).toBeNull();
    expect(decodeOrgSession("not-valid")).toBeNull();
  });

  it("rejects expired organization sessions", async () => {
    const { encodeOrgSession, decodeOrgSession } = await import(
      "@/lib/org/session"
    );
    const orgId = new mongoose.Types.ObjectId().toString();
    const token = encodeOrgSession({
      orgId,
      exp: Date.now() - 1_000,
    });
    expect(decodeOrgSession(token)).toBeNull();
  });

  it("rejects a signed cookie that names a different org after body rewrite", async () => {
    const { encodeOrgSession, decodeOrgSession } = await import(
      "@/lib/org/session"
    );
    const orgA = new mongoose.Types.ObjectId().toString();
    const orgB = new mongoose.Types.ObjectId().toString();
    const tokenA = encodeOrgSession({
      orgId: orgA,
      exp: Date.now() + 60_000,
    });
    const [, signature] = tokenA.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ orgId: orgB, exp: Date.now() + 60_000 }),
      "utf8"
    ).toString("base64url");
    expect(decodeOrgSession(`${forgedBody}.${signature}`)).toBeNull();
  });
});
