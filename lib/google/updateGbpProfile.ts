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
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { createHash } from "node:crypto";
import { normalizeBusinessPhone } from "@/lib/business/phone";

export function isLiveGbpProfileWriteAllowed(
  env: Record<string, string | undefined> = process.env
): boolean {
  return String(env.ALLOW_LIVE_GBP_PROFILE_WRITES || "").trim() === "true";
}

export class GbpProfileWriteAuthorizationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "GbpProfileWriteAuthorizationError";
    this.code = code;
    this.status = status;
  }
}

/** Defense in depth for every remote profile write entry point. */
export function assertGbpProfileWriteAllowed(input: {
  actorRole: string;
  confirmed: boolean;
  env?: Record<string, string | undefined>;
}): void {
  if (input.actorRole !== "superadmin") {
    throw new GbpProfileWriteAuthorizationError(
      "Only a Super Admin can update a Google Business Profile.",
      "forbidden",
      403
    );
  }
  if (!input.confirmed) {
    throw new GbpProfileWriteAuthorizationError(
      "Explicit confirmation is required for a Google Business Profile update.",
      "confirmation_required",
      400
    );
  }
  if (!isLiveGbpProfileWriteAllowed(input.env)) {
    throw new GbpProfileWriteAuthorizationError(
      "Live Google Business Profile updates are disabled by server configuration.",
      "google_writes_disabled",
      503
    );
  }
}

type FetchLike = typeof fetch;
export const GBP_PROFILE_PATCH_TIMEOUT_MS = 20_000;

export class GbpProfileWriteUncertainError extends Error {
  readonly code = "google_write_uncertain";
  readonly status: number;
  constructor(message = "Google may have received this profile update, but its result is uncertain. Reload the Google profile before attempting another update.", status = 502) {
    super(message);
    this.name = "GbpProfileWriteUncertainError";
    this.status = status;
  }
}

async function patchGoogleProfileJson<T>(input: {
  url: string; accessToken: string; body: unknown; fetchImpl: FetchLike;
}): Promise<T> {
  let requestStarted = false;
  const signal = AbortSignal.timeout(GBP_PROFILE_PATCH_TIMEOUT_MS);
  const boundedFetch: FetchLike = (resource, init) => {
    requestStarted = true;
    return input.fetchImpl(resource, { ...init, signal });
  };
  try {
    return await googleApiPatchJson<T>(input.url, input.accessToken, input.body, boundedFetch, { retry: false });
  } catch (err) {
    if (err instanceof GoogleBusinessApiError && err.status < 500) throw err;
    if (!requestStarted) throw err;
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new GbpProfileWriteUncertainError(
      timedOut
        ? "The Google profile update timed out. Google may have received it; reload the profile before attempting another update."
        : "The connection failed after the Google profile update was sent. Google may have received it; reload the profile before attempting another update.",
      timedOut ? 504 : 502,
    );
  }
}

export async function patchGbpLocationPhone(input: {
  /** locations/{locationId} or accounts/.../locations/... businessInfoName */
  businessInfoName: string;
  phone: string;
  accessToken: string;
  actorRole: string;
  confirmed: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}): Promise<{ updated: true; phoneNumbers: unknown }> {
  assertGbpProfileWriteAllowed(input);
  const name = input.businessInfoName.replace(/^\/+/, "");
  const path = name.startsWith("locations/")
    ? name
    : name.includes("/locations/")
      ? `locations/${name.split("/locations/").pop()}`
      : name;
  const url = buildUrl(BUSINESS_INFORMATION_BASE, path, {
    updateMask: "phoneNumbers",
  });
  const body = {
    phoneNumbers: { primaryPhone: input.phone, additionalPhones: [] },
  };
  const result = await patchGoogleProfileJson<{ phoneNumbers?: unknown }>({ url, accessToken: input.accessToken, body, fetchImpl: input.fetchImpl || fetch });
  return { updated: true, phoneNumbers: result.phoneNumbers ?? null };
}

export async function patchGbpLocationLatLng(input: {
  businessInfoName: string;
  latitude: number;
  longitude: number;
  accessToken: string;
  actorRole: string;
  confirmed: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}): Promise<{ updated: true; latlng: unknown }> {
  void input;
  throw new GbpProfileWriteAuthorizationError(
    "Google coordinate updates are disabled until approved-client eligibility is confirmed.",
    "unsupported_field",
    400
  );
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
    readMask: "name,title,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,specialHours",
  });
  return googleApiGetJson<Record<string, unknown>>(
    url,
    input.accessToken,
    input.fetchImpl || fetch
  );
}

