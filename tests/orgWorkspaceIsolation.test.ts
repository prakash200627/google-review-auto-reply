import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  readOrganizationIdMock,
  connectMock,
  organizationFindByIdMock,
  businessFindMock,
  locationFindMock,
  listStoredMock,
  listActiveMock,
  requireSuperAdminMock,
  applyCookieMock,
  auditMock,
} = vi.hoisted(() => ({
  readOrganizationIdMock: vi.fn(),
  connectMock: vi.fn(),
  organizationFindByIdMock: vi.fn(),
  businessFindMock: vi.fn(),
  locationFindMock: vi.fn(),
  listStoredMock: vi.fn(),
  listActiveMock: vi.fn(),
  requireSuperAdminMock: vi.fn(),
  applyCookieMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock("@/lib/org/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/org/session")>(
    "@/lib/org/session"
  );
  return {
    ...actual,
    readOrganizationId: readOrganizationIdMock,
    applySelectedOrganizationCookie: applyCookieMock,
  };
});

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Organization", () => ({
  Organization: { findById: organizationFindByIdMock },
}));

vi.mock("@/models/Business", () => ({
  Business: { find: businessFindMock },
}));

vi.mock("@/models/Location", () => ({
  Location: { find: locationFindMock },
}));

vi.mock("@/lib/google/syncLocations", () => ({
  listStoredLocationsForOrg: listStoredMock,
}));

vi.mock("@/lib/auth/authorize", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/authorize")>(
    "@/lib/auth/authorize"
  );
  return {
    ...actual,
    listActiveBusinessIdsForUser: listActiveMock,
    requireSuperAdmin: requireSuperAdminMock,
    isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
      "user" in value,
  };
});

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditMock,
}));

import {
  assertSuperAdminActiveOrgMatches,
  resolveAuthorizedOrgId,
} from "@/lib/auth/resolveOrgContext";
import { listVisibleLocationsForUser } from "@/lib/auth/visibleLocations";
import { encodeOrgSession, decodeOrgSession } from "@/lib/org/session";
import { POST as selectOrganization } from "@/app/api/admin/organizations/select/route";

const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();
const BIZ_A = new mongoose.Types.ObjectId().toString();
const LOC_A = new mongoose.Types.ObjectId().toString();
const LOC_B = new mongoose.Types.ObjectId().toString();

describe("organization switching and cookie persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = "test-auth-secret-32chars-minimum!";
    connectMock.mockResolvedValue({});
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
    });
  });

  it("switches active org by setting a signed cookie on the select response", async () => {
    organizationFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: ORG_A, name: "Workspace A" }),
      }),
    });

    const res = await selectOrganization(
      new Request("http://localhost:3000/api/admin/organizations/select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ orgId: ORG_A }),
      })
    );
    expect(res.status).toBe(200);
    expect(applyCookieMock).toHaveBeenCalledWith(
      expect.any(NextResponse),
      ORG_A
    );
  });

  it("persists org id through encode/decode round-trip (refresh-safe)", () => {
    const token = encodeOrgSession({
      orgId: ORG_A,
      exp: Date.now() + 60_000,
    });
    expect(decodeOrgSession(token)?.orgId).toBe(ORG_A);
  });

  it("rejects invalid organization ids on switch", async () => {
    const res = await selectOrganization(
      new Request("http://localhost:3000/api/admin/organizations/select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ orgId: "bad-id" }),
      })
    );
    expect(res.status).toBe(400);
    expect(applyCookieMock).not.toHaveBeenCalled();
  });

  it("rejects inaccessible / missing organizations on switch", async () => {
    organizationFindByIdMock.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    const res = await selectOrganization(
      new Request("http://localhost:3000/api/admin/organizations/select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ orgId: ORG_B }),
      })
    );
    expect(res.status).toBe(404);
    expect(applyCookieMock).not.toHaveBeenCalled();
  });
});

describe("assertSuperAdminActiveOrgMatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("requires an active org session for Super Admin", async () => {
    readOrganizationIdMock.mockResolvedValue(null);
    const result = await assertSuperAdminActiveOrgMatches(
      {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
      ORG_A
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("org_required");
  });

  it("blocks cross-organization business access for Super Admin", async () => {
    readOrganizationIdMock.mockResolvedValue(ORG_A);
    organizationFindByIdMock.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: ORG_A }) }),
    });

    const result = await assertSuperAdminActiveOrgMatches(
      {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
      ORG_B
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("org_mismatch");
  });

  it("allows Super Admin when resource org matches active session", async () => {
    readOrganizationIdMock.mockResolvedValue(ORG_A);
    organizationFindByIdMock.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: ORG_A }) }),
    });

    const result = await assertSuperAdminActiveOrgMatches(
      {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
      ORG_A
    );
    expect(result).toEqual({ ok: true, orgId: ORG_A });
  });

  it("is a no-op for Business Admin (assignment gates apply elsewhere)", async () => {
    const result = await assertSuperAdminActiveOrgMatches(
      {
        userId: USER,
        role: "business_owner",
        email: "ba@example.com",
        businessIds: [BIZ_A],
      },
      ORG_B
    );
    expect(result.ok).toBe(true);
    expect(readOrganizationIdMock).not.toHaveBeenCalled();
  });
});

describe("GMB organization scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("lists only locations for the authorized org (SA)", async () => {
    listStoredMock.mockResolvedValue([
      {
        id: LOC_A,
        title: "In org",
        address: "",
        googleLocationName: "accounts/1/locations/1",
        lastDiscoveryAt: null,
        lastReviewsSyncAt: null,
      },
    ]);

    const rows = await listVisibleLocationsForUser({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
      orgId: ORG_A,
    });
    expect(listStoredMock).toHaveBeenCalledWith(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(LOC_A);
  });

  it("SA with businessId only sees locations assigned to that business", async () => {
    listStoredMock.mockResolvedValue([
      {
        id: LOC_A,
        title: "Assigned",
        address: "",
        googleLocationName: "accounts/1/locations/1",
        lastDiscoveryAt: null,
        lastReviewsSyncAt: null,
      },
      {
        id: LOC_B,
        title: "Unassigned cache",
        address: "",
        googleLocationName: "accounts/1/locations/2",
        lastDiscoveryAt: null,
        lastReviewsSyncAt: null,
      },
    ]);
    locationFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: new mongoose.Types.ObjectId(LOC_A) }],
      }),
    });

    const rows = await listVisibleLocationsForUser({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
      orgId: ORG_A,
      businessId: BIZ_A,
    });
    expect(locationFindMock).toHaveBeenCalledWith({
      orgId: ORG_A,
      businessId: BIZ_A,
    });
    expect(rows.map((r) => r.id)).toEqual([LOC_A]);
  });

  it("returns empty for invalid org id", async () => {
    const rows = await listVisibleLocationsForUser({
      user: {
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      },
      orgId: "not-valid",
    });
    expect(rows).toEqual([]);
    expect(listStoredMock).not.toHaveBeenCalled();
  });

  it("BA only sees locations assigned to authorized businesses in that org", async () => {
    listStoredMock.mockResolvedValue([
      {
        id: LOC_A,
        title: "Mine",
        address: "",
        googleLocationName: "accounts/1/locations/1",
        lastDiscoveryAt: null,
        lastReviewsSyncAt: null,
      },
      {
        id: LOC_B,
        title: "Other",
        address: "",
        googleLocationName: "accounts/1/locations/2",
        lastDiscoveryAt: null,
        lastReviewsSyncAt: null,
      },
    ]);
    listActiveMock.mockResolvedValue([BIZ_A]);
    locationFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: new mongoose.Types.ObjectId(LOC_A) }],
      }),
    });

    const rows = await listVisibleLocationsForUser({
      user: {
        userId: USER,
        role: "business_owner",
        email: "ba@example.com",
        businessIds: [BIZ_A],
      },
      orgId: ORG_A,
    });
    expect(locationFindMock).toHaveBeenCalledWith({
      orgId: ORG_A,
      businessId: { $in: [BIZ_A] },
    });
    expect(rows.map((r) => r.id)).toEqual([LOC_A]);
  });
});

