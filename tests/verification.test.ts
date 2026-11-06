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
    Location: {
      findOne: locationFindOneMock,
    },
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
  buildVerifyRequestBody,
  deriveVerificationStatus,
  fetchOptionsForLocation,
  refreshLocationVerificationStatus,
  sanitizeVerificationOptions,
  startVerificationForLocation,
  toVerificationsLocationName,
} from "@/lib/google/verification";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";

const ORG = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId();

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

describe("verification helpers", () => {
  it("normalizes locations/* names", () => {
    expect(toVerificationsLocationName("locations/abc")).toBe("locations/abc");
    expect(
      toVerificationsLocationName("accounts/1/locations/abc")
    ).toBe("locations/abc");
    expect(toVerificationsLocationName("bad")).toBeNull();
  });

  it("keeps only Google-returned VerificationMethod values", () => {
    expect(
      sanitizeVerificationOptions([
        { verificationMethod: "SMS", phoneNumber: "+15551212" },
        { verificationMethod: "FAKE_METHOD" as never },
        { verificationMethod: "AUTO" },
      ])
    ).toEqual([
      { verificationMethod: "SMS", phoneNumber: "+15551212" },
      { verificationMethod: "AUTO" },
    ]);
  });

  it("builds official verify RequestData union fields", () => {
    expect(
      buildVerifyRequestBody({
        method: "ADDRESS",
        languageCode: "en",
        mailerContact: "Ann",
      })
    ).toEqual({
      method: "ADDRESS",
      languageCode: "en",
      mailerContact: "Ann",
    });
    expect(
      buildVerifyRequestBody({
        method: "SMS",
        phoneNumber: "+1555",
      })
    ).toEqual({ method: "SMS", phoneNumber: "+1555" });
    expect(buildVerifyRequestBody({ method: "AUTO" })).toEqual({
      method: "AUTO",
    });
  });

  it("derives verified only from hasVoiceOfMerchant=true", () => {
    expect(
      deriveVerificationStatus({
        voice: { hasVoiceOfMerchant: true },
        latestVerification: { state: "PENDING" },
      }).status
    ).toBe("verified");

    expect(
      deriveVerificationStatus({
        voice: { hasVoiceOfMerchant: false, verify: {} },
        latestVerification: null,
      }).status
    ).toBe("unverified");

    expect(
      deriveVerificationStatus({
        voice: {
          hasVoiceOfMerchant: false,
          verify: { hasPendingVerification: true },
        },
        latestVerification: null,
      }).status
    ).toBe("pending");

    expect(
      deriveVerificationStatus({
        voice: { hasVoiceOfMerchant: false, verify: {} },
        latestVerification: { state: "FAILED" },
      }).status
    ).toBe("failed");

    expect(
      deriveVerificationStatus({
        voice: null,
        latestVerification: { state: "COMPLETED" },
      }).status
    ).toBe("unknown");

    expect(
      deriveVerificationStatus({
        voice: {},
        latestVerification: null,
      }).status
    ).toBe("unknown");
  });
});

describe("verification Google workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    claimMock.mockResolvedValue({
      kind: "execute",
      recordId: new mongoose.Types.ObjectId().toString(),
    });
    markSucceededMock.mockResolvedValue(undefined);
    markFailedMock.mockResolvedValue(undefined);
    getTokenMock.mockResolvedValue("access-token");
  });

  it("refreshes and persists status from VoiceOfMerchant + list", async () => {
    const doc = mockLocationDoc();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            hasVoiceOfMerchant: false,
            verify: { hasPendingVerification: true },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            verifications: [
              {
                name: "locations/loc-1/verifications/v1",
                method: "SMS",
                state: "PENDING",
              },
            ],
          }),
      });

    const snap = await refreshLocationVerificationStatus(
      ORG,
      String(LOC),
      fetchImpl
    );

    expect(snap.verificationStatus).toBe("pending");
    expect(snap.verificationLastCheckedAt).toBeTruthy();
    expect(snap.publicVisibilityClaim).toBe(false);
    expect(doc.save).toHaveBeenCalled();
    expect(doc.verificationStatus).toBe("pending");
    expect(doc.latestVerificationName).toBe(
      "locations/loc-1/verifications/v1"
    );

    const vomUrl = String(fetchImpl.mock.calls[0][0]);
    expect(vomUrl).toContain(
      "mybusinessverifications.googleapis.com/v1/locations/loc-1/VoiceOfMerchantState"
    );
  });

  it("leaves status unknown when VoiceOfMerchant response is inconclusive", async () => {
    mockLocationDoc();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ verifications: [] }),
      });

    const snap = await refreshLocationVerificationStatus(
      ORG,
      String(LOC),
      fetchImpl
    );
    expect(snap.verificationStatus).toBe("unknown");
  });

  it("returns empty options when Google returns none", async () => {
    mockLocationDoc();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ options: [] }),
    });

    const result = await fetchOptionsForLocation(
      ORG,
      String(LOC),
      "en",
      fetchImpl
    );
    expect(result.options).toEqual([]);
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain(":fetchVerificationOptions");
  });

  it("returns methods Google provides", async () => {
    mockLocationDoc();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          options: [
            { verificationMethod: "EMAIL", emailData: { user: "a", domain: "b.com" } },
            { verificationMethod: "NOT_REAL" },
          ],
        }),
    });
    const result = await fetchOptionsForLocation(
      ORG,
      String(LOC),
      "en",
      fetchImpl
    );
    expect(result.options).toHaveLength(1);
    expect(result.options[0].verificationMethod).toBe("EMAIL");
  });

  it("starts verification and posts to :verify", async () => {
    const doc = mockLocationDoc();
    claimMock.mockResolvedValue({
      kind: "execute",
      recordId: new mongoose.Types.ObjectId().toString(),
    });
    markSucceededMock.mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      // start verify
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            verification: {
              name: "locations/loc-1/verifications/v2",
              method: "AUTO",
              state: "COMPLETED",
            },
          }),
      })
      // refresh VoM
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({ hasVoiceOfMerchant: true, hasBusinessAuthority: true }),
      })
      // refresh list
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            verifications: [
              {
                name: "locations/loc-1/verifications/v2",
                method: "AUTO",
                state: "COMPLETED",
              },
            ],
          }),
      });

    const result = await startVerificationForLocation(
      ORG,
      String(LOC),
      {
        method: "AUTO",
        languageCode: "en",
        idempotencyKey: "verif-key-cccccccccccc",
      },
      fetchImpl
    );

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/locations/loc-1:verify");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      method: "AUTO",
      languageCode: "en",
    });
    expect(result.snapshot.verificationStatus).toBe("verified");
    expect(doc.save).toHaveBeenCalled();
  });

  it("surfaces Google auth errors without creating inventing status", async () => {
    mockLocationDoc();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          error: { status: "UNAUTHENTICATED", message: "bad token" },
        }),
    });

    await expect(
      refreshLocationVerificationStatus(ORG, String(LOC), fetchImpl)
    ).rejects.toBeInstanceOf(GoogleBusinessApiError);

    await expect(
      refreshLocationVerificationStatus(ORG, String(LOC), fetchImpl)
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
