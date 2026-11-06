/**
 * Claim / replay helpers for Super Admin business onboarding idempotency.
 */

import type { ClientSession } from "mongoose";
import type { OnboardingResult } from "@/lib/business/onboarding";
import {
  claimIdempotencySlot,
  IdempotencyClaimError,
  markIdempotencyFailed,
  markIdempotencySucceeded,
} from "@/lib/idempotency/claim";

export type OnboardingClaim =
  | {
      kind: "execute";
      recordId: string;
    }
  | {
      kind: "replay";
      result: OnboardingResult;
      reusedIdempotentResult: true;
    };

function asOnboardingResult(raw: unknown): OnboardingResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as OnboardingResult;
  if (!r.business?.id || !r.location?.id) return null;
  return r;
}

export async function claimOnboardingIdempotency(input: {
  orgId: string;
  key: string;
  payloadHash: string;
}): Promise<OnboardingClaim> {
  return claimIdempotencySlot<OnboardingResult>({
    orgId: input.orgId,
    operation: "business.onboarding",
    scopeId: "",
    key: input.key,
    payloadHash: input.payloadHash,
    parseResult: asOnboardingResult,
  });
}

export async function markOnboardingIdempotencySucceeded(input: {
  recordId: string;
  result: OnboardingResult;
  session?: ClientSession | null;
}): Promise<void> {
  await markIdempotencySucceeded(input);
}

export async function markOnboardingIdempotencyFailed(input: {
  recordId: string;
  code: string;
  message: string;
}): Promise<void> {
  await markIdempotencyFailed(input);
}

export function isOnboardingIdempotencyError(
  err: unknown
): err is Error & { code: string; status: number } {
  return (
    err instanceof IdempotencyClaimError ||
    Boolean(
      err &&
        typeof err === "object" &&
        "code" in err &&
        typeof (err as { code: unknown }).code === "string" &&
        String((err as { code: string }).code).startsWith("idempotency_")
    )
  );
}
