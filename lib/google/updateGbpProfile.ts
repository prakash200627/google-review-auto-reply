/**
 * Google Business Profile profile/location updates.
 * Live writes require ALLOW_LIVE_GBP_PROFILE_WRITES=true AND caller confirmation.
 * Default is dry-run / local-only so shared Atlas demos stay safe.
 */

import {
  BUSINESS_INFORMATION_BASE,
  buildUrl,
  googleApiGetJson,
  googleApiPatchJson,
} from "@/lib/google/gbpClient";

export function isLiveGbpProfileWriteAllowed(
  env: Record<string, string | undefined> = process.env
): boolean {
  return String(env.ALLOW_LIVE_GBP_PROFILE_WRITES || "").trim() === "true";
}

type FetchLike = typeof fetch;

export async function patchGbpLocationPhone(input: {
  /** locations/{locationId} or accounts/.../locations/... businessInfoName */
  businessInfoName: string;
  phone: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<{ updated: true; phoneNumbers: unknown }> {
  const name = input.businessInfoName.replace(/^\/+/, "");
  const path = name.startsWith("locations/")
    ? name
    : name.includes("/locations/")
      ? `locations/${name.split("/locations/").pop()}`
      : name;
  const url = buildUrl(BUSINESS_INFORMATION_BASE, path, {
    updateMask: "phoneNumbers.primaryPhone",
  });
  const body = {
    phoneNumbers: { primaryPhone: input.phone },
  };
  const result = await googleApiPatchJson<{ phoneNumbers?: unknown }>(
    url,
    input.accessToken,
    body,
    input.fetchImpl || fetch
  );
  return { updated: true, phoneNumbers: result.phoneNumbers ?? null };
}

export async function patchGbpLocationLatLng(input: {
  businessInfoName: string;
  latitude: number;
  longitude: number;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<{ updated: true; latlng: unknown }> {
  const name = input.businessInfoName.replace(/^\/+/, "");
  const path = name.startsWith("locations/")
    ? name
    : name.includes("/locations/")
      ? `locations/${name.split("/locations/").pop()}`
      : name;
  const url = buildUrl(BUSINESS_INFORMATION_BASE, path, {
    updateMask: "latlng",
  });
  const body = {
    latlng: { latitude: input.latitude, longitude: input.longitude },
  };
  const result = await googleApiPatchJson<{ latlng?: unknown }>(
    url,
    input.accessToken,
    body,
    input.fetchImpl || fetch
  );
  return { updated: true, latlng: result.latlng ?? null };
}

export async function fetchGbpLocationSnapshot(input: {
  businessInfoName: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<Record<string, unknown>> {
  const name = input.businessInfoName.replace(/^\/+/, "");
  const path = name.startsWith("locations/")
    ? name
    : name.includes("/locations/")
      ? `locations/${name.split("/locations/").pop()}`
      : name;
  const url = buildUrl(BUSINESS_INFORMATION_BASE, path, {
    readMask: "name,title,phoneNumbers,latlng,storefrontAddress",
  });
  return googleApiGetJson<Record<string, unknown>>(
    url,
    input.accessToken,
    input.fetchImpl || fetch
  );
}
