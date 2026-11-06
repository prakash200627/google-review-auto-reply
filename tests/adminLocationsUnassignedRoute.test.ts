import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireSuperAdminMock,
  requireOrganizationIdMock,
  connectMock,
  locationFindMock,
} = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
  requireOrganizationIdMock: vi.fn(),
  connectMock: vi.fn(),
  locationFindMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/org/requireOrg", () => ({
  requireOrganizationId: requireOrganizationIdMock,
  isOrgResult: (value: { orgId: string } | { response: NextResponse }) =>
    "orgId" in value,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Location", () => ({
  Location: { find: locationFindMock },
}));

import { GET } from "@/app/api/admin/locations/unassigned/route";

const ORG = new mongoose.Types.ObjectId().toString();
const OTHER = new mongoose.Types.ObjectId().toString();

describe("GET /api/admin/locations/unassigned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: new mongoose.Types.ObjectId().toString(),
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
    });
    requireOrganizationIdMock.mockResolvedValue({ orgId: ORG });
  });

  it("scopes to active org, bounds results, and skips invalid identities", async () => {
    locationFindMock.mockReturnValue({
      sort: () => ({
        select: () => ({
          limit: () => ({
            lean: async () => [
              {
                _id: new mongoose.Types.ObjectId().toString(),
                title: "A",
                address: "",
                googleLocationName: "accounts/1/locations/1",
                orgId: ORG,
              },
              {
                _id: new mongoose.Types.ObjectId().toString(),
                title: "Bad",
                address: "",
                googleLocationName: undefined,
                orgId: ORG,
              },
              {
                _id: new mongoose.Types.ObjectId().toString(),
                title: "Leak",
                address: "x",
                googleLocationName: "accounts/2/locations/9",
                orgId: OTHER,
              },
            ],
          }),
        }),
      }),
    });

    const res = await GET(
      new Request("http://localhost/api/admin/locations/unassigned?limit=80")
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(locationFindMock).toHaveBeenCalledWith({
      orgId: ORG,
      $or: [{ businessId: null }, { businessId: { $exists: false } }],
    });
    expect(body.locations).toHaveLength(1);
    expect(body.locations[0].identityKey).toBe(
      `${ORG}::accounts/1/locations/1`
    );
    expect(body.locations[0].addressUnavailable).toBe(true);
    expect(body.skippedInvalid).toBe(1);
    expect(body.hasMore).toBe(false);
  });
});