export type GbpEditableProfile = {
  title: string;
  phoneNumbers: { primaryPhone: string; additionalPhones: string[] };
  websiteUri: string;
  categories: { primaryCategory: { name: string }; additionalCategories: { name: string }[] };
  storefrontAddress: {
    revision: number;
    languageCode?: string;
    sublocality?: string;
    sortingCode?: string;
    addressLines: string[];
    locality: string;
    administrativeArea: string;
    postalCode: string;
    regionCode: string;
    recipients?: string[];
    organization?: string;
  };
  regularHours: { periods: Array<Record<string, unknown>> };
  specialHours: { specialHourPeriods: Array<Record<string, unknown>> };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

export function normalizeGbpProfile(raw: Record<string, unknown>): GbpEditableProfile {
  const phones = record(raw.phoneNumbers);
  const categories = record(raw.categories);
  const primaryCategory = record(categories.primaryCategory);
  const address = record(raw.storefrontAddress);
  const regular = record(raw.regularHours);
  const special = record(raw.specialHours);
  const categoryList = Array.isArray(categories.additionalCategories) ? categories.additionalCategories : [];
  const phoneList = Array.isArray(phones.additionalPhones) ? phones.additionalPhones : [];
  return {
    title: text(raw.title),
    phoneNumbers: { primaryPhone: text(phones.primaryPhone), additionalPhones: phoneList.filter((x): x is string => typeof x === "string") },
    websiteUri: text(raw.websiteUri),
    categories: {
      primaryCategory: { name: text(primaryCategory.name) },
      additionalCategories: categoryList.map((x) => ({ name: text(record(x).name) })).filter((x) => x.name),
    },
    storefrontAddress: {
      revision: typeof address.revision === "number" ? address.revision : 0,
      ...(typeof address.languageCode === "string" ? { languageCode: address.languageCode } : {}),
      ...(typeof address.sublocality === "string" ? { sublocality: address.sublocality } : {}),
      ...(typeof address.sortingCode === "string" ? { sortingCode: address.sortingCode } : {}),
      addressLines: Array.isArray(address.addressLines) ? address.addressLines.filter((x): x is string => typeof x === "string") : [],
      locality: text(address.locality), administrativeArea: text(address.administrativeArea),
      postalCode: text(address.postalCode), regionCode: text(address.regionCode),
      ...(Array.isArray(address.recipients) ? { recipients: address.recipients.filter((x): x is string => typeof x === "string") } : {}),
      ...(typeof address.organization === "string" ? { organization: address.organization } : {}),
    },
    regularHours: { periods: Array.isArray(regular.periods) ? regular.periods as Array<Record<string, unknown>> : [] },
    specialHours: { specialHourPeriods: Array.isArray(special.specialHourPeriods) ? special.specialHourPeriods as Array<Record<string, unknown>> : [] },
  };
}

export function gbpProfileFingerprint(profile: GbpEditableProfile): string {
  return createHash("sha256").update(stableSerialize(profile)).digest("hex");
}

function normalizedPhone(value: string): string {
  try { return normalizeBusinessPhone(value); } catch { return value.trim(); }
}

function comparableHours(value: { periods: Array<Record<string, unknown>> } | { specialHourPeriods: Array<Record<string, unknown>> }): string {
  const periods = "periods" in value ? value.periods : value.specialHourPeriods;
  const normalized = periods.map((period) => {
    const copy = { ...period };
    for (const key of ["openTime", "closeTime"]) {
      if (copy[key] && typeof copy[key] === "object") {
        const time = record(copy[key]);
        copy[key] = { ...time, hours: time.hours ?? 0, minutes: time.minutes ?? 0 };
      }
    }
    return copy;
  }).sort((a, b) => stableSerialize(a).localeCompare(stableSerialize(b)));
  return stableSerialize(normalized);
}

function groupMatches(field: string, expected: GbpEditableProfile, actual: GbpEditableProfile): boolean {
  switch (field) {
    case "Business name": return expected.title.trim() === actual.title.trim();
    case "Phone numbers": {
      const expectedPhones = { primaryPhone: normalizedPhone(expected.phoneNumbers.primaryPhone), additionalPhones: expected.phoneNumbers.additionalPhones.map(normalizedPhone).sort() };
      const actualPhones = { primaryPhone: normalizedPhone(actual.phoneNumbers.primaryPhone), additionalPhones: actual.phoneNumbers.additionalPhones.map(normalizedPhone).sort() };
      return stableSerialize(expectedPhones) === stableSerialize(actualPhones);
    }
    case "Website": return expected.websiteUri.trim() === actual.websiteUri.trim();
    case "Business categories": {
      const expectedCategories = { primary: expected.categories.primaryCategory.name.toLowerCase(), additional: expected.categories.additionalCategories.map((x) => x.name.toLowerCase()).sort() };
      const actualCategories = { primary: actual.categories.primaryCategory.name.toLowerCase(), additional: actual.categories.additionalCategories.map((x) => x.name.toLowerCase()).sort() };
      return stableSerialize(expectedCategories) === stableSerialize(actualCategories);
    }
    case "Storefront address": {
      const normalizeAddress = (a: GbpEditableProfile["storefrontAddress"]) => ({
        ...a,
        addressLines: a.addressLines.map((x) => x.trim()),
        locality: a.locality.trim(), administrativeArea: a.administrativeArea.trim(),
        postalCode: a.postalCode.trim(), regionCode: a.regionCode.trim().toUpperCase(),
        ...(a.languageCode === undefined ? {} : { languageCode: a.languageCode.trim() }),
        ...(a.sublocality === undefined ? {} : { sublocality: a.sublocality.trim() }),
        ...(a.sortingCode === undefined ? {} : { sortingCode: a.sortingCode.trim() }),
        ...(a.organization === undefined ? {} : { organization: a.organization.trim() }),
        ...(a.recipients === undefined ? {} : { recipients: a.recipients.map((x) => x.trim()) }),
      });
      return stableSerialize(normalizeAddress(expected.storefrontAddress)) === stableSerialize(normalizeAddress(actual.storefrontAddress));
    }
    case "Regular business hours": return comparableHours(expected.regularHours) === comparableHours(actual.regularHours);
    case "Special hours": return comparableHours(expected.specialHours) === comparableHours(actual.specialHours);
    default: return false;
  }
}

export function getGbpProfileReadbackMismatches(
  expected: GbpEditableProfile,
  actual: GbpEditableProfile,
  changedFields: string[],
): string[] {
  return changedFields.filter((field) => !groupMatches(field, expected, actual));
}

const GCID_RE = /^gcid:[a-z0-9_]+$/i;
const DAYS = new Set(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]);
function validTimeOfDay(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const time = record(value);
  if (Object.keys(time).some((key) => !["hours", "minutes"].includes(key))) return false;
  if (Object.keys(time).length === 0) return true; // Proto3 JSON omits zero-valued midnight fields.
  if ((time.hours !== undefined && typeof time.hours !== "number") || (time.minutes !== undefined && typeof time.minutes !== "number")) return false;
  const hours = time.hours ?? 0; const minutes = time.minutes ?? 0;
  return Number.isInteger(hours) && hours >= 0 && hours <= 24 && Number.isInteger(minutes) && minutes >= 0 && minutes < 60 && (hours !== 24 || minutes === 0);
}

