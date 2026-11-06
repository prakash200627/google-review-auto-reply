import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import {
  assertBusinessAccess,
  isAuthUser,
  requireSuperAdmin,
} from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { connectToDatabase } from "@/lib/mongodb";
import { Business, BRAND_VOICES, REPLY_MODES } from "@/models/Business";
import { Review } from "@/models/Review";
import { User } from "@/models/User";
import {
  GroupMembershipError,
  refreshOwnersForBusinessGroupChange,
  setBusinessGroup,
} from "@/lib/groups/membership";
import {
  assertAssignableLocations,
  loadAssignableLocations,
  LocationAssignmentError,
  validateLocationAssignmentInput,
} from "@/lib/business/assignLocations";
import { replaceBusinessLocationsAtomic } from "@/lib/business/reassignLocation";
import {
  MongoTransactionError,
  withMongoTransaction,
} from "@/lib/mongo/transactions";
import {
  OwnerAccountError,
  reassignBusinessOwner,
  upsertBusinessOwner,
} from "@/lib/business/owners";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";
import {
  PLAN_CATALOG,
  defaultPlanFields,
  isPlanCode,
  isPlanStatus,
} from "@/lib/entitlements/plans";
import {
  applyLifecycleTransition,
  LifecycleTransitionError,
  resolveBusinessLifecycle,
  type LifecycleTransition,
} from "@/lib/business/lifecycle";
import { cancelOpenAutoPublishJobsForBusiness } from "@/lib/autoPublish/cancelJobs";
import {
  DEFAULT_AUTO_PUBLISH_CONFIG,
  normalizeAutoPublishConfig,
} from "@/lib/autoPublish/policy";
import { readJsonObjectBody } from "@/lib/http/readJsonBody";

export const runtime = "nodejs";

const LIFECYCLE_ACTIONS: LifecycleTransition[] = [
  "suspend",
  "reactivate",
  "archive",
  "restore",
];

function isLifecycleAction(value: unknown): value is LifecycleTransition {
  return (
    typeof value === "string" &&
    (LIFECYCLE_ACTIONS as readonly string[]).includes(value)
  );
}

type RouteContext = { params: Promise<{ businessId: string }> };

export async function GET(
  _request: Request,
  context: RouteContext
) {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  const access = await assertBusinessAccess(auth.user, businessId);
  if (!access.ok) return access.response;

  await connectToDatabase();
  const [reviewCount, owner] = await Promise.all([
    Review.countDocuments({ businessId }),
    access.business.ownerUserId
      ? User.findById(access.business.ownerUserId)
          .select("email name active role")
          .lean()
      : Promise.resolve(null),
  ]);

  const lifecycle = resolveBusinessLifecycle(access.business);
  return NextResponse.json({
    success: true,
    business: {
      id: String(access.business._id),
      name: access.business.name,
      active: access.business.active,
      status: lifecycle,
      replyMode: access.business.replyMode,
      brandVoice: access.business.brandVoice || "friendly",
      preferredLanguage: access.business.preferredLanguage || "English",
      orgId: String(access.business.orgId),
      googleLocationNames: access.business.googleLocationNames || [],
      locationIds: (access.business.locationIds || []).map((id) => String(id)),
      reviewCount,
      plan: toPlanSnapshot(access.business.plan as never),
      owner: owner
        ? {
            id: String(owner._id),
            email: owner.email,
            name: owner.name || "",
            active: Boolean(owner.active),
          }
        : null,
    },
  });
}

