import { NextResponse } from "next/server";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  USER_COOKIE_NAME,
  userSessionCookieOptions,
} from "@/lib/auth/userSession";
import { ORG_COOKIE_NAME } from "@/lib/google/oauthConfig";
import { orgSessionCookieOptions } from "@/lib/org/session";

export const runtime = "nodejs";

/** Clear signed-in user session (and provisional org cookie for a clean sign-out). */
export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const response = NextResponse.json({ success: true });
  response.cookies.set(USER_COOKIE_NAME, "", {
    ...userSessionCookieOptions(),
    maxAge: 0,
  });
  response.cookies.set(ORG_COOKIE_NAME, "", {
    ...orgSessionCookieOptions(),
    maxAge: 0,
  });
  return response;
}
