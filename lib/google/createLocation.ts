/**
 * Super Admin GBP location creation via Business Information API
 * accounts.locations.create.
 *
 * Does not call verification APIs. Does not assign locations to businesses.
 * Persists a local Location only after Google returns a successful create.
 */

import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { getValidAccessTokenForOrg } from "@/lib/google/accessToken";
import {
  BUSINESS_INFORMATION_BASE,
  buildUrl,
  googleApiPostJson,
} from "@/lib/google/gbpClient";
import {
  accountIdFromAccountName,
  formatAddress,
  listAllAccounts,
  toReviewsLocationName,
  type GbpLocation,
} from "@/lib/google/gbpDiscovery";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import {
  CreateLocationValidationError,
  validatePrimaryCategoryName,
  validateStorefrontAddress,
} from "@/lib/google/createLocationValidation";
import { toLocationSummary, type SyncedLocationSummary } from "@/lib/google/syncLocations";
import { GbpCreateLocationRequest } from "@/models/GbpCreateLocationRequest";
import { Location } from "@/models/Location";

type FetchLike = typeof fetch;

/** Verification was not queried in this phase — do not claim verified/public. */
export type CreateLocationVerificationStatus = "unknown";

export type CreateGbpLocationInput = {
  orgId: string;
  createdByUserId: string;
  /** accounts/{accountId} — must be selected explicitly by Super Admin. */
  googleAccountName: string;
  /**
   * Idempotency key forwarded to Google as requestId (max 50 chars).
   * UUID recommended per Google docs.
   */
  requestId: string;
  title: string;
  /** Immutable after create (Google). Examples: en, en-US, en-AU. */
  languageCode: string;
  storeCode?: string;
  websiteUri?: string;
  primaryPhone?: string;
  /** Category resource, e.g. gcid:software_company */
  primaryCategoryName?: string;
  storefrontAddress?: {
    addressLines?: string[];
    locality?: string;
    administrativeArea?: string;
    postalCode?: string;
    regionCode?: string;
  };
};

export type CreatedGbpLocationResult = {
  location: SyncedLocationSummary & {
    businessId: string | null;
    businessInfoName: string;
    placeId: string;
  };
  googleAccountName: string;
  googleLocationName: string;
  businessInfoName: string;
  /** Always unknown until a verification integration exists. */
  verificationStatus: CreateLocationVerificationStatus;
  verificationNote: string;
  reusedIdempotentResult: boolean;
};

export class CreateGbpLocationError extends Error {
  code: string;
  status: number;
  fieldIssues?: Array<{ field: string; message: string }>;

  constructor(
    message: string,
    {
      code = "create_failed",
      status = 400,
      fieldIssues,
    }: {
      code?: string;
      status?: number;
      fieldIssues?: Array<{ field: string; message: string }>;
    } = {}
  ) {
    super(message);
    this.name = "CreateGbpLocationError";
    this.code = code;
    this.status = status;
    this.fieldIssues = fieldIssues;
  }
}

const REQUEST_ID_MAX = 50;

