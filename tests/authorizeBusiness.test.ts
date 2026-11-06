import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const { connectMock, findByIdMock, readSessionMock, userFindOneMock } =
  vi.hoisted(() => ({
    connectMock: vi.fn(),
    findByIdMock: vi.fn(),
    readSessionMock: vi.fn(),
    userFindOneMock: vi.fn(),
  }));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: {
    findById: findByIdMock,
  },
}));

vi.mock("@/lib/auth/userSession", () => ({
  readUserSession: readSessionMock,
}));

vi.mock("@/models/User", () => ({
  USER_ROLES: ["superadmin", "business_owner"],
  User: {
    findOne: userFindOneMock,
  },
}));

import {
  assertBusinessAccess,
  loadAuthUser,
} from "@/lib/auth/authorize";

const BIZ_A = new mongoose.Types.ObjectId().toString();
const BIZ_B = new mongoose.Types.ObjectId().toString();
const USER_ID = new mongoose.Types.ObjectId().toString();

describe("business authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("loads role from the database, not only the cookie", async () => {
    userFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: USER_ID,
          email: "owner@example.com",
          role: "business_owner",
          businessIds: [BIZ_A],
        }),
      }),
    });

    const user = await loadAuthUser({
      userId: USER_ID,
      role: "superadmin", // forged cookie role must not win
      email: "owner@example.com",
      exp: Date.now() + 60_000,
    });

    expect(user?.role).toBe("business_owner");
    expect(user?.businessIds).toEqual([BIZ_A]);
  });

  it("allows superadmin cross-business access", async () => {
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: BIZ_B,
          name: "Other Biz",
          orgId: new mongoose.Types.ObjectId(),
          active: true,
          replyMode: "manual",
          googleLocationNames: [],
          locationIds: [],
        }),
      }),
    });

    const result = await assertBusinessAccess(
      {
        userId: USER_ID,
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
      BIZ_B
    );
    expect(result.ok).toBe(true);
  });

  it("denies business_owner access to another business", async () => {
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: BIZ_B,
          name: "Other Biz",
          orgId: new mongoose.Types.ObjectId(),
          active: true,
          replyMode: "manual",
          googleLocationNames: [],
          locationIds: [],
          ownerUserId: new mongoose.Types.ObjectId(),
        }),
      }),
    });

    const result = await assertBusinessAccess(
      {
        userId: USER_ID,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ_A],
      },
      BIZ_B
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it("denies owner access to an inactive business", async () => {
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: BIZ_A,
          name: "Inactive Biz",
          orgId: new mongoose.Types.ObjectId(),
          active: false,
          replyMode: "manual",
          googleLocationNames: [],
          locationIds: [],
          ownerUserId: USER_ID,
        }),
      }),
    });

    const result = await assertBusinessAccess(
      {
        userId: USER_ID,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ_A],
      },
      BIZ_A
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.code).toBe("business_lifecycle_blocked");
    }
  });

  it("allows business_owner access via groupIds without businessIds", async () => {
    const GROUP = new mongoose.Types.ObjectId().toString();
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: BIZ_A,
          name: "Grouped Biz",
          orgId: new mongoose.Types.ObjectId(),
          groupId: GROUP,
          active: true,
          status: "active",
          replyMode: "manual",
          googleLocationNames: [],
          locationIds: [],
          ownerUserId: new mongoose.Types.ObjectId(),
        }),
      }),
    });

    const result = await assertBusinessAccess(
      {
        userId: USER_ID,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [],
        groupIds: [GROUP],
      },
      BIZ_A
    );
    expect(result.ok).toBe(true);
  });

  it("denies business_owner when groupIds do not match the business group", async () => {
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: BIZ_A,
          name: "Other Group Biz",
          orgId: new mongoose.Types.ObjectId(),
          groupId: new mongoose.Types.ObjectId().toString(),
          active: true,
          status: "active",
          replyMode: "manual",
          googleLocationNames: [],
          locationIds: [],
          ownerUserId: new mongoose.Types.ObjectId(),
        }),
      }),
    });

    const result = await assertBusinessAccess(
      {
        userId: USER_ID,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [],
        groupIds: [new mongoose.Types.ObjectId().toString()],
      },
      BIZ_A
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });
});
