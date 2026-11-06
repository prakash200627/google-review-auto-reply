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
  GeoValidationError,
  normalizeAddressLine,
  normalizeCoordinates,
} from "@/lib/business/geo";
import {
  normalizeBusinessPhone,
  PhoneValidationError,
} from "@/lib/business/phone";
import { getValidAccessTokenForContext } from "@/lib/google/accessToken";
import {
  isLiveGbpProfileWriteAllowed,
  patchGbpLocationLatLng,
  patchGbpLocationPhone,
} from "@/lib/google/updateGbpProfile";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { Location } from "@/models/Location";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ businessId: string }> };

/**
 * Read TRONX vs Google-facing profile fields for one outlet.
 * Google snapshot is optional and never returns tokens.
 */
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
  const business = await Business.findById(businessId)
    .select("name profile locationIds orgId")
    .lean();
  if (!business) {
    return NextResponse.json(
      { success: false, message: "Business not found." },
      { status: 404 }
    );
  }
  const locId = (business.locationIds || [])[0];
  const location = locId
    ? await Location.findById(locId)
        .select(
          "title address latitude longitude businessInfoName googleLocationName"
        )
        .lean()
    : null;

  return NextResponse.json({
    success: true,
    liveGoogleWritesAllowed: isLiveGbpProfileWriteAllowed(),
    tronx: {
      phone: business.profile?.phone || "",
      address: location?.address || "",
      latitude:
        typeof location?.latitude === "number" ? location.latitude : null,
      longitude:
        typeof location?.longitude === "number" ? location.longitude : null,
    },
    googleAssignedLocation: location
      ? {
          title: location.title || "",
          businessInfoName: location.businessInfoName || "",
          googleLocationName: location.googleLocationName || "",
        }
      : null,
    note: "TRONX fields are local. Pushing to Google requires ALLOW_LIVE_GBP_PROFILE_WRITES=true and confirmLiveGoogleUpdate=true.",
  });
}

/**
 * Update TRONX profile fields and optionally push to Google when explicitly enabled.
 */
export async function PATCH(request: Request, context: RouteContext) {
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

  let body: {
    phone?: unknown;
    address?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    confirmLiveGoogleUpdate?: unknown;
    pushPhoneToGoogle?: unknown;
    pushGeoToGoogle?: unknown;
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

  const tronxUpdated: Record<string, string | number | null> = {};
  if (body.phone !== undefined) {
    try {
      const phone = normalizeBusinessPhone(body.phone);
      if (!business.profile) {
        business.profile = { description: "", website: "", phone: "" };
      }
      business.profile.phone = phone;
      tronxUpdated.phone = phone;
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

  const locId = (business.locationIds || [])[0];
  let location = locId ? await Location.findById(locId).exec() : null;

  if (body.address !== undefined && location) {
    location.address = normalizeAddressLine(body.address);
    tronxUpdated.address = location.address;
  }
  if (
    (body.latitude !== undefined || body.longitude !== undefined) &&
    location
  ) {
    try {
      const coords = normalizeCoordinates({
        latitude:
          body.latitude !== undefined ? body.latitude : location.latitude,
        longitude:
          body.longitude !== undefined ? body.longitude : location.longitude,
      });
      location.latitude = coords.latitude;
      location.longitude = coords.longitude;
      tronxUpdated.latitude = coords.latitude;
      tronxUpdated.longitude = coords.longitude;
    } catch (err) {
      if (err instanceof GeoValidationError) {
        return NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: 400 }
        );
      }
      throw err;
    }
  }

  await business.save();
  if (location) await location.save();

  const wantPhoneGoogle = body.pushPhoneToGoogle === true;
  const wantGeoGoogle = body.pushGeoToGoogle === true;
  const confirmLive = body.confirmLiveGoogleUpdate === true;
  let googleResult: {
    attempted: boolean;
    applied: boolean;
    skippedReason?: string;
    details?: unknown;
  } = { attempted: false, applied: false };

  if (wantPhoneGoogle || wantGeoGoogle) {
    googleResult.attempted = true;
    if (!isLiveGbpProfileWriteAllowed()) {
      googleResult.skippedReason =
        "ALLOW_LIVE_GBP_PROFILE_WRITES is not true — Google was not modified.";
    } else if (!confirmLive) {
      googleResult.skippedReason =
        "confirmLiveGoogleUpdate=true is required for live GBP writes.";
    } else if (!location?.businessInfoName) {
      googleResult.skippedReason = "No assigned Google location for this outlet.";
    } else {
      try {
        const token = await getValidAccessTokenForContext({
          orgId: String(business.orgId),
          businessId: String(business._id),
        });
        const details: Record<string, unknown> = {};
        if (wantPhoneGoogle && business.profile?.phone) {
          details.phone = await patchGbpLocationPhone({
            businessInfoName: location.businessInfoName,
            phone: business.profile.phone,
            accessToken: token,
          });
        }
        if (
          wantGeoGoogle &&
          typeof location.latitude === "number" &&
          typeof location.longitude === "number"
        ) {
          details.geo = await patchGbpLocationLatLng({
            businessInfoName: location.businessInfoName,
            latitude: location.latitude,
            longitude: location.longitude,
            accessToken: token,
          });
        }
        googleResult = { attempted: true, applied: true, details };
      } catch (err) {
        auditLog({
          actorId: auth.user.userId,
          actorRole: auth.user.role,
          action: "business.profile_google_update",
          success: false,
          code: "google_update_failed",
          target: { businessId },
        });
        return NextResponse.json(
          {
            success: false,
            code: "google_update_failed",
            message:
              err instanceof Error
                ? err.message.slice(0, 200)
                : "Google profile update failed.",
            tronxUpdated,
          },
          { status: 502 }
        );
      }
    }
  }

  auditLog({
    actorId: auth.user.userId,
    actorRole: auth.user.role,
    action: "business.profile_update",
    success: true,
    target: {
      businessId,
      googleApplied: googleResult.applied,
    },
  });

  return NextResponse.json({
    success: true,
    tronxUpdated,
    google: googleResult,
    message: googleResult.applied
      ? "TRONX saved and Google confirmed the update."
      : "TRONX fields saved. Google was not modified unless explicitly enabled and confirmed.",
  });
}
