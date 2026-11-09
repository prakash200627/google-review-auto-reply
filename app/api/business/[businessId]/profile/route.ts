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
  assertGbpProfileWriteAllowed,
  GbpProfileWriteAuthorizationError,
  GbpProfileWriteUncertainError,
  fetchGbpLocationSnapshot,
  isLiveGbpProfileWriteAllowed,
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
    ? await Location.findOne({
        _id: locId,
        businessId: business._id,
        orgId: business.orgId,
      })
        .select(
          "title address latitude longitude businessInfoName googleLocationName"
        )
        .lean()
    : null;
  if (locId && !location) {
    return NextResponse.json(
      {
        success: false,
        code: "location_association_invalid",
        message: "The assigned location does not belong to this business and organization.",
      },
      { status: 409 }
    );
  }

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
 * Local data commits before the optional Google PATCH. A remote failure is
 * returned as an explicit partial result; local data is intentionally retained.
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
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json(
        { success: false, code: "invalid_body", message: "Request body must be a JSON object." },
        { status: 400 }
      );
    }
    body = parsed as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const allowedKeys = new Set([
    "phone", "address", "latitude", "longitude",
    "confirmLiveGoogleUpdate", "pushPhoneToGoogle", "pushGeoToGoogle",
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return NextResponse.json(
      { success: false, code: "unsupported_field", message: "Request contains an unsupported profile field." },
      { status: 400 }
    );
  }
  if (
    (body.phone !== undefined && body.phone !== null && typeof body.phone !== "string") ||
    (body.address !== undefined && typeof body.address !== "string") ||
    ([body.pushPhoneToGoogle, body.pushGeoToGoogle, body.confirmLiveGoogleUpdate]
      .some((value) => value !== undefined && typeof value !== "boolean")) ||
    ([body.latitude, body.longitude].some(
      (value) => value !== undefined && typeof value !== "number" && typeof value !== "string"
    ))
  ) {
    return NextResponse.json(
      { success: false, code: "invalid_field_type", message: "One or more profile fields have an invalid type." },
      { status: 400 }
    );
  }
  const wantPhoneGoogle = body.pushPhoneToGoogle === true;
  const wantGeoGoogle = body.pushGeoToGoogle === true;
  const wantsGoogle = wantPhoneGoogle || wantGeoGoogle;
  if (wantsGoogle && auth.user.role !== "superadmin") {
    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "business.profile_google_update",
      success: false,
      code: "forbidden",
      target: { businessId, outcome: "unauthorized_attempt" },
    });
    return NextResponse.json(
      { success: false, code: "forbidden", message: "Only a Super Admin can update a Google Business Profile." },
      { status: 403 }
    );
  }
  if (wantsGoogle && body.confirmLiveGoogleUpdate !== true) {
    return NextResponse.json(
      { success: false, code: "confirmation_required", message: "Explicit confirmation is required for a Google Business Profile update." },
      { status: 400 }
    );
  }
  if (wantGeoGoogle) {
    return NextResponse.json(
      {
        success: false,
        code: "unsupported_field",
        message: "Google coordinate updates are not enabled; coordinates can be saved to TRONX only.",
      },
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
      let storedPhone = "";
      try {
        storedPhone = normalizeBusinessPhone(business.profile?.phone);
      } catch {
        // Treat legacy invalid storage as changed so the normalized value repairs it.
      }
      if (phone !== storedPhone) {
      if (!business.profile) {
        business.profile = { description: "", website: "", phone: "" };
      }
      business.profile.phone = phone;
      tronxUpdated.phone = phone;
      }
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
  const hasLocationEdits = body.address !== undefined ||
    body.latitude !== undefined || body.longitude !== undefined;
  const location = locId
    ? await Location.findOne({
        _id: locId,
        businessId: business._id,
        orgId: business.orgId,
      }).exec()
    : null;
  if (locId && !location) {
    return NextResponse.json(
      { success: false, code: "location_association_invalid", message: "The assigned location does not belong to this business and organization." },
      { status: 409 }
    );
  }
  if (hasLocationEdits && !location) {
    return NextResponse.json(
      { success: false, code: "location_not_found", message: "This business has no assigned location to update." },
      { status: 404 }
    );
  }

  if (body.address !== undefined && location) {
    try {
      const address = normalizeAddressLine(body.address);
      let storedAddress = "";
      try {
        storedAddress = normalizeAddressLine(location.address ?? "");
      } catch {
        // Treat invalid legacy storage as changed so the normalized value repairs it.
      }
      if (address !== storedAddress) {
        location.address = address;
        tronxUpdated.address = address;
      }
    } catch (err) {
      if (err instanceof GeoValidationError) {
        return NextResponse.json({ success: false, code: err.code, message: err.message }, { status: 400 });
      }
      throw err;
    }
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
      if (
        coords.latitude !== location.latitude ||
        coords.longitude !== location.longitude
      ) {
        location.latitude = coords.latitude;
        location.longitude = coords.longitude;
        tronxUpdated.latitude = coords.latitude;
        tronxUpdated.longitude = coords.longitude;
      }
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

  const hasLocalEdits = Object.keys(tronxUpdated).length > 0;
  const hasLocalInputs =
    body.phone !== undefined ||
    body.address !== undefined ||
    body.latitude !== undefined ||
    body.longitude !== undefined;
  if (!hasLocalEdits && !wantsGoogle) {
    return NextResponse.json({
      success: true,
      local: {
        applied: false,
        status: hasLocalInputs ? "no_op" : "not_requested",
      },
      tronxUpdated,
      google: { attempted: false, applied: false, status: "not_requested" },
      message: hasLocalInputs
        ? "No profile changes were needed; the supplied values already match TRONX."
        : "No profile changes were requested.",
    });
  }
  if (hasLocalEdits) {
    await business.save();
    if (location && (body.address !== undefined || body.latitude !== undefined || body.longitude !== undefined)) {
      await location.save();
    }
  }

  const confirmLive = body.confirmLiveGoogleUpdate === true;
  let googleResult: {
    attempted: boolean;
    applied: boolean;
      status:
        | "not_requested"
        | "blocked"
        | "succeeded"
        | "failed"
        | "uncertain"
        | "no_operation"
        | "not_compared";
    skippedReason?: string;
    details?: unknown;
  } = { attempted: false, applied: false, status: "not_requested" };

  if (wantsGoogle) {
    googleResult.attempted = true;
    googleResult.status = "blocked";
    if (!isLiveGbpProfileWriteAllowed()) {
      googleResult.skippedReason = "Live Google Business Profile updates are disabled by server configuration.";
      auditLog({
        actorId: auth.user.userId,
        actorRole: auth.user.role,
        action: "business.profile_google_update",
        success: false,
        code: "google_writes_disabled",
        target: { businessId, outcome: "blocked" },
      });
    } else if (!location?.businessInfoName) {
      googleResult.skippedReason = "No assigned Google location for this outlet.";
    } else {
      const hasPhoneOperation =
        wantPhoneGoogle && Boolean(business.profile?.phone);
      if (!hasPhoneOperation) {
        googleResult.status = "not_compared";
        googleResult.skippedReason =
          "No non-empty phone was available; Google was not checked or updated.";
      } else {
        try {
          assertGbpProfileWriteAllowed({
            actorRole: auth.user.role,
            confirmed: confirmLive,
          });
          const token = await getValidAccessTokenForContext({
            orgId: String(business.orgId),
            businessId: String(business._id),
          });
          let requestedPhone: string;
          try {
            requestedPhone = normalizeBusinessPhone(business.profile?.phone);
          } catch {
            googleResult.status = "blocked";
            googleResult.skippedReason =
              "The stored phone could not be normalized safely; Google was not updated.";
            auditLog({
              actorId: auth.user.userId,
              actorRole: auth.user.role,
              action: "business.profile_google_update",
              success: false,
              code: "phone_comparison_invalid",
              target: { businessId, outcome: "blocked" },
            });
            requestedPhone = "";
          }
          if (!requestedPhone) {
            // Clearing a local number does not imply a Google delete operation.
            if (googleResult.status !== "blocked") {
              googleResult.status = "not_compared";
              googleResult.skippedReason =
                "No non-empty phone was available; Google was not checked or updated.";
            }
          } else {
            let snapshot: Record<string, unknown> | null = null;
            try {
              snapshot = await fetchGbpLocationSnapshot({
                businessInfoName: location.businessInfoName,
                accessToken: token,
              });
            } catch {
              googleResult.status = "blocked";
              googleResult.skippedReason =
                "The current Google phone could not be verified; no phone update was sent.";
              auditLog({
                actorId: auth.user.userId,
                actorRole: auth.user.role,
                action: "business.profile_google_update",
                success: false,
                code: "phone_comparison_failed",
                target: { businessId, outcome: "blocked" },
              });
            }
            const phoneNumbers = snapshot?.phoneNumbers;
            const phoneRecord =
              phoneNumbers && typeof phoneNumbers === "object" && !Array.isArray(phoneNumbers)
                ? (phoneNumbers as Record<string, unknown>)
                : null;
            const currentPrimary = phoneRecord?.primaryPhone;
            const additionalPhones = phoneRecord?.additionalPhones;
            let currentNormalized = "";
            let safeComparison = Boolean(snapshot && typeof currentPrimary === "string");
            if (safeComparison) {
              try {
                currentNormalized = normalizeBusinessPhone(currentPrimary);
              } catch {
                safeComparison = false;
              }
              if (
                additionalPhones !== undefined &&
                (!Array.isArray(additionalPhones) || additionalPhones.some((p) => typeof p !== "string"))
              ) {
                safeComparison = false;
              }
            }
            if (snapshot && !safeComparison) {
              googleResult.status = "blocked";
              googleResult.skippedReason =
                "Google phone details could not be verified safely; no phone update was sent.";
              auditLog({
                actorId: auth.user.userId,
                actorRole: auth.user.role,
                action: "business.profile_google_update",
                success: false,
                code: "phone_comparison_invalid",
                target: { businessId, outcome: "blocked" },
              });
            } else if (snapshot && currentNormalized === requestedPhone) {
              googleResult = {
                attempted: true,
                applied: false,
                status: "no_operation",
                skippedReason: "Google's current primary phone already matches (verified).",
              };
            } else if (snapshot && Array.isArray(additionalPhones) && additionalPhones.length > 0) {
              googleResult.status = "blocked";
              googleResult.skippedReason =
                "Google has additional phone numbers; the current update format cannot preserve them, so no phone update was sent.";
              auditLog({
                actorId: auth.user.userId,
                actorRole: auth.user.role,
                action: "business.profile_google_update",
                success: false,
                code: "additional_phones_preserved",
                target: { businessId, outcome: "blocked" },
              });
            } else if (snapshot && safeComparison) {
              try {
                const details = await patchGbpLocationPhone({
                  businessInfoName: location.businessInfoName,
                  phone: requestedPhone,
                  accessToken: token,
                  actorRole: auth.user.role,
                  confirmed: confirmLive,
                });
                googleResult = {
                  attempted: true,
                  applied: true,
                  status: "succeeded",
                  details: { phone: details },
                };
                auditLog({
                  actorId: auth.user.userId,
                  actorRole: auth.user.role,
                  action: "business.profile_google_update",
                  success: true,
                  code: "google_update_succeeded",
                  target: { businessId, fieldsUpdated: 1 },
                });
              } catch (err) {
                const uncertain = err instanceof GbpProfileWriteUncertainError;
                const code = err instanceof GbpProfileWriteAuthorizationError || uncertain
                  ? err.code
                  : "google_update_failed";
                googleResult = {
                  attempted: true,
                  applied: false,
                  status: uncertain ? "uncertain" : "failed",
                  skippedReason:
                    err instanceof Error
                      ? err.message.slice(0, 200)
                      : "Google profile update failed.",
                };
                auditLog({
                  actorId: auth.user.userId,
                  actorRole: auth.user.role,
                  action: "business.profile_google_update",
                  success: false,
                  code,
                  target: { businessId, localUpdateSucceeded: hasLocalEdits, outcome: uncertain ? "uncertain" : "failed" },
                });
              }
            }
          }
        } catch (err) {
          const blocked = err instanceof GbpProfileWriteAuthorizationError;
          googleResult = {
            attempted: true,
            applied: false,
            status: blocked ? "blocked" : "failed",
            skippedReason:
              err instanceof Error
                ? err.message.slice(0, 200)
                : "Google profile update could not be completed.",
          };
          auditLog({
            actorId: auth.user.userId,
            actorRole: auth.user.role,
            action: "business.profile_google_update",
            success: false,
            code:
              err instanceof GbpProfileWriteAuthorizationError
                ? err.code
                : "google_update_failed",
            target: { businessId, localUpdateSucceeded: hasLocalEdits },
          });
        }
      }
    }
  }

  if (hasLocalEdits) {
    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "business.profile_local_update",
      success: true,
      target: { businessId, fieldsUpdated: Object.keys(tronxUpdated).length },
    });
  }

  return NextResponse.json({
    success: true,
    local: {
      applied: hasLocalEdits,
      status: hasLocalEdits
        ? "succeeded"
        : hasLocalInputs
          ? "no_op"
          : "not_requested",
    },
    tronxUpdated,
    google: googleResult,
    message: googleResult.applied
      ? hasLocalEdits
        ? "TRONX changes saved and Google accepted the requested update."
        : "Google accepted the requested update."
      : googleResult.status === "failed"
        ? hasLocalEdits
          ? "TRONX changes were saved, but Google did not accept the update."
          : "Google did not accept the requested update; no TRONX fields changed."
        : googleResult.status === "no_operation"
          ? hasLocalEdits
            ? "TRONX changes were saved; Google already had the requested phone."
            : "Google already had the requested phone; no TRONX fields changed."
        : googleResult.status === "not_compared"
          ? hasLocalEdits
            ? "TRONX changes were saved; Google was not checked or updated because no non-empty phone was available."
            : "Google was not checked or updated because no non-empty phone was available."
        : googleResult.status === "blocked"
          ? hasLocalEdits
            ? "TRONX changes were saved; the Google update was blocked."
            : "The Google update was blocked; no TRONX fields changed."
          : googleResult.status === "uncertain"
            ? hasLocalEdits
              ? "TRONX changes were saved, but Google may have received the update. Reload the Google profile before trying again."
              : "Google may have received the update. Reload the Google profile before trying again."
          : hasLocalEdits
              ? "TRONX changes saved. No Google update was requested."
              : "No profile changes were requested.",
  });
}
