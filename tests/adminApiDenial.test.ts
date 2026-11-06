/**
 * BA / signed-out denial matrix for Super Admin organization and assignment APIs.
 * Uses route handlers with mocked requireSuperAdmin — no live Mongo data.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const { requireSuperAdminMock } = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: vi.fn(),
}));

vi.mock("@/lib/org/session", () => ({
  readOrganizationId: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/org/requireOrg", () => ({
  requireOrganizationId: vi.fn(),
  isOrgResult: () => false,
}));

vi.mock("@/models/Organization", () => ({
  Organization: { find: vi.fn() },
}));

vi.mock("@/models/Location", () => ({
  Location: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/models/Business", () => ({
  Business: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/models/BusinessGroup", () => ({
  BusinessGroup: { find: vi.fn() },
}));

vi.mock("@/models/User", () => ({
  User: { find: vi.fn() },
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: { find: vi.fn(), findOne: vi.fn() },
}));

import { GET as organizationsGet } from "@/app/api/admin/organizations/route";
import { POST as organizationsSelectPost } from "@/app/api/admin/organizations/select/route";
import { GET as locationsGet } from "@/app/api/admin/locations/route";
import { GET as unassignedGet } from "@/app/api/admin/locations/unassigned/route";
import { GET as businessesGet } from "@/app/api/admin/businesses/route";
import { GET as groupsGet } from "@/app/api/admin/groups/route";

function forbiddenResponse() {
  return NextResponse.json(
    {
      success: false,
      code: "forbidden",
      message: "Super Admin access required.",
    },
    { status: 403 }
  );
}

function unauthorizedResponse() {
  return NextResponse.json(
    { success: false, code: "unauthorized" },
    { status: 401 }
  );
}

const superAdmin = {
  user: {
    userId: "sa1",
    role: "superadmin" as const,
    email: "sa@example.com",
    businessIds: [] as string[],
  },
};

describe("admin API denial (BA / signed-out)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["GET /api/admin/organizations", () => organizationsGet()],
    [
      "POST /api/admin/organizations/select",
      () =>
        organizationsSelectPost(
          new Request("http://localhost/api/admin/organizations/select", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
            },
            body: JSON.stringify({ orgId: "000000000000000000000001" }),
          })
        ),
    ],
    [
      "GET /api/admin/locations",
      () =>
        locationsGet(new Request("http://localhost/api/admin/locations")),
    ],
    [
      "GET /api/admin/locations/unassigned",
      () =>
        unassignedGet(
          new Request("http://localhost/api/admin/locations/unassigned")
        ),
    ],
    ["GET /api/admin/businesses", () => businessesGet()],
    ["GET /api/admin/groups", () => groupsGet()],
  ])("%s returns 403 for Business Admin", async (_label, call) => {
    requireSuperAdminMock.mockImplementation(async () => ({
      response: forbiddenResponse(),
    }));
    const res = await call();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it.each([
    ["GET /api/admin/organizations", () => organizationsGet()],
    ["GET /api/admin/businesses", () => businessesGet()],
    ["GET /api/admin/groups", () => groupsGet()],
    [
      "GET /api/admin/locations/unassigned",
      () =>
        unassignedGet(
          new Request("http://localhost/api/admin/locations/unassigned")
        ),
    ],
  ])("%s returns 401 when signed out", async (_label, call) => {
    requireSuperAdminMock.mockImplementation(async () => ({
      response: unauthorizedResponse(),
    }));
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("Super Admin still reaches organization list gate", async () => {
    requireSuperAdminMock.mockResolvedValue(superAdmin);
    const { Organization } = await import("@/models/Organization");
    (Organization.find as ReturnType<typeof vi.fn>).mockReturnValue({
      select: () => ({
        sort: () => ({
          lean: async () => [],
        }),
      }),
    });
    const res = await organizationsGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.organizations).toEqual([]);
  });
});
