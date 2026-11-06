import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  getTokenMock,
  locationFindOneMock,
  claimMock,
  markSucceededMock,
  markFailedMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  getTokenMock: vi.fn(),
  locationFindOneMock: vi.fn(),
  claimMock: vi.fn(),
  markSucceededMock: vi.fn(),
  markFailedMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/lib/google/accessToken", () => ({
  getValidAccessTokenForOrg: getTokenMock,
}));

vi.mock("@/models/Location", async () => {
  const actual = await vi.importActual<typeof import("@/models/Location")>(
    "@/models/Location"
  );
  return {
    ...actual,
    Location: { findOne: locationFindOneMock },
  };
});

vi.mock("@/lib/idempotency/claim", async () => {
  const actual = await vi.importActual<typeof import("@/lib/idempotency/claim")>(
    "@/lib/idempotency/claim"
  );
  return {
    ...actual,
    claimIdempotencySlot: claimMock,
    markIdempotencySucceeded: markSucceededMock,
    markIdempotencyFailed: markFailedMock,
  };
});

import {
  locationHasPendingVerificationAttempt,
  startVerificationForLocation,
} from "@/lib/google/verification";
import { IdempotencyClaimError } from "@/lib/idempotency/claim";

const ORG = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId();
const KEY = "verif-key-bbbbbbbbbbbb";

function mockLocationDoc(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: LOC,
    orgId: ORG,
    businessInfoName: "locations/loc-1",
    googleLocationName: "accounts/a/locations/loc-1",
    verificationStatus: "unknown",
    verificationLastCheckedAt: null,
    verificationHasVoiceOfMerchant: null,
    verificationHasBusinessAuthority: null,
    verificationRecommendedAction: "",
    latestVerificationName: "",
    latestVerificationMethod: "",
    latestVerificationState: "",
    verificationLastError: "",
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  locationFindOneMock.mockResolvedValue(doc);
  return doc;
}

describe("locationHasPendingVerificationAttempt", () => {
  it("detects PENDING Google state", () => {
    expect(
      locationHasPendingVerificationAttempt({
        latestVerificationState: "PENDING",
        latestVerificationName: "locations/1/verifications/v1",
      })
    ).toBe(true);
  });

  it("allows start when no outstanding attempt", () => {
    expect(
      locationHasPendingVerificationAttempt({
        verificationStatus: "unknown",
        latestVerificationState: "",
        latestVerificationName: "",
      })
    ).toBe(false);
  });
});

describe("startVerificationForLocation idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    getTokenMock.mockResolvedValue("access-token");
    markSucceededMock.mockResolvedValue(undefined);
    markFailedMock.mockResolvedValue(undefined);
    claimMock.mockResolvedValue({
      kind: "execute",
      recordId: new mongoose.Types.ObjectId().toString(),
    });
  });

  it("requires idempotencyKey", async () => {
    mockLocationDoc();
    await expect(
      startVerificationForLocation(ORG, String(LOC), {
        method: "AUTO",
        idempotencyKey: "short",
      })
    ).rejects.toMatchObject({ code: "missing_idempotency_key" });
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("replays same key + same payload without calling Google again", async () => {
    mockLocationDoc();
    const prior = {
      verification: {
        name: "locations/loc-1/verifications/v9",
        method: "AUTO",
        state: "PENDING",
      },
      snapshot: {
        locationId: String(LOC),
        businessInfoName: "locations/loc-1",
        verificationStatus: "pending" as const,
        verificationLastCheckedAt: null,
        verificationHasVoiceOfMerchant: null,
        verificationHasBusinessAuthority: null,
        verificationRecommendedAction: "verify",
        latestVerificationName: "locations/loc-1/verifications/v9",
        latestVerificationMethod: "AUTO",
        latestVerificationState: "PENDING",
        verificationLastError: "",
        note: "prior",
        publicVisibilityClaim: false as const,
      },
    };
    claimMock.mockResolvedValue({
      kind: "replay",
      result: prior,
      reusedIdempotentResult: true,
    });
    const fetchImpl = vi.fn();

    const result = await startVerificationForLocation(
      ORG,
      String(LOC),
      { method: "AUTO", languageCode: "en", idempotencyKey: KEY },
      fetchImpl
    );

    expect(result.reusedIdempotentResult).toBe(true);
    expect(result.verification.name).toBe(
      "locations/loc-1/verifications/v9"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it("conflicts when same key is reused with a different payload", async () => {
    mockLocationDoc();
    claimMock.mockRejectedValue(
      new IdempotencyClaimError("payload conflict", {
        code: "idempotency_payload_conflict",
        status: 409,
      })
    );

    await expect(
      startVerificationForLocation(ORG, String(LOC), {
        method: "SMS",
        phoneNumber: "+1",
        idempotencyKey: KEY,
      })
    ).rejects.toMatchObject({
      code: "idempotency_payload_conflict",
      status: 409,
    });
  });

  it("returns in-progress for concurrent duplicate key", async () => {
    mockLocationDoc();
    claimMock.mockRejectedValue(
      new IdempotencyClaimError("in progress", {
        code: "idempotency_in_progress",
        status: 409,
      })
    );

    await expect(
      startVerificationForLocation(ORG, String(LOC), {
        method: "AUTO",
        idempotencyKey: KEY,
      })
    ).rejects.toMatchObject({ code: "idempotency_in_progress", status: 409 });
  });

  it("does not start Google verify when a pending attempt already exists", async () => {
    mockLocationDoc({
      verificationStatus: "pending",
      latestVerificationState: "PENDING",
      latestVerificationName: "locations/loc-1/verifications/old",
    });
    const fetchImpl = vi.fn();

    await expect(
      startVerificationForLocation(
        ORG,
        String(LOC),
        { method: "AUTO", idempotencyKey: KEY },
        fetchImpl
      )
    ).rejects.toMatchObject({
      code: "verification_already_pending",
      status: 409,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(markFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "verification_already_pending" })
    );
  });

  it("starts once and marks idempotency succeeded", async () => {
    const doc = mockLocationDoc();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            verification: {
              name: "locations/loc-1/verifications/v2",
              method: "AUTO",
              state: "PENDING",
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            hasVoiceOfMerchant: false,
            verify: { hasPendingVerification: true },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            verifications: [
              {
                name: "locations/loc-1/verifications/v2",
                method: "AUTO",
                state: "PENDING",
              },
            ],
          }),
      });

    const result = await startVerificationForLocation(
      ORG,
      String(LOC),
      { method: "AUTO", languageCode: "en", idempotencyKey: KEY },
      fetchImpl
    );

    expect(result.verification.state).toBe("PENDING");
    expect(result.snapshot.verificationStatus).not.toBe("verified");
    expect(doc.save).toHaveBeenCalled();
    expect(markSucceededMock).toHaveBeenCalled();
    expect(claimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "gbp.verification.start",
        scopeId: String(LOC),
        key: KEY,
      })
    );
  });
});
