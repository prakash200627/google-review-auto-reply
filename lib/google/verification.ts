/**
 * Google My Business Verifications API helpers.
 *
 * Official operations used (parent path is locations/LOCATION_ID):
 * - GET  VoiceOfMerchantState
 * - POST :fetchVerificationOptions
 * - POST :verify
 * - GET  /verifications
 * - POST /verifications/VERIFICATION_ID:complete
 *
 * Scope: https://www.googleapis.com/auth/business.manage
 * Docs: https://developers.google.com/my-business/reference/verifications/rest
 */

import mongoose from "mongoose";
import {
  hashIdempotencyPayload,
  normalizeIdempotencyKey,
} from "@/lib/idempotency/keys";
import {
  claimIdempotencySlot,
  IdempotencyClaimError,
  markIdempotencyFailed,
  markIdempotencySucceeded,
} from "@/lib/idempotency/claim";
import { connectToDatabase } from "@/lib/mongodb";
import { getValidAccessTokenForOrg } from "@/lib/google/accessToken";
import {
  VERIFICATIONS_BASE,
  buildUrl,
  googleApiGetJson,
  googleApiPostJson,
} from "@/lib/google/gbpClient";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import {
  Location,
  LOCATION_VERIFICATION_STATUSES,
  type LocationVerificationStatus,
} from "@/models/Location";

type FetchLike = typeof fetch;

export const VERIFICATION_METHODS = [
  "ADDRESS",
  "EMAIL",
  "PHONE_CALL",
  "SMS",
  "AUTO",
  "VETTED_PARTNER",
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export type VerificationState =
  | "STATE_UNSPECIFIED"
  | "PENDING"
  | "COMPLETED"
  | "FAILED";

export type VoiceOfMerchantState = {
  hasVoiceOfMerchant?: boolean;
  hasBusinessAuthority?: boolean;
  waitForVoiceOfMerchant?: Record<string, never>;
  verify?: { hasPendingVerification?: boolean };
  resolveOwnershipConflict?: Record<string, never>;
  complyWithGuidelines?: { recommendationReason?: string };
};

export type GoogleVerification = {
  name?: string;
  method?: string;
  state?: string;
  createTime?: string;
  announcement?: string;
};

export type AddressVerificationData = {
  business?: string;
  address?: {
    addressLines?: string[];
    locality?: string;
    administrativeArea?: string;
    postalCode?: string;
    regionCode?: string;
  };
  expectedDeliveryDaysRegion?: number;
};

export type EmailVerificationData = {
  domain?: string;
  user?: string;
  isUserNameEditable?: boolean;
};

export type VerificationOption = {
  verificationMethod?: string;
  phoneNumber?: string;
  addressData?: AddressVerificationData;
  emailData?: EmailVerificationData;
  announcement?: string;
};

export type SafeVerificationOption = {
  verificationMethod: VerificationMethod;
  phoneNumber?: string;
  addressData?: AddressVerificationData;
  emailData?: EmailVerificationData;
  announcement?: string;
};

export class VerificationServiceError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code = "verification_error", status = 400 }: { code?: string; status?: number } = {}
  ) {
    super(message);
    this.name = "VerificationServiceError";
    this.code = code;
    this.status = status;
  }
}

