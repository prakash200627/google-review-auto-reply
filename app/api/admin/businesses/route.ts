import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { connectToDatabase } from "@/lib/mongodb";
import { Business, BRAND_VOICES, REPLY_MODES } from "@/models/Business";
import { Location } from "@/models/Location";
import { Organization } from "@/models/Organization";
import { Review } from "@/models/Review";
import { User } from "@/models/User";
import {
  clearReviewBusinessIdsForLocations,
  syncReviewBusinessIdsForLocations,
} from "@/lib/business/stats";
import {
  assertAssignableLocations,
  loadAssignableLocations,
  LocationAssignmentError,
  validateLocationAssignmentInput,
} from "@/lib/business/assignLocations";
import { assertLocationMovable } from "@/lib/business/reassignLocation";
import { resolveLocationForBusinessCreate } from "@/lib/business/resolveLocationForCreate";
import {
  OwnerAccountError,
  upsertBusinessOwner,
} from "@/lib/business/owners";
import {
  GroupMembershipError,
  refreshOwnersForBusinessGroupChange,
  setBusinessGroup,
} from "@/lib/groups/membership";
import { defaultPlanFields, isPlanCode } from "@/lib/entitlements/plans";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";
import { resolveBusinessLifecycle } from "@/lib/business/lifecycle";
import {
  isMongoDuplicateKeyError,
  MongoTransactionError,
  withMongoTransaction,
} from "@/lib/mongo/transactions";
import { readOrganizationId } from "@/lib/org/session";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  await connectToDatabase();
  const businesses = await Business.find({}).sort({ name: 1 }).lean();
  const ownerIds = businesses
    .map((b) => b.ownerUserId)
    .filter(Boolean)
    .map((id) => String(id));
  const owners = ownerIds.length
    ? await User.find({ _id: { $in: ownerIds } })
        .select("email name active")
        .lean()
    : [];
  const ownerById = new Map(owners.map((o) => [String(o._id), o]));

  const rows = await Promise.all(
    businesses.map(async (b) => {
      const reviewCount = await Review.countDocuments({ businessId: b._id });
      const owner = b.ownerUserId
        ? ownerById.get(String(b.ownerUserId))
        : null;
      return {
        id: String(b._id),
        name: b.name,
        active: b.active,
        status: resolveBusinessLifecycle(b),
        replyMode: b.replyMode,
        brandVoice: b.brandVoice,
        preferredLanguage: b.preferredLanguage,
        orgId: String(b.orgId),
        ownerUserId: b.ownerUserId ? String(b.ownerUserId) : null,
        ownerEmail: owner?.email || null,
        ownerActive: owner ? Boolean(owner.active) : null,
        googleLocationNames: b.googleLocationNames || [],
        locationIds: (b.locationIds || []).map((id) => String(id)),
        groupId: b.groupId ? String(b.groupId) : null,
        ownersMayChangeReplyMode: Boolean(b.ownersMayChangeReplyMode),
        autoDraftOnSync: Boolean(b.autoDraftOnSync),
        reviewCount,
        plan: toPlanSnapshot(b.plan as never),
        lastSyncError: b.lastSyncError || "",
        lastPublishError: b.lastPublishError || "",
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      };
    })
  );

  return NextResponse.json({
    success: true,
    businesses: rows,
  });
}

