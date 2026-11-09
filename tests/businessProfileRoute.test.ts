import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), access: vi.fn(), connect: vi.fn(), businessFind: vi.fn(),
  locationFind: vi.fn(), token: vi.fn(), phonePatch: vi.fn(), geoPatch: vi.fn(),
  snapshot: vi.fn(), audit: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireAuthUser: mocks.auth,
  isAuthUser: (x: { user?: unknown; response?: NextResponse }) => Boolean(x.user),
  assertBusinessAccess: mocks.access,
}));
vi.mock("@/lib/auth/requestOrigin", () => ({ assertMutationOrigin: () => ({ ok: true }) }));
vi.mock("@/lib/mongodb", () => ({ connectToDatabase: mocks.connect }));
vi.mock("@/models/Business", () => ({ Business: { findById: mocks.businessFind } }));
vi.mock("@/models/Location", () => ({ Location: { findOne: mocks.locationFind } }));
vi.mock("@/lib/google/accessToken", () => ({ getValidAccessTokenForContext: mocks.token }));
vi.mock("@/lib/google/updateGbpProfile", () => ({
  isLiveGbpProfileWriteAllowed: () => process.env.ALLOW_LIVE_GBP_PROFILE_WRITES === "true",
  patchGbpLocationPhone: mocks.phonePatch,
  patchGbpLocationLatLng: mocks.geoPatch,
  fetchGbpLocationSnapshot: mocks.snapshot,
  assertGbpProfileWriteAllowed: () => undefined,
  GbpProfileWriteAuthorizationError: class extends Error { status = 403; code = "forbidden"; },
}));
vi.mock("@/lib/audit/log", () => ({ auditLog: mocks.audit }));

import { PATCH } from "@/app/api/business/[businessId]/profile/route";

const businessId = new mongoose.Types.ObjectId().toString();
const orgId = new mongoose.Types.ObjectId().toString();
const locationId = new mongoose.Types.ObjectId().toString();

function setup(role: "superadmin" | "business_owner" = "superadmin") {
  const business = {
    _id: new mongoose.Types.ObjectId(businessId), orgId: new mongoose.Types.ObjectId(orgId),
    locationIds: [new mongoose.Types.ObjectId(locationId)],
    profile: { description: "", website: "", phone: "+14155550123" },
    save: vi.fn().mockResolvedValue(undefined),
  };
  const location = {
    _id: new mongoose.Types.ObjectId(locationId), businessId: business._id, orgId: business.orgId,
    address: "1 Main Street", latitude: 37, longitude: -122, businessInfoName: "locations/google-1",
    save: vi.fn().mockResolvedValue(undefined),
  };
  mocks.auth.mockResolvedValue({ user: { userId: new mongoose.Types.ObjectId().toString(), role, businessIds: [businessId], groupIds: [] } });
  mocks.access.mockResolvedValue({ ok: true, business });
  mocks.connect.mockResolvedValue(undefined);
  mocks.businessFind.mockReturnValue({ exec: async () => business });
  mocks.locationFind.mockReturnValue({ exec: async () => location });
  mocks.token.mockResolvedValue("test-token");
  mocks.phonePatch.mockResolvedValue({ updated: true });
  mocks.geoPatch.mockResolvedValue({ updated: true });
  mocks.snapshot.mockResolvedValue({
    phoneNumbers: { primaryPhone: "+14155550000", additionalPhones: [] },
  });
  return { business, location };
}