export function isLocationVerificationStatus(
  value: unknown
): value is LocationVerificationStatus {
  return (
    typeof value === "string" &&
    (LOCATION_VERIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isVerificationMethod(
  value: unknown
): value is VerificationMethod {
  return (
    typeof value === "string" &&
    (VERIFICATION_METHODS as readonly string[]).includes(value)
  );
}

/** Normalize to locations/{locationId} for Verifications API paths. */
export function toVerificationsLocationName(
  businessInfoName: string
): string | null {
  const raw = String(businessInfoName || "").trim().replace(/^\/+/, "");
  if (/^locations\/[^/]+$/.test(raw)) return raw;
  if (raw.includes("/locations/")) {
    const id = raw.split("/locations/").pop();
    if (id && !id.includes("/")) return `locations/${id}`;
  }
  return null;
}

export function sanitizeVerificationOptions(
  options: VerificationOption[] | undefined
): SafeVerificationOption[] {
  const out: SafeVerificationOption[] = [];
  for (const opt of options || []) {
    if (!isVerificationMethod(opt.verificationMethod)) continue;
    const safe: SafeVerificationOption = {
      verificationMethod: opt.verificationMethod,
    };
    if (typeof opt.phoneNumber === "string" && opt.phoneNumber) {
      safe.phoneNumber = opt.phoneNumber;
    }
    if (opt.addressData && typeof opt.addressData === "object") {
      safe.addressData = opt.addressData;
    }
    if (opt.emailData && typeof opt.emailData === "object") {
      safe.emailData = opt.emailData;
    }
    if (typeof opt.announcement === "string" && opt.announcement) {
      safe.announcement = opt.announcement;
    }
    out.push(safe);
  }
  return out;
}

/**
 * Map Google VoiceOfMerchant + latest Verification into TRONX status.
 * `verified` only when hasVoiceOfMerchant === true.
 * `failed` only when Google Verification.state is FAILED (reliable).
 * Inconclusive responses stay `unknown`.
 */
export function deriveVerificationStatus(input: {
  voice: VoiceOfMerchantState | null | undefined;
  latestVerification: GoogleVerification | null | undefined;
}): {
  status: LocationVerificationStatus;
  recommendedAction: string;
  note: string;
} {
  const voice = input.voice;
  if (!voice || typeof voice !== "object") {
    return {
      status: "unknown",
      recommendedAction: "",
      note: "Google did not return a usable Voice of Merchant state.",
    };
  }

  if (voice.hasVoiceOfMerchant === true) {
    return {
      status: "verified",
      recommendedAction: "",
      note: "Google reports hasVoiceOfMerchant=true (good standing / control). This does not claim the listing is publicly visible on Search or Maps.",
    };
  }

  let recommendedAction = "";
  if (voice.verify) recommendedAction = "verify";
  else if (voice.waitForVoiceOfMerchant)
    recommendedAction = "waitForVoiceOfMerchant";
  else if (voice.resolveOwnershipConflict)
    recommendedAction = "resolveOwnershipConflict";
  else if (voice.complyWithGuidelines)
    recommendedAction = "complyWithGuidelines";

  const latestState = String(input.latestVerification?.state || "").toUpperCase();

  if (voice.verify?.hasPendingVerification === true || latestState === "PENDING") {
    return {
      status: "pending",
      recommendedAction: recommendedAction || "verify",
      note: "A verification is pending. Complete it with the PIN when Google delivers one (non-AUTO methods).",
    };
  }

  if (latestState === "FAILED") {
    return {
      status: "failed",
      recommendedAction: recommendedAction || "verify",
      note: "Google reported the latest verification attempt as FAILED.",
    };
  }

  if (recommendedAction === "waitForVoiceOfMerchant") {
    return {
      status: "pending",
      recommendedAction,
      note: "Google asks to wait while the location is under review for Voice of Merchant.",
    };
  }

  if (recommendedAction === "verify") {
    return {
      status: "unverified",
      recommendedAction,
      note: "Google indicates verification is required (hasVoiceOfMerchant is not true).",
    };
  }

  if (
    recommendedAction === "resolveOwnershipConflict" ||
    recommendedAction === "complyWithGuidelines"
  ) {
    return {
      status: "unverified",
      recommendedAction,
      note: `Google recommends action "${recommendedAction}" before Voice of Merchant can be gained.`,
    };
  }

  if (voice.hasVoiceOfMerchant === false) {
    return {
      status: "unverified",
      recommendedAction: "",
      note: "Google reports hasVoiceOfMerchant=false without a clearer recommended action.",
    };
  }

  return {
    status: "unknown",
    recommendedAction: "",
    note: "Voice of Merchant response was inconclusive; status left unknown.",
  };
}

export async function getVoiceOfMerchantState(
  locationName: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch
): Promise<VoiceOfMerchantState> {
  const name = toVerificationsLocationName(locationName);
  if (!name) {
    throw new VerificationServiceError(
      "Invalid Google location resource for verification.",
      { code: "invalid_location_name", status: 400 }
    );
  }
  const url = buildUrl(VERIFICATIONS_BASE, `${name}/VoiceOfMerchantState`);
  return googleApiGetJson<VoiceOfMerchantState>(url, accessToken, fetchImpl);
}

export async function fetchVerificationOptionsFromGoogle(input: {
  locationName: string;
  languageCode: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<SafeVerificationOption[]> {
  const name = toVerificationsLocationName(input.locationName);
  if (!name) {
    throw new VerificationServiceError(
      "Invalid Google location resource for verification.",
      { code: "invalid_location_name", status: 400 }
    );
  }
  const languageCode = String(input.languageCode || "").trim();
  if (!languageCode) {
    throw new VerificationServiceError("languageCode is required.", {
      code: "missing_language_code",
      status: 400,
    });
  }
  const url = buildUrl(
    VERIFICATIONS_BASE,
    `${name}:fetchVerificationOptions`
  );
  // fetchVerificationOptions is not safely retryable here (no requestId).
  const data = await googleApiPostJson<{ options?: VerificationOption[] }>(
    url,
    input.accessToken,
    { languageCode },
    input.fetchImpl || fetch,
    { retry: false }
  );
  return sanitizeVerificationOptions(data.options);
}

export async function listVerificationsFromGoogle(input: {
  locationName: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleVerification[]> {
  const name = toVerificationsLocationName(input.locationName);
  if (!name) {
    throw new VerificationServiceError(
      "Invalid Google location resource for verification.",
      { code: "invalid_location_name", status: 400 }
    );
  }
  const url = buildUrl(VERIFICATIONS_BASE, `${name}/verifications`, {
    pageSize: 20,
  });
  const data = await googleApiGetJson<{
    verifications?: GoogleVerification[];
  }>(url, input.accessToken, input.fetchImpl || fetch);
  return data.verifications || [];
}

export type StartVerificationInput = {
  method: VerificationMethod;
  languageCode?: string;
  /** EMAIL — must be an address Google returned in options (per docs). */
  emailAddress?: string;
  /** ADDRESS — contact name for postcard. */
  mailerContact?: string;
  /** PHONE_CALL / SMS — must be a number from options. */
  phoneNumber?: string;
  /** VETTED_PARTNER token string when required. */
  tokenString?: string;
  /**
   * High-entropy key for one start attempt (required).
   * Reuse after recoverable failures — never mint a new key for the same submit.
   */
  idempotencyKey?: string;
};

export type StartVerificationResult = {
  verification: GoogleVerification;
  snapshot: VerificationSnapshot;
  reusedIdempotentResult?: boolean;
};

function parseStartVerificationResult(
  raw: unknown
): StartVerificationResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as StartVerificationResult;
  if (!r.verification || !r.snapshot?.locationId) return null;
  return r;
}

/** True when a Google verification attempt is still outstanding for this location. */
export function locationHasPendingVerificationAttempt(doc: {
  verificationStatus?: string | null;
  latestVerificationState?: string | null;
  latestVerificationName?: string | null;
}): boolean {
  const state = String(doc.latestVerificationState || "").toUpperCase();
  if (state === "PENDING") return true;
  if (
    doc.verificationStatus === "pending" &&
    String(doc.latestVerificationName || "").trim()
  ) {
    return true;
  }
  return false;
}

/** Build locations.verify body from official REST RequestData union. */
export function buildVerifyRequestBody(
  input: StartVerificationInput
): Record<string, unknown> {
  if (!isVerificationMethod(input.method)) {
    throw new VerificationServiceError("Unsupported verification method.", {
      code: "invalid_method",
      status: 400,
    });
  }
  const body: Record<string, unknown> = { method: input.method };
  const languageCode = String(input.languageCode || "").trim();
  if (languageCode) body.languageCode = languageCode;

  if (input.method === "EMAIL") {
    const emailAddress = String(input.emailAddress || "").trim();
    if (emailAddress) body.emailAddress = emailAddress;
  } else if (input.method === "ADDRESS") {
    const mailerContact = String(input.mailerContact || "").trim();
    if (mailerContact) body.mailerContact = mailerContact;
  } else if (input.method === "PHONE_CALL" || input.method === "SMS") {
    const phoneNumber = String(input.phoneNumber || "").trim();
    if (phoneNumber) body.phoneNumber = phoneNumber;
  } else if (input.method === "VETTED_PARTNER") {
    const tokenString = String(input.tokenString || "").trim();
    if (tokenString) body.token = { tokenString };
  }
  // AUTO: no RequestData
  return body;
}

export async function startVerificationOnGoogle(input: {
  locationName: string;
  accessToken: string;
  start: StartVerificationInput;
  fetchImpl?: FetchLike;
}): Promise<GoogleVerification> {
  const name = toVerificationsLocationName(input.locationName);
  if (!name) {
    throw new VerificationServiceError(
      "Invalid Google location resource for verification.",
      { code: "invalid_location_name", status: 400 }
    );
  }
  const url = buildUrl(VERIFICATIONS_BASE, `${name}:verify`);
  // Starting verification must not be auto-retried (side-effecting POST).
  const data = await googleApiPostJson<{ verification?: GoogleVerification }>(
    url,
    input.accessToken,
    buildVerifyRequestBody(input.start),
    input.fetchImpl || fetch,
    { retry: false }
  );
  if (!data.verification) {
    throw new VerificationServiceError(
      "Google verify response did not include a verification resource.",
      { code: "invalid_google_response", status: 502 }
    );
  }
  return data.verification;
}

export async function completeVerificationOnGoogle(input: {
  verificationName: string;
  pin: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleVerification> {
  const name = String(input.verificationName || "").trim();
  if (!/^locations\/[^/]+\/verifications\/[^/]+$/.test(name)) {
    throw new VerificationServiceError(
      "Invalid verification resource name.",
      { code: "invalid_verification_name", status: 400 }
    );
  }
  const pin = String(input.pin || "").trim();
  if (!pin) {
    throw new VerificationServiceError("PIN is required to complete verification.", {
      code: "missing_pin",
      status: 400,
    });
  }
  const url = buildUrl(VERIFICATIONS_BASE, `${name}:complete`);
  // Completing verification must not be auto-retried (side-effecting POST).
  const data = await googleApiPostJson<{ verification?: GoogleVerification }>(
    url,
    input.accessToken,
    { pin },
    input.fetchImpl || fetch,
    { retry: false }
  );
  if (!data.verification) {
    throw new VerificationServiceError(
      "Google complete response did not include a verification resource.",
      { code: "invalid_google_response", status: 502 }
    );
  }
  return data.verification;
}

export type VerificationSnapshot = {
  locationId: string;
  businessInfoName: string;
  verificationStatus: LocationVerificationStatus;
  verificationLastCheckedAt: string | null;
  verificationHasVoiceOfMerchant: boolean | null;
  verificationHasBusinessAuthority: boolean | null;
  verificationRecommendedAction: string;
  latestVerificationName: string;
  latestVerificationMethod: string;
  latestVerificationState: string;
  verificationLastError: string;
  note: string;
  /** Explicit product disclaimer. */
  publicVisibilityClaim: false;
};

function toSnapshot(
  doc: {
    _id: mongoose.Types.ObjectId;
    businessInfoName: string;
    verificationStatus?: string | null;
    verificationLastCheckedAt?: Date | null;
    verificationHasVoiceOfMerchant?: boolean | null;
    verificationHasBusinessAuthority?: boolean | null;
    verificationRecommendedAction?: string | null;
    latestVerificationName?: string | null;
    latestVerificationMethod?: string | null;
    latestVerificationState?: string | null;
    verificationLastError?: string | null;
  },
  note: string
): VerificationSnapshot {
  const status = isLocationVerificationStatus(doc.verificationStatus)
    ? doc.verificationStatus
    : "unknown";
  return {
    locationId: String(doc._id),
    businessInfoName: doc.businessInfoName,
    verificationStatus: status,
    verificationLastCheckedAt: doc.verificationLastCheckedAt
      ? new Date(doc.verificationLastCheckedAt).toISOString()
      : null,
    verificationHasVoiceOfMerchant:
      typeof doc.verificationHasVoiceOfMerchant === "boolean"
        ? doc.verificationHasVoiceOfMerchant
        : null,
    verificationHasBusinessAuthority:
      typeof doc.verificationHasBusinessAuthority === "boolean"
        ? doc.verificationHasBusinessAuthority
        : null,
    verificationRecommendedAction: doc.verificationRecommendedAction || "",
    latestVerificationName: doc.latestVerificationName || "",
    latestVerificationMethod: doc.latestVerificationMethod || "",
    latestVerificationState: doc.latestVerificationState || "",
    verificationLastError: doc.verificationLastError || "",
    note,
    publicVisibilityClaim: false,
  };
}

async function loadOrgLocation(orgId: string, locationId: string) {
  if (!mongoose.isValidObjectId(orgId) || !mongoose.isValidObjectId(locationId)) {
    throw new VerificationServiceError("Invalid organization or location id.", {
      code: "invalid_id",
      status: 400,
    });
  }
  await connectToDatabase();
  const doc = await Location.findOne({ _id: locationId, orgId });
  if (!doc) {
    throw new VerificationServiceError("Location not found in this organization.", {
      code: "not_found",
      status: 404,
    });
  }
  return doc;
}

export async function getStoredVerificationSnapshot(
  orgId: string,
  locationId: string
): Promise<VerificationSnapshot> {
  const doc = await loadOrgLocation(orgId, locationId);
  return toSnapshot(doc, "Stored verification status (not refreshed from Google).");
}

/**
 * Refresh from getVoiceOfMerchantState + verifications.list and persist.
 */
export async function refreshLocationVerificationStatus(
  orgId: string,
  locationId: string,
  fetchImpl: FetchLike = fetch
): Promise<VerificationSnapshot> {
  const doc = await loadOrgLocation(orgId, locationId);
  const accessToken = await getValidAccessTokenForOrg(orgId, fetchImpl);
  const locationName = doc.businessInfoName;

  let voice: VoiceOfMerchantState | null = null;
  let latest: GoogleVerification | null = null;
  let errorMessage = "";

  try {
    voice = await getVoiceOfMerchantState(
      locationName,
      accessToken,
      fetchImpl
    );
  } catch (err) {
    if (err instanceof GoogleBusinessApiError) throw err;
    throw err;
  }

  try {
    const list = await listVerificationsFromGoogle({
      locationName,
      accessToken,
      fetchImpl,
    });
    // Docs say ordered by createTime but not asc/desc — pick max createTime when present.
    if (list.length) {
      latest = [...list].sort((a, b) => {
        const ta = Date.parse(a.createTime || "") || 0;
        const tb = Date.parse(b.createTime || "") || 0;
        return ta - tb;
      })[list.length - 1];
    }
  } catch (err) {
    // Voice succeeded but list failed — still derive from voice alone.
    errorMessage =
      err instanceof Error
        ? err.message.slice(0, 300)
        : "Could not list verifications";
  }

  const derived = deriveVerificationStatus({
    voice,
    latestVerification: latest,
  });

  const now = new Date();
  doc.verificationStatus = derived.status;
  doc.verificationLastCheckedAt = now;
  doc.verificationHasVoiceOfMerchant =
    typeof voice.hasVoiceOfMerchant === "boolean"
      ? voice.hasVoiceOfMerchant
      : null;
  doc.verificationHasBusinessAuthority =
    typeof voice.hasBusinessAuthority === "boolean"
      ? voice.hasBusinessAuthority
      : null;
  doc.verificationRecommendedAction = derived.recommendedAction;
  doc.latestVerificationName = latest?.name || doc.latestVerificationName || "";
  doc.latestVerificationMethod =
    latest?.method || doc.latestVerificationMethod || "";
  doc.latestVerificationState =
    latest?.state || doc.latestVerificationState || "";
  doc.verificationLastError = errorMessage;
  await doc.save();

  return toSnapshot(doc, derived.note);
}

export async function fetchOptionsForLocation(
  orgId: string,
  locationId: string,
  languageCode: string,
  fetchImpl: FetchLike = fetch
): Promise<{
  options: SafeVerificationOption[];
  languageCode: string;
  locationName: string;
}> {
  const doc = await loadOrgLocation(orgId, locationId);
  const accessToken = await getValidAccessTokenForOrg(orgId, fetchImpl);
  const options = await fetchVerificationOptionsFromGoogle({
    locationName: doc.businessInfoName,
    languageCode,
    accessToken,
    fetchImpl,
  });
  return {
    options,
    languageCode: String(languageCode || "").trim(),
    locationName: toVerificationsLocationName(doc.businessInfoName) || "",
  };
}

export async function startVerificationForLocation(
  orgId: string,
  locationId: string,
  start: StartVerificationInput,
  fetchImpl: FetchLike = fetch
): Promise<StartVerificationResult> {
  const idempotencyKey = normalizeIdempotencyKey(start.idempotencyKey);
  if (!idempotencyKey) {
    throw new VerificationServiceError(
      "idempotencyKey is required (16–128 URL-safe characters) for one verification start attempt.",
      { code: "missing_idempotency_key", status: 400 }
    );
  }

  const doc = await loadOrgLocation(orgId, locationId);

  const payloadHash = hashIdempotencyPayload({
    locationId,
    method: start.method,
    languageCode: String(start.languageCode || "").trim(),
    emailAddress: String(start.emailAddress || "").trim(),
    mailerContact: String(start.mailerContact || "").trim(),
    phoneNumber: String(start.phoneNumber || "").trim(),
    // Never hash raw partner tokens — presence only.
    hasToken: Boolean(String(start.tokenString || "").trim()),
  });

  let claim;
  try {
    claim = await claimIdempotencySlot<StartVerificationResult>({
      orgId,
      operation: "gbp.verification.start",
      scopeId: locationId,
      key: idempotencyKey,
      payloadHash,
      parseResult: parseStartVerificationResult,
    });
  } catch (err) {
    if (err instanceof IdempotencyClaimError) {
      throw new VerificationServiceError(err.message, {
        code: err.code,
        status: err.status,
      });
    }
    throw err;
  }

  if (claim.kind === "replay") {
    return { ...claim.result, reusedIdempotentResult: true };
  }

  // Block a new Google :verify when an attempt is already pending (any key).
  if (locationHasPendingVerificationAttempt(doc)) {
    await markIdempotencyFailed({
      recordId: claim.recordId,
      code: "verification_already_pending",
      message: "A verification attempt is already pending for this location.",
    });
    throw new VerificationServiceError(
      "A verification attempt is already pending for this location. Wait for it to complete, submit a PIN if required, or refresh status — do not start another Google verification.",
      { code: "verification_already_pending", status: 409 }
    );
  }

  try {
    const accessToken = await getValidAccessTokenForOrg(orgId, fetchImpl);
    const verification = await startVerificationOnGoogle({
      locationName: doc.businessInfoName,
      accessToken,
      start,
      fetchImpl,
    });

    doc.latestVerificationName = verification.name || "";
    doc.latestVerificationMethod = verification.method || start.method;
    doc.latestVerificationState = verification.state || "";
    if (String(verification.state || "").toUpperCase() === "PENDING") {
      doc.verificationStatus = "pending";
    } else if (String(verification.state || "").toUpperCase() === "FAILED") {
      doc.verificationStatus = "failed";
    } else if (String(verification.state || "").toUpperCase() === "COMPLETED") {
      // COMPLETED verification attempt ≠ Voice of Merchant; refresh for truth.
      doc.verificationStatus = "pending";
    }
    doc.verificationRecommendedAction = "verify";
    doc.verificationLastError = "";
    await doc.save();

    // Refresh VoM so AUTO / immediate COMPLETED paths update accurately.
    // verified is only set when Voice of Merchant supports it (deriveVerificationStatus).
    let snapshot: VerificationSnapshot;
    try {
      snapshot = await refreshLocationVerificationStatus(
        orgId,
        locationId,
        fetchImpl
      );
    } catch {
      snapshot = toSnapshot(
        doc,
        "Verification started. Refresh status if Voice of Merchant check fails."
      );
    }

    const result: StartVerificationResult = {
      verification,
      snapshot,
      reusedIdempotentResult: false,
    };
    await markIdempotencySucceeded({
      recordId: claim.recordId,
      result,
    });
    return result;
  } catch (err) {
    const code =
      err instanceof VerificationServiceError ||
      err instanceof GoogleBusinessApiError
        ? err.code
        : "start_failed";
    const message =
      err instanceof Error ? err.message : "Could not start verification";
    await markIdempotencyFailed({
      recordId: claim.recordId,
      code,
      message,
    });
    throw err;
  }
}

export async function completeVerificationForLocation(
  orgId: string,
  locationId: string,
  input: { verificationName?: string; pin: string },
  fetchImpl: FetchLike = fetch
): Promise<{
  verification: GoogleVerification;
  snapshot: VerificationSnapshot;
}> {
  const doc = await loadOrgLocation(orgId, locationId);
  const verificationName =
    String(input.verificationName || "").trim() ||
    String(doc.latestVerificationName || "").trim();
  if (!verificationName) {
    throw new VerificationServiceError(
      "No pending verification resource name is stored. Refresh status or start verification first.",
      { code: "missing_verification_name", status: 400 }
    );
  }

  const accessToken = await getValidAccessTokenForOrg(orgId, fetchImpl);
  const verification = await completeVerificationOnGoogle({
    verificationName,
    pin: input.pin,
    accessToken,
    fetchImpl,
  });

  doc.latestVerificationName = verification.name || verificationName;
  doc.latestVerificationMethod =
    verification.method || doc.latestVerificationMethod || "";
  doc.latestVerificationState = verification.state || "";
  doc.verificationLastError = "";
  await doc.save();

  const snapshot = await refreshLocationVerificationStatus(
    orgId,
    locationId,
    fetchImpl
  );
  return { verification, snapshot };
}
