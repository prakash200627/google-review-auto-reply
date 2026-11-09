import { describe, expect, it } from "vitest";
import {
  assertGbpProfileWriteAllowed,
  GbpProfileWriteAuthorizationError,
} from "@/lib/google/updateGbpProfile";

describe("Google profile write service authorization", () => {
  it("requires Super Admin, confirmation, and the server gate", () => {
    expect(() => assertGbpProfileWriteAllowed({ actorRole: "business_owner", confirmed: true, env: { ALLOW_LIVE_GBP_PROFILE_WRITES: "true" } }))
      .toThrowError(GbpProfileWriteAuthorizationError);
    expect(() => assertGbpProfileWriteAllowed({ actorRole: "superadmin", confirmed: false, env: { ALLOW_LIVE_GBP_PROFILE_WRITES: "true" } }))
      .toThrowError(GbpProfileWriteAuthorizationError);
    expect(() => assertGbpProfileWriteAllowed({ actorRole: "superadmin", confirmed: true, env: {} }))
      .toThrowError(GbpProfileWriteAuthorizationError);
  });

  it("allows only a confirmed SA operation when the server gate is enabled", () => {
    expect(() => assertGbpProfileWriteAllowed({ actorRole: "superadmin", confirmed: true, env: { ALLOW_LIVE_GBP_PROFILE_WRITES: "true" } })).not.toThrow();
  });
});
