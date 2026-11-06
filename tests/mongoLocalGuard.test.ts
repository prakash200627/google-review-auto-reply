import { describe, expect, it } from "vitest";
import {
  assertDevelopmentMongoUri,
  classifyMongoUri,
} from "@/lib/mongodb";

describe("classifyMongoUri", () => {
  it("recognizes localhost development URIs", () => {
    const c = classifyMongoUri("mongodb://127.0.0.1:27017/tronx_orm_local");
    expect(c.isLocalhost).toBe(true);
    expect(c.isAtlas).toBe(false);
    expect(c.db).toBe("tronx_orm_local");
  });

  it("flags Atlas hosts as Atlas (allowed for local Next.js + Atlas)", () => {
    const c = classifyMongoUri(
      "mongodb+srv://user:pass@cluster0.example.mongodb.net/app"
    );
    expect(c.isLocalhost).toBe(false);
    expect(c.isAtlas).toBe(true);
  });
});

describe("assertDevelopmentMongoUri", () => {
  it("allows Atlas without ALLOW_REMOTE_MONGO", () => {
    expect(() =>
      assertDevelopmentMongoUri(
        "mongodb+srv://user:pass@cluster0.example.mongodb.net/app"
      )
    ).not.toThrow();
  });

  it("allows localhost", () => {
    expect(() =>
      assertDevelopmentMongoUri("mongodb://127.0.0.1:27017/tronx_orm_local")
    ).not.toThrow();
  });

  it("rejects unrecognized remote hosts", () => {
    expect(() =>
      assertDevelopmentMongoUri("mongodb://db.example.com:27017/app")
    ).toThrow(/unrecognized MongoDB host/i);
  });
});