export async function PATCH(
  request: Request,
  context: RouteContext
) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const actor = { actorId: auth.user.userId, actorRole: auth.user.role };
  const { businessId } = await context.params;

  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      {
        success: false,
        code: "invalid_business_id",
        message: "Invalid business id.",
      },
      { status: 400 }
    );
  }

  const parsed = await readJsonObjectBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as {
    name?: unknown;
    active?: unknown;
    /** Preferred: suspend | reactivate | archive | restore */
    lifecycleAction?: unknown;
    replyMode?: unknown;
    ownersMayChangeReplyMode?: unknown;
    autoDraftOnSync?: unknown;
    groupId?: unknown;
    brandVoice?: unknown;
    preferredLanguage?: unknown;
    locationIds?: unknown;
    /** Required to clear all location assignments via locationIds: []. */
    confirmClearLocations?: unknown;
    /** Required to move a location that already belongs to another business. */
    confirmReassign?: unknown;
    ownerEmail?: unknown;
    ownerPassword?: unknown;
    ownerName?: unknown;
    planCode?: unknown;
    planStatus?: unknown;
    planNotes?: unknown;
    planFeatures?: unknown;
    planLimits?: unknown;
    resetAiDraftUsage?: unknown;
  };

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json(
        {
          success: false,
          code: "invalid_name",
          message: "name must be a non-empty string when provided.",
        },
        { status: 400 }
      );
    }
  }

  try {
    await connectToDatabase();

    let lifecycleActionApplied: LifecycleTransition | null = null;
    let cancelJobsReason: string | null = null;
    let locationsChanged = false;
    let groupRefresh: {
      previousGroupId: string | null;
      nextGroupId: string | null;
    } | null = null;

    const business = await withMongoTransaction(async (session) => {
      const doc = await Business.findById(businessId).session(session).exec();
      if (!doc) {
        throw Object.assign(new Error("Business not found."), {
          code: "not_found",
          status: 404,
        });
      }

      // Legacy rows may omit `status`. Materialize from `active` before any
      // save() so the schema default ("active") cannot revive a suspended
      // business during an unrelated field update.
      {
        const raw = String(doc.status || "").trim().toLowerCase();
        if (raw !== "active" && raw !== "suspended" && raw !== "archived") {
          const resolved = resolveBusinessLifecycle({
            active: doc.active,
          });
          doc.status = resolved;
          doc.active = resolved === "active";
        }
      }

      if (typeof body.name === "string") {
        doc.name = body.name.trim();
      }

      if (isLifecycleAction(body.lifecycleAction)) {
        const current = resolveBusinessLifecycle(doc);
        const next = applyLifecycleTransition(current, body.lifecycleAction);
        doc.status = next.status;
        doc.active = next.active;
        if (next.status === "suspended") {
          doc.suspendedAt = new Date();
        }
        if (next.status === "archived") {
          doc.archivedAt = new Date();
        }
        if (next.disableAutoReply) {
          const ap = normalizeAutoPublishConfig(doc.autoPublish as never);
          doc.autoPublish = {
            ...DEFAULT_AUTO_PUBLISH_CONFIG,
            ...ap,
            enabled: false,
            disabledByAdmin: true,
          };
        }
        if (
          body.lifecycleAction === "suspend" ||
          body.lifecycleAction === "archive" ||
          body.lifecycleAction === "restore"
        ) {
          cancelJobsReason = `lifecycle_${body.lifecycleAction}`;
        }
        lifecycleActionApplied = body.lifecycleAction;
      } else if (typeof body.active === "boolean") {
        // Legacy binary flag: map to suspend / reactivate only (never archive).
        const current = resolveBusinessLifecycle(doc);
        if (body.active === false && current === "active") {
          const next = applyLifecycleTransition(current, "suspend");
          doc.status = next.status;
          doc.active = next.active;
          doc.suspendedAt = new Date();
          cancelJobsReason = "lifecycle_suspend_legacy";
          lifecycleActionApplied = "suspend";
        } else if (body.active === true && current === "suspended") {
          const next = applyLifecycleTransition(current, "reactivate");
          doc.status = next.status;
          doc.active = next.active;
          lifecycleActionApplied = "reactivate";
        } else if (body.active === true && current === "archived") {
          throw Object.assign(
            new Error(
              "Archived businesses cannot reactivate directly. Restore to Suspended first, then Reactivate."
            ),
            { code: "invalid_transition", status: 400 }
          );
        } else {
          doc.active = body.active;
          if (!doc.status) {
            doc.status = body.active ? "active" : "suspended";
          }
        }
      }

      if (REPLY_MODES.includes(body.replyMode as never)) {
        doc.replyMode = body.replyMode as "manual" | "auto";
      }
      if (typeof body.ownersMayChangeReplyMode === "boolean") {
        doc.ownersMayChangeReplyMode = body.ownersMayChangeReplyMode;
      }
      if (typeof body.autoDraftOnSync === "boolean") {
        doc.autoDraftOnSync = body.autoDraftOnSync;
      }
      if (body.groupId !== undefined) {
        const nextGroupId =
          body.groupId === null || body.groupId === ""
            ? null
            : String(body.groupId);
        const groupResult = await setBusinessGroup({
          businessId: String(doc._id),
          groupId: nextGroupId,
          session,
          skipOwnerRefresh: true,
        });
        groupRefresh = {
          previousGroupId: groupResult.previousGroupId,
          nextGroupId: groupResult.groupId,
        };
        const refreshedGroup = await Business.findById(businessId)
          .session(session)
          .exec();
        if (refreshedGroup) {
          doc.groupId = refreshedGroup.groupId;
        }
      }
      if (BRAND_VOICES.includes(body.brandVoice as never)) {
        doc.brandVoice = body.brandVoice as (typeof BRAND_VOICES)[number];
      }
      if (typeof body.preferredLanguage === "string") {
        const lang = body.preferredLanguage.trim();
        if (lang) doc.preferredLanguage = lang.slice(0, 64);
      }

      if (isPlanCode(body.planCode)) {
        const next = defaultPlanFields(body.planCode);
        const previousUsage = doc.plan?.usage;
        doc.plan = {
          ...next,
          status: isPlanStatus(body.planStatus)
            ? body.planStatus
            : doc.plan?.status || "active",
          notes:
            typeof body.planNotes === "string"
              ? body.planNotes.slice(0, 500)
              : doc.plan?.notes || "",
          usage: {
            aiDraftsThisPeriod: previousUsage?.aiDraftsThisPeriod ?? 0,
            periodStart: previousUsage?.periodStart || new Date(),
          },
        };
      } else if (isPlanStatus(body.planStatus) && doc.plan) {
        doc.plan.status = body.planStatus;
      }
      if (typeof body.planNotes === "string" && doc.plan) {
        doc.plan.notes = body.planNotes.slice(0, 500);
      }
      if (
        body.planFeatures &&
        typeof body.planFeatures === "object" &&
        doc.plan
      ) {
        const f = body.planFeatures as Record<string, unknown>;
        const features = doc.plan.features ?? {
          reviewSync: true,
          aiDrafts: true,
          advancedAnalytics: false,
          automation: false,
        };
        if (typeof f.reviewSync === "boolean") features.reviewSync = f.reviewSync;
        if (typeof f.aiDrafts === "boolean") features.aiDrafts = f.aiDrafts;
        if (typeof f.advancedAnalytics === "boolean") {
          features.advancedAnalytics = f.advancedAnalytics;
        }
        if (typeof f.automation === "boolean") features.automation = f.automation;
        doc.plan.features = features;
      }
      if (
        body.planLimits &&
        typeof body.planLimits === "object" &&
        doc.plan
      ) {
        const l = body.planLimits as Record<string, unknown>;
        const limits = doc.plan.limits ?? {
          maxLocations: 1,
          maxOwnerAccounts: 1,
          monthlyAiDraftQuota: 50,
        };
        if (typeof l.maxLocations === "number") {
          limits.maxLocations = Math.min(
            1,
            Math.max(0, Math.floor(l.maxLocations))
          );
        }
        if (typeof l.maxOwnerAccounts === "number") {
          limits.maxOwnerAccounts = Math.max(
            0,
            Math.floor(l.maxOwnerAccounts)
          );
        }
        if (typeof l.monthlyAiDraftQuota === "number") {
          limits.monthlyAiDraftQuota = Math.floor(l.monthlyAiDraftQuota);
        }
        doc.plan.limits = limits;
      }
      if (body.resetAiDraftUsage === true && doc.plan) {
        doc.plan.usage = {
          aiDraftsThisPeriod: 0,
          periodStart: new Date(),
        };
      }
      if (doc.plan?.code && isPlanCode(doc.plan.code)) {
        doc.plan.displayName =
          doc.plan.displayName || PLAN_CATALOG[doc.plan.code].displayName;
      }

      // Validate locations before owner writes; both commit in this session.
      let pendingLocationIds: string[] | null = null;
      if (Array.isArray(body.locationIds)) {
        const locationIdList = validateLocationAssignmentInput({
          orgId: String(doc.orgId),
          locationIds: body.locationIds,
          currentBusinessId: String(doc._id),
        });
        if (
          locationIdList.length === 0 &&
          body.confirmClearLocations !== true
        ) {
          throw Object.assign(
            new Error(
              "Omitting locationIds leaves assignments unchanged. To clear all locations, send locationIds: [] with confirmClearLocations: true."
            ),
            { code: "confirm_clear_locations_required", status: 400 }
          );
        }
        if (locationIdList.length > 0 && body.confirmReassign !== true) {
          const found = await loadAssignableLocations({
            orgId: String(doc.orgId),
            locationIds: locationIdList,
          });
          assertAssignableLocations({
            orgId: String(doc.orgId),
            requestedIds: locationIdList,
            found,
            currentBusinessId: String(doc._id),
          });
        }
        pendingLocationIds = locationIdList;
      }

      if (
        body.ownerEmail !== undefined &&
        body.ownerEmail !== null &&
        body.ownerEmail !== ""
      ) {
        if (doc.ownerUserId) {
          await reassignBusinessOwner({
            businessId: String(doc._id),
            email: body.ownerEmail,
            password: body.ownerPassword,
            name:
              typeof body.ownerName === "string" ? body.ownerName : doc.name,
            session,
          });
        } else {
          await upsertBusinessOwner({
            email: body.ownerEmail,
            password: body.ownerPassword,
            name:
              typeof body.ownerName === "string" ? body.ownerName : doc.name,
            businessId: String(doc._id),
            requirePassword: true,
            session,
          });
        }
        const refreshedOwner = await Business.findById(doc._id)
          .select("ownerUserId")
          .session(session)
          .lean();
        doc.ownerUserId = refreshedOwner?.ownerUserId || doc.ownerUserId;
      }

      if (pendingLocationIds !== null) {
        const replaced = await replaceBusinessLocationsAtomic({
          businessId: String(doc._id),
          locationIds: pendingLocationIds,
          confirmReassign: body.confirmReassign === true,
          session,
        });
        doc.locationIds = replaced.locationObjectIds;
        doc.googleLocationNames = replaced.googleLocationNames;
        locationsChanged = true;
      }

      await doc.save({ session });
      return doc;
    });

    // Side effects after commit only (not rolled back with Mongo writes).
    if (cancelJobsReason) {
      await cancelOpenAutoPublishJobsForBusiness(
        String(business._id),
        cancelJobsReason
      );
    }
    if (groupRefresh) {
      await refreshOwnersForBusinessGroupChange(groupRefresh);
    }

    if (locationsChanged) {
      auditLog({
        ...actor,
        action: "business.locations_assign",
        success: true,
        target: {
          businessId: String(business._id),
          orgId: String(business.orgId),
          locationCount: (business.locationIds || []).length,
        },
      });
    }
    if (lifecycleActionApplied) {
      auditLog({
        ...actor,
        action: `business.lifecycle.${lifecycleActionApplied}`,
        success: true,
        target: {
          businessId: String(business._id),
          orgId: String(business.orgId),
          status: resolveBusinessLifecycle(business),
        },
      });
    }
    auditLog({
      ...actor,
      action: "business.update",
      success: true,
      target: {
        businessId: String(business._id),
        orgId: String(business.orgId),
      },
    });

    const lifecycle = resolveBusinessLifecycle(business);
    return NextResponse.json({
      success: true,
      business: {
        id: String(business._id),
        name: business.name,
        active: business.active,
        status: lifecycle,
        replyMode: business.replyMode,
        brandVoice: business.brandVoice,
        preferredLanguage: business.preferredLanguage,
        locationIds: (business.locationIds || []).map((id) => String(id)),
        ownerUserId: business.ownerUserId ? String(business.ownerUserId) : null,
        plan: toPlanSnapshot(business.plan as never),
      },
      message:
        lifecycleActionApplied
          ? `Business ${lifecycleActionApplied}d. Lifecycle is now ${lifecycle}.`
          : business.replyMode === "auto"
            ? "Updated. replyMode=auto is stored only; auto-publish is not enabled in this app build."
            : "Business updated.",
    });
  } catch (err) {
    const coded = err as { code?: string; status?: number; message?: string };
    if (
      coded &&
      typeof coded.code === "string" &&
      typeof coded.status === "number" &&
      coded.status >= 400 &&
      coded.status < 500
    ) {
      return NextResponse.json(
        {
          success: false,
          code: coded.code,
          message: coded.message || "Request rejected.",
        },
        { status: coded.status }
      );
    }
    if (err instanceof LifecycleTransitionError) {
      return NextResponse.json(
        { success: false, code: err.code, message: err.message },
        { status: 400 }
      );
    }
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
    auditLog({
      ...actor,
      action: "business.update",
      success: false,
      code: "update_failed",
      target: { businessId },
    });
    console.error(
      "Update business failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "update_failed",
        message: "Could not update business.",
      },
      { status: 500 }
    );
  }
}
