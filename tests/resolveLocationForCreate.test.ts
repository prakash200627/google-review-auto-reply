import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  locationFindByIdMock,
  businessFindByIdMock,
  orgFindByIdMock,
  googleFindOneMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  locationFindByIdMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  orgFindByIdMock: vi.fn(),
  googleFindOneMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Location", () => ({
  Location: { findById: locationFindByIdMock },
}));

vi.mock("@/models/Business", () => ({
  Business: { findById: businessFindByIdMock },
}));

vi.mock("@/models/Organization", () => ({
  Organization: { findById: orgFindByIdMock },
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: { findOne: googleFindOneMock },
}));

import { resolveLocationForBusinessCreate } from "@/lib/business/resolveLocationForCreate";
import { LocationAssignmentError } from "@/lib/business/assignLocations";

const LOC = new mongoose.Types.ObjectId().toString();
const ORG = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();

function leanLoc(doc: Record<string, unknown> | null) {
  locationFindByIdMock.mockReturnValue({
    select: () => ({ lean: async () => doc }),
  });
}

describe("resolveLocationForBusinessCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("rejects invalid location ids", async () => {
    await expect(resolveLocationForBusinessCreate("bad")).rejects.toMatchObject({
      code: "invalid_location_id",
    });
  });

  it("rejects missing locations", async () => {
    leanLoc(null);
    await expect(resolveLocationForBusinessCreate(LOC)).rejects.toMatchObject({
      code: "location_not_found",
    });
  });

  it("rejects already-assigned locations without stealing", async () => {
    leanLoc({
      _id: LOC,
      orgId: ORG,
      businessId: BIZ,
      googleLocationName: "accounts/1/locations/1",
      title: "Native South",
      address: "1 Main",
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ name: "Native South" }),
      }),
    });

    await expect(resolveLocationForBusinessCreate(LOC)).rejects.toBeInstanceOf(
      LocationAssignmentError
    );
    await expect(resolveLocationForBusinessCreate(LOC)).rejects.toMatchObject({
      code: "location_already_assigned",
      status: 409,
    });
  });

  it("rejects when organization is missing", async () => {
    leanLoc({
      _id: LOC,
      orgId: ORG,
      businessId: null,
      googleLocationName: "accounts/1/locations/1",
      title: "Brew Times",
      address: "",
    });
    orgFindByIdMock.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });

    await expect(resolveLocationForBusinessCreate(LOC)).rejects.toMatchObject({
      code: "org_missing",
    });
  });

  it("rejects when Google connection is unavailable", async () => {
    leanLoc({
      _id: LOC,
      orgId: ORG,
      businessId: null,
      googleLocationName: "accounts/1/locations/1",
      title: "Brew Times",
      address: "2 Main",
    });
    orgFindByIdMock.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: ORG }) }),
    });
    googleFindOneMock.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });

    await expect(resolveLocationForBusinessCreate(LOC)).rejects.toMatchObject({
      code: "connection_unavailable",
    });
  });

  it("resolves org and connection from the location document", async () => {
    leanLoc({
      _id: new mongoose.Types.ObjectId(LOC),
      orgId: new mongoose.Types.ObjectId(ORG),
      businessId: null,
      googleLocationName: "accounts/1/locations/9",
      title: "Brew Times",
      address: "2 Main",
    });
    orgFindByIdMock.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: ORG }) }),
    });
    googleFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          status: "active",
          googleAccountEmail: "ops@example.com",
          connectionSource: "platform",
        }),
      }),
    });

    const resolved = await resolveLocationForBusinessCreate(LOC);
    expect(resolved.orgId).toBe(ORG);
    expect(resolved.locationId).toBe(LOC);
    expect(resolved.connection?.status).toBe("active");
    expect(resolved.title).toBe("Brew Times");
  });
});