function validDate(value: Record<string, unknown>): boolean {
  const { year, month, day } = value;
  if (![year, month, day].every(Number.isInteger)) return false;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === year && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === day;
}

export type GbpProfileValidationIssue = { field: string; message: string };

export function validateGbpProfile(profile: GbpEditableProfile, changedFields?: string[]): GbpProfileValidationIssue[] {
  const issues: GbpProfileValidationIssue[] = [];
  const issue = (field: string, message: string) => issues.push({ field, message });
  const validate = (field: string) => changedFields === undefined || changedFields.includes(field);
  if (validate("Business name") && !profile.title.trim()) issue("title", "Business name cannot be empty.");
  if (validate("Phone numbers")) {
    const phones = [profile.phoneNumbers.primaryPhone, ...profile.phoneNumbers.additionalPhones].filter(Boolean);
    try {
      const normalized = phones.map((phone) => normalizeBusinessPhone(phone));
      if (new Set(normalized).size !== normalized.length) issue("phoneNumbers", "Primary and additional phone numbers must be unique.");
    } catch { issue("phoneNumbers", "Phone numbers must use valid digits and standard phone formatting."); }
    if (profile.phoneNumbers.additionalPhones.length > 2) issue("phoneNumbers.additionalPhones", "Google supports at most two additional phone numbers.");
  }
  if (validate("Website") && profile.websiteUri) {
    try { const url = new URL(profile.websiteUri); if (!["http:", "https:"].includes(url.protocol) || !url.hostname) issue("websiteUri", "Website must be a valid HTTP or HTTPS URL."); }
    catch { issue("websiteUri", "Website must be a valid HTTP or HTTPS URL."); }
  }
  if (validate("Business categories")) {
    if (!GCID_RE.test(profile.categories.primaryCategory.name)) issue("categories.primaryCategory.name", "Primary category must use a Google category id such as gcid:restaurant.");
    if (profile.categories.additionalCategories.some((x) => !GCID_RE.test(x.name))) issue("categories.additionalCategories", "Additional categories must use valid Google category ids.");
  }
  const address = profile.storefrontAddress;
  const hasAddress = address.addressLines.length || address.locality || address.administrativeArea || address.postalCode || address.regionCode;
  if (validate("Storefront address")) {
    if (address.revision !== 0) issue("storefrontAddress.revision", "Postal address revision must be 0.");
    if (hasAddress && !address.addressLines.some((line) => line.trim())) issue("storefrontAddress.addressLines", "A storefront address needs a street line.");
    if (hasAddress && !/^[A-Z]{2}$/.test(address.regionCode)) issue("storefrontAddress.regionCode", "A storefront address needs a two-letter country code.");
    if (address.addressLines.length > 5 || address.addressLines.some((x) => !x.trim())) issue("storefrontAddress.addressLines", "Address requires one to five non-empty street lines.");
  }
  if (validate("Regular business hours") || validate("Special hours")) {
    const dayOrder = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
    const intervals: Array<{ start: number; end: number }> = [];
    for (const period of profile.regularHours.periods) {
      const openDay = dayOrder.indexOf(String(period.openDay)); const closeDay = dayOrder.indexOf(String(period.closeDay));
      const openTime = record(period.openTime); const closeTime = record(period.closeTime);
      const openMinutes = Number(openTime.hours ?? 0) * 60 + Number(openTime.minutes ?? 0);
      const closeMinutes = Number(closeTime.hours ?? 0) * 60 + Number(closeTime.minutes ?? 0);
      const dayDelta = (closeDay - openDay + 7) % 7;
      const duration = dayDelta * 1440 + closeMinutes - openMinutes;
      if (!DAYS.has(String(period.openDay)) || !DAYS.has(String(period.closeDay)) || !validTimeOfDay(period.openTime) || !validTimeOfDay(period.closeTime) || duration <= 0 || duration > 1440) {
        issue("regularHours.periods", "Each regular-hours period needs valid open and close days and times, closes after opening, and spans no more than 24 hours.");
      } else {
        intervals.push({ start: openDay * 1440 + openMinutes, end: openDay * 1440 + openMinutes + duration });
      }
    }
    const weekMinutes = 7 * 1440;
    for (let i = 0; i < intervals.length; i++) for (let j = i + 1; j < intervals.length; j++) {
      if ([-weekMinutes, 0, weekMinutes].some((shift) => Math.max(intervals[i].start, intervals[j].start + shift) < Math.min(intervals[i].end, intervals[j].end + shift))) {
        issue("regularHours.periods", "Regular-hours periods cannot overlap.");
      }
    }
  }
  if (validate("Special hours")) for (const period of profile.specialHours.specialHourPeriods) {
    const start = record(period.startDate); const end = record(period.endDate);
    if (!validDate(start)) issue("specialHours.specialHourPeriods.startDate", "Each special-hours period needs a valid start date.");
    if (period.closed !== true && (!validTimeOfDay(period.openTime) || !validTimeOfDay(period.closeTime))) issue("specialHours.specialHourPeriods", "Open special-hours periods need valid open and close times.");
    if (Object.keys(end).length && !validDate(end)) issue("specialHours.specialHourPeriods.endDate", "Special-hours end dates must be valid.");
    if (Object.keys(end).length && validDate(start) && validDate(end)) {
      const startDate = Date.UTC(Number(start.year), Number(start.month) - 1, Number(start.day));
      const endDate = Date.UTC(Number(end.year), Number(end.month) - 1, Number(end.day));
      if (endDate < startDate || endDate - startDate > 86_400_000) issue("specialHours.specialHourPeriods.endDate", "Special-hours end date must be the start date or the following day.");
    }
    if (period.closed !== true && validDate(start) && (!Object.keys(end).length || validDate(end))) {
      const closeDate = Object.keys(end).length ? end : start;
      const dateDelta = (Date.UTC(Number(closeDate.year), Number(closeDate.month) - 1, Number(closeDate.day)) - Date.UTC(Number(start.year), Number(start.month) - 1, Number(start.day))) / 86_400_000;
      const openTime = record(period.openTime); const closeTime = record(period.closeTime);
      const openMinutes = Number(openTime.hours ?? 0) * 60 + Number(openTime.minutes ?? 0);
      const closeMinutes = Number(closeTime.hours ?? 0) * 60 + Number(closeTime.minutes ?? 0);
      const duration = dateDelta * 1440 + closeMinutes - openMinutes;
      if (duration <= 0 || duration >= 1440 || (dateDelta === 1 && closeMinutes > 11 * 60 + 59)) issue("specialHours.specialHourPeriods", "Open special hours must close after opening and last less than 24 hours (by 11:59 a.m. the next day at the latest).");
    }
  }
  if (validate("Special hours") && profile.specialHours.specialHourPeriods.length && !profile.regularHours.periods.length) issue("regularHours.periods", "Regular business hours are required when special hours are set.");
  return issues.filter((item, index) => issues.findIndex((x) => x.field === item.field && x.message === item.message) === index);
}

