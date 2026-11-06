import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  userFindByIdMock,
  userFindMock,
  businessFindMock,
  businessFindByIdMock,
  groupFindMock,
  groupFindByIdMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  userFindByIdMock: vi.fn(),
  userFindMock: vi.fn(),
  businessFindMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  groupFindMock: vi.fn(),
  groupFindByIdMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/User", () => ({
  User: {
    findById: userFindByIdMock,
    find: userFindMock,
  },
}));

vi.mock("@/models/Business", () => ({
  Business: {
    find: businessFindMock,
    findById: businessFindByIdMock,
  },
}));

vi.mock("@/models/BusinessGroup", () => ({
  BusinessGroup: {
    find: groupFindMock,
    findById: groupFindByIdMock,
  },
}));

import {
  assignOwnerToGroups,
  setBusinessGroup,
  syncOwnerBusinessIdsFromGroups,
} from "@/lib/groups/membership";

const USER = new mongoose.Types.ObjectId();
const GROUP = new mongoose.Types.ObjectId();
const BIZ = new mongoose.Types.ObjectId();
const ORG = new mongoose.Types.ObjectId();

describe("group membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("syncs businessIds from group membership and owned businesses", async () => {
    const save = vi.fn();
    userFindByIdMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: USER,
          role: "business_owner",
          groupIds: [GROUP],
          businessIds: [],
          save,
        }),
      }),
    });
    businessFindMock
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => [{ _id: BIZ }],
        }),
      })
      .mockReturnValueOnce({
        select: () => ({
          lean: async () => [],
        }),
      });

    const ids = await syncOwnerBusinessIdsFromGroups(String(USER));
    expect(ids).toEqual([String(BIZ)]);
    expect(save).toHaveBeenCalled();
  });

  it("assigns owner to groups only for business_owner role", async () => {
    userFindByIdMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: USER,
          role: "superadmin",
          groupIds: [],
          save: vi.fn(),
        }),
      }),
    });
    await expect(
      assignOwnerToGroups({ userId: String(USER), groupIds: [String(GROUP)] })
    ).rejects.toMatchObject({ code: "invalid_role" });
  });

  it("rejects business assignment when group org mismatches", async () => {
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          groupId: null,
          orgId: ORG,
          save: vi.fn(),
        }),
      }),
    });
    groupFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          orgId: new mongoose.Types.ObjectId(),
          active: true,
        }),
      }),
    });

    await expect(
      setBusinessGroup({
        businessId: String(BIZ),
        groupId: String(GROUP),
      })
    ).rejects.toMatchObject({ code: "org_mismatch" });
  });
});
