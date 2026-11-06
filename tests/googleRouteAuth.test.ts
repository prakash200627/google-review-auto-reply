import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireOrgMock,
  requireAuthMock,
  connectMock,
  businessFindOneMock,
  businessFindMock,
  businessFindByIdMock,
  organizationFindByIdMock,
  locationFindOneMock,
  reviewFindOneMock,
  readOrganizationIdMock,
} = vi.hoisted(() => ({
  requireOrgMock: vi.fn(),
  requireAuthMock: vi.fn(),
  connectMock: vi.fn(),
  businessFindOneMock: vi.fn(),
  businessFindMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  organizationFindByIdMock: vi.fn(),
  locationFindOneMock: vi.fn(),
  reviewFindOneMock: vi.fn(),
  readOrganizationIdMock: vi.fn(),
}));

vi.mock("@/lib/org/requireOrg", () => ({
  requireOrganizationId: requireOrgMock,
  isOrgResult: (value: { orgId: string } | { response: NextResponse }) =>
    "orgId" in value,
}));

vi.mock("@/lib/org/session", () => ({
  readOrganizationId: readOrganizationIdMock,
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireAuthUser: requireAuthMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: {
    findOne: businessFindOneMock,
    find: businessFindMock,
    findById: businessFindByIdMock,
  },
}));

vi.mock("@/models/Organization", () => ({
  Organization: {
    findById: organizationFindByIdMock,
  },
}));

vi.mock("@/models/Location", () => ({
  Location: {
    findOne: locationFindOneMock,
  },
}));

vi.mock("@/models/Review", () => ({
  Review: {
    findOne: reviewFindOneMock,
  },
}));

import {
  assertUserCanAccessLocation,
  assertUserCanAccessReview,
  requireOrgAndUserAccess,
  userHasOrgAccess,
} from "@/lib/auth/googleRouteAuth";

const ORG_A = new mongoose.Types.ObjectId().toString();
const BIZ_A = new mongoose.Types.ObjectId().toString();
const BIZ_B = new mongoose.Types.ObjectId().toString();
const LOC_A = new mongoose.Types.ObjectId().toString();
const REVIEW_A = new mongoose.Types.ObjectId().toString();
const USER_ID = new mongoose.Types.ObjectId().toString();