export function buildGbpProfilePatch(current: GbpEditableProfile, proposed: GbpEditableProfile): { body: Record<string, unknown>; updateMask: string; changedFields: string[] } {
  const body: Record<string, unknown> = {};
  const masks: string[] = [];
  const changedFields: string[] = [];
  if (stableSerialize(current.title) !== stableSerialize(proposed.title)) { body.title = proposed.title.trim(); masks.push("title"); changedFields.push("Business name"); }
  if (stableSerialize(current.phoneNumbers) !== stableSerialize(proposed.phoneNumbers)) { body.phoneNumbers = proposed.phoneNumbers; masks.push("phoneNumbers"); changedFields.push("Phone numbers"); }
  if (stableSerialize(current.websiteUri) !== stableSerialize(proposed.websiteUri)) { body.websiteUri = proposed.websiteUri; masks.push("websiteUri"); changedFields.push("Website"); }
  if (stableSerialize(current.categories) !== stableSerialize(proposed.categories)) { body.categories = proposed.categories; masks.push("categories"); changedFields.push("Business categories"); }
  if (stableSerialize(current.storefrontAddress) !== stableSerialize(proposed.storefrontAddress)) { body.storefrontAddress = proposed.storefrontAddress; masks.push("storefrontAddress"); changedFields.push("Storefront address"); }
  if (stableSerialize(current.regularHours) !== stableSerialize(proposed.regularHours) || stableSerialize(current.specialHours) !== stableSerialize(proposed.specialHours)) {
    body.regularHours = proposed.regularHours;
    masks.push("regularHours"); changedFields.push("Regular business hours");
    if (stableSerialize(current.specialHours) !== stableSerialize(proposed.specialHours)) { body.specialHours = proposed.specialHours; masks.push("specialHours"); changedFields.push("Special hours"); }
  }
  return { body, updateMask: masks.join(","), changedFields };
}

export async function patchGbpLocationProfile(input: {
  businessInfoName: string; body: Record<string, unknown>; updateMask: string;
  accessToken: string; actorRole: string; confirmed: boolean; env?: Record<string, string | undefined>; fetchImpl?: FetchLike;
}): Promise<Record<string, unknown>> {
  assertGbpProfileWriteAllowed(input);
  if (!input.updateMask) return {};
  const name = input.businessInfoName.replace(/^\/+/, "");
  const path = name.startsWith("locations/") ? name : name.includes("/locations/") ? `locations/${name.split("/locations/").pop()}` : name;
  return patchGoogleProfileJson<Record<string, unknown>>({
    url: buildUrl(BUSINESS_INFORMATION_BASE, path, { updateMask: input.updateMask }),
    accessToken: input.accessToken,
    body: input.body,
    fetchImpl: input.fetchImpl || fetch,
  });
}
