import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const USER_ROLES = ["superadmin", "business_owner"] as const;
export type UserRole = (typeof USER_ROLES)[number];

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: { type: String, default: "" },
    /** scrypt hash — never select by default */
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: USER_ROLES,
      required: true,
      default: "business_owner",
      index: true,
    },
    /**
     * Businesses this Business Admin (role=business_owner) may manage.
     * Kept in sync with group membership via lib/groups/membership.ts.
     * Empty for superadmin.
     */
    businessIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Business",
      },
    ],
    /**
     * Business groups this Business Admin is assigned to (multi-group).
     * Super Admin assigns group membership; owners cannot self-assign.
     */
    groupIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "BusinessGroup",
      },
    ],
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export type UserDocument = InferSchemaType<typeof userSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const User: Model<UserDocument> =
  mongoose.models.User || mongoose.model<UserDocument>("User", userSchema);
