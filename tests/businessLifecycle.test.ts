import { describe, expect, it } from "vitest";
import {
  allowedLifecycleTransitions,
  applyLifecycleTransition,
  LifecycleTransitionError,
  lifecycleAllowsAutoPublish,
  lifecycleAllowsOwnerAccess,
  lifecycleWriteFields,
  resolveBusinessLifecycle,
} from "@/lib/business/lifecycle";

describe("resolveBusinessLifecycle", () => {
  it("uses explicit status when present", () => {
    expect(resolveBusinessLifecycle({ status: "archived", active: true })).toBe(
      "archived"
    );
    expect(resolveBusinessLifecycle({ status: "suspended", active: true })).toBe(
      "suspended"
    );
  });

  it("maps legacy active=false to suspended, never archived", () => {
    expect(resolveBusinessLifecycle({ active: false })).toBe("suspended");
    expect(resolveBusinessLifecycle({ active: true })).toBe("active");
    expect(resolveBusinessLifecycle({})).toBe("active");
  });
});

describe("lifecycle transitions", () => {
  it("allows only valid transitions", () => {
    expect(allowedLifecycleTransitions("active")).toEqual([
      "suspend",
      "archive",
    ]);
    expect(allowedLifecycleTransitions("suspended")).toEqual([
      "reactivate",
      "archive",
    ]);
    expect(allowedLifecycleTransitions("archived")).toEqual(["restore"]);
  });

  it("restore returns suspended and disables auto-reply", () => {
    const next = applyLifecycleTransition("archived", "restore");
    expect(next).toEqual({
      status: "suspended",
      active: false,
      disableAutoReply: true,
    });
  });

  it("suspend and reactivate disarm auto-reply (SA must re-enable)", () => {
    expect(applyLifecycleTransition("active", "suspend")).toEqual({
      status: "suspended",
      active: false,
      disableAutoReply: true,
    });
    expect(applyLifecycleTransition("suspended", "reactivate")).toEqual({
      status: "active",
      active: true,
      disableAutoReply: true,
    });
  });

  it("rejects archived → reactivate", () => {
    expect(() => applyLifecycleTransition("archived", "reactivate")).toThrow(
      LifecycleTransitionError
    );
  });

  it("dual-writes active flag with status", () => {
    expect(lifecycleWriteFields("active")).toEqual({
      status: "active",
      active: true,
    });
    expect(lifecycleWriteFields("archived")).toEqual({
      status: "archived",
      active: false,
    });
  });

  it("blocks owner access and auto-publish when not active", () => {
    expect(lifecycleAllowsOwnerAccess({ status: "suspended" })).toBe(false);
    expect(lifecycleAllowsOwnerAccess({ status: "archived" })).toBe(false);
    expect(lifecycleAllowsAutoPublish({ status: "suspended" })).toBe(false);
    expect(lifecycleAllowsOwnerAccess({ status: "active" })).toBe(true);
  });
});
