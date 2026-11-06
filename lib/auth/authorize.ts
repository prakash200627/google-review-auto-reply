import mongoose from "mongoose";
import { NextResponse } from "next/server";
import {
  lifecycleAllowsOwnerAccess,
  resolveBusinessLifecycle,
} from "@/lib/business/lifecycle";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { User, type UserRole } from "@/models/User";
import {
  readUserSession,
  type UserSessionPayload,
} from "@/lib/auth/userSession";

export type AuthUser = {
  userId: string;
  role: UserRole;
  email: string;
  businessIds: string[];
  /** Business Admin group membership (empty/undefined for superadmin or legacy fixtures). */
  groupIds?: string[];
};

export async function loadAuthUser(
  session: UserSessionPayload
): Promise<AuthUser | null> {
  if (!mongoose.isValidObjectId(session.userId)) return null;
  await connectToDatabase();
  const user = await User.findOne({
    _id: session.userId,
    active: true,
  })
    .select("email role businessIds groupIds")
    .lean();
  if (!user) return null;
  // Role always from DB — never trust cookie role alone for authorization.
  return {
    userId: String(user._id),
    role: user.role as UserRole,
    email: user.email,
    businessIds: (user.businessIds || []).map((id) => String(id)),
    groupIds: (user.groupIds || []).map((id) => String(id)),
  };
}

export async function requireAuthUser(): Promise<
  { user: AuthUser } | { response: NextResponse }
> {
  const session = await readUserSession();
  if (!session) {
    return {
      response: NextResponse.json(
        {
          success: false,
          code: "unauthorized",
          message: "Authentication required.",
        },
        { status: 401 }
      ),
    };
  }
  const user = await loadAuthUser(session);
  if (!user) {
    return {
      response: NextResponse.json(
        {
          success: false,
          code: "unauthorized",
          message: "Invalid or inactive user session.",
        },
        { status: 401 }
      ),
    };
  }
  return { user };
}

export function isAuthUser(
  value: { user: AuthUser } | { response: NextResponse }
): value is { user: AuthUser } {
  return "user" in value;
}

export async function requireSuperAdmin(): Promise<
  { user: AuthUser } | { response: NextResponse }
> {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth;
  if (auth.user.role !== "superadmin") {
    return {
      response: NextResponse.json(
        {
          success: false,
          code: "forbidden",
          message: "Super Admin access required.",
        },
        { status: 403 }
      ),
    };
  }
  return auth;
}

export type BusinessAccessDoc = {
  _id: mongoose.Types.ObjectId;
  orgId: mongoose.Types.ObjectId;
  groupId?: mongoose.Types.ObjectId | null;
  name: string;
  active: boolean;
  status?: string;
  replyMode: string;
  ownersMayChangeReplyMode?: boolean;
  autoDraftOnSync?: boolean;
  brandVoice?: string;
  preferredLanguage?: string;
  replyToneNotes?: string;
  profile?: {
    description?: string;
    website?: string;
    phone?: string;
  } | null;
  googleLocationNames: string[];
  locationIds: mongoose.Types.ObjectId[];
  ownerUserId?: mongoose.Types.ObjectId | null;
  plan?: unknown;
  autoPublish?: {
    enabled?: boolean | null;
    disabledByAdmin?: boolean | null;
  } | null;
};

/**
 * Verify the caller may access the business.
 * Client-supplied businessId is never trusted without this check.
 * Inactive businesses are denied for ordinary owners (Super Admin may still view for support).
 */
export async function assertBusinessAccess(
  user: AuthUser,
  businessId: string,
  options: { allowInactiveForOwner?: boolean } = {}
): Promise<
  | { ok: true; business: BusinessAccessDoc }
  | { ok: false; response: NextResponse }
> {
  if (!mongoose.isValidObjectId(businessId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, code: "invalid_id", message: "Invalid business id." },
        { status: 400 }
      ),
    };
  }

  await connectToDatabase();
  const business = await Business.findById(businessId)
    .select(
      "name orgId groupId active status replyMode ownersMayChangeReplyMode autoDraftOnSync brandVoice preferredLanguage replyToneNotes profile googleLocationNames locationIds ownerUserId plan autoPublish"
    )
    .lean();

  if (!business) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, code: "not_found", message: "Business not found." },
        { status: 404 }
      ),
    };
  }

  if (user.role === "superadmin") {
    return { ok: true, business: business as BusinessAccessDoc };
  }

  const groupId = business.groupId ? String(business.groupId) : null;
  const userGroupIds = user.groupIds || [];
  const owns =
    user.businessIds.includes(String(business._id)) ||
    String(business.ownerUserId || "") === user.userId ||
    Boolean(groupId && userGroupIds.includes(groupId));

  if (!owns) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "forbidden",
          message: "You do not have access to this business.",
        },
        { status: 403 }
      ),
    };
  }

  if (
    !options.allowInactiveForOwner &&
    !lifecycleAllowsOwnerAccess(business)
  ) {
    const status = resolveBusinessLifecycle(business);
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          code: "business_lifecycle_blocked",
          message: `This business is ${status}. Contact a Super Admin.`,
        },
        { status: 403 }
      ),
    };
  }

  return { ok: true, business: business as BusinessAccessDoc };
}

/** Active business ids the owner may use for workspace queries. */
export async function listActiveBusinessIdsForUser(
  user: AuthUser
): Promise<string[]> {
  if (user.role === "superadmin") {
    await connectToDatabase();
    const all = await Business.find({}).select("_id").lean();
    return all.map((b) => String(b._id));
  }
  await connectToDatabase();
  const orFilters: Record<string, unknown>[] = [];
  if (user.businessIds.length > 0) {
    orFilters.push({ _id: { $in: user.businessIds } });
  }
  if ((user.groupIds || []).length > 0) {
    orFilters.push({ groupId: { $in: user.groupIds } });
  }
  orFilters.push({ ownerUserId: user.userId });
  const candidates = await Business.find({ $or: orFilters })
    .select("_id active status")
    .lean();
  return [
    ...new Set(
      candidates
        .filter((b) => lifecycleAllowsOwnerAccess(b))
        .map((b) => String(b._id))
    ),
  ];
}
