import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { assertBusinessAccess, isAuthUser, requireAuthUser, type AuthUser } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { assertSuperAdminActiveOrgMatches } from "@/lib/auth/resolveOrgContext";
import { getValidAccessTokenForContext } from "@/lib/google/accessToken";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import {
  assertGbpProfileWriteAllowed, buildGbpProfilePatch, fetchGbpLocationSnapshot,
  getGbpProfileReadbackMismatches, gbpProfileFingerprint, GbpProfileWriteAuthorizationError,
  GbpProfileWriteUncertainError, isLiveGbpProfileWriteAllowed,
  normalizeGbpProfile, patchGbpLocationProfile, validateGbpProfile,
  type GbpEditableProfile,
} from "@/lib/google/updateGbpProfile";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { Location } from "@/models/Location";

export const runtime = "nodejs";
type Context = { params: Promise<{ businessId: string }> };

function isProfileInput(value: unknown): value is GbpEditableProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const hasOnly = (entry: unknown, keys: string[]) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).every((key) => keys.includes(key)));
  const allowed = ["title", "phoneNumbers", "websiteUri", "categories", "storefrontAddress", "regularHours", "specialHours"];
  if (Object.keys(p).some((key) => !allowed.includes(key))) return false;
  const phones = p.phoneNumbers as Record<string, unknown> | null;
  const categories = p.categories as Record<string, unknown> | null;
  const primaryCategory = categories?.primaryCategory as Record<string, unknown> | null;
  const address = p.storefrontAddress as Record<string, unknown> | null;
  const regular = p.regularHours as Record<string, unknown> | null;
  const special = p.specialHours as Record<string, unknown> | null;
  const addressKeys = ["revision", "languageCode", "sublocality", "sortingCode", "addressLines", "locality", "administrativeArea", "postalCode", "regionCode", "recipients", "organization"];
  const validPeriodArray = (value: unknown, keys: string[], dateKeys: string[] = []) => Array.isArray(value) && value.every((item) => {
    if (!hasOnly(item, keys)) return false;
    const period = item as Record<string, unknown>;
    return ["openDay", "closeDay"].every((key) => period[key] === undefined || typeof period[key] === "string") &&
      (period.closed === undefined || typeof period.closed === "boolean") &&
      ["openTime", "closeTime"].every((key) => period[key] === undefined || hasOnly(period[key], ["hours", "minutes"])) &&
      ["startDate", "endDate"].every((key) => period[key] === undefined || hasOnly(period[key], dateKeys));
  });
  return typeof p.title === "string" && typeof p.websiteUri === "string" &&
    Boolean(phones && hasOnly(phones, ["primaryPhone", "additionalPhones"]) && typeof phones.primaryPhone === "string" && Array.isArray(phones.additionalPhones) && phones.additionalPhones.every((x) => typeof x === "string")) &&
    Boolean(categories && hasOnly(categories, ["primaryCategory", "additionalCategories"]) && primaryCategory && hasOnly(primaryCategory, ["name"]) && typeof primaryCategory.name === "string" && Array.isArray(categories.additionalCategories) && categories.additionalCategories.every((x) => hasOnly(x, ["name"]) && typeof (x as Record<string, unknown>).name === "string")) &&
    Boolean(address && hasOnly(address, addressKeys) && Number.isInteger(address.revision) && Array.isArray(address.addressLines) && address.addressLines.every((x) => typeof x === "string") && ["locality", "administrativeArea", "postalCode", "regionCode"].every((key) => typeof address[key] === "string") && ["languageCode", "sublocality", "sortingCode", "organization"].every((key) => address[key] === undefined || typeof address[key] === "string") && (address.recipients === undefined || Array.isArray(address.recipients) && address.recipients.every((x) => typeof x === "string"))) &&
    Boolean(regular && hasOnly(regular, ["periods"]) && validPeriodArray(regular.periods, ["openDay", "openTime", "closeDay", "closeTime"])) &&
    Boolean(special && hasOnly(special, ["specialHourPeriods"]) && validPeriodArray(special.specialHourPeriods, ["startDate", "openTime", "endDate", "closeTime", "closed"], ["year", "month", "day"]));
}

