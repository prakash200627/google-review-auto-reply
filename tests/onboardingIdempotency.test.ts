import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  createMock,
  findOneMock,
  findOneAndUpdateMock,
  findByIdMock,
  updateOneMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  createMock: vi.fn(),
  findOneMock: vi.fn(),
  findOneAndUpdateMock: vi.fn(),
  findByIdMock: vi.fn(),
  updateOneMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/IdempotencyRecord", () => ({
  IDEMPOTENCY_RETENTION_DAYS: 30,
  IdempotencyRecord: {
    create: createMock,
    findOne: findOneMock,
    findOneAndUpdate: findOneAndUpdateMock,
    findById: findByIdMock,
    updateOne: updateOneMock,
  },
}));

import {
  claimOnboardingIdempotency,
} from "@/lib/idempotency/onboardingClaim";
import { hashIdempotencyPayload } from "@/lib/idempotency/keys";

const ORG = new mongoose.Types.ObjectId().toString();
const KEY = "idem-key-bbbbbbbbbbbb";
const HASH_A = hashIdempotencyPayload({ name: "A", locationId: "1" });
const HASH_B = hashIdempotencyPayload({ name: "B", locationId: "1" });

describe("claimOnboardingIdempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a pending record for a new key", async () => {
    const id = new mongoose.Types.ObjectId();
    createMock.mockResolvedValue({ _id: id, status: "pending" });
    const claim = await claimOnboardingIdempotency({
      orgId: ORG,
      key: KEY,
      payloadHash: HASH_A,
    });
    expect(claim).toEqual({ kind: "execute", recordId: String(id) });
  });

  it("replays succeeded result for same key + same payload", async () => {
    createMock.mockRejectedValue({ code: 11000 });
    const result = {
      business: { id: "b1", name: "X", orgId: ORG, groupId: "g", locationIds: ["l"], googleLocationNames: ["n"] },
      group: { id: "g", name: "G" },
      location: {
        id: "l",
        title: "T",
        address: "",
        googleLocationName: "n",
        businessInfoName: "locations/1",
        businessId: "b1",
        verificationStatus: "unknown",
      },
      reassignedFrom: null,
    };
    findOneMock.mockReturnValue({
      lean: async () => ({
        _id: new mongoose.Types.ObjectId(),
        payloadHash: HASH_A,
        status: "succeeded",
        result,
      }),
    });

    const claim = await claimOnboardingIdempotency({
      orgId: ORG,
      key: KEY,
      payloadHash: HASH_A,
    });
    expect(claim.kind).toBe("replay");
    if (claim.kind === "replay") {
      expect(claim.result.business.id).toBe("b1");
    }
  });

  it("conflicts when same key has a different payload hash", async () => {
    createMock.mockRejectedValue({ code: 11000 });
    findOneMock.mockReturnValue({
      lean: async () => ({
        _id: new mongoose.Types.ObjectId(),
        payloadHash: HASH_A,
        status: "succeeded",
        result: { business: { id: "b1" }, location: { id: "l" } },
      }),
    });

    await expect(
      claimOnboardingIdempotency({
        orgId: ORG,
        key: KEY,
        payloadHash: HASH_B,
      })
    ).rejects.toMatchObject({
      code: "idempotency_payload_conflict",
      status: 409,
    });
  });

  it("concurrent duplicate insert surfaces via unique index then in-progress", async () => {
    createMock.mockRejectedValue({ code: 11000 });
    findOneMock.mockReturnValue({
      lean: async () => ({
        _id: new mongoose.Types.ObjectId(),
        payloadHash: HASH_A,
        status: "pending",
        result: null,
      }),
    });

    await expect(
      claimOnboardingIdempotency({
        orgId: ORG,
        key: KEY,
        payloadHash: HASH_A,
      })
    ).rejects.toMatchObject({ code: "idempotency_in_progress", status: 409 });
  });
});
