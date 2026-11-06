import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Super Admin–recorded subscription payment ledger.
 * No payment provider integration. Amounts are operator-entered only.
 * Do not invent "received" totals without stored rows.
 */
export const PAYMENT_STATUSES = [
  "expected",
  "received",
  "overdue",
  "waived",
  "not_recorded",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const manualPaymentSchema = new Schema(
  {
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    /** Calendar month key YYYY-MM for the billing period. */
    periodKey: { type: String, required: true, index: true },
    amountExpectedCents: { type: Number, default: 0 },
    amountReceivedCents: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "not_recorded",
      index: true,
    },
    notes: { type: String, default: "" },
    recordedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    recordedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

manualPaymentSchema.index({ businessId: 1, periodKey: 1 }, { unique: true });

export type ManualPaymentDocument = InferSchemaType<
  typeof manualPaymentSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const ManualPayment: Model<ManualPaymentDocument> =
  mongoose.models.ManualPayment ||
  mongoose.model<ManualPaymentDocument>("ManualPayment", manualPaymentSchema);