async function resolveContext(businessId: string, user: AuthUser) {
  const access = await assertBusinessAccess(user, businessId);
  if (!access.ok) return { response: access.response };
  await connectToDatabase();
  const business = await Business.findById(businessId).select("orgId locationIds").lean();
  if (!business) return { response: NextResponse.json({ success: false, code: "not_found", message: "Business not found." }, { status: 404 }) };
  const orgAccess = await assertSuperAdminActiveOrgMatches(user, business.orgId ? String(business.orgId) : null);
  if (!orgAccess.ok) return { response: NextResponse.json({ success: false, code: orgAccess.code, message: orgAccess.message }, { status: orgAccess.status }) };
  const locationId = business.locationIds?.[0];
  if (!locationId) return { response: NextResponse.json({ success: false, code: "location_not_found", message: "No Google location is assigned to this business." }, { status: 404 }) };
  const location = await Location.findOne({ _id: locationId, businessId: business._id, orgId: business.orgId })
    .select("businessInfoName googleLocationName").lean();
  if (!location) return { response: NextResponse.json({ success: false, code: "location_association_invalid", message: "The assigned Google location does not belong to this business and organization." }, { status: 409 }) };
  const resourceName = location.businessInfoName || location.googleLocationName;
  if (!resourceName) return { response: NextResponse.json({ success: false, code: "google_location_unavailable", message: "The assigned location has no Google Business Information resource name." }, { status: 409 }) };
  return { business, location, resourceName, orgId: orgAccess.orgId || String(business.orgId) };
}

function profileError(err: unknown) {
  if (err instanceof GbpProfileWriteUncertainError) {
    return NextResponse.json({ success: false, code: err.code, outcome: "uncertain", message: err.message }, { status: err.status });
  }
  if (err instanceof GbpProfileWriteAuthorizationError || err instanceof GoogleBusinessApiError) {
    return NextResponse.json({ success: false, code: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ success: false, code: "google_profile_unavailable", message: "Google Business Profile could not be retrieved or updated." }, { status: 502 });
}

export async function GET(_request: Request, context: Context) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;
  if (auth.user.role !== "superadmin") return NextResponse.json({ success: false, code: "forbidden", message: "Super Admin access required." }, { status: 403 });
  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) return NextResponse.json({ success: false, code: "invalid_id", message: "Invalid business id." }, { status: 400 });
  const target = await resolveContext(businessId, auth.user);
  if ("response" in target) return target.response;
  try {
    const accessToken = await getValidAccessTokenForContext({ orgId: target.orgId, businessId });
    const profile = normalizeGbpProfile(await fetchGbpLocationSnapshot({ businessInfoName: target.resourceName, accessToken }));
    return NextResponse.json({ success: true, profile, fingerprint: gbpProfileFingerprint(profile), liveGoogleWritesAllowed: isLiveGbpProfileWriteAllowed() });
  } catch (err) { return profileError(err); }
}

