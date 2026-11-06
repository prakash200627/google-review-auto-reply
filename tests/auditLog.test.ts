import { afterEach, describe, expect, it, vi } from "vitest";
import { auditLog } from "@/lib/audit/log";

describe("auditLog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits structured JSON without secrets", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    auditLog({
      actorId: "u1",
      actorRole: "superadmin",
      action: "owner.reset_password",
      success: true,
      target: {
        userId: "u2",
        password: "should-not-appear",
        accessToken: "tok",
        refreshToken: "ref",
      },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0] || "");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.type).toBe("audit");
    expect(parsed.action).toBe("owner.reset_password");
    expect(parsed.success).toBe(true);
    expect(parsed.actorId).toBe("u1");
    expect(parsed.target).toEqual({ userId: "u2" });
    expect(line).not.toContain("should-not-appear");
    expect(line).not.toContain('"accessToken"');
    expect(line).not.toContain('"refreshToken"');
    expect(line).not.toContain('"password"');
  });

  it("never throws when console.info fails", () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("log sink down");
    });
    expect(() =>
      auditLog({
        actorId: null,
        actorRole: null,
        action: "review.publish",
        success: false,
        code: "publish_failed",
      })
    ).not.toThrow();
  });
});