describe("stale client data after organization switching (source contracts)", () => {
  it("Admin businesses panel clears stale org data and refreshes on switch", () => {
    const src = readFileSync(
      join(process.cwd(), "components/AdminBusinessesPanel.tsx"),
      "utf8"
    );
    expect(src).toMatch(/selectActiveOrganization/);
    expect(src).toMatch(/setLocationResults\(\[\]\)/);
    expect(src).toMatch(/setUnassigned\(\[\]\)/);
    expect(src).toMatch(/setSelectedLocationId\(""\)/);
    expect(src).toMatch(/await refreshLists\(\)/);
    expect(src).toMatch(/router\.refresh\(\)/);
    expect(src).toMatch(/\/api\/admin\/organizations\/select/);
    expect(src).toMatch(/scopedBusinesses/);
  });

  it("admin location search rejects client orgId mismatch", () => {
    const src = readFileSync(
      join(process.cwd(), "app/api/admin/locations/route.ts"),
      "utf8"
    );
    expect(src).toMatch(/org_scope_mismatch/);
    expect(src).toMatch(/requireOrganizationId/);
  });

  it("GMB locations page uses resolveAuthorizedOrgId", () => {
    const src = readFileSync(
      join(process.cwd(), "app/gmb/locations/page.tsx"),
      "utf8"
    );
    expect(src).toMatch(/resolveAuthorizedOrgId/);
    expect(src).toMatch(/listVisibleLocationsForUser/);
  });

  it("Reviews inbox and page use org-scoped resolveReviewsBusinessScope", () => {
    const inbox = readFileSync(
      join(process.cwd(), "app/api/reviews/inbox/route.ts"),
      "utf8"
    );
    const page = readFileSync(
      join(process.cwd(), "app/orm/reviews/page.tsx"),
      "utf8"
    );
    expect(inbox).toMatch(/resolveReviewsBusinessScope/);
    expect(page).toMatch(/resolveReviewsBusinessScope/);
    expect(page).toMatch(/activeOrgId/);
  });

  it("ORM landing uses the same authorized org resolver", () => {
    const src = readFileSync(join(process.cwd(), "app/orm/page.tsx"), "utf8");
    expect(src).toMatch(/resolveAuthorizedOrgId/);
    expect(src).toMatch(/getOrmLandingChoices/);
  });

  it("ORM dashboards enforce Super Admin active-org match", () => {
    const src = readFileSync(
      join(process.cwd(), "lib/dashboard/ormDashboard.ts"),
      "utf8"
    );
    expect(src).toMatch(/assertSuperAdminActiveOrgMatches/);
  });
});

describe("resolveAuthorizedOrgId invalid / inaccessible cookie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("ignores cookie org when organization no longer exists (via userHasOrgAccess)", async () => {
    readOrganizationIdMock.mockResolvedValue(ORG_A);
    organizationFindByIdMock.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    businessFindMock.mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });

    await expect(
      resolveAuthorizedOrgId({
        userId: USER,
        role: "business_owner",
        email: "ba@example.com",
        businessIds: [BIZ_A],
      })
    ).resolves.toBeNull();
  });

  it("SA with missing cookie resolves to null (no invented org)", async () => {
    readOrganizationIdMock.mockResolvedValue(null);
    await expect(
      resolveAuthorizedOrgId({
        userId: USER,
        role: "superadmin",
        email: "sa@example.com",
        businessIds: [],
      })
    ).resolves.toBeNull();
  });
});
