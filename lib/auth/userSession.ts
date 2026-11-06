import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import type { UserRole } from "@/models/User";

export const USER_COOKIE_NAME = "tronx_user_session";
const USER_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 14;

export type UserSessionPayload = {
  userId: string;
  role: UserRole;
  email: string;
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

export function encodeUserSession(payload: UserSessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function decodeUserSession(token: string): UserSessionPayload | null {
  const [body, signature] = String(token || "").split(".");
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
    ) as UserSessionPayload;
    if (
      !parsed?.userId ||
      !parsed?.role ||
      !parsed?.email ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp < Date.now()) return null;
    if (parsed.role !== "superadmin" && parsed.role !== "business_owner") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function userSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: USER_COOKIE_MAX_AGE_SEC,
  };
}

export async function readUserSession(): Promise<UserSessionPayload | null> {
  const jar = await cookies();
  const raw = jar.get(USER_COOKIE_NAME)?.value;
  if (!raw) return null;
  return decodeUserSession(raw);
}

export async function setUserSessionCookie(
  payload: Omit<UserSessionPayload, "exp">
): Promise<void> {
  const full: UserSessionPayload = {
    ...payload,
    exp: Date.now() + USER_COOKIE_MAX_AGE_SEC * 1000,
  };
  const jar = await cookies();
  jar.set(USER_COOKIE_NAME, encodeUserSession(full), userSessionCookieOptions());
}

export function applyUserSessionCookie(
  response: NextResponse,
  payload: Omit<UserSessionPayload, "exp">
): void {
  const full: UserSessionPayload = {
    ...payload,
    exp: Date.now() + USER_COOKIE_MAX_AGE_SEC * 1000,
  };
  response.cookies.set(
    USER_COOKIE_NAME,
    encodeUserSession(full),
    userSessionCookieOptions()
  );
}

export async function clearUserSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(USER_COOKIE_NAME, "", {
    ...userSessionCookieOptions(),
    maxAge: 0,
  });
}
