import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireOrgUserMock,
  syncLocationsMock,
  listStoredMock,
  connectMock,
  locationFindMock,
  businessFindMock,
} = vi.hoisted(() => ({
  requireOrgUserMock: vi.fn(),
  syncLocationsMock: vi.fn(),
  listStoredMock: vi.fn(),
  connectMock: vi.fn(),
  locationFindMock: vi.fn(),
  businessFindMock: vi.fn(),
}));

vi.mock("@/lib/auth/googleRouteAuth", () => ({
  requireOrgAndUserAccess: requireOrgUserMock,
  isOrgUserResult: (
    value: { orgId: string; user: unknown } | { response: NextResponse }
  ) => "orgId" in value && "user" in value,
}));

vi.mock("@/lib/google/syncLocations", () => ({
  syncLocationsForOrg: syncLocationsMock,
  listStoredLocationsForOrg: listStoredMock,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Location", () => ({
  Location: {
    find: locationFindMock,
  },
}));

vi.mock("@/models/Business", () => ({
  Business: {
    find: businessFindMock,
  },
  BRAND_VOICES: ["friendly", "professional", "casual", "premium"],
  REPLY_MODES: ["manual", "auto"],
}));

import { GET, POST } from "@/app/api/google/locations/route";

const ORG = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId().toString();

describe("GET/POST /api/google/locations authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("rejects discovery from business owners without calling Google sync", async () => {
    requireOrgUserMock.mockResolvedValue({
      orgId: ORG,
      user: {
        userId: new mongoose.Types.ObjectId().toString(),
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ],
      },
    });

    const res = await POST(
      new Request("http://localhost/api/google/locations", { method: "POST" })
    );
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe("forbidden");
    expect(syncLocationsMock).not.toHaveBeenCalled();
  });

  it("allows Super Admin discovery / org-wide upsert", async () => {
    requireOrgUserMock.mockResolvedValue({
      orgId: ORG,
      user: {
        userId: new mongoose.Types.ObjectId().toString(),
        role: "superadmin",
        email: "admin@example.com",
        businessIds: [],
      },
    });
    syncLocationsMock.mockResolvedValue({
      discovered: 2,
      locations: [{ id: LOC, title: "Store" }],
    });

    const res = await POST(
      new Request("http://localhost/api/google/locations", { method: "POST" })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(syncLocationsMock).toHaveBeenCalledWith(ORG);
  });

  it("filters listed locations for business owners", async () => {
    requireOrgUserMock.mockResolvedValue({
      orgId: ORG,
      user: {
        userId: new mongoose.Types.ObjectId().toString(),
        role: "business_owner",
        email: "owner@example.com",
        businessIds: [BIZ],
      },
    });
    listStoredMock.mockResolvedValue([
      { id: LOC, title: "Assigned" },
      { id: new mongoose.Types.ObjectId().toString(), title: "Other" },
    ]);
    businessFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: BIZ }],
      }),
    });
    locationFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: LOC }],
      }),
    });

    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.locations).toEqual([{ id: LOC, title: "Assigned" }]);
  });

  it("rejects unauthenticated location list", async () => {
    requireOrgUserMock.mockResolvedValue({
      response: NextResponse.json(
        { success: false, code: "unauthorized" },
        { status: 401 }
      ),
    });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listStoredMock).not.toHaveBeenCalled();
  });
});
