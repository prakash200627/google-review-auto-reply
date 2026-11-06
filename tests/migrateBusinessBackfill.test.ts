import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("migrateBusinessBackfill script contract", () => {
  const script = readFileSync(
    path.join(process.cwd(), "scripts/migrateBusinessBackfill.mjs"),
    "utf8"
  );

  it("never auto-assigns locations or invents businesses", () => {
    expect(script).toMatch(/No automatic location→business assignment/);
    expect(script).not.toMatch(/\$set:\s*\{\s*businessId/);
    expect(script).toMatch(/createIndex\(\{\s*businessId:\s*1\s*\}\)/);
  });

  it("requires an explicit allow flag for --apply writes", () => {
    expect(script).toMatch(/ALLOW_MIGRATE_APPLY/);
    expect(script).toMatch(/MIGRATE_REFUSED/);
  });

  it("skips cleanly without MONGODB_URI (no production connection)", () => {
    expect(script).toMatch(/MIGRATE_SKIP missing MONGODB_URI/);
  });
});
