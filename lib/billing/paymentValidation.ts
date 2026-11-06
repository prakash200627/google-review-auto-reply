import {
  PAYMENT_STATUSES,
  type PaymentStatus,
} from "@/models/ManualPayment";

export const PAYMENT_STATUS_TRANSITIONS: Record<
  PaymentStatus,
  readonly PaymentStatus[]
> = {
  not_recorded: ["expected", "received", "overdue", "waived", "not_recorded"],
  expected: ["received", "overdue", "waived", "expected", "not_recorded"],
  overdue: ["received", "waived", "overdue", "expected"],
  received: ["received", "waived", "expected"],
  waived: ["waived", "expected", "not_recorded"],
};

export class PaymentValidationError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "invalid_payment", status = 400) {
    super(message);
    this.name = "PaymentValidationError";
    this.code = code;
    this.status = status;
  }
}

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (
    typeof value === "string" &&
    (PAYMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Validate amount/status consistency and optional prior-status transitions.
 * Rejects status=received with zero/missing received amount.
 */
export function validateManualPaymentInput(input: {
  status: PaymentStatus;
  amountExpectedCents: number;
  amountReceivedCents: number;
  previousStatus?: PaymentStatus | null;
}): void {
  const { status, amountExpectedCents, amountReceivedCents, previousStatus } =
    input;

  if (!Number.isFinite(amountExpectedCents) || amountExpectedCents < 0) {
    throw new PaymentValidationError(
      "amountExpectedCents must be a non-negative integer.",
      "invalid_amount"
    );
  }
  if (!Number.isFinite(amountReceivedCents) || amountReceivedCents < 0) {
    throw new PaymentValidationError(
      "amountReceivedCents must be a non-negative integer.",
      "invalid_amount"
    );
  }

  if (status === "received") {
    if (!amountReceivedCents || amountReceivedCents <= 0) {
      throw new PaymentValidationError(
        "Status 'received' requires a positive amountReceivedCents. Never mark received without a payment amount.",
        "received_requires_amount"
      );
    }
  }

  if (previousStatus && previousStatus !== status) {
    const allowed = PAYMENT_STATUS_TRANSITIONS[previousStatus] || [];
    if (!allowed.includes(status)) {
      throw new PaymentValidationError(
        `Cannot transition payment status from ${previousStatus} to ${status}.`,
        "invalid_status_transition"
      );
    }
  }
}
