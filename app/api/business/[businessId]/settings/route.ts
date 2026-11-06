import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import {
  assertBusinessAccess,
  isAuthUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  lifecycleAllowsOwnerAccess,
  resolveBusinessLifecycle,
} from "@/lib/business/lifecycle";
import { sanitizeToneNotes } from "@/lib/ai/replyDraft";
import { normalizeBusinessPhone, PhoneValidationError } from "@/lib/business/phone";
import { connectToDatabase } from "@/lib/mongodb";
import { Business, BRAND_VOICES, REPLY_MODES } from "@/models/Business";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ businessId: string }> };

function canEditReplyMode(
  role: string,
  ownersMayChangeReplyMode: boolean | undefined
): boolean {
  if (role === "superadmin") return true;
  return ownersMayChangeReplyMode === true;
}

/** Owner-readable business settings (no tokens, no other businesses). */
export async function GET(
  _request: Request,
  context: RouteContext
) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  const access = await assertBusinessAccess(auth.user, businessId);
  if (!access.ok) return access.response;

  const ownersMayChangeReplyMode = Boolean(
    access.business.ownersMayChangeReplyMode
  );

  return NextResponse.json({
    success: true,
    business: {
      id: String(access.business._id),
      name: access.business.name,
      active: access.business.active,
      groupId: access.business.groupId
        ? String(access.business.groupId)
        : null,
      brandVoice: access.business.brandVoice || "friendly",
      preferredLanguage: access.business.preferredLanguage || "English",
      replyToneNotes: String(
        (access.business as { replyToneNotes?: string }).replyToneNotes || ""
      ),
      phone: String(
        (access.business as { profile?: { phone?: string } }).profile?.phone ||
          ""
      ),
      phoneScope: "tronx_internal",
      replyMode: access.business.replyMode,
      ownersMayChangeReplyMode,
      autoDraftOnSync: Boolean(access.business.autoDraftOnSync),
      autoPublishEnabled: Boolean(access.business.autoPublish?.enabled),
      replyModeNote:
        "Manual = admin drafts/publishes explicitly. Automated = optional AI draft generation only. Automatic publishing stays OFF unless Super Admin enables autoPublish separately.",
      canEditReplyMode: canEditReplyMode(
        auth.user.role,
        ownersMayChangeReplyMode
      ),
    },
  });
}

/**
 * Owners may update brand voice, preferred language, tone, phone.
 * Reply mode only when Super Admin enabled ownersMayChangeReplyMode.
 */
export async function PATCH(
  request: Request,
  context: RouteContext
) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  const access = await assertBusinessAccess(auth.user, businessId);
  if (!access.ok) return access.response;

  let body: {
    brandVoice?: unknown;
    preferredLanguage?: unknown;
    replyToneNotes?: unknown;
    phone?: unknown;
    name?: unknown;
    replyMode?: unknown;
    role?: unknown;
    businessIds?: unknown;
    ownersMayChangeReplyMode?: unknown;
    autoDraftOnSync?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  if (body.role !== undefined || body.businessIds !== undefined) {
    return NextResponse.json(
      {
        success: false,
        code: "forbidden",
        message: "Owners cannot change role or business association.",
      },
      { status: 403 }
    );
  }

  const ownersMayChange = Boolean(access.business.ownersMayChangeReplyMode);
  const mayEditMode = canEditReplyMode(auth.user.role, ownersMayChange);

  if (body.replyMode !== undefined && !mayEditMode) {
    return NextResponse.json(
      {
        success: false,
        code: "forbidden",
        message:
          "Reply mode can only be changed by a Super Admin, or by a Business Admin when Super Admin has enabled that permission for this business.",
      },
      { status: 403 }
    );
  }

  if (
    (body.ownersMayChangeReplyMode !== undefined ||
      body.autoDraftOnSync !== undefined) &&
    auth.user.role !== "superadmin"
  ) {
    return NextResponse.json(
      {
        success: false,
        code: "forbidden",
        message:
          "Only Super Admin can change ownersMayChangeReplyMode or autoDraftOnSync.",
      },
      { status: 403 }
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

  if (
    auth.user.role !== "superadmin" &&
    !lifecycleAllowsOwnerAccess(business)
  ) {
    const status = resolveBusinessLifecycle(business);
    return NextResponse.json(
      {
        success: false,
        code: "business_lifecycle_blocked",
        message: `This business is ${status}. Contact a Super Admin.`,
      },
      { status: 403 }
    );
  }

  const previousReplyMode = business.replyMode;

  if (typeof body.name === "string" && body.name.trim()) {
    business.name = body.name.trim().slice(0, 120);
  }
  if (BRAND_VOICES.includes(body.brandVoice as never)) {
    business.brandVoice = body.brandVoice as (typeof BRAND_VOICES)[number];
  }
  if (typeof body.preferredLanguage === "string") {
    const lang = body.preferredLanguage.trim();
    if (lang) business.preferredLanguage = lang.slice(0, 64);
  }
  if (body.replyToneNotes !== undefined) {
    business.replyToneNotes = sanitizeToneNotes(body.replyToneNotes);
  }
  if (body.phone !== undefined) {
    try {
      const phone = normalizeBusinessPhone(body.phone);
      if (!business.profile) {
        business.profile = { description: "", website: "", phone: "" };
      }
      business.profile.phone = phone;
    } catch (err) {
      if (err instanceof PhoneValidationError) {
        return NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: 400 }
        );
      }
      throw err;
    }
  }

  if (
    body.replyMode !== undefined &&
    REPLY_MODES.includes(body.replyMode as never)
  ) {
    business.replyMode = body.replyMode as (typeof REPLY_MODES)[number];
  }
  if (typeof body.ownersMayChangeReplyMode === "boolean") {
    business.ownersMayChangeReplyMode = body.ownersMayChangeReplyMode;
  }
  if (typeof body.autoDraftOnSync === "boolean") {
    business.autoDraftOnSync = body.autoDraftOnSync;
  }

  await business.save();

  if (previousReplyMode !== business.replyMode) {
    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "business.reply_mode_change",
      success: true,
      target: {
        businessId: String(business._id),
        from: previousReplyMode,
        to: business.replyMode,
        autoPublishStillOff: !business.autoPublish?.enabled,
      },
    });
  }

  auditLog({
    actorId: auth.user.userId,
    actorRole: auth.user.role,
    action: "business.settings_update",
    success: true,
    target: { businessId: String(business._id) },
  });

  return NextResponse.json({
    success: true,
    business: {
      id: String(business._id),
      name: business.name,
      brandVoice: business.brandVoice,
      preferredLanguage: business.preferredLanguage,
      replyToneNotes: business.replyToneNotes || "",
      phone: business.profile?.phone || "",
      phoneScope: "tronx_internal",
      replyMode: business.replyMode,
      ownersMayChangeReplyMode: Boolean(business.ownersMayChangeReplyMode),
      autoDraftOnSync: Boolean(business.autoDraftOnSync),
      autoPublishEnabled: Boolean(business.autoPublish?.enabled),
      canEditReplyMode: canEditReplyMode(
        auth.user.role,
        business.ownersMayChangeReplyMode
      ),
    },
    message:
      "Business settings updated. Reply mode never publishes by itself; autoPublish remains separately controlled and OFF by default.",
  });
}
