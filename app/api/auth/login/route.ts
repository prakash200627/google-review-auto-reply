import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clientIpFromRequest,
  recordLoginFailure,
} from "@/lib/auth/loginRateLimit";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { applyUserSessionCookie } from "@/lib/auth/userSession";
import { lifecycleAllowsOwnerAccess } from "@/lib/business/lifecycle";
import { applyOrganizationCookie } from "@/lib/org/session";
import { Business } from "@/models/Business";
import { User } from "@/models/User";

/** Bind owner org cookie from their first active business (platform Google). */
async function applyOwnerOrgCookieIfNeeded(
  response: NextResponse,
  userId: string,
  role: string,
  businessIds: unknown[]
): Promise<void> {
  if (role !== "business_owner") return;
  const ids = (businessIds || []).map((id) => String(id));
  const businesses = await Business.find({
    $or: [{ _id: { $in: ids } }, { ownerUserId: userId }],
  })
    .select("orgId active status")
    .lean();
  for (const biz of businesses) {
    if (!lifecycleAllowsOwnerAccess(biz)) continue;
    if (biz.orgId) {
      applyOrganizationCookie(response, String(biz.orgId));
      return;
    }
  }
}

export const runtime = "nodejs";

const INVALID_CREDENTIALS = "Invalid email or password.";

function tooManyAttempts(retryAfterSec: number) {
  const response = NextResponse.json(
    {
      success: false,
      code: "rate_limited",
      message: "Too many login attempts. Try again later.",
      retryAfterSec,
    },
    { status: 429 }
  );
  response.headers.set("Retry-After", String(retryAfterSec));
  return response;
}

/**
 * Email/password login for Super Admin and business owners.
 * Optionally bootstraps the first Super Admin from env when no users exist.
 *
 * Failed attempts are throttled in-memory (see loginRateLimit.ts). Responses
 * never reveal whether an email is registered.
 */
export async function POST(request: Request) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  let email = "";
  let password = "";
  try {
    const body = (await request.json()) as {
      email?: unknown;
      password?: unknown;
    };
    email = String(body.email || "")
      .trim()
      .toLowerCase();
    password = String(body.password || "");
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  if (!email || !password) {
    return NextResponse.json(
      { success: false, message: "Email and password are required." },
      { status: 400 }
    );
  }

  const ip = clientIpFromRequest(request);
  const limit = checkLoginRateLimit({ ip, email });
  if (!limit.allowed) {
    return tooManyAttempts(limit.retryAfterSec);
  }

  try {
    await connectToDatabase();

    const userCount = await User.countDocuments({});
    if (userCount === 0) {
      const bootstrapEmail = (process.env.SUPERADMIN_EMAIL || "")
        .trim()
        .toLowerCase();
      const bootstrapPassword = process.env.SUPERADMIN_PASSWORD || "";
      if (
        bootstrapEmail &&
        bootstrapPassword &&
        email === bootstrapEmail &&
        password === bootstrapPassword
      ) {
        const created = await User.create({
          email: bootstrapEmail,
          name: "Super Admin",
          passwordHash: hashPassword(bootstrapPassword),
          role: "superadmin",
          businessIds: [],
          active: true,
        });
        clearLoginFailures({ ip, email });
        const response = NextResponse.json({
          success: true,
          user: {
            id: String(created._id),
            email: created.email,
            role: created.role,
          },
        });
        applyUserSessionCookie(response, {
          userId: String(created._id),
          role: "superadmin",
          email: created.email,
        });
        return response;
      }
    }

    const user = await User.findOne({ email, active: true })
      .select("+passwordHash email role businessIds")
      .exec();

    if (!user || !verifyPassword(password, user.passwordHash)) {
      recordLoginFailure({ ip, email });
      return NextResponse.json(
        { success: false, message: INVALID_CREDENTIALS },
        { status: 401 }
      );
    }

    clearLoginFailures({ ip, email });
    const response = NextResponse.json({
      success: true,
      user: {
        id: String(user._id),
        email: user.email,
        role: user.role,
      },
    });
    applyUserSessionCookie(response, {
      userId: String(user._id),
      role: user.role as "superadmin" | "business_owner",
      email: user.email,
    });
    await applyOwnerOrgCookieIfNeeded(
      response,
      String(user._id),
      String(user.role),
      user.businessIds || []
    );
    return response;
  } catch (err) {
    console.error(
      "Login failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      { success: false, message: "Login failed." },
      { status: 500 }
    );
  }
}