export function validateCreateGbpLocationInput(
  raw: CreateGbpLocationInput
): CreateGbpLocationInput {
  if (!mongoose.isValidObjectId(raw.orgId)) {
    throw new CreateGbpLocationError("Invalid organization.", {
      code: "invalid_org",
      status: 400,
    });
  }
  if (!mongoose.isValidObjectId(raw.createdByUserId)) {
    throw new CreateGbpLocationError("Invalid user.", {
      code: "invalid_user",
      status: 400,
    });
  }

  const requestId = String(raw.requestId || "").trim();
  if (!requestId || requestId.length > REQUEST_ID_MAX) {
    throw new CreateGbpLocationError(
      `requestId is required (1–${REQUEST_ID_MAX} characters). Use a UUID.`,
      { code: "invalid_request_id", status: 400 }
    );
  }

  const googleAccountName = String(raw.googleAccountName || "").trim();
  if (!accountIdFromAccountName(googleAccountName)) {
    throw new CreateGbpLocationError(
      "Select a Google account resource in the form accounts/{accountId}.",
      { code: "invalid_account", status: 400 }
    );
  }

  const title = String(raw.title || "").trim();
  if (!title) {
    throw new CreateGbpLocationError("title is required.", {
      code: "missing_title",
      status: 400,
    });
  }

  const languageCode = String(raw.languageCode || "").trim();
  if (!languageCode) {
    throw new CreateGbpLocationError(
      "languageCode is required (set at creation and immutable thereafter).",
      { code: "missing_language_code", status: 400 }
    );
  }

  const storeCode = String(raw.storeCode || "").trim();
  const websiteUri = String(raw.websiteUri || "").trim();
  const primaryPhone = String(raw.primaryPhone || "").trim();

  let primaryCategoryName: string | undefined;
  let storefrontAddress: CreateGbpLocationInput["storefrontAddress"];
  try {
    primaryCategoryName = validatePrimaryCategoryName(raw.primaryCategoryName);
    storefrontAddress = validateStorefrontAddress(raw.storefrontAddress);
  } catch (err) {
    if (err instanceof CreateLocationValidationError) {
      throw new CreateGbpLocationError(err.message, {
        code: err.code,
        status: err.status,
        fieldIssues: err.fieldIssues,
      });
    }
    throw err;
  }

  return {
    orgId: raw.orgId,
    createdByUserId: raw.createdByUserId,
    googleAccountName,
    requestId,
    title,
    languageCode,
    ...(storeCode ? { storeCode } : {}),
    ...(websiteUri ? { websiteUri } : {}),
    ...(primaryPhone ? { primaryPhone } : {}),
    ...(primaryCategoryName ? { primaryCategoryName } : {}),
    ...(storefrontAddress ? { storefrontAddress } : {}),
  };
}

/** Build Google Location body from validated input (only documented fields). */
export function buildGoogleLocationBody(
  input: CreateGbpLocationInput
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: input.title,
    languageCode: input.languageCode,
  };
  if (input.storeCode) body.storeCode = input.storeCode;
  if (input.websiteUri) body.websiteUri = input.websiteUri;
  if (input.primaryPhone) {
    body.phoneNumbers = { primaryPhone: input.primaryPhone };
  }
  if (input.primaryCategoryName) {
    body.categories = {
      primaryCategory: { name: input.primaryCategoryName },
    };
  }
  if (input.storefrontAddress) {
    body.storefrontAddress = input.storefrontAddress;
  }
  return body;
}

async function assertAccountAccessible(
  accessToken: string,
  googleAccountName: string,
  fetchImpl: FetchLike
): Promise<void> {
  const accounts = await listAllAccounts(accessToken, fetchImpl);
  const match = accounts.some((a) => a.name === googleAccountName);
  if (!match) {
    throw new CreateGbpLocationError(
      "Selected Google account is not available on the connected Google connection. Discover accounts and choose one explicitly.",
      { code: "account_not_available", status: 400 }
    );
  }
}

type PersistableGoogleLocation = {
  businessInfoName: string;
  googleLocationName: string;
  title: string;
  storeCode: string;
  address: string;
  placeId: string;
};

function resolveNamesFromGoogleCreate(input: {
  googleAccountName: string;
  created: GbpLocation;
}): PersistableGoogleLocation {
  const businessInfoName = String(input.created.name || "").trim();
  if (!businessInfoName.startsWith("locations/")) {
    throw new CreateGbpLocationError(
      "Google create response did not include a locations/{locationId} resource name.",
      { code: "invalid_google_response", status: 502 }
    );
  }

  const googleLocationName = toReviewsLocationName(
    input.googleAccountName,
    businessInfoName
  );
  if (!googleLocationName) {
    throw new CreateGbpLocationError(
      "Could not derive accounts/{accountId}/locations/{locationId} from Google response.",
      { code: "invalid_google_response", status: 502 }
    );
  }

  return {
    businessInfoName,
    googleLocationName,
    title: input.created.title || "",
    storeCode: input.created.storeCode || "",
    address: formatAddress(input.created.storefrontAddress),
    placeId: input.created.metadata?.placeId || "",
  };
}

/**
 * Upsert local Location from known Google resource names + safe metadata.
 * Prefer this over creating a second Google location after a persist failure.
 */
