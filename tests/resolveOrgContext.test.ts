import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  readOrganizationIdMock,
  connectMock,
  businessFindMock,
  organizationFindByIdMock,
} = vi.hoisted(() => ({
  readOrganizationIdMock: vi.fn(),
  connectMock: vi.fn(),
  businessFindMock: vi.fn(),
  organizationFindByIdMock: vi.fn(),
}));

vi.mock("@/lib/org/session", () => ({
  readOrganizationId: readOrganizationIdMock,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: { find: businessFindMock },
}));

vi.mock("@/models/Organization", () => ({
  Organization: { findById: organizationFindByIdMock },
}));

import { resolveAuthorizedOrgId } from "@/lib/auth/resolveOrgContext";

const ORG = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();

describe("resolveAuthorizedOrgId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("uses signed org cookie when owner is authorized", async () => {
    readOrganizationIdMock.mockResolvedValue(ORG);
    organizationFindByIdMock.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: ORG }) }),
    });
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: BIZ, active: true, status: "active" }],
      }),
    });

    await expect(
      resolveAuthorizedOrgId({
        userId: USER,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ],
      })
    ).resolves.toBe(ORG);
  });

  it("falls back to owner business orgId when cookie missing", async () => {
    readOrganizationIdMock.mockResolvedValue(null);
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [
          {
            _id: BIZ,
            orgId: ORG,
            active: true,
            status: "active",
          },
        ],
      }),
    });

    await expect(
      resolveAuthorizedOrgId({
        userId: USER,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ],
      })
    ).resolves.toBe(ORG);
  });

  it("skips suspended businesses when resolving owner org", async () => {
    readOrganizationIdMock.mockResolvedValue(null);
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [
          {
            _id: BIZ,
            orgId: ORG,
            active: false,
            status: "suspended",
          },
        ],
      }),
    });

    await expect(
      resolveAuthorizedOrgId({
        userId: USER,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ],
      })
    ).resolves.toBeNull();
  });

  it("does not invent org for Super Admin without cookie", async () => {
    readOrganizationIdMock.mockResolvedValue(null);
    await expect(
      resolveAuthorizedOrgId({
        userId: USER,
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      })
    ).resolves.toBeNull();
    expect(businessFindMock).not.toHaveBeenCalled();
  });

  it("falls back to org via groupIds when businessIds are empty", async () => {
    const GROUP = new mongoose.Types.ObjectId().toString();
    readOrganizationIdMock.mockResolvedValue(null);
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [
          {
            _id: BIZ,
            orgId: ORG,
            active: true,
            status: "active",
          },
        ],
      }),
    });

    await expect(
      resolveAuthorizedOrgId({
        userId: USER,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [],
        groupIds: [GROUP],
      })
    ).resolves.toBe(ORG);
    expect(businessFindMock).toHaveBeenCalledWith({
      $or: expect.arrayContaining([
        { groupId: { $in: [GROUP] } },
        { ownerUserId: USER },
      ]),
    });
  });
});
