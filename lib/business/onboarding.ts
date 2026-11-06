/**
 * Super Admin business ↔ group ↔ Google location onboarding.
 * Relationships are always explicit — never inferred from name/address/org.
 * Ownership writes run in a MongoDB transaction (fail closed if unsupported).
 */

import mongoose from "mongoose";
import { LocationAssignmentError } from "@/lib/business/assignLocations";
import { assertLocationMovable } from "@/lib/business/reassignLocation";
import {
  clearReviewBusinessIdsForLocations,
  syncReviewBusinessIdsForLocations,
} from "@/lib/business/stats";
import { defaultPlanFields, isPlanCode } from "@/lib/entitlements/plans";
import {
  GroupMembershipError,
  refreshOwnersForBusinessGroupChange,
  setBusinessGroup,
} from "@/lib/groups/membership";
import { normalizeGoogleLocationName } from "@/lib/location/identity";
import {
  hashIdempotencyPayload,
  normalizeIdempotencyKey,
} from "@/lib/idempotency/keys";
import {
  claimOnboardingIdempotency,
  isOnboardingIdempotencyError,
  markOnboardingIdempotencyFailed,
  markOnboardingIdempotencySucceeded,
} from "@/lib/idempotency/onboardingClaim";
import {
  isMongoDuplicateKeyError,
  MongoTransactionError,
  withMongoTransaction,
} from "@/lib/mongo/transactions";
import { connectToDatabase } from "@/lib/mongodb";
import { Business, BRAND_VOICES, REPLY_MODES } from "@/models/Business";
import { BusinessGroup } from "@/models/BusinessGroup";
import { GoogleConnection } from "@/models/GoogleConnection";
import { Location } from "@/models/Location";
import { Organization } from "@/models/Organization";

export type OnboardingInput = {
  /** Must be true — review/confirm gate. */
  confirm: boolean;
  name: string;
  locationId: string;
  groupId: string;
  /**
   * High-entropy key for one onboarding attempt (required).
   * Reuse the same key for retries of the same attempt — never mint a new key
   * after a failure for the same logical submit.
   */
  idempotencyKey: string;
  /** Required when the selected location is already assigned elsewhere. */
  confirmReassign?: boolean;
  replyMode?: string;
  brandVoice?: string;
  preferredLanguage?: string;
  planCode?: string;
};

export type OnboardingResult = {
  business: {
    id: string;
    name: string;
    orgId: string;
    groupId: string | null;
    locationIds: string[];
    googleLocationNames: string[];
  };
  group: {
    id: string;
    name: string;
  } | null;
  location: {
    id: string;
    title: string;
    address: string;
    googleLocationName: string;
    businessInfoName: string;
    businessId: string;
    verificationStatus: string;
  };
  reassignedFrom: {
    businessId: string;
    businessName: string;
  } | null;
  /** True when a prior succeeded attempt was returned for the same key+payload. */
  reusedIdempotentResult?: boolean;
};

export class OnboardingError extends Error {
  code: string;
  status: number;
  conflict?: {
    currentBusinessId: string;
    currentBusinessName: string;
    currentGroupId: string | null;
  };

  constructor(
    message: string,
    opts: {
      code: string;
      status: number;
      conflict?: OnboardingError["conflict"];
    }
  ) {
    super(message);
    this.name = "OnboardingError";
    this.code = opts.code;
    this.status = opts.status;
    this.conflict = opts.conflict;
  }
}

function mapAssignmentError(err: LocationAssignmentError): OnboardingError {
  return new OnboardingError(err.message, {
    code: err.code,
    status: err.status,
  });
}

/**
 * Create a business, assign one Google location, and set group — only after confirm.
 * Location is never detached before the transaction can commit.
 */
