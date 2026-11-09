import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), orgMatch: vi.fn(), connect: vi.fn(), businessFind: vi.fn(), locationFind: vi.fn(), token: vi.fn(), fetchProfile: vi.fn(), patchProfile: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ requireAuthUser: mocks.auth, isAuthUser: (x: { user?: unknown }) => Boolean(x.user), assertBusinessAccess: mocks.access }));
vi.mock("@/lib/auth/requestOrigin", () => ({ assertMutationOrigin: () => ({ ok: true }) }));
vi.mock("@/lib/auth/resolveOrgContext", () => ({ assertSuperAdminActiveOrgMatches: mocks.orgMatch }));
vi.mock("@/lib/mongodb", () => ({ connectToDatabase: mocks.connect }));
vi.mock("@/models/Business", () => ({ Business: { findById: mocks.businessFind } }));
vi.mock("@/models/Location", () => ({ Location: { findOne: mocks.locationFind } }));
vi.mock("@/lib/google/accessToken", () => ({ getValidAccessTokenForContext: mocks.token }));
vi.mock("@/lib/google/updateGbpProfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/updateGbpProfile")>();
  return { ...actual, fetchGbpLocationSnapshot: mocks.fetchProfile, patchGbpLocationProfile: mocks.patchProfile };
});
vi.mock("@/lib/audit/log", () => ({ auditLog: mocks.audit }));

import { GET, PATCH } from "@/app/api/business/[businessId]/google-profile/route";
import { gbpProfileFingerprint, GbpProfileWriteUncertainError, normalizeGbpProfile } from "@/lib/google/updateGbpProfile";

const businessId = new mongoose.Types.ObjectId().toString();
const orgId = new mongoose.Types.ObjectId().toString();
const locationId = new mongoose.Types.ObjectId().toString();
const context = { params: Promise.resolve({ businessId }) };
const validProfile = {
  title: "Cafe", phoneNumbers: { primaryPhone: "+14155550100", additionalPhones: [] }, websiteUri: "",
  categories: { primaryCategory: { name: "gcid:cafe" }, additionalCategories: [] },
  storefrontAddress: { revision: 0, addressLines: [], locality: "", administrativeArea: "", postalCode: "", regionCode: "" },
  regularHours: { periods: [] }, specialHours: { specialHourPeriods: [] },
};