export async function persistLocalLocationFromGoogleNames(input: {
  orgId: string;
  googleAccountName: string;
  googleLocationName: string;
  businessInfoName: string;
  title?: string;
  storeCode?: string;
  address?: string;
  placeId?: string;
}): Promise<{
  doc: {
    _id: mongoose.Types.ObjectId;
    title?: string | null;
    address?: string | null;
    storeCode?: string | null;
    googleLocationName: string;
    googleAccountName: string;
    businessInfoName: string;
    placeId?: string | null;
    businessId?: mongoose.Types.ObjectId | null;
    lastDiscoveryAt?: Date | null;
    lastReviewsSyncAt?: Date | null;
    lastReviewsSyncError?: string | null;
  };
}> {
  const googleLocationName = normalizeRequiredGoogleLocationName(
    input.googleLocationName
  );
  const businessInfoName = String(input.businessInfoName || "").trim();
  if (!businessInfoName.startsWith("locations/")) {
    throw new CreateGbpLocationError(
      "Cannot reconcile: missing locations/{locationId} businessInfoName.",
      { code: "reconcile_missing_names", status: 400 }
    );
  }

  const now = new Date();
  const doc = await Location.findOneAndUpdate(
    { orgId: input.orgId, googleLocationName },
    {
      $set: {
        orgId: input.orgId,
        googleAccountName: input.googleAccountName,
        googleLocationName,
        businessInfoName,
        title: input.title || "",
        storeCode: input.storeCode || "",
        address: input.address || "",
        placeId: input.placeId || "",
        lastDiscoveryAt: now,
      },
      $setOnInsert: {
        businessId: null,
        verificationStatus: "unknown",
        verificationLastCheckedAt: null,
        verificationHasVoiceOfMerchant: null,
        verificationHasBusinessAuthority: null,
        verificationRecommendedAction: "",
        latestVerificationName: "",
        latestVerificationMethod: "",
        latestVerificationState: "",
        verificationLastError: "",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );

  if (!doc) {
    throw new CreateGbpLocationError("Failed to persist local location.", {
      code: "persist_failed",
      status: 500,
    });
  }

  return { doc };
}

function normalizeRequiredGoogleLocationName(name: string): string {
  const trimmed = String(name || "").trim();
  if (!trimmed.includes("/locations/")) {
    throw new CreateGbpLocationError(
      "Cannot reconcile: missing accounts/.../locations/... resource name.",
      { code: "reconcile_missing_names", status: 400 }
    );
  }
  return trimmed;
}

/**
 * Reconcile a prior Google-successful create whose local upsert failed.
 * Does not call Google create again.
 */
export async function reconcileGbpCreateLocation(input: {
  orgId: string;
  requestId: string;
}): Promise<CreatedGbpLocationResult> {
  await connectToDatabase();
  const ledger = await GbpCreateLocationRequest.findOne({
    orgId: input.orgId,
    requestId: input.requestId,
  }).lean();

  if (!ledger) {
    throw new CreateGbpLocationError("Create request not found for reconciliation.", {
      code: "request_not_found",
      status: 404,
    });
  }

  if (ledger.status === "succeeded" && ledger.locationId) {
    const loc = await Location.findById(ledger.locationId).lean();
    if (loc) return toCreatedResult(loc, true);
  }

  if (
    ledger.status !== "google_created" &&
    !(ledger.googleLocationName && ledger.businessInfoName)
  ) {
    throw new CreateGbpLocationError(
      "This request has no Google-created location to reconcile. Do not create again with a new requestId unless Google create never succeeded.",
      { code: "reconcile_not_applicable", status: 409 }
    );
  }

  const { doc } = await persistLocalLocationFromGoogleNames({
    orgId: input.orgId,
    googleAccountName: ledger.googleAccountName,
    googleLocationName: ledger.googleLocationName,
    businessInfoName: ledger.businessInfoName,
    title: ledger.createdTitle || "",
    storeCode: ledger.createdStoreCode || "",
    address: ledger.createdAddress || "",
    placeId: ledger.createdPlaceId || "",
  });

  await GbpCreateLocationRequest.updateOne(
    { _id: ledger._id },
    {
      $set: {
        status: "succeeded",
        locationId: doc._id,
        errorCode: "",
        errorMessage: "",
      },
    }
  );

  return toCreatedResult(doc, true);
}

function toCreatedResult(
  doc: {
    _id: mongoose.Types.ObjectId;
    title?: string | null;
    address?: string | null;
    storeCode?: string | null;
    googleLocationName: string;
    googleAccountName: string;
    businessInfoName?: string | null;
    placeId?: string | null;
    businessId?: mongoose.Types.ObjectId | null;
    lastDiscoveryAt?: Date | null;
    lastReviewsSyncAt?: Date | null;
    lastReviewsSyncError?: string | null;
  },
  reusedIdempotentResult: boolean
): CreatedGbpLocationResult {
  const summary = toLocationSummary(doc);
  return {
    location: {
      ...summary,
      businessId: doc.businessId ? String(doc.businessId) : null,
      businessInfoName: doc.businessInfoName || "",
      placeId: doc.placeId || "",
    },
    googleAccountName: doc.googleAccountName,
    googleLocationName: doc.googleLocationName,
    businessInfoName: doc.businessInfoName || "",
    verificationStatus: "unknown",
    verificationNote:
      "Verification status was not queried. This listing is not claimed as verified or publicly visible by TRONX.",
    reusedIdempotentResult,
  };
}

/**
 * Create a GBP location under an explicitly selected account, then upsert locally.
 * Local Location.businessId is never set from this flow.
 * If Google succeeds but local persist fails, ledger status becomes google_created
 * so the same requestId can reconcile without a second Google create.
 */
export async function createGbpLocationForOrg(
  rawInput: CreateGbpLocationInput,
  fetchImpl: FetchLike = fetch
): Promise<CreatedGbpLocationResult> {
  const input = validateCreateGbpLocationInput(rawInput);
  await connectToDatabase();

  const existing = await GbpCreateLocationRequest.findOne({
    orgId: input.orgId,
    requestId: input.requestId,
  }).lean();

  if (existing?.status === "succeeded" && existing.locationId) {
    const loc = await Location.findById(existing.locationId).lean();
    if (loc) {
      return toCreatedResult(loc, true);
    }
  }

  // Google already created — reconcile local only (never POST create again).
  if (
    existing?.status === "google_created" ||
    (existing &&
      existing.googleLocationName &&
      existing.businessInfoName &&
      existing.status !== "failed" &&
      existing.status !== "pending")
  ) {
    return reconcileGbpCreateLocation({
      orgId: input.orgId,
      requestId: input.requestId,
    });
  }

  if (existing?.status === "pending") {
    throw new CreateGbpLocationError(
      "A create request with this requestId is already in progress.",
      { code: "duplicate_in_progress", status: 409 }
    );
  }

  if (existing?.status === "succeeded") {
    throw new CreateGbpLocationError(
      "This requestId already created a location, but the local record is missing. Retry reconciliation with the same requestId or rediscover locations — do not mint a new requestId.",
      { code: "idempotent_orphan", status: 409 }
    );
  }

  try {
    if (existing?.status === "failed") {
      // Only restart Google create when we never recorded a Google resource.
      if (existing.googleLocationName || existing.businessInfoName) {
        return reconcileGbpCreateLocation({
          orgId: input.orgId,
          requestId: input.requestId,
        });
      }
      await GbpCreateLocationRequest.updateOne(
        { _id: existing._id },
        {
          $set: {
            status: "pending",
            createdByUserId: input.createdByUserId,
            googleAccountName: input.googleAccountName,
            locationId: null,
            googleLocationName: "",
            businessInfoName: "",
            createdTitle: "",
            createdStoreCode: "",
            createdAddress: "",
            createdPlaceId: "",
            errorCode: "",
            errorMessage: "",
          },
        }
      );
    } else {
      await GbpCreateLocationRequest.create({
        orgId: input.orgId,
        requestId: input.requestId,
        createdByUserId: input.createdByUserId,
        googleAccountName: input.googleAccountName,
        status: "pending",
      });
    }
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new CreateGbpLocationError(
        "Duplicate create request. Wait for the in-progress request or reuse the prior successful result.",
        { code: "duplicate_request", status: 409 }
      );
    }
    throw err;
  }

  let googlePhaseCompleted = false;

  try {
    const accessToken = await getValidAccessTokenForOrg(
      input.orgId,
      fetchImpl
    );
    await assertAccountAccessible(
      accessToken,
      input.googleAccountName,
      fetchImpl
    );

    const url = buildUrl(
      BUSINESS_INFORMATION_BASE,
      `${input.googleAccountName}/locations`,
      { requestId: input.requestId }
    );
    const body = buildGoogleLocationBody(input);

    // Same requestId on retry — Google-side idempotent; safe to retry 429/5xx.
    const created = await googleApiPostJson<GbpLocation>(
      url,
      accessToken,
      body,
      fetchImpl,
      { retry: true }
    );

    const resolved = resolveNamesFromGoogleCreate({
      googleAccountName: input.googleAccountName,
      created,
    });

    // Mark Google success before local persist so a crash is recoverable.
    await GbpCreateLocationRequest.updateOne(
      { orgId: input.orgId, requestId: input.requestId },
      {
        $set: {
          status: "google_created",
          googleLocationName: resolved.googleLocationName,
          businessInfoName: resolved.businessInfoName,
          createdTitle: resolved.title,
          createdStoreCode: resolved.storeCode,
          createdAddress: resolved.address,
          createdPlaceId: resolved.placeId,
          errorCode: "",
          errorMessage: "",
        },
      }
    );
    googlePhaseCompleted = true;

    let doc;
    try {
      const persisted = await persistLocalLocationFromGoogleNames({
        orgId: input.orgId,
        googleAccountName: input.googleAccountName,
        googleLocationName: resolved.googleLocationName,
        businessInfoName: resolved.businessInfoName,
        title: resolved.title,
        storeCode: resolved.storeCode,
        address: resolved.address,
        placeId: resolved.placeId,
      });
      doc = persisted.doc;
    } catch (persistErr) {
      const message =
        persistErr instanceof Error
          ? persistErr.message
          : "Local persistence failed after Google create";
      await GbpCreateLocationRequest.updateOne(
        { orgId: input.orgId, requestId: input.requestId },
        {
          $set: {
            status: "google_created",
            errorCode: "persist_failed_needs_reconcile",
            errorMessage: message.slice(0, 500),
          },
        }
      );
      throw new CreateGbpLocationError(
        "Google created the location, but saving it in TRONX failed. The Google listing may already exist. Retry with the same requestId to reconcile the local record — do not create again with a new requestId.",
        { code: "persist_failed_needs_reconcile", status: 500 }
      );
    }

    await GbpCreateLocationRequest.updateOne(
      { orgId: input.orgId, requestId: input.requestId },
      {
        $set: {
          status: "succeeded",
          locationId: doc._id,
          googleLocationName: resolved.googleLocationName,
          businessInfoName: resolved.businessInfoName,
          errorCode: "",
          errorMessage: "",
        },
      }
    );

    return toCreatedResult(doc, false);
  } catch (err) {
    if (
      err instanceof CreateGbpLocationError &&
      err.code === "persist_failed_needs_reconcile"
    ) {
      throw err;
    }

    const code =
      err instanceof CreateGbpLocationError
        ? err.code
        : err instanceof GoogleBusinessApiError
          ? err.code
          : "create_failed";
    const message =
      err instanceof Error ? err.message : "Location create failed";

    if (!googlePhaseCompleted) {
      await GbpCreateLocationRequest.updateOne(
        { orgId: input.orgId, requestId: input.requestId },
        {
          $set: {
            status: "failed",
            errorCode: code,
            errorMessage: message.slice(0, 500),
            locationId: null,
            // Clear only when Google create itself did not succeed.
            googleLocationName: "",
            businessInfoName: "",
            createdTitle: "",
            createdStoreCode: "",
            createdAddress: "",
            createdPlaceId: "",
          },
        }
      );
    }

    throw err;
  }
}

export async function listGoogleAccountsForOrg(
  orgId: string,
  fetchImpl: FetchLike = fetch
): Promise<Array<{ name: string; accountName: string; type: string }>> {
  if (!mongoose.isValidObjectId(orgId)) {
    throw new CreateGbpLocationError("Invalid organization.", {
      code: "invalid_org",
      status: 400,
    });
  }
  const accessToken = await getValidAccessTokenForOrg(orgId, fetchImpl);
  const accounts = await listAllAccounts(accessToken, fetchImpl);
  return accounts
    .filter((a) => a.name?.startsWith("accounts/"))
    .map((a) => ({
      name: a.name,
      accountName: a.accountName || "",
      type: a.type || "",
    }));
}