export async function completeBusinessOnboarding(
  raw: OnboardingInput
): Promise<OnboardingResult> {
  if (raw.confirm !== true) {
    throw new OnboardingError(
      "Set confirm=true after reviewing the business, group, and Google location assignment.",
      { code: "confirmation_required", status: 400 }
    );
  }

  const name = String(raw.name || "").trim();
  if (!name) {
    throw new OnboardingError("Business name is required.", {
      code: "missing_name",
      status: 400,
    });
  }

  const locationId = String(raw.locationId || "").trim();
  const groupId = String(raw.groupId || "").trim();
  if (!mongoose.isValidObjectId(locationId)) {
    throw new OnboardingError("Select a valid Google location.", {
      code: "invalid_location_id",
      status: 400,
    });
  }
  if (!mongoose.isValidObjectId(groupId)) {
    throw new OnboardingError("Select a valid business group.", {
      code: "invalid_group_id",
      status: 400,
    });
  }

  const replyMode = REPLY_MODES.includes(raw.replyMode as never)
    ? (raw.replyMode as (typeof REPLY_MODES)[number])
    : "manual";
  const brandVoice = BRAND_VOICES.includes(raw.brandVoice as never)
    ? (raw.brandVoice as (typeof BRAND_VOICES)[number])
    : "friendly";
  const preferredLanguage =
    String(raw.preferredLanguage || "English").trim() || "English";
  const planCode = isPlanCode(raw.planCode) ? raw.planCode : "starter";
  const confirmReassign = raw.confirmReassign === true;
  const idempotencyKey = normalizeIdempotencyKey(raw.idempotencyKey);
  if (!idempotencyKey) {
    throw new OnboardingError(
      "idempotencyKey is required (16–128 URL-safe characters) for one onboarding attempt.",
      { code: "missing_idempotency_key", status: 400 }
    );
  }

  await connectToDatabase();

  const location = await Location.findById(locationId)
    .select(
      "orgId businessId googleLocationName businessInfoName title address verificationStatus"
    )
    .lean();
  if (!location) {
    throw new OnboardingError(
      "Location not found. Discover or create a Google location first.",
      { code: "location_not_found", status: 404 }
    );
  }

  const googleLocationName = normalizeGoogleLocationName(
    location.googleLocationName
  );
  if (!googleLocationName) {
    throw new OnboardingError(
      "Location cache row is missing a valid Google location resource name.",
      { code: "invalid_google_location_name", status: 400 }
    );
  }

  const orgId = String(location.orgId);
  const org = await Organization.findById(orgId).select("_id").lean();
  if (!org) {
    throw new OnboardingError(
      "The location's organization no longer exists.",
      { code: "org_missing", status: 400 }
    );
  }

  const group = await BusinessGroup.findById(groupId)
    .select("name orgId active")
    .lean();
  if (!group) {
    throw new OnboardingError("Group not found.", {
      code: "group_not_found",
      status: 404,
    });
  }
  if (String(group.orgId) !== orgId) {
    throw new OnboardingError(
      "Group and Google location must share the same organization workspace. Selection is explicit — not inferred from names.",
      { code: "org_mismatch", status: 400 }
    );
  }
  if (group.active === false) {
    throw new OnboardingError("Cannot assign a business to an inactive group.", {
      code: "group_inactive",
      status: 400,
    });
  }

  const connection = await GoogleConnection.findOne({
    orgId,
    status: { $in: ["active", "error"] },
    businessId: null,
  })
    .select("status")
    .lean();
  if (!connection || connection.status !== "active") {
    throw new OnboardingError(
      "No active Google connection for this location's organization.",
      { code: "connection_unavailable", status: 400 }
    );
  }

  // Pre-flight (no writes). Surfaces 409 before starting a transaction.
  try {
    await assertLocationMovable({
      locationId,
      confirmReassign,
    });
  } catch (err) {
    if (err instanceof LocationAssignmentError) {
      if (err.code === "location_already_assigned") {
        const conflict = await Location.findById(locationId)
          .select("businessId")
          .lean();
        const prevBiz = conflict?.businessId
          ? await Business.findById(conflict.businessId)
              .select("name groupId")
              .lean()
          : null;
        throw new OnboardingError(err.message, {
          code: err.code,
          status: err.status,
          conflict: prevBiz
            ? {
                currentBusinessId: String(conflict!.businessId),
                currentBusinessName: prevBiz.name || "another business",
                currentGroupId: prevBiz.groupId
                  ? String(prevBiz.groupId)
                  : null,
              }
            : undefined,
        });
      }
      throw mapAssignmentError(err);
    }
    throw err;
  }

  const payloadHash = hashIdempotencyPayload({
    name,
    locationId,
    groupId,
    confirmReassign,
    replyMode,
    brandVoice,
    preferredLanguage,
    planCode,
  });

  let claim;
  try {
    claim = await claimOnboardingIdempotency({
      orgId,
      key: idempotencyKey,
      payloadHash,
    });
  } catch (err) {
    if (isOnboardingIdempotencyError(err)) {
      throw new OnboardingError(err.message, {
        code: err.code,
        status: err.status,
      });
    }
    throw err;
  }

  if (claim.kind === "replay") {
    return { ...claim.result, reusedIdempotentResult: true };
  }

  const idempotencyRecordId = claim.recordId;

  try {
    const result = await withMongoTransaction(async (session) => {
      const movable = await assertLocationMovable({
        locationId,
        confirmReassign,
        session,
      });

      const locDoc = await Location.findById(locationId).session(session).exec();
      if (!locDoc) {
        throw new OnboardingError("Location not found.", {
          code: "location_not_found",
          status: 404,
        });
      }

      if (movable.requiresReassign && movable.conflict) {
        const previous = await Business.findById(
          movable.conflict.currentBusinessId
        )
          .session(session)
          .exec();
        if (previous) {
          previous.locationIds = (previous.locationIds || []).filter(
            (id) => String(id) !== locationId
          );
          previous.googleLocationNames = (
            previous.googleLocationNames || []
          ).filter((n) => n !== locDoc.googleLocationName);
          await previous.save({ session });
          await clearReviewBusinessIdsForLocations({
            businessId: movable.conflict.currentBusinessId,
            locationIds: [locationId],
            session,
          });
        }
      }

      const createdArr = await Business.create(
        [
          {
            name,
            orgId,
            ownerUserId: null,
            replyMode,
            brandVoice,
            preferredLanguage,
            active: true,
            googleLocationNames: [googleLocationName],
            locationIds: [new mongoose.Types.ObjectId(locationId)],
            groupId: null,
            plan: defaultPlanFields(planCode),
            lastSyncError: "",
            lastPublishError: "",
          },
        ],
        { session }
      );
      const created = createdArr[0];

      locDoc.businessId = created._id;
      try {
        await locDoc.save({ session });
      } catch (err) {
        if (isMongoDuplicateKeyError(err)) {
          throw new OnboardingError(
            "Another location is already assigned to this business (database unique constraint).",
            { code: "location_business_conflict", status: 409 }
          );
        }
        throw err;
      }

      await syncReviewBusinessIdsForLocations({
        businessId: String(created._id),
        locationIds: [locationId],
        session,
      });

      await setBusinessGroup({
        businessId: String(created._id),
        groupId,
        session,
        skipOwnerRefresh: true,
      });

      const onboardingResult: OnboardingResult = {
        business: {
          id: String(created._id),
          name: created.name,
          orgId,
          groupId,
          locationIds: [locationId],
          googleLocationNames: [googleLocationName],
        },
        group: {
          id: groupId,
          name: group.name || "",
        },
        location: {
          id: locationId,
          title: locDoc.title || location.title || "",
          address: locDoc.address || location.address || "",
          googleLocationName,
          businessInfoName:
            locDoc.businessInfoName || location.businessInfoName || "",
          businessId: String(created._id),
          verificationStatus: String(locDoc.verificationStatus || "unknown"),
        },
        reassignedFrom:
          movable.requiresReassign && movable.conflict
            ? {
                businessId: movable.conflict.currentBusinessId,
                businessName: movable.conflict.currentBusinessName,
              }
            : null,
      };

      await markOnboardingIdempotencySucceeded({
        recordId: idempotencyRecordId,
        result: onboardingResult,
        session,
      });

      return onboardingResult;
    });

    await refreshOwnersForBusinessGroupChange({
      previousGroupId: null,
      nextGroupId: groupId,
    });

    return { ...result, reusedIdempotentResult: false };
  } catch (err) {
    const mapped =
      err instanceof OnboardingError
        ? err
        : err instanceof MongoTransactionError
          ? new OnboardingError(err.message, {
              code: err.code,
              status: err.status,
            })
          : err instanceof LocationAssignmentError
            ? mapAssignmentError(err)
            : err instanceof GroupMembershipError
              ? new OnboardingError(err.message, {
                  code: err.code,
                  status: err.status,
                })
              : isMongoDuplicateKeyError(err)
                ? new OnboardingError(
                    "Location ownership conflict (database unique constraint).",
                    { code: "location_business_conflict", status: 409 }
                  )
                : null;

    const failCode =
      mapped?.code ||
      (err instanceof Error && "code" in err
        ? String((err as { code?: string }).code || "onboarding_failed")
        : "onboarding_failed");
    const failMessage =
      mapped?.message ||
      (err instanceof Error ? err.message : "Onboarding failed");

    await markOnboardingIdempotencyFailed({
      recordId: idempotencyRecordId,
      code: failCode,
      message: failMessage,
    });

    if (mapped) throw mapped;
    throw err;
  }
}
