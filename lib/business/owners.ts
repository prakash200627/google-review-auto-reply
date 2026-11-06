import mongoose, { type ClientSession } from "mongoose";
import { hashPassword } from "@/lib/auth/password";
import { User } from "@/models/User";
import { Business } from "@/models/Business";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class OwnerAccountError extends Error {
  code: string;
  status: number;

  constructor(
    message: string,
    { code, status }: { code: string; status: number }
  ) {
    super(message);
    this.name = "OwnerAccountError";
    this.code = code;
    this.status = status;
  }
}

export function validateOwnerEmail(raw: unknown): string {
  const email = String(raw || "")
    .trim()
    .toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    throw new OwnerAccountError("A valid owner email is required.", {
      code: "invalid_email",
      status: 400,
    });
  }
  return email;
}

export function validateOwnerPassword(raw: unknown, required: boolean): string {
  const password = String(raw || "");
  if (!password) {
    if (required) {
      throw new OwnerAccountError(
        "Owner password must be at least 8 characters.",
        { code: "invalid_password", status: 400 }
      );
    }
    return "";
  }
  if (password.length < 8) {
    throw new OwnerAccountError(
      "Owner password must be at least 8 characters.",
      { code: "invalid_password", status: 400 }
    );
  }
  return password;
}

/**
 * Create a new business_owner or link an existing one to a business.
 *
 * - New user: password required; account created active.
 * - Existing active owner: linked only — password is never changed.
 * - Existing inactive owner: refused unless reactivateExisting is true
 *   (still does not change password; use resetOwnerPassword separately).
 * Never elevates to superadmin. Does not log passwords.
 * Pass `session` to participate in a caller-owned Mongo transaction.
 */
export async function upsertBusinessOwner(input: {
  email: unknown;
  password: unknown;
  name?: string;
  businessId: string;
  /** Required when creating a new user; ignored when linking an existing active owner. */
  requirePassword: boolean;
  /** Explicit opt-in to attach an inactive owner without changing their password. */
  reactivateExisting?: boolean;
  session?: ClientSession | null;
}): Promise<{
  userId: mongoose.Types.ObjectId;
  created: boolean;
  linkedExisting: boolean;
  passwordSet: boolean;
}> {
  if (!mongoose.isValidObjectId(input.businessId)) {
    throw new OwnerAccountError("Invalid business id.", {
      code: "invalid_id",
      status: 400,
    });
  }

  const session = input.session || undefined;
  const email = validateOwnerEmail(input.email);
  const existingQuery = User.findOne({ email }).select(
    "role businessIds active name"
  );
  if (session) existingQuery.session(session);
  const existing = await existingQuery.exec();

  if (existing) {
    if (existing.role === "superadmin") {
      throw new OwnerAccountError(
        "Cannot assign a Super Admin account as a business owner.",
        { code: "cannot_demote_superadmin", status: 400 }
      );
    }
    if (existing.role !== "business_owner") {
      throw new OwnerAccountError("User role cannot be linked as a business owner.", {
        code: "invalid_role",
        status: 400,
      });
    }

    if (!existing.active) {
      if (!input.reactivateExisting) {
        throw new OwnerAccountError(
          "This owner account is inactive. Reactivate explicitly (set_active) or pass reactivateExisting before linking. Password is not changed by linking.",
          { code: "owner_inactive", status: 409 }
        );
      }
      existing.active = true;
      await existing.save(session ? { session } : undefined);
    }

    // Linking never overwrites password — ignore any password in the payload.
    if (input.name && !existing.name) {
      existing.name = input.name;
      await existing.save(session ? { session } : undefined);
    }

    await User.updateOne(
      { _id: existing._id },
      { $addToSet: { businessIds: new mongoose.Types.ObjectId(input.businessId) } },
      session ? { session } : undefined
    );
    await Business.updateOne(
      { _id: input.businessId },
      { $set: { ownerUserId: existing._id } },
      session ? { session } : undefined
    );
    return {
      userId: existing._id,
      created: false,
      linkedExisting: true,
      passwordSet: false,
    };
  }

  const password = validateOwnerPassword(
    input.password,
    input.requirePassword !== false
  );

  const userFields = {
    email,
    name: input.name || "",
    passwordHash: hashPassword(password),
    role: "business_owner" as const,
    businessIds: [new mongoose.Types.ObjectId(input.businessId)],
    active: true,
  };
  // Array + options form is required when joining a Mongo transaction session.
  const created = session
    ? (await User.create([userFields], { session }))[0]
    : await User.create(userFields);

  await Business.updateOne(
    { _id: input.businessId },
    { $set: { ownerUserId: created._id } },
    session ? { session } : undefined
  );

  return {
    userId: created._id,
    created: true,
    linkedExisting: false,
    passwordSet: true,
  };
}

