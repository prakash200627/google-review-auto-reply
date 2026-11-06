import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import {
  assertBusinessAccess,
  isAuthUser,
  requireAuthUser,
  requireSuperAdmin,
  type AuthUser,
} from "@/lib/auth/authorize";
import {
  assertBusinessOperationAllowed,
  operationalGuardResponse,
  OperationalGuardError,
} from "@/lib/auth/operationalGuard";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { EntitlementError, entitlementErrorResponse } from "@/lib/entitlements/enforce";
import { connectToDatabase } from "@/lib/mongodb";
import { SeoKeyword } from "@/models/SeoKeyword";
import { SeoRanking } from "@/models/SeoRanking";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ businessId: string }> };

async function gate(
  user: AuthUser,
  businessId: string,
  action: "read_seo" | "manage_seo"
) {
  const access = await assertBusinessAccess(user, businessId);
  if (!access.ok) return access;
  try {
    await assertBusinessOperationAllowed({
      businessId,
      business: access.business,
      action,
      actorRole: user.role,
    });
  } catch (err) {
    if (err instanceof OperationalGuardError) {
      return { ok: false as const, response: operationalGuardResponse(err) };
    }
    if (err instanceof EntitlementError) {
      return { ok: false as const, response: entitlementErrorResponse(err) };
    }
    throw err;
  }
  return { ok: true as const, business: access.business };
}

/** List keywords + recent rankings (owners read-only). */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, message: "Invalid business id." },
      { status: 400 }
    );
  }
  // Super Admin staff tools must load SEO even when the business is suspended;
  // owners remain on read_seo (active + entitlement).
  const access = await gate(
    auth.user,
    businessId,
    auth.user.role === "superadmin" ? "manage_seo" : "read_seo"
  );
  if (!access.ok) return access.response;

  await connectToDatabase();
  const keywords = await SeoKeyword.find({ businessId, active: true })
    .sort({ keyword: 1 })
    .lean();
  const keywordIds = keywords.map((k) => k._id);
  const rankings = keywordIds.length
    ? await SeoRanking.find({ keywordId: { $in: keywordIds } })
        .sort({ observedAt: -1 })
        .limit(200)
        .lean()
    : [];

  return NextResponse.json({
    success: true,
    keywords: keywords.map((k) => ({
      id: String(k._id),
      keyword: k.keyword,
      targetLocation: k.targetLocation || "",
      notes: auth.user.role === "superadmin" ? k.notes || "" : "",
    })),
    rankings: rankings.map((r) => ({
      id: String(r._id),
      keywordId: String(r.keywordId),
      position: r.position,
      observedAt: r.observedAt
        ? new Date(r.observedAt).toISOString()
        : null,
    })),
    note: "Staff-managed Local SEO (GEO). No automatic ranking collection.",
  });
}

/** Super Admin: create keyword or record ranking. */
export async function POST(request: Request, context: RouteContext) {
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
  const access = await gate(auth.user, businessId, "manage_seo");
  if (!access.ok) return access.response;

  let body: {
    action?: unknown;
    keyword?: unknown;
    targetLocation?: unknown;
    notes?: unknown;
    keywordId?: unknown;
    position?: unknown;
    observedAt?: unknown;
    active?: unknown;
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
  const action = String(body.action || "create_keyword");

  if (action === "create_keyword") {
    const keyword = String(body.keyword || "").trim();
    if (!keyword) {
      return NextResponse.json(
        { success: false, message: "keyword is required." },
        { status: 400 }
      );
    }
    const doc = await SeoKeyword.create({
      businessId,
      orgId: access.business.orgId,
      keyword,
      targetLocation: String(body.targetLocation || "").trim().slice(0, 200),
      notes: String(body.notes || "").slice(0, 2000),
      createdByUserId: auth.user.userId,
    });
    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "seo.keyword_create",
      success: true,
      target: {
        businessId,
        orgId: String(access.business.orgId),
        keywordId: String(doc._id),
      },
    });
    return NextResponse.json({
      success: true,
      keyword: { id: String(doc._id), keyword: doc.keyword },
    });
  }

  if (action === "record_ranking") {
    const keywordId = String(body.keywordId || "");
    const position = Number(body.position);
    if (!mongoose.isValidObjectId(keywordId) || !Number.isFinite(position)) {
      return NextResponse.json(
        { success: false, message: "keywordId and numeric position required." },
        { status: 400 }
      );
    }
    const kw = await SeoKeyword.findOne({ _id: keywordId, businessId }).lean();
    if (!kw) {
      return NextResponse.json(
        { success: false, message: "Keyword not found." },
        { status: 404 }
      );
    }
    const observedAt =
      typeof body.observedAt === "string" && body.observedAt
        ? new Date(body.observedAt)
        : new Date();
    const doc = await SeoRanking.create({
      keywordId,
      businessId,
      orgId: access.business.orgId,
      position: Math.max(1, Math.floor(position)),
      observedAt,
      recordedByUserId: auth.user.userId,
    });
    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "seo.ranking_record",
      success: true,
      target: {
        businessId,
        orgId: String(access.business.orgId),
        keywordId,
        position: doc.position,
      },
    });
    return NextResponse.json({
      success: true,
      ranking: {
        id: String(doc._id),
        position: doc.position,
        observedAt: observedAt.toISOString(),
      },
    });
  }

  if (action === "deactivate_keyword" || action === "update_keyword") {
    const keywordId = String(body.keywordId || "");
    if (!mongoose.isValidObjectId(keywordId)) {
      return NextResponse.json(
        { success: false, message: "keywordId is required." },
        { status: 400 }
      );
    }
    const kw = await SeoKeyword.findOne({ _id: keywordId, businessId }).exec();
    if (!kw) {
      return NextResponse.json(
        { success: false, message: "Keyword not found." },
        { status: 404 }
      );
    }
    if (action === "deactivate_keyword") {
      kw.active = false;
    } else {
      if (typeof body.keyword === "string" && body.keyword.trim()) {
        kw.keyword = body.keyword.trim().slice(0, 200);
      }
      if (typeof body.targetLocation === "string") {
        kw.targetLocation = body.targetLocation.trim().slice(0, 200);
      }
      if (typeof body.notes === "string") {
        kw.notes = body.notes.slice(0, 2000);
      }
      if (typeof body.active === "boolean") {
        kw.active = body.active;
      }
    }
    await kw.save();
    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action:
        action === "deactivate_keyword"
          ? "seo.keyword_deactivate"
          : "seo.keyword_update",
      success: true,
      target: { businessId, keywordId },
    });
    return NextResponse.json({
      success: true,
      keyword: {
        id: String(kw._id),
        keyword: kw.keyword,
        active: Boolean(kw.active),
      },
    });
  }

  return NextResponse.json(
    { success: false, message: "Unknown action." },
    { status: 400 }
  );
}
