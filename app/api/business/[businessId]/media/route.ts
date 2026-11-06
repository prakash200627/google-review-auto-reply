import mongoose from "mongoose";
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
import {
  cloudinaryConfigStatus,
  destroyCloudinaryAsset,
  MediaUploadError,
  MEDIA_UPLOAD_LIMITS,
  uploadImageToCloudinary,
} from "@/lib/media/cloudinary";
import { connectToDatabase } from "@/lib/mongodb";
import { BusinessMedia, MEDIA_PURPOSES } from "@/models/BusinessMedia";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ businessId: string }> };

/** List TRONX media for an outlet (not live Google photos). */
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
  const access = await assertBusinessAccess(auth.user, businessId);
  if (!access.ok) return access.response;

  await connectToDatabase();
  const rows = await BusinessMedia.find({ businessId })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return NextResponse.json({
    success: true,
    cloudinary: cloudinaryConfigStatus(),
    note: "These are TRONX media assets. Uploading here does NOT update Google Business Profile photos.",
    media: rows.map((m) => ({
      id: String(m._id),
      purpose: m.purpose,
      secureUrl: m.secureUrl,
      mimeType: m.mimeType,
      bytes: m.bytes,
      width: m.width,
      height: m.height,
      originalFilename: m.originalFilename || "",
      createdAt: m.createdAt
        ? new Date(m.createdAt as Date).toISOString()
        : null,
    })),
  });
}

/** Owner/SA upload — Cloudinary server-side only. */
export async function POST(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, message: "Invalid business id." },
      { status: 400 }
    );
  }
  const access = await assertBusinessAccess(auth.user, businessId);
  if (!access.ok) return access.response;

  if (
    auth.user.role !== "superadmin" &&
    !lifecycleAllowsOwnerAccess(access.business)
  ) {
    return NextResponse.json(
      {
        success: false,
        code: "business_lifecycle_blocked",
        message: `Business is ${resolveBusinessLifecycle(access.business)}.`,
      },
      { status: 403 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { success: false, message: "Expected multipart form data." },
      { status: 400 }
    );
  }

  const file = form.get("file");
  const purposeRaw = String(form.get("purpose") || "internal");
  const purpose = MEDIA_PURPOSES.includes(purposeRaw as never)
    ? (purposeRaw as (typeof MEDIA_PURPOSES)[number])
    : "internal";

  if (!(file instanceof File)) {
    return NextResponse.json(
      { success: false, message: "file is required." },
      { status: 400 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";
    const uploaded = await uploadImageToCloudinary({
      buffer,
      mimeType,
      folder: `tronx/business/${businessId}`,
    });

    await connectToDatabase();
    const doc = await BusinessMedia.create({
      businessId,
      orgId: access.business.orgId,
      purpose,
      cloudinaryPublicId: uploaded.public_id,
      secureUrl: uploaded.secure_url,
      mimeType,
      bytes: uploaded.bytes || buffer.byteLength,
      width: uploaded.width ?? null,
      height: uploaded.height ?? null,
      originalFilename: String(file.name || "").slice(0, 200),
      uploadedByUserId: auth.user.userId,
    });

    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "business.media_upload",
      success: true,
      target: {
        businessId,
        mediaId: String(doc._id),
        purpose,
        bytes: doc.bytes,
      },
    });

    return NextResponse.json({
      success: true,
      media: {
        id: String(doc._id),
        purpose: doc.purpose,
        secureUrl: doc.secureUrl,
      },
      note:
        purpose === "gbp_candidate"
          ? "Marked as a GBP candidate in TRONX only — Google photos were not changed."
          : "Internal TRONX media asset. Google Business Profile was not updated.",
      limits: MEDIA_UPLOAD_LIMITS,
    });
  } catch (err) {
    if (err instanceof MediaUploadError) {
      return NextResponse.json(
        { success: false, code: err.code, message: err.message },
        { status: err.status }
      );
    }
    console.error(
      "Media upload failed:",
      err instanceof Error ? err.message : "unknown"
    );
    return NextResponse.json(
      { success: false, message: "Could not upload media." },
      { status: 500 }
    );
  }
}

/** Delete TRONX media (and Cloudinary asset when configured). */
export async function DELETE(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, message: "Invalid business id." },
      { status: 400 }
    );
  }
  const access = await assertBusinessAccess(auth.user, businessId);
  if (!access.ok) return access.response;

  let body: { mediaId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }
  const mediaId = String(body.mediaId || "");
  if (!mongoose.isValidObjectId(mediaId)) {
    return NextResponse.json(
      { success: false, message: "mediaId is required." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const doc = await BusinessMedia.findOne({ _id: mediaId, businessId }).exec();
  if (!doc) {
    return NextResponse.json(
      { success: false, message: "Media not found." },
      { status: 404 }
    );
  }

  await destroyCloudinaryAsset({ publicId: doc.cloudinaryPublicId });
  await BusinessMedia.deleteOne({ _id: doc._id, businessId });

  auditLog({
    actorId: auth.user.userId,
    actorRole: auth.user.role,
    action: "business.media_delete",
    success: true,
    target: { businessId, mediaId },
  });

  return NextResponse.json({
    success: true,
    message: "TRONX media removed. Google Business Profile photos were not changed.",
  });
}
