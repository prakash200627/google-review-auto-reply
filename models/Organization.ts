import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const organizationSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    mode: {
      type: String,
      enum: ["manual", "auto"],
      default: "manual",
    },
  },
  { timestamps: true }
);

export type OrganizationDocument = InferSchemaType<typeof organizationSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Organization: Model<OrganizationDocument> =
  mongoose.models.Organization ||
  mongoose.model<OrganizationDocument>("Organization", organizationSchema);
