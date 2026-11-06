/**
 * BA / signed-out denial for admin business mutating routes and detail GET.
 * Mocked requireSuperAdmin — no live Mongo writes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const { requireSuperAdminMock } = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  assertBusinessAccess: vi.fn(),
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/auth/requestOrigin", () => ({
  assertMutationOrigin: () => ({ ok: true as const }),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: vi.fn(),
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: vi.fn(),
}));

vi.mock("@/models/Business", () => ({
  Business: { find: vi.fn(), findById: vi.fn(), create: vi.fn() },
  BRAND_VOICES: ["friendly"],
  REPLY_MODES: ["manual", "auto"],
}));

vi.mock("@/models/Location", () => ({
  Location: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/models/Organization", () => ({
  Organization: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/models/Review", () => ({
  Review: { countDocuments: vi.fn() },
}));

vi.mock("@/models/User", () => ({
  User: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/lib/org/session", () => ({
  readOrganizationId: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/mongo/transactions", () => ({
  withMongoTransaction: vi.fn(),
  isMongoDuplicateKeyError: () => false,
  MongoTransactionError: class extends Error {
    code = "transaction_failed";
    status = 500;
  },
}));

vi.mock("@/lib/business/assignLocations", () => ({
  assertAssignableLocations: vi.fn(),
  loadAssignableLocations: vi.fn(),
  LocationAssignmentError: class extends Error {
    code = "assign_error";
    status = 400;
  },
  validateLocationAssignmentInput: vi.fn(),
}));

vi.mock("@/lib/business/reassignLocation", () => ({
  replaceBusinessLocationsAtomic: vi.fn(),
  assertLocationMovable: vi.fn(),
}));

vi.mock("@/lib/business/resolveLocationForCreate", () => ({
  resolveLocationForBusinessCreate: vi.fn(),
}));

vi.mock("@/lib/business/owners", () => ({
  OwnerAccountError: class extends Error {
    code = "owner_error";
    status = 400;
  },
  upsertBusinessOwner: vi.fn(),
  reassignBusinessOwner: vi.fn(),
}));

vi.mock("@/lib/groups/membership", () => ({
  GroupMembershipError: class extends Error {
    code = "group_error";
    status = 400;
  },
  setBusinessGroup: vi.fn(),
  refreshOwnersForBusinessGroupChange: vi.fn(),
}));

vi.mock("@/lib/business/stats", () => ({
  clearReviewBusinessIdsForLocations: vi.fn(),
  syncReviewBusinessIdsForLocations: vi.fn(),
}));

vi.mock("@/lib/autoPublish/cancelJobs", () => ({
  cancelOpenAutoPublishJobsForBusiness: vi.fn(),
}));

import { POST as businessesPost } from "@/app/api/admin/businesses/route";
import {
  GET as businessGet,
  PATCH as businessPatch,
} from "@/app/api/admin/businesses/[businessId]/route";
import { POST as ownersPost } from "@/app/api/admin/owners/route";

const BIZ = new mongoose.Types.ObjectId().toString();

function forbidden() {
  return NextResponse.json(
    {
      success: false,
      code: "forbidden",
      message: "Super Admin access required.",
    },
    { status: 403 }
  );
}

describe("admin business mutation denial (BA)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSuperAdminMock.mockResolvedValue({ response: forbidden() });
  });

  it("POST /api/admin/businesses returns 403 for Business Admin", async () => {
    const res = await businessesPost(
      new Request("http://localhost/api/admin/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X", locationId: BIZ }),
      })
    );
    expect(res.status).toBe(403);
  });

  it("GET /api/admin/businesses/[id] returns 403 for Business Admin", async () => {
    const res = await businessGet(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(403);
  });

  it("PATCH /api/admin/businesses/[id] returns 403 for Business Admin", async () => {
    const res = await businessPatch(
      new Request(`http://localhost/api/admin/businesses/${BIZ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(403);
  });

  it("POST /api/admin/owners returns 403 for Business Admin", async () => {
    const res = await ownersPost(
      new Request("http://localhost/api/admin/owners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "assign",
          email: "ba@example.com",
          businessId: BIZ,
        }),
      })
    );
    expect(res.status).toBe(403);
  });
});