export async function setOwnerActive(
  userId: string,
  active: boolean
): Promise<void> {
  if (!mongoose.isValidObjectId(userId)) {
    throw new OwnerAccountError("Invalid user id.", {
      code: "invalid_id",
      status: 400,
    });
  }
  const user = await User.findById(userId).select("role").exec();
  if (!user) {
    throw new OwnerAccountError("User not found.", {
      code: "not_found",
      status: 404,
    });
  }
  if (user.role === "superadmin") {
    throw new OwnerAccountError("Cannot deactivate a Super Admin via owner APIs.", {
      code: "forbidden",
      status: 403,
    });
  }
  await User.updateOne({ _id: userId }, { $set: { active } });
}

/**
 * Explicit Super Admin password reset for a business_owner.
 * Does not send email — caller must share the password out-of-band.
 */
export async function resetOwnerPassword(input: {
  userId: string;
  newPassword: unknown;
}): Promise<void> {
  if (!mongoose.isValidObjectId(input.userId)) {
    throw new OwnerAccountError("Invalid user id.", {
      code: "invalid_id",
      status: 400,
    });
  }
  const password = validateOwnerPassword(input.newPassword, true);
  const user = await User.findById(input.userId)
    .select("+passwordHash role")
    .exec();
  if (!user) {
    throw new OwnerAccountError("User not found.", {
      code: "not_found",
      status: 404,
    });
  }
  if (user.role !== "business_owner") {
    throw new OwnerAccountError(
      "Password reset via this API is only allowed for business owners.",
      { code: "forbidden", status: 403 }
    );
  }
  user.passwordHash = hashPassword(password);
  await user.save();
}

/**
 * Reassign primary owner for a business.
 * Existing owners are linked without password changes.
 * New owners require a password.
 * Pass `session` to participate in a caller-owned Mongo transaction.
 */
export async function reassignBusinessOwner(input: {
  businessId: string;
  email: unknown;
  password: unknown;
  name?: string;
  reactivateExisting?: boolean;
  session?: ClientSession | null;
}): Promise<{
  userId: string;
  created: boolean;
  linkedExisting: boolean;
  passwordSet: boolean;
}> {
  const session = input.session || undefined;
  const businessQuery = Business.findById(input.businessId).select(
    "ownerUserId name"
  );
  if (session) businessQuery.session(session);
  const business = await businessQuery.exec();
  if (!business) {
    throw new OwnerAccountError("Business not found.", {
      code: "not_found",
      status: 404,
    });
  }

  const previousOwnerId = business.ownerUserId
    ? String(business.ownerUserId)
    : null;

  const result = await upsertBusinessOwner({
    email: input.email,
    password: input.password,
    name: input.name || business.name,
    businessId: input.businessId,
    requirePassword: true,
    reactivateExisting: input.reactivateExisting === true,
    session,
  });

  if (previousOwnerId && previousOwnerId !== String(result.userId)) {
    await User.updateOne(
      { _id: previousOwnerId },
      { $pull: { businessIds: business._id } },
      session ? { session } : undefined
    );
  }

  return {
    userId: String(result.userId),
    created: result.created,
    linkedExisting: result.linkedExisting,
    passwordSet: result.passwordSet,
  };
}
