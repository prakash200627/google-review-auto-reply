import { afterEach, describe, expect, it } from "vitest";
import {
  assertSchedulerSecret,
  SCHEDULER_SECRET_MIN_LENGTH,
} from "@/lib/auth/schedulerAuth";

describe("assertSchedulerSecret", () => {
  const prev = process.env.AUTO_PUBLISH_SCHEDULER_SECRET;

  afterEach(() => {
    if (prev === undefined) delete process.env.AUTO_PUBLISH_SCHEDULER_SECRET;
    else process.env.AUTO_PUBLISH_SCHEDULER_SECRET = prev;
  });

  it("rejects when secret is not configured", async () => {
    delete process.env.AUTO_PUBLISH_SCHEDULER_SECRET;
    const result = assertSchedulerSecret(
      new Request("http://localhost/api/admin/auto-publish/process", {
        method: "POST",
        headers: { "x-tronx-scheduler-secret": "anything" },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      const body = await result.response.json();
      expect(body.code).toBe("scheduler_not_configured");
    }
  });

  it("rejects weak secrets under minimum length", async () => {
    process.env.AUTO_PUBLISH_SCHEDULER_SECRET = "short";
    const result = assertSchedulerSecret(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "x-tronx-scheduler-secret": "short" },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      const body = await result.response.json();
      expect(body.code).toBe("scheduler_secret_weak");
    }
  });

  it("rejects Authorization Bearer as ambiguous credential", async () => {
    const secret = "a".repeat(SCHEDULER_SECRET_MIN_LENGTH);
    process.env.AUTO_PUBLISH_SCHEDULER_SECRET = secret;
    const result = assertSchedulerSecret(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it("accepts matching dedicated header", () => {
    const secret = "b".repeat(SCHEDULER_SECRET_MIN_LENGTH);
    process.env.AUTO_PUBLISH_SCHEDULER_SECRET = secret;
    const result = assertSchedulerSecret(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "x-tronx-scheduler-secret": secret },
      })
    );
    expect(result.ok).toBe(true);
  });
});