function setAuth(role: string) {
  mocks.auth.mockResolvedValue({ user: { userId: new mongoose.Types.ObjectId().toString(), role, email: "test@example.invalid", businessIds: [], groupIds: [] } });
  mocks.access.mockResolvedValue({ ok: true });
}
function setLocationAssociation(storedBusinessId: string, storedOrgId: string) {
  mocks.locationFind.mockImplementation((query: { businessId: unknown; orgId: unknown }) => ({
    select: () => ({ lean: async () => String(query.businessId) === storedBusinessId && String(query.orgId) === storedOrgId ? { businessInfoName: "locations/g-1" } : null }),
  }));
}
function patchRequest(body: unknown) { return new Request(`http://localhost/api/business/${businessId}/google-profile`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

describe("Super Admin Google profile route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth("superadmin");
    mocks.orgMatch.mockResolvedValue({ ok: true, orgId });
    mocks.connect.mockResolvedValue(undefined);
    const business = { _id: new mongoose.Types.ObjectId(businessId), orgId: new mongoose.Types.ObjectId(orgId), locationIds: [new mongoose.Types.ObjectId(locationId)] };
    mocks.businessFind.mockReturnValue({ select: () => ({ lean: async () => business }) });
    mocks.locationFind.mockReturnValue({ select: () => ({ lean: async () => ({ businessInfoName: "locations/g-1" }) }) });
    mocks.token.mockResolvedValue("mock-token");
    mocks.fetchProfile.mockResolvedValue({ title: "Cafe", phoneNumbers: { primaryPhone: "+14155550100", additionalPhones: [] }, categories: { primaryCategory: { name: "gcid:cafe" }, additionalCategories: [] } });
    mocks.patchProfile.mockResolvedValue({});
  });

  it("denies Business Admin profile retrieval and publishing", async () => {
    setAuth("business_owner");
    expect((await GET(new Request("http://localhost"), context))?.status).toBe(403);
    expect((await PATCH(patchRequest({}), context))?.status).toBe(403);
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.patchProfile).not.toHaveBeenCalled();
  });

  it("allows retrieval when the verified active organization matches the business", async () => {
    const response = await GET(new Request("http://localhost"), context);
    expect(response?.status).toBe(200);
    expect(mocks.orgMatch).toHaveBeenCalledWith(expect.objectContaining({ role: "superadmin" }), orgId);
    expect(mocks.token).toHaveBeenCalledWith({ orgId, businessId });
  });

  it("fails closed when an existing location belongs to a different business", async () => {
    setLocationAssociation(new mongoose.Types.ObjectId().toString(), orgId);
    const response = await GET(new Request("http://localhost"), context);
    expect(response?.status).toBe(409);
    expect(mocks.locationFind).toHaveBeenCalledWith({ _id: expect.any(mongoose.Types.ObjectId), businessId: expect.any(mongoose.Types.ObjectId), orgId: expect.any(mongoose.Types.ObjectId) });
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("fails closed when an existing location belongs to a different organization", async () => {
    setLocationAssociation(businessId, new mongoose.Types.ObjectId().toString());
    const response = await GET(new Request("http://localhost"), context);
    expect(response?.status).toBe(409);
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("requires a selected active organization for both GET and PATCH", async () => {
    mocks.orgMatch.mockResolvedValue({ ok: false, status: 403, code: "org_required", message: "Select an active organization." });
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "true");
    expect((await GET(new Request("http://localhost"), context))?.status).toBe(403);
    expect((await PATCH(patchRequest({ profile: { ...validProfile, title: "Updated" }, fingerprint: "a".repeat(64), confirm: true }), context))?.status).toBe(403);
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
    expect(mocks.patchProfile).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("rejects invalid or inaccessible active organization context for both methods", async () => {
    mocks.orgMatch.mockResolvedValue({ ok: false, status: 403, code: "org_required", message: "Select an active organization." });
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "true");
    expect((await GET(new Request("http://localhost"), context))?.status).toBe(403);
    expect((await PATCH(patchRequest({ profile: { ...validProfile, title: "Updated" }, fingerprint: "a".repeat(64), confirm: true }), context))?.status).toBe(403);
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
    expect(mocks.patchProfile).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("rejects businesses outside the active organization for both methods", async () => {
    mocks.orgMatch.mockResolvedValue({ ok: false, status: 403, code: "org_mismatch", message: "This business belongs to another organization." });
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "true");
    expect((await GET(new Request("http://localhost"), context))?.status).toBe(403);
    expect((await PATCH(patchRequest({ profile: { ...validProfile, title: "Updated" }, fingerprint: "a".repeat(64), confirm: true }), context))?.status).toBe(403);
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.fetchProfile).not.toHaveBeenCalled();
    expect(mocks.patchProfile).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("requires explicit confirmation and the server environment gate", async () => {
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "true");
    expect((await PATCH(patchRequest({ profile: validProfile, fingerprint: "a".repeat(64), confirm: false }), context))?.status).toBe(400);
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "false");
    const request = patchRequest({ profile: validProfile, fingerprint: "a".repeat(64), confirm: true });
    const response = await PATCH(request, context);
    expect(response?.status).toBe(503);
    expect(mocks.patchProfile).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("rejects a changed Google profile fingerprint without writing", async () => {
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "true");
    const response = await PATCH(patchRequest({ profile: { ...validProfile, title: "Changed" }, fingerprint: "a".repeat(64), confirm: true }), context);
    expect(response?.status).toBe(409);
    expect(mocks.patchProfile).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: "profile_conflict" }));
    vi.unstubAllEnvs();
  });

  it("publishes changed supported fields with explicit complete update data and audits success", async () => {
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "true");
    const currentRaw = { title: "Cafe", phoneNumbers: { primaryPhone: "+14155550100", additionalPhones: [] }, categories: { primaryCategory: { name: "gcid:cafe" }, additionalCategories: [] } };
    const proposed = { ...validProfile, title: "New Cafe" };
    mocks.fetchProfile.mockResolvedValueOnce(currentRaw).mockResolvedValueOnce({ ...currentRaw, title: "New Cafe" });
    const fingerprint = gbpProfileFingerprint(normalizeGbpProfile(currentRaw));
    const response = await PATCH(patchRequest({ profile: proposed, fingerprint, confirm: true }), context);
    expect(response?.status).toBe(200);
    const json = await response?.json();
    expect(json).toMatchObject({ success: true, verified: true });
    expect(json).not.toHaveProperty("outcome");
    expect(mocks.patchProfile).toHaveBeenCalledWith(expect.objectContaining({ body: { title: "New Cafe" }, updateMask: "title", actorRole: "superadmin", confirmed: true }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "business.google_profile_update", success: true, target: expect.objectContaining({ outcome: "updated" }) }));
    vi.unstubAllEnvs();
  });

  it.each([
    ["title", { ...validProfile, title: "New Cafe" }, { title: "Cafe" }, "Business name"],
    ["phone group", { ...validProfile, phoneNumbers: { primaryPhone: "+14155550199", additionalPhones: ["+14155550101"] } }, { phoneNumbers: { primaryPhone: "+14155550100", additionalPhones: [] } }, "Phone numbers"],
    ["category group", { ...validProfile, categories: { primaryCategory: { name: "gcid:restaurant" }, additionalCategories: [{ name: "gcid:bakery" }] } }, { categories: { primaryCategory: { name: "gcid:cafe" }, additionalCategories: [] } }, "Business categories"],
    ["hours", { ...validProfile, regularHours: { periods: [{ openDay: "MONDAY", openTime: { hours: 9 }, closeDay: "MONDAY", closeTime: { hours: 17 } }] } }, { regularHours: { periods: [] } }, "Regular business hours"],
  ])("returns unverified when readback mismatches the changed %s", async (_name, proposed, afterFields, mismatchField) => {
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "true");
    const currentRaw = { title: "Cafe", phoneNumbers: { primaryPhone: "+14155550100", additionalPhones: [] }, categories: { primaryCategory: { name: "gcid:cafe" }, additionalCategories: [] } };
    mocks.fetchProfile.mockResolvedValueOnce(currentRaw).mockResolvedValueOnce({ ...currentRaw, ...(afterFields as object) });
    const fingerprint = gbpProfileFingerprint(normalizeGbpProfile(currentRaw));
    const response = await PATCH(patchRequest({ profile: proposed, fingerprint, confirm: true }), context);
    const json = await response?.json();
    expect(response?.status).toBe(200);
    expect(json).toMatchObject({ success: true, verified: false, outcome: "unverified", mismatchedFields: [mismatchField] });
    vi.unstubAllEnvs();
  });

  it("returns a partial result when readback matches only some changed groups", async () => {
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "true");
    const currentRaw = { title: "Cafe", phoneNumbers: { primaryPhone: "+14155550100", additionalPhones: [] }, categories: { primaryCategory: { name: "gcid:cafe" }, additionalCategories: [] } };
    const proposed = { ...validProfile, title: "New Cafe", phoneNumbers: { primaryPhone: "+14155550199", additionalPhones: [] } };
    mocks.fetchProfile.mockResolvedValueOnce(currentRaw).mockResolvedValueOnce({ ...currentRaw, title: "New Cafe" });
    const fingerprint = gbpProfileFingerprint(normalizeGbpProfile(currentRaw));
    const response = await PATCH(patchRequest({ profile: proposed, fingerprint, confirm: true }), context);
    const json = await response?.json();
    expect(json).toMatchObject({ success: true, verified: false, outcome: "partial", mismatchedFields: ["Phone numbers"] });
    vi.unstubAllEnvs();
  });

  it("keeps a successful write unverified when the readback request fails", async () => {
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "true");
    const currentRaw = { title: "Cafe", phoneNumbers: { primaryPhone: "+14155550100", additionalPhones: [] }, categories: { primaryCategory: { name: "gcid:cafe" }, additionalCategories: [] } };
    mocks.fetchProfile.mockResolvedValueOnce(currentRaw).mockRejectedValueOnce(new Error("network failure"));
    const fingerprint = gbpProfileFingerprint(normalizeGbpProfile(currentRaw));
    const response = await PATCH(patchRequest({ profile: { ...validProfile, title: "New Cafe" }, fingerprint, confirm: true }), context);
    const json = await response?.json();
    expect(json).toMatchObject({ success: true, verified: false });
    expect(json.message).toContain("could not be read back");
    vi.unstubAllEnvs();
  });

  it("reports ambiguous network outcomes as uncertain and audits them accurately", async () => {
    vi.stubEnv("ALLOW_LIVE_GBP_PROFILE_WRITES", "true");
    const currentRaw = { title: "Cafe", phoneNumbers: { primaryPhone: "+14155550100", additionalPhones: [] }, categories: { primaryCategory: { name: "gcid:cafe" }, additionalCategories: [] } };
    mocks.fetchProfile.mockResolvedValueOnce(currentRaw);
    mocks.patchProfile.mockRejectedValueOnce(new GbpProfileWriteUncertainError());
    const fingerprint = gbpProfileFingerprint(normalizeGbpProfile(currentRaw));
    const response = await PATCH(patchRequest({ profile: { ...validProfile, title: "New Cafe" }, fingerprint, confirm: true }), context);
    const json = await response?.json();
    expect(response?.status).toBe(502);
    expect(json).toMatchObject({ success: false, code: "google_write_uncertain", outcome: "uncertain" });
    expect(json.message).toContain("Reload the Google profile");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: "google_write_uncertain", target: expect.objectContaining({ outcome: "uncertain" }) }));
    vi.unstubAllEnvs();
  });
});
