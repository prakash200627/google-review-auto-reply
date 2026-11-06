import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireSuperAdminMock,
  requireOrganizationIdMock,
  connectMock,
  locationFindMock,
  businessFindMock,
  googleFindMock,
} = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
  requireOrganizationIdMock: vi.fn(),
  connectMock: vi.fn(),
  locationFindMock: vi.fn(),
  businessFindMock: vi.fn(),
  googleFindMock: vi.fn(),
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

vi.mock("@/models/Business", () => ({
  Business: { find: businessFindMock },
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: { find: googleFindMock },
}));

import { GET } from "@/app/api/admin/locations/route";

const ORG = new mongoose.Types.ObjectId().toString();
const OTHER_ORG = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId().toString();

function saAuth() {
  requireSuperAdminMock.mockResolvedValue({
    user: {
      userId: new mongoose.Types.ObjectId().toString(),
      role: "superadmin",
      email: "admin@example.com",
      businessIds: [],
    },
  });
  requireOrganizationIdMock.mockResolvedValue({ orgId: ORG });
}

function mockLocations(rows: Record<string, unknown>[]) {
  locationFindMock.mockReturnValue({
    sort: () => ({
      select: () => ({
        limit: () => ({
          lean: async () => rows,
        }),
      }),
    }),
  });
}

describe("GET /api/admin/locations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("rejects non-Super-Admin callers", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json({ success: false }, { status: 403 }),
    });
    const res = await GET(
      new Request("http://localhost/api/admin/locations")
    );
    expect(res.status).toBe(403);
    expect(locationFindMock).not.toHaveBeenCalled();
  });

  it("requires an active organization session", async () => {
    saAuth();
    requireOrganizationIdMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "no_session" },
        { status: 401 }
      ),
    });
    const res = await GET(
      new Request("http://localhost/api/admin/locations")
    );
    expect(res.status).toBe(401);
    expect(locationFindMock).not.toHaveBeenCalled();
  });

  it("rejects a client orgId that differs from the signed workspace cookie", async () => {
    saAuth();
    const res = await GET(
      new Request(
        `http://localhost/api/admin/locations?orgId=${OTHER_ORG}`
      )
    );
    expect(res.status).toBe(403);
    expect(locationFindMock).not.toHaveBeenCalled();
  });

  it("scopes the Mongo query to the active org and returns metadata", async () => {
    saAuth();
    mockLocations([
      {
        _id: LOC,
        title: "Brew Times",
        address: "2 Main",
        googleLocationName: "accounts/1/locations/2",
        googleAccountName: "accounts/1",
        businessInfoName: "locations/2",
        orgId: ORG,
        businessId: null,
      },
    ]);
    businessFindMock.mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    googleFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [
          {
            orgId: ORG,
            status: "active",
            googleAccountEmail: "ops@example.com",
            connectionSource: "platform",
          },
        ],
      }),
    });

    const res = await GET(
      new Request(
        "http://localhost/api/admin/locations?q=brew&includeAssigned=1"
      )
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(locationFindMock).toHaveBeenCalledWith({ orgId: ORG });
    expect(body.source).toBe("mongodb_discovery_cache");
    expect(body.orgId).toBe(ORG);
    expect(body.locations).toHaveLength(1);
    expect(body.locations[0].identityKey).toBe(
      `${ORG}::accounts/1/locations/2`
    );
    expect(body.locations[0].selectability).toBe("available");
    expect(body.locations[0].identityKey).not.toContain("undefined");
  });

  it("dedupes identical resource ids, keeps same display names separate, and skips invalid ids", async () => {
    saAuth();
    const idA = new mongoose.Types.ObjectId().toString();
    const idB = new mongoose.Types.ObjectId().toString();
    const idC = new mongoose.Types.ObjectId().toString();
    const bizId = new mongoose.Types.ObjectId().toString();
    mockLocations([
      {
        _id: idA,
        title: "Amnesia Lounge Bar",
        address: "",
        googleLocationName: "accounts/1/locations/dup",
        orgId: ORG,
        businessId: null,
        updatedAt: new Date("2026-01-01"),
      },
      {
        _id: idB,
        title: "Amnesia Lounge Bar",
        address: "",
        googleLocationName: "accounts/1/locations/dup",
        orgId: ORG,
        businessId: bizId,
        updatedAt: new Date("2026-02-01"),
      },
      {
        _id: idC,
        title: "Amnesia Lounge Bar",
        address: "",
        googleLocationName: "accounts/1/locations/other",
        orgId: ORG,
        businessId: null,
        updatedAt: new Date("2026-03-01"),
      },
      {
        _id: new mongoose.Types.ObjectId().toString(),
        title: "Broken",
        address: "",
        googleLocationName: undefined,
        orgId: ORG,
        businessId: null,
      },
      {
        _id: new mongoose.Types.ObjectId().toString(),
        title: "Leak",
        address: "x",
        googleLocationName: "accounts/9/locations/z",
        orgId: OTHER_ORG,
        businessId: null,
      },
    ]);
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: bizId, name: "Assigned Biz" }],
      }),
    });
    googleFindMock.mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });

    const res = await GET(
      new Request("http://localhost/api/admin/locations?includeAssigned=1")
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.skippedInvalid).toBeGreaterThanOrEqual(1);
    expect(body.totalMatched).toBe(2);
    expect(body.duplicateCollapsed).toBe(1);
    expect(body.locations).toHaveLength(2);
    expect(
      body.locations.every(
        (l: { identityKey: string; orgId: string }) =>
          l.orgId === ORG && !l.identityKey.includes("undefined")
      )
    ).toBe(true);
    const assigned = body.locations.find(
      (l: { googleLocationName: string }) =>
        l.googleLocationName === "accounts/1/locations/dup"
    );
    expect(assigned.selectability).toBe("already_assigned");
    expect(assigned.selectable).toBe(false);
    expect(assigned.assignedBusinessName).toBe("Assigned Biz");
    expect(assigned.addressUnavailable).toBe(true);
    const other = body.locations.find(
      (l: { googleLocationName: string }) =>
        l.googleLocationName === "accounts/1/locations/other"
    );
    expect(other.selectability).toBe("no_usable_connection");
    expect(other.title).toBe("Amnesia Lounge Bar");
  });

  it("paginates with offset/limit and reports hasMore", async () => {
    saAuth();
    mockLocations(
      Array.from({ length: 5 }, (_, i) => ({
        _id: new mongoose.Types.ObjectId().toString(),
        title: `Loc ${i}`,
        address: `Addr ${i}`,
        googleLocationName: `accounts/1/locations/${i}`,
        orgId: ORG,
        businessId: null,
      }))
    );
    businessFindMock.mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    googleFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ orgId: ORG, status: "active" }],
      }),
    });

    const res = await GET(
      new Request(
        "http://localhost/api/admin/locations?includeAssigned=1&limit=2&offset=0"
      )
    );
    const body = await res.json();
    expect(body.locations).toHaveLength(2);
    expect(body.totalMatched).toBe(5);
    expect(body.hasMore).toBe(true);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);

    const res2 = await GET(
      new Request(
        "http://localhost/api/admin/locations?includeAssigned=1&limit=2&offset=4"
      )
    );
    const body2 = await res2.json();
    expect(body2.locations).toHaveLength(1);
    expect(body2.hasMore).toBe(false);
  });
});