describe("Google route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    readOrganizationIdMock.mockResolvedValue(null);
  });

  it("rejects unauthenticated Google workspace access", async () => {
    requireOrgMock.mockResolvedValue({ orgId: ORG_A });
    requireAuthMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "unauthorized" },
        { status: 401 }
      ),
    });

    const result = await requireOrgAndUserAccess();
    expect("response" in result).toBe(true);
    if ("response" in result) {
      expect(result.response.status).toBe(401);
    }
  });

  it("resolves owner org from business when cookie is missing", async () => {
    requireAuthMock.mockResolvedValue({
      user: {
        userId: USER_ID,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ_A],
      },
    });
    readOrganizationIdMock.mockResolvedValue(null);
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [
          {
            _id: BIZ_A,
            orgId: ORG_A,
            active: true,
            status: "active",
          },
        ],
      }),
    });

    const result = await requireOrgAndUserAccess();
    expect(result).toMatchObject({ orgId: ORG_A });
    expect(requireOrgMock).not.toHaveBeenCalled();
  });

  it("rejects signed-in owners without org business membership", async () => {
    requireOrgMock.mockResolvedValue({ orgId: ORG_A });
    requireAuthMock.mockResolvedValue({
      user: {
        userId: USER_ID,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ_B],
      },
    });
    organizationFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: ORG_A }),
      }),
    });
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [],
      }),
    });

    const result = await requireOrgAndUserAccess();
    expect("response" in result).toBe(true);
    if ("response" in result) {
      expect(result.response.status).toBe(403);
    }
  });

  it("rejects owner access when organization record is missing", async () => {
    organizationFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });
    await expect(
      userHasOrgAccess(
        {
          userId: USER_ID,
          role: "business_owner",
          email: "owner@example.com",
          businessIds: [BIZ_A],
        },
        ORG_A
      )
    ).resolves.toBe(false);
    expect(businessFindMock).not.toHaveBeenCalled();
  });

  it("rejects superadmin access for a non-existent organization id", async () => {
    organizationFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });
    await expect(
      userHasOrgAccess(
        {
          userId: USER_ID,
          role: "superadmin",
          email: "admin@example.com",
          businessIds: [],
        },
        ORG_A
      )
    ).resolves.toBe(false);
  });

  it("denies cross-business location access for owners", async () => {
    locationFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          businessId: BIZ_B,
        }),
      }),
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          active: true,
          ownerUserId: new mongoose.Types.ObjectId(),
        }),
      }),
    });

    const result = await assertUserCanAccessLocation({
      user: {
        userId: USER_ID,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ_A],
      },
      orgId: ORG_A,
      locationId: LOC_A,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("denies unassigned review access for business owners", async () => {
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          businessId: null,
          locationId: LOC_A,
        }),
      }),
    });
    locationFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          businessId: null,
        }),
      }),
    });

    const result = await assertUserCanAccessReview({
      user: {
        userId: USER_ID,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ_A],
      },
      orgId: ORG_A,
      reviewId: REVIEW_A,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.code).toBe("location_unassigned");
    }
  });

  it("allows owner access when review.businessId is null but location is assigned to their business", async () => {
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          businessId: null,
          locationId: LOC_A,
        }),
      }),
    });
    locationFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          businessId: BIZ_A,
        }),
      }),
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          active: true,
          status: "active",
          ownerUserId: USER_ID,
        }),
      }),
    });

    const result = await assertUserCanAccessReview({
      user: {
        userId: USER_ID,
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ_A],
      },
      orgId: ORG_A,
      reviewId: REVIEW_A,
    });
    expect(result.ok).toBe(true);
  });

  it("allows superadmin location access including unassigned", async () => {
    locationFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          businessId: null,
        }),
      }),
    });

    const result = await assertUserCanAccessLocation({
      user: {
        userId: USER_ID,
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
      orgId: ORG_A,
      locationId: LOC_A,
    });
    expect(result.ok).toBe(true);
  });

  it("grants org access via groupIds when businessIds are empty", async () => {
    const GROUP = new mongoose.Types.ObjectId().toString();
    organizationFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: ORG_A }),
      }),
    });
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [
          { _id: BIZ_A, active: true, status: "active" },
        ],
      }),
    });

    await expect(
      userHasOrgAccess(
        {
          userId: USER_ID,
          role: "business_owner",
          email: "owner@example.com",
          businessIds: [],
          groupIds: [GROUP],
        },
        ORG_A
      )
    ).resolves.toBe(true);
    expect(businessFindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_A,
        $or: expect.arrayContaining([
          { groupId: { $in: [GROUP] } },
          { ownerUserId: USER_ID },
        ]),
      })
    );
  });

  it("denies org access when group membership does not match any business", async () => {
    const GROUP = new mongoose.Types.ObjectId().toString();
    organizationFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: ORG_A }),
      }),
    });
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [],
      }),
    });

    await expect(
      userHasOrgAccess(
        {
          userId: USER_ID,
          role: "business_owner",
          email: "owner@example.com",
          businessIds: [],
          groupIds: [GROUP],
        },
        ORG_A
      )
    ).resolves.toBe(false);
  });

  it("userHasOrgAccess is true for superadmin when the organization exists", async () => {
    organizationFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: ORG_A }),
      }),
    });
    await expect(
      userHasOrgAccess(
        {
          userId: USER_ID,
          role: "superadmin",
          email: "admin@example.com",
          businessIds: [],
        },
        ORG_A
      )
    ).resolves.toBe(true);
  });
});