function request(body: unknown) {
  return new Request(`http://localhost/api/business/${businessId}/profile`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("business profile update foundation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ALLOW_LIVE_GBP_PROFILE_WRITES;
  });

  it("rejects unauthenticated requests", async () => {
    mocks.auth.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) });
    const res = await PATCH(request({ phone: "+14155550123" }), { params: Promise.resolve({ businessId }) });
    expect(res.status).toBe(401);
  });

  it("allows BA local updates without invoking Google", async () => {
    const { business } = setup("business_owner");
    const res = await PATCH(request({ phone: "+1 (415) 555-0199" }), { params: Promise.resolve({ businessId }) });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.local.applied).toBe(true);
    expect(business.profile.phone).toBe("+14155550199");
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("rejects BA Google updates before saving local data", async () => {
    const { business } = setup("business_owner");
    const res = await PATCH(request({ phone: "+14155550199", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    expect(res.status).toBe(403);
    expect(business.save).not.toHaveBeenCalled();
    expect(mocks.phonePatch).not.toHaveBeenCalled();
  });

  it("rejects even confirmed Super Admin coordinate writes to Google", async () => {
    const { location } = setup();
    const res = await PATCH(request({ latitude: 38, longitude: -121, pushGeoToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe("unsupported_field");
    expect(mocks.geoPatch).not.toHaveBeenCalled();
    expect(location.save).not.toHaveBeenCalled();
  });

  it("scopes a Super Admin local update to the assigned business and organization", async () => {
    setup();
    const res = await PATCH(request({ address: "2 Main Street" }), { params: Promise.resolve({ businessId }) });
    expect(res.status).toBe(200);
    expect(mocks.locationFind).toHaveBeenCalledWith({
      _id: expect.any(mongoose.Types.ObjectId),
      businessId: expect.any(mongoose.Types.ObjectId),
      orgId: expect.any(mongoose.Types.ObjectId),
    });
  });

  it("fails closed when the existing location belongs to another business", async () => {
    const { business, location } = setup();
    const otherBusinessId = new mongoose.Types.ObjectId();
    location.businessId = otherBusinessId as unknown as typeof business._id;
    mocks.locationFind.mockImplementation((query: { businessId: unknown; orgId: unknown }) => ({
      exec: async () =>
        String(location.businessId) === String(query.businessId) &&
        String(location.orgId) === String(query.orgId)
          ? location
          : null,
    }));
    const res = await PATCH(request({ phone: "+14155550199", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    expect(res.status).toBe(409);
    expect(business.save).not.toHaveBeenCalled();
    expect(location.save).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.phonePatch).not.toHaveBeenCalled();
  });

  it("fails closed when the existing location belongs to another organization", async () => {
    const { business, location } = setup();
    location.orgId = new mongoose.Types.ObjectId() as unknown as typeof business.orgId;
    mocks.locationFind.mockImplementation((query: { businessId: unknown; orgId: unknown }) => ({
      exec: async () =>
        String(location.businessId) === String(query.businessId) &&
        String(location.orgId) === String(query.orgId)
          ? location
          : null,
    }));
    const res = await PATCH(request({ phone: "+14155550199", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    expect(res.status).toBe(409);
    expect(business.save).not.toHaveBeenCalled();
    expect(location.save).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.phonePatch).not.toHaveBeenCalled();
  });

  it("fails closed on a broken location association without modifying data", async () => {
    const { business } = setup();
    mocks.locationFind.mockReturnValue({ exec: async () => null });
    const res = await PATCH(request({ phone: "+14155550199" }), { params: Promise.resolve({ businessId }) });
    expect(res.status).toBe(409);
    expect(business.save).not.toHaveBeenCalled();
  });

  it("rejects malformed phone and address values without saving", async () => {
    const { business } = setup();
    const phoneRes = await PATCH(request({ phone: "123" }), { params: Promise.resolve({ businessId }) });
    expect(phoneRes.status).toBe(400);
    const addressRes = await PATCH(request({ address: "x".repeat(501) }), { params: Promise.resolve({ businessId }) });
    expect(addressRes.status).toBe(400);
    expect(business.save).not.toHaveBeenCalled();
  });

  it("rejects malformed phone input before saving or calling Google", async () => {
    const { business } = setup();
    const res = await PATCH(request({ phone: "+1abc4155550199", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    expect(res.status).toBe(400);
    expect(business.save).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.phonePatch).not.toHaveBeenCalled();
  });

  it("rejects coordinate-only updates when the other stored coordinate is missing", async () => {
    const { business, location } = setup();
    location.longitude = null as unknown as number;
    const res = await PATCH(request({ latitude: 38 }), { params: Promise.resolve({ businessId }) });
    expect(res.status).toBe(400);
    expect(business.save).not.toHaveBeenCalled();
    expect(location.save).not.toHaveBeenCalled();
  });

  it("preserves omitted fields and reports a Google failure as a partial success", async () => {
    setup();
    process.env.ALLOW_LIVE_GBP_PROFILE_WRITES = "true";
    mocks.phonePatch.mockRejectedValue(new Error("Google rejected request"));
    const res = await PATCH(request({ address: "2 Main Street", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.local.applied).toBe(true);
    expect(json.google.status).toBe("failed");
    expect(json.google.applied).toBe(false);
    expect(json.message).toContain("were saved, but Google did not accept");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "business.profile_google_update", success: false }));
  });

  it("returns a no-op when local values and the verified Google primary phone already match", async () => {
    const { business, location } = setup();
    process.env.ALLOW_LIVE_GBP_PROFILE_WRITES = "true";
    mocks.snapshot.mockResolvedValue({
      phoneNumbers: { primaryPhone: "+1 (415) 555-0123", additionalPhones: [] },
    });
    const res = await PATCH(request({ phone: "+14155550123", address: "1 Main Street", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.local).toMatchObject({ applied: false, status: "no_op" });
    expect(json.google).toMatchObject({ applied: false, status: "no_operation" });
    expect(json.google.skippedReason).toContain("already matches (verified)");
    expect(business.save).not.toHaveBeenCalled();
    expect(location.save).not.toHaveBeenCalled();
    expect(mocks.phonePatch).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "business.profile_local_update" }));
  });

  it("does not send an update when Google has additional phone numbers", async () => {
    const { business } = setup();
    process.env.ALLOW_LIVE_GBP_PROFILE_WRITES = "true";
    mocks.snapshot.mockResolvedValue({
      phoneNumbers: {
        primaryPhone: "+14155550000",
        additionalPhones: ["+14155550001"],
      },
    });
    const res = await PATCH(request({ phone: "+14155550199", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.local.applied).toBe(true);
    expect(json.google).toMatchObject({ applied: false, status: "blocked" });
    expect(json.google.skippedReason).toContain("cannot preserve them");
    expect(business.save).toHaveBeenCalledTimes(1);
    expect(mocks.phonePatch).not.toHaveBeenCalled();
  });

  it("reports an unverifiable Google phone and does not claim a no-op or send a patch", async () => {
    setup();
    process.env.ALLOW_LIVE_GBP_PROFILE_WRITES = "true";
    mocks.snapshot.mockResolvedValue({ phoneNumbers: {} });
    const res = await PATCH(request({ phone: "+14155550199", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    const json = await res.json();
    expect(json.google).toMatchObject({ applied: false, status: "blocked" });
    expect(json.google.skippedReason).toContain("could not be verified safely");
    expect(mocks.phonePatch).not.toHaveBeenCalled();
  });

  it("allows a confirmed SA Google update and reports only accepted remote work", async () => {
    setup();
    process.env.ALLOW_LIVE_GBP_PROFILE_WRITES = "true";
    const res = await PATCH(request({ phone: "+14155550199", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.local.applied).toBe(true);
    expect(json.google).toMatchObject({ attempted: true, applied: true, status: "succeeded" });
    expect(mocks.phonePatch).toHaveBeenCalledWith(expect.objectContaining({
      businessInfoName: "locations/google-1",
      phone: "+14155550199",
      actorRole: "superadmin",
      confirmed: true,
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "business.profile_google_update", success: true }));
  });

  it("blocks Google writes when the environment gate is off", async () => {
    setup();
    const res = await PATCH(request({ phone: "+14155550199", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.local.applied).toBe(true);
    expect(json.google.status).toBe("blocked");
    expect(mocks.phonePatch).not.toHaveBeenCalled();
  });

  it("requires confirmation and rejects unsupported Google fields", async () => {
    setup();
    const unconfirmed = await PATCH(request({ phone: "+14155550199", pushPhoneToGoogle: true }), { params: Promise.resolve({ businessId }) });
    expect(unconfirmed.status).toBe(400);
    const unsupported = await PATCH(request({ title: "New title" }), { params: Promise.resolve({ businessId }) });
    expect(unsupported.status).toBe(400);
  });

  it("does not claim a Google update when no remote operation has usable values", async () => {
    setup();
    process.env.ALLOW_LIVE_GBP_PROFILE_WRITES = "true";
    const res = await PATCH(request({ phone: "", pushPhoneToGoogle: true, confirmLiveGoogleUpdate: true }), { params: Promise.resolve({ businessId }) });
    const json = await res.json();
    expect(json.google.applied).toBe(false);
    expect(json.google.status).toBe("not_compared");
    expect(mocks.phonePatch).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
