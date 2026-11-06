import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  connectMock,
  auditCreateMock,
  healthFindOneAndUpdateMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  auditCreateMock: vi.fn(),
  healthFindOneAndUpdateMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/AuditEvent", () => ({
  AuditEvent: { create: auditCreateMock },
}));

vi.mock("@/models/AuditPersistHealth", () => ({
  AUDIT_PERSIST_HEALTH_ID: "audit_persist",
  AuditPersistHealth: {
    findOneAndUpdate: healthFindOneAndUpdateMock,
  },
}));

import {
  auditLog,
  getAuditPersistAlertThreshold,
  getAuditPersistFailureCount,
  recordAuditPersistFailure,
  resetAuditPersistFailureCountForTests,
  DEFAULT_AUDIT_PERSIST_ALERT_THRESHOLD,
} from "@/lib/audit/log";

describe("audit persistence monitoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditPersistFailureCountForTests();
    connectMock.mockResolvedValue({});
    healthFindOneAndUpdateMock.mockReturnValue({
      lean: async () => ({
        _id: "audit_persist",
        failureCount: 5,
        alertArmed: true,
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses configured alert threshold", () => {
    expect(getAuditPersistAlertThreshold({})).toBe(
      DEFAULT_AUDIT_PERSIST_ALERT_THRESHOLD
    );
    expect(
      getAuditPersistAlertThreshold({
        AUDIT_PERSIST_FAILURE_ALERT_THRESHOLD: "3",
      })
    ).toBe(3);
  });

  it("increments failure metric and emits alert at threshold without recursive auditLog", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // Bring counter to threshold-1 without alert.
    resetAuditPersistFailureCountForTests();
    for (let i = 0; i < DEFAULT_AUDIT_PERSIST_ALERT_THRESHOLD - 1; i++) {
      await recordAuditPersistFailure({
        action: "review.publish",
        errorMessage: "db down",
        threshold: DEFAULT_AUDIT_PERSIST_ALERT_THRESHOLD,
      });
    }
    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes("audit_persist_alert")
      )
    ).toBe(false);

    const result = await recordAuditPersistFailure({
      action: "review.publish",
      errorMessage: "db down again",
      threshold: DEFAULT_AUDIT_PERSIST_ALERT_THRESHOLD,
    });

    expect(result.alertFired).toBe(true);
    expect(getAuditPersistFailureCount()).toBe(
      DEFAULT_AUDIT_PERSIST_ALERT_THRESHOLD
    );
    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes('"type":"audit_persist_alert"')
      )
    ).toBe(true);
    // No recursive audit emission from failure path.
    expect(infoSpy).not.toHaveBeenCalled();
    const failureLines = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(failureLines.join("\n")).not.toMatch(/"type":"audit"/);
    expect(failureLines.join("\n")).not.toMatch(/password|token|secret/i);
  });

  it("records durable health upsert on persist failure from auditLog", async () => {
    auditCreateMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    auditLog({
      actorId: "u1",
      actorRole: "superadmin",
      action: "business.onboarding.complete",
      success: true,
      target: { orgId: "507f1f77bcf86cd799439011" },
    });

    // allow async persist to settle
    await new Promise((r) => setTimeout(r, 30));

    expect(getAuditPersistFailureCount()).toBeGreaterThanOrEqual(1);
    expect(healthFindOneAndUpdateMock).toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes("audit_persist_failure")
      )
    ).toBe(true);
  });

  it("does not claim stdout is durable in alert messaging", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resetAuditPersistFailureCountForTests();
    await recordAuditPersistFailure({
      action: "x",
      errorMessage: "fail",
      threshold: 1,
    });
    const alert = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("audit_persist_alert"));
    expect(alert).toBeTruthy();
    expect(alert!).toMatch(/not treat stdout as the durable audit log|not durable/i);
  });
});
