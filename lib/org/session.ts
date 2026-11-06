import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { Organization } from "@/models/Organization";
import {
  ORG_COOKIE_MAX_AGE_SEC,
  ORG_COOKIE_NAME,
} from "@/lib/google/oauthConfig";

export type OrgSessionPayload = {
  orgId: string;
  exp: number;
};

function authSecret(): string {
  const secret = (process.env.AUTH_SECRET || "").trim();
  if (!secret || secret.length < 16) {
    throw new Error(
      "AUTH_SECRET is missing or too short. Set a long random value in .env.local."
    );
  }
  return secret;
}

function sign(body: string): string {
  return createHmac("sha256", authSecret()).update(body).digest("base64url");
}

/**
 * Encode a server-signed organization context cookie.
 * Integrity only — callers must still authorize the user for this org.
 */
export function encodeOrgSession(payload: OrgSessionPayload): string {
  if (!mongoose.isValidObjectId(payload.orgId)) {
    throw new Error("Invalid organization id for session cookie");
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("Invalid organization session expiry");
  }
  const body = Buffer.from(
    JSON.stringify({ orgId: payload.orgId, exp: payload.exp }),
    "utf8"
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * Decode and verify a signed organization cookie.
 * Rejects unsigned legacy ObjectId cookies, tampered signatures, and expiry.
 */
export function decodeOrgSession(token: string): OrgSessionPayload | null {
  const raw = String(token || "");
  // Legacy unsigned cookies were bare ObjectIds — never accept them.
  if (!raw.includes(".")) return null;

  const [body, signature] = raw.split(".");
  if (!body || !signature) return null;

  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return null;
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as OrgSessionPayload;
    if (
      !parsed?.orgId ||
      !mongoose.isValidObjectId(parsed.orgId) ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp < Date.now()) return null;
    return { orgId: parsed.orgId, exp: parsed.exp };
  } catch {
    return null;
  }
}

export function orgSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: ORG_COOKIE_MAX_AGE_SEC,
  };
}

function buildOrgCookieValue(orgId: string): string {
  return encodeOrgSession({
    orgId,
    exp: Date.now() + ORG_COOKIE_MAX_AGE_SEC * 1000,
  });
}

async function setOrgCookie(orgId: string): Promise<void> {
  const jar = await cookies();
  jar.set(ORG_COOKIE_NAME, buildOrgCookieValue(orgId), orgSessionCookieOptions());
}

/**
 * Read the provisional org id from the signed cookie and verify the org exists.
 * Never creates an organization or writes cookies — safe in Server Components.
 * A valid signature alone does not authorize the user; pair with role checks.
 */
export async function readOrganizationId(): Promise<string | null> {
  const jar = await cookies();
  const existing = jar.get(ORG_COOKIE_NAME)?.value;
  if (!existing) return null;

  const decoded = decodeOrgSession(existing);
  if (!decoded) return null;

  await connectToDatabase();
  const found = await Organization.findById(decoded.orgId).select("_id").lean();
  return found ? String(found._id) : null;
}

/**
 * Attach a signed provisional org cookie to a Route Handler response
 * (e.g. OAuth callback redirect after validated state → org binding).
 */
export function applyOrganizationCookie(
  response: NextResponse,
  orgId: string
): void {
  if (!mongoose.isValidObjectId(orgId)) {
    throw new Error("Invalid organization id for session cookie");
  }
  response.cookies.set(
    ORG_COOKIE_NAME,
    buildOrgCookieValue(orgId),
    orgSessionCookieOptions()
  );
}

/**
 * Resume only the signed cookie-bound organization.
 * Does NOT adopt another org's Google connection.
 */
export async function resumeOrganizationSession(): Promise<string | null> {
  return readOrganizationId();
}

/**
 * Ensure a provisional org exists and set a signed `tronx_org_id` cookie.
 * Uses the existing signed cookie org when present; otherwise creates a new
 * local workspace. Never steals another organization's Google-connected org id.
 * Never accepts a client-supplied org id — switching to an existing org must
 * go through `selectOrganizationSession` (Super Admin API).
 * Call only from Route Handlers or Server Actions — never from Server Components.
 *
 * Compatibility: pre-signing bare ObjectId cookies are ignored; callers must
 * re-establish org context (OAuth start / ensureOrganizationSession / select).
 */
export async function ensureOrganizationSession(): Promise<string> {
  const existing = await readOrganizationId();
  if (existing) {
    return existing;
  }

  await connectToDatabase();
  const created = await Organization.create({
    name: "Local workspace",
    email: `local-${randomUUID()}@localhost.invalid`,
    mode: "manual",
  });

  const orgId = String(created._id);
  await setOrgCookie(orgId);
  return orgId;
}

/**
 * Explicit Super Admin organization switch: bind the signed org cookie to an
 * existing organization after server-side existence check.
 * Integrity of the cookie is HMAC; authorization remains role + membership
 * checks on subsequent requests. Does not invent an allowlist — this
 * deployment treats Super Admins as operators of any existing org.
 */
export async function selectOrganizationSession(orgId: string): Promise<string> {
  if (!mongoose.isValidObjectId(orgId)) {
    throw new Error("Invalid organization id");
  }
  await connectToDatabase();
  const found = await Organization.findById(orgId).select("_id").lean();
  if (!found) {
    throw new Error("Organization not found");
  }
  const id = String(found._id);
  await setOrgCookie(id);
  return id;
}

/** Attach a selected org cookie to a Route Handler response (explicit switch). */
export function applySelectedOrganizationCookie(
  response: NextResponse,
  orgId: string
): void {
  applyOrganizationCookie(response, orgId);
}
