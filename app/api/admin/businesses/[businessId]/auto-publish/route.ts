import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  isAutoPublishGloballyEnabled,
  normalizeAutoPublishConfig,
  DEFAULT_AUTO_PUBLISH_CONFIG,
} from "@/lib/autoPublish/policy";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ businessId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, message: "Invalid business id." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const business = await Business.findById(businessId)
    .select("name replyMode plan autoPublish")
    .lean();
  if (!business) {
    return NextResponse.json(
      { success: false, message: "Business not found." },
      { status: 404 }
    );
  }

  const plan = toPlanSnapshot(business.plan as never);
  const autoPublish = normalizeAutoPublishConfig(
    business.autoPublish as never
  );

  return NextResponse.json({
    success: true,
    businessId,
    replyMode: business.replyMode,
    replyModeNote:
      "replyMode does not authorize automatic publishing.",
    plan: {
      code: plan.code,
      status: plan.status,
      automationEntitled: plan.features.automation,
    },
    autoPublish,
    globallyEnabled: isAutoPublishGloballyEnabled(),
    defaults: DEFAULT_AUTO_PUBLISH_CONFIG,
  });
}

/**
 * Explicit Super Admin configuration for automatic publishing.
 * Enabling requires plan.features.automation; global kill switch is still
 * required before any job processing can publish.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, message: "Invalid business id." },
      { status: 400 }
    );
  }

  let body: {
    enabled?: unknown;
    syncIntervalMinutes?: unknown;
    publishDelayMinutes?: unknown;
    maxAutoStarRatingExclusive?: unknown;
    disabledByAdmin?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const business = await Business.findById(businessId).exec();
  if (!business) {
    return NextResponse.json(
      { success: false, message: "Business not found." },
      { status: 404 }
    );
  }

  const plan = toPlanSnapshot(business.plan as never);
  const current = normalizeAutoPublishConfig(business.autoPublish as never);
  const next = normalizeAutoPublishConfig({
    ...current,
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    ...(typeof body.syncIntervalMinutes === "number"
      ? { syncIntervalMinutes: body.syncIntervalMinutes }
      : {}),
    ...(typeof body.publishDelayMinutes === "number"
      ? { publishDelayMinutes: body.publishDelayMinutes }
      : {}),
    ...(typeof body.maxAutoStarRatingExclusive === "number"
      ? { maxAutoStarRatingExclusive: body.maxAutoStarRatingExclusive }
      : {}),
    ...(typeof body.disabledByAdmin === "boolean"
      ? { disabledByAdmin: body.disabledByAdmin }
      : {}),
  });

  if (next.enabled && !plan.features.automation) {
    return NextResponse.json(
      {
        success: false,
        code: "feature_disabled",
        message:
          "Cannot enable automatic publishing: plan does not include automation. Assign a plan with automation (e.g. Custom) first.",
      },
      { status: 403 }
    );
  }

  business.autoPublish = next;
  await business.save();

  auditLog({
    actorId: auth.user.userId,
    actorRole: auth.user.role,
    action: "business.auto_publish_config",
    success: true,
    target: {
      businessId,
      enabled: next.enabled,
      disabledByAdmin: next.disabledByAdmin,
    },
  });

  return NextResponse.json({
    success: true,
    autoPublish: next,
    globallyEnabled: isAutoPublishGloballyEnabled(),
    message: next.enabled
      ? "Auto-publish enabled for this business only if the global kill switch is also true. replyMode is ignored for authorization."
      : "Auto-publish remains disabled for this business.",
  });
}