export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const actor = { actorId: auth.user.userId, actorRole: auth.user.role };

  let body: {
    name?: unknown;
    orgId?: unknown;
    locationId?: unknown;
    replyMode?: unknown;
    ownersMayChangeReplyMode?: unknown;
    autoDraftOnSync?: unknown;
    groupId?: unknown;
    brandVoice?: unknown;
    preferredLanguage?: unknown;
    locationIds?: unknown;
    confirmReassign?: unknown;
    ownerEmail?: unknown;
    ownerPassword?: unknown;
    active?: unknown;
    planCode?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const name = String(body.name || "").trim();
  if (!name) {
    return NextResponse.json(
      { success: false, message: "Business name is required." },
      { status: 400 }
    );
  }

  // Prefer explicit single locationId from the searchable selector.
  const preferredLocationId =
    typeof body.locationId === "string" && body.locationId.trim()
      ? body.locationId.trim()
      : Array.isArray(body.locationIds) &&
          typeof body.locationIds[0] === "string"
        ? String(body.locationIds[0]).trim()
        : "";

  // replyMode=auto is preference storage only — never enables auto-publish.
  const replyMode = REPLY_MODES.includes(body.replyMode as never)
    ? (body.replyMode as (typeof REPLY_MODES)[number])
    : "manual";
  const brandVoice = BRAND_VOICES.includes(body.brandVoice as never)
    ? (body.brandVoice as (typeof BRAND_VOICES)[number])
    : "friendly";
  const preferredLanguage =
    String(body.preferredLanguage || "English").trim() || "English";

  try {
    await connectToDatabase();

    let orgId = "";
    let locations: Awaited<ReturnType<typeof loadAssignableLocations>> = [];

    const confirmReassign = body.confirmReassign === true;
    const requestedGroupId =
      body.groupId !== undefined && body.groupId !== null && body.groupId !== ""
        ? String(body.groupId)
        : null;

    try {
      if (preferredLocationId) {
        // Server resolves org + connection from the Location document.
        // Client-supplied orgId is ignored for this path (cannot retarget).
        if (
          body.orgId != null &&
          body.orgId !== "" &&
          String(body.orgId) !== ""
        ) {
          // Soft ignore with audit — never trust client org binding.
          auditLog({
            ...actor,
            action: "business.create",
            success: true,
            code: "client_org_id_ignored",
            target: { preferredLocationId },
          });
        }
        // Never silently steal — require confirmReassign for moves.
        // Do not detach before the create transaction commits.
        await assertLocationMovable({
          locationId: preferredLocationId,
          confirmReassign,
        });
        const resolved = await resolveLocationForBusinessCreate(
          preferredLocationId,
          { allowAssigned: confirmReassign }
        );
        orgId = resolved.orgId;
        locations = [
          {
            _id: new mongoose.Types.ObjectId(resolved.locationId),
            orgId: new mongoose.Types.ObjectId(resolved.orgId),
            businessId: null,
            googleLocationName: resolved.googleLocationName,
          },
        ];
      } else {
        // Legacy path: optional create without location (org cookie / body).
        orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
        if (!orgId) {
          orgId = (await readOrganizationId()) || "";
        }
        if (!orgId || !mongoose.isValidObjectId(orgId)) {
          return NextResponse.json(
            {
              success: false,
              code: "location_required",
              message:
                "Select a Google Business Profile location. Organization is resolved from that location on the server.",
            },
            { status: 400 }
          );
        }
        const org = await Organization.findById(orgId).select("_id").lean();
        if (!org) {
          return NextResponse.json(
            { success: false, message: "Organization not found." },
            { status: 400 }
          );
        }
        const locationIdList = validateLocationAssignmentInput({
          orgId,
          locationIds: Array.isArray(body.locationIds) ? body.locationIds : [],
        });
        if (locationIdList.length > 0) {
          for (const locId of locationIdList) {
            await assertLocationMovable({
              locationId: locId,
              confirmReassign,
            });
          }
          const found = await loadAssignableLocations({
            orgId,
            locationIds: locationIdList,
          });
          // When confirmReassign, ownership move happens inside the transaction.
          locations = confirmReassign
            ? found
            : assertAssignableLocations({
                orgId,
                requestedIds: locationIdList,
                found,
              });
        }
      }
    } catch (err) {
      if (err instanceof LocationAssignmentError) {
        return NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        );
      }
      throw err;
    }

    const planCode = isPlanCode(body.planCode) ? body.planCode : "starter";

    let created: InstanceType<typeof Business>;
    let ownerMessage = "";
    try {
      const txnResult = await withMongoTransaction(async (session) => {
        const locationDocs = [] as Array<{
          _id: mongoose.Types.ObjectId;
          googleLocationName: string;
        }>;

        for (const loc of locations) {
          const locId = String(loc._id);
          const movable = await assertLocationMovable({
            locationId: locId,
            confirmReassign,
            session,
          });
          const locDoc = await Location.findById(locId).session(session).exec();
          if (!locDoc) {
            throw new LocationAssignmentError("Location not found.", {
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
                (id) => String(id) !== locId
              );
              previous.googleLocationNames = (
                previous.googleLocationNames || []
              ).filter((n) => n !== locDoc.googleLocationName);
              await previous.save({ session });
              await clearReviewBusinessIdsForLocations({
                businessId: movable.conflict.currentBusinessId,
                locationIds: [locId],
                session,
              });
            }
          }
          locationDocs.push({
            _id: locDoc._id,
            googleLocationName: locDoc.googleLocationName,
          });
        }

        const createdArr = await Business.create(
          [
            {
              name,
              orgId,
              ownerUserId: null,
              replyMode,
              ownersMayChangeReplyMode: body.ownersMayChangeReplyMode === true,
              autoDraftOnSync: body.autoDraftOnSync === true,
              brandVoice,
              preferredLanguage,
              active: body.active === false ? false : true,
              googleLocationNames: locationDocs.map((l) => l.googleLocationName),
              locationIds: locationDocs.map((l) => l._id),
              groupId: null,
              plan: defaultPlanFields(planCode),
              lastSyncError: "",
              lastPublishError: "",
            },
          ],
          { session }
        );
        const doc = createdArr[0];

        for (const loc of locationDocs) {
          const locDoc = await Location.findById(loc._id).session(session).exec();
          if (!locDoc) continue;
          locDoc.businessId = doc._id;
          try {
            await locDoc.save({ session });
          } catch (err) {
            if (isMongoDuplicateKeyError(err)) {
              throw new LocationAssignmentError(
                "Another location is already assigned to this business (database unique constraint).",
                { code: "location_business_conflict", status: 409 }
              );
            }
            throw err;
          }
        }

        if (locationDocs.length > 0) {
          await syncReviewBusinessIdsForLocations({
            businessId: String(doc._id),
            locationIds: locationDocs.map((l) => String(l._id)),
            session,
          });
        }

        if (requestedGroupId) {
          await setBusinessGroup({
            businessId: String(doc._id),
            groupId: requestedGroupId,
            session,
            skipOwnerRefresh: true,
          });
        }

        // Owner association participates in the same transaction so a failed
        // owner setup rolls back the business + location assignment.
        let linkedOwnerMessage = "";
        if (body.ownerEmail) {
          const owner = await upsertBusinessOwner({
            email: body.ownerEmail,
            password: body.ownerPassword,
            name,
            businessId: String(doc._id),
            requirePassword: true,
            session,
          });
          linkedOwnerMessage = owner.created
            ? " Owner account created — share the password out-of-band (this app does not send email)."
            : " Existing owner linked to this business (password unchanged).";
          const refreshed = await Business.findById(doc._id)
            .session(session)
            .exec();
          if (refreshed) {
            doc.ownerUserId = refreshed.ownerUserId;
          }
        }

        return { doc, linkedOwnerMessage };
      });
      created = txnResult.doc;
      ownerMessage = txnResult.linkedOwnerMessage;

      if (requestedGroupId) {
        await refreshOwnersForBusinessGroupChange({
          previousGroupId: null,
          nextGroupId: requestedGroupId,
        });
      }
    } catch (err) {
      if (err instanceof LocationAssignmentError) {
        return NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        );
      }
      if (err instanceof OwnerAccountError) {
        return NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        );
      }
      if (err instanceof GroupMembershipError) {
        return NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        );
      }
      if (err instanceof MongoTransactionError) {
        return NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        );
      }
      if (isMongoDuplicateKeyError(err)) {
        return NextResponse.json(
          {
            success: false,
            code: "location_business_conflict",
            message: "Location ownership conflict (database unique constraint).",
          },
          { status: 409 }
        );
      }
      throw err;
    }

    auditLog({
      ...actor,
      action: "business.create",
      success: true,
      target: {
        businessId: String(created._id),
        orgId,
        locationCount: locations.length,
        ownerLinked: Boolean(body.ownerEmail),
      },
    });

    return NextResponse.json(
      {
        success: true,
        business: {
          id: String(created._id),
          name: created.name,
          replyMode: created.replyMode,
          brandVoice: created.brandVoice,
          preferredLanguage: created.preferredLanguage,
          active: created.active,
        },
        message:
          (replyMode === "auto"
            ? "Business created with replyMode=auto stored. Auto-publish pipeline is not enabled in this app build."
            : "Business created.") + ownerMessage,
      },
      { status: 201 }
    );
  } catch (err) {
    auditLog({
      ...actor,
      action: "business.create",
      success: false,
      code: "create_failed",
    });
    console.error(
      "Create business failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      { success: false, message: "Could not create business." },
      { status: 500 }
    );
  }
}
