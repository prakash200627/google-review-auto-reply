import { describe, expect, it, beforeEach } from "vitest";
import {
  checkSaUnassignedDraftRateLimit,
  resetDraftRateLimitForTests,
} from "@/lib/ai/rateLimit";

describe("checkSaUnassignedDraftRateLimit", () => {
  beforeEach(() => {
    resetDraftRateLimitForTests();
  });

  it("allows a burst then rejects further SA unassigned drafts", () => {
    const userId = "sa-user-1";
    let allowed = 0;
    let blocked = false;
    for (let i = 0; i < 40; i++) {
      const result = checkSaUnassignedDraftRateLimit(userId, 1_000_000);
      if (result.allowed) allowed += 1;
      else {
        blocked = true;
        expect(result.retryAfterSec).toBeGreaterThan(0);
        break;
      }
    }
    expect(allowed).toBeGreaterThan(0);
    expect(blocked).toBe(true);
  });

  it("isolates buckets per Super Admin user", () => {
    const t = 2_000_000;
    for (let i = 0; i < 40; i++) {
      checkSaUnassignedDraftRateLimit("sa-a", t);
    }
    expect(checkSaUnassignedDraftRateLimit("sa-b", t).allowed).toBe(true);
  });
});