export async function PATCH(request: Request, context: Context) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  if (auth.user.role !== "superadmin") {
    auditLog({ actorId: auth.user.userId, actorRole: auth.user.role, action: "business.google_profile_update", success: false, code: "forbidden", target: { businessId, outcome: "unauthorized_attempt" } });
    return NextResponse.json({ success: false, code: "forbidden", message: "Only a Super Admin can update a Google Business Profile." }, { status: 403 });
  }
  if (!mongoose.isValidObjectId(businessId)) return NextResponse.json({ success: false, code: "invalid_id", message: "Invalid business id." }, { status: 400 });
  let body: { profile?: GbpEditableProfile; fingerprint?: string; confirm?: boolean };
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    body = parsed as typeof body;
  } catch { return NextResponse.json({ success: false, code: "invalid_body", message: "Request body must be a JSON object." }, { status: 400 }); }
  if (Object.keys(body).some((key) => !["profile", "fingerprint", "confirm"].includes(key)) || !isProfileInput(body.profile) || typeof body.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.fingerprint)) return NextResponse.json({ success: false, code: "invalid_body", message: "A valid profile and its loaded fingerprint are required." }, { status: 400 });
  if (body.confirm !== true) {
    auditLog({ actorId: auth.user.userId, actorRole: auth.user.role, action: "business.google_profile_update", success: false, code: "confirmation_required", target: { businessId, outcome: "confirmation_missing" } });
    return NextResponse.json({ success: false, code: "confirmation_required", message: "Explicit confirmation is required before publishing profile changes." }, { status: 400 });
  }
  try { assertGbpProfileWriteAllowed({ actorRole: auth.user.role, confirmed: body.confirm === true }); }
  catch (err) {
    auditLog({ actorId: auth.user.userId, actorRole: auth.user.role, action: "business.google_profile_update", success: false, code: err instanceof GbpProfileWriteAuthorizationError ? err.code : "write_blocked", target: { businessId, outcome: "write_blocked" } });
    return profileError(err);
  }
  const target = await resolveContext(businessId, auth.user);
  if ("response" in target) return target.response;
  const actor = { actorId: auth.user.userId, actorRole: auth.user.role };
  try {
    const accessToken = await getValidAccessTokenForContext({ orgId: target.orgId, businessId });
    const before = normalizeGbpProfile(await fetchGbpLocationSnapshot({ businessInfoName: target.resourceName, accessToken }));
    if (gbpProfileFingerprint(before) !== body.fingerprint) {
      auditLog({ ...actor, action: "business.google_profile_update", success: false, code: "profile_conflict", target: { businessId, orgId: target.orgId, outcome: "conflict" } });
      return NextResponse.json({ success: false, code: "profile_conflict", message: "The Google profile changed after it was loaded. Reload and review the latest profile before publishing.", profile: before, fingerprint: gbpProfileFingerprint(before) }, { status: 409 });
    }
    const patch = buildGbpProfilePatch(before, body.profile);
    if (!patch.updateMask) return NextResponse.json({ success: true, noOp: true, message: "Google profile already matches the supplied values.", profile: before, fingerprint: body.fingerprint });
    const issues = validateGbpProfile(body.profile, patch.changedFields);
    if (issues.length) return NextResponse.json({ success: false, code: "invalid_profile", message: "Review the highlighted Google profile fields.", issues }, { status: 400 });
    if (patch.body.title !== undefined && !(patch.body.title as string).trim()) return NextResponse.json({ success: false, code: "invalid_profile", message: "Business name cannot be empty." }, { status: 400 });
    if (patch.body.storefrontAddress) {
      const address = body.profile.storefrontAddress;
      if (!address.addressLines.some((line) => line.trim()) || !/^[A-Z]{2}$/.test(address.regionCode)) return NextResponse.json({ success: false, code: "invalid_profile", message: "A storefront address needs a street line and a two-letter country code." }, { status: 400 });
    }
    if (patch.body.categories && !/^gcid:[a-z0-9_]+$/i.test(body.profile.categories.primaryCategory.name)) {
      return NextResponse.json({ success: false, code: "invalid_profile", message: "A valid primary Google category is required when changing categories." }, { status: 400 });
    }
    await patchGbpLocationProfile({ businessInfoName: target.resourceName, body: patch.body, updateMask: patch.updateMask, accessToken, actorRole: auth.user.role, confirmed: true });
    let after = body.profile;
    try { after = normalizeGbpProfile(await fetchGbpLocationSnapshot({ businessInfoName: target.resourceName, accessToken })); }
    catch {
      auditLog({ ...actor, action: "business.google_profile_update", success: true, code: "updated_readback_unavailable", target: { businessId, orgId: target.orgId, outcome: "updated_readback_unavailable", fieldCount: patch.changedFields.length } });
      return NextResponse.json({ success: true, verified: false, changedFields: patch.changedFields, message: "Google accepted the update, but the result could not be read back. Reload the profile to verify it." });
    }
    const mismatchedFields = getGbpProfileReadbackMismatches(body.profile, after, patch.changedFields);
    if (mismatchedFields.length) {
      const outcome = mismatchedFields.length === patch.changedFields.length ? "unverified" : "partial";
      auditLog({ ...actor, action: "business.google_profile_update", success: false, code: "readback_mismatch", target: { businessId, orgId: target.orgId, outcome, fieldCount: patch.changedFields.length, mismatchedFieldCount: mismatchedFields.length } });
      return NextResponse.json({ success: true, verified: false, outcome, changedFields: patch.changedFields, mismatchedFields, profile: after, fingerprint: gbpProfileFingerprint(after), message: "Google accepted the update, but some returned values did not match the requested changes. Review the current Google profile before publishing again." });
    }
    auditLog({ ...actor, action: "business.google_profile_update", success: true, target: { businessId, orgId: target.orgId, outcome: "updated", fieldCount: patch.changedFields.length } });
    return NextResponse.json({ success: true, verified: true, changedFields: patch.changedFields, profile: after, fingerprint: gbpProfileFingerprint(after), message: "Google Business Profile updated and verified." });
  } catch (err) {
    const uncertain = err instanceof GbpProfileWriteUncertainError;
    auditLog({ ...actor, action: "business.google_profile_update", success: false, code: uncertain ? err.code : err instanceof GoogleBusinessApiError ? err.code : "google_update_failed", target: { businessId, orgId: target.orgId, outcome: uncertain ? "uncertain" : "failed" } });
    return profileError(err);
  }
}
