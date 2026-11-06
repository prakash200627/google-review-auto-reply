/**
 * Phase 3 — BA / signed-out denial matrix for SA-only routes that were
 * under-covered by adminApiDenial / mutation suites.
 * Route handlers only; requireSuperAdmin mocked — no live Mongo / Google.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const { requireSuperAdminMock } = vi.hoisted(() => ({
  requireSuperAdminMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  requireAuthUser: vi.fn(),
  assertBusinessAccess: vi.fn(),
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: vi.fn(),
}));

vi.mock("@/lib/org/requireOrg", () => ({
  requireOrganizationId: vi.fn(),
  isOrgResult: () => false,
}));

vi.mock("@/lib/org/session", () => ({
  readOrganizationId: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/requestOrigin", () => ({
  assertMutationOrigin: vi.fn(() => ({ ok: true as const })),
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: vi.fn(),
}));

vi.mock("@/models/AuditEvent", () => ({
  AuditEvent: { find: vi.fn() },
}));

vi.mock("@/models/Business", () => ({
  Business: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/models/BusinessGroup", () => ({
  BusinessGroup: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/models/Organization", () => ({
  Organization: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/models/User", () => ({
  User: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/models/FakeReviewFlag", () => ({
  FakeReviewFlag: { find: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/models/AutoPublishJob", () => ({
  AutoPublishJob: { countDocuments: vi.fn() },
}));

vi.mock("@/models/Review", () => ({
  Review: { findById: vi.fn() },
}));

vi.mock("@/lib/google/createLocation", () => ({
  CreateGbpLocationError: class extends Error {},
  listGoogleAccountsForOrg: vi.fn(),
}));

vi.mock("@/lib/business/stats", () => ({
  getAdminAggregateStats: vi.fn(),
}));

import { GET as statsGet } from "@/app/api/admin/stats/route";
import { GET as auditGet } from "@/app/api/admin/audit/route";
import { GET as ownersGet } from "@/app/api/admin/owners/route";
import { GET as groupsGet, POST as groupsPost } from "@/app/api/admin/groups/route";
import {
  GET as groupGet,
  PATCH as groupPatch,
  DELETE as groupDelete,
} from "@/app/api/admin/groups/[groupId]/route";
import {
  GET as autoPublishGet,
  PATCH as autoPublishPatch,
} from "@/app/api/admin/businesses/[businessId]/auto-publish/route";
import { GET as googleAccountsGet } from "@/app/api/admin/google/accounts/route";
import { GET as autoPublishProcessGet } from "@/app/api/admin/auto-publish/process/route";
import { GET as flagsGet } from "@/app/api/business/[businessId]/flags/route";
import { POST as seoPost } from "@/app/api/business/[businessId]/seo/route";
import { POST as servicesPost } from "@/app/api/business/[businessId]/services/route";
import { PATCH as flagPatch } from "@/app/api/reviews/[reviewId]/flag/route";

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

const bizId = "6aec4270d7e96d87e5543bab";
const groupId = "6aed514c5d05fe49ec2e21e1";
const reviewId = "6aaaaaaaaaaaaaaaaaaaaaaa";

const bizCtx = { params: Promise.resolve({ businessId: bizId }) };
const groupCtx = { params: Promise.resolve({ groupId }) };
const reviewCtx = { params: Promise.resolve({ reviewId }) };

describe("BA SA-only denial matrix (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["GET /api/admin/stats", () => statsGet()],
    [
      "GET /api/admin/audit",
      () => auditGet(new Request("http://localhost/api/admin/audit")),
    ],
    ["GET /api/admin/owners", () => ownersGet()],
    ["GET /api/admin/groups", () => groupsGet()],
    [
      "POST /api/admin/groups",
      () =>
        groupsPost(
          new Request("http://localhost/api/admin/groups", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
            },
            body: JSON.stringify({ name: "x" }),
          })
        ),
    ],
    ["GET /api/admin/groups/[groupId]", () => groupGet(new Request("http://localhost"), groupCtx)],
    [
      "PATCH /api/admin/groups/[groupId]",
      () =>
        groupPatch(
          new Request("http://localhost/api/admin/groups/" + groupId, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
            },
            body: JSON.stringify({ name: "y" }),
          }),
          groupCtx
        ),
    ],
    [
      "DELETE /api/admin/groups/[groupId]",
      () =>
        groupDelete(
          new Request("http://localhost/api/admin/groups/" + groupId, {
            method: "DELETE",
            headers: { Origin: "http://localhost:3000" },
          }),
          groupCtx
        ),
    ],
    [
      "GET /api/admin/businesses/[id]/auto-publish",
      () => autoPublishGet(new Request("http://localhost"), bizCtx),
    ],
    [
      "PATCH /api/admin/businesses/[id]/auto-publish",
      () =>
        autoPublishPatch(
          new Request("http://localhost", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
            },
            body: JSON.stringify({ enabled: false }),
          }),
          bizCtx
        ),
    ],
    ["GET /api/admin/google/accounts", () => googleAccountsGet()],
    [
      "GET /api/admin/auto-publish/process",
      () =>
        autoPublishProcessGet(
          new Request("http://localhost/api/admin/auto-publish/process")
        ),
    ],
    [
      "GET /api/business/[id]/flags",
      () => flagsGet(new Request("http://localhost"), bizCtx),
    ],
    [
      "POST /api/business/[id]/seo",
      () =>
        seoPost(
          new Request("http://localhost", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
            },
            body: JSON.stringify({ keyword: "test" }),
          }),
          bizCtx
        ),
    ],
    [
      "POST /api/business/[id]/services",
      () =>
        servicesPost(
          new Request("http://localhost", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
            },
            body: JSON.stringify({ name: "svc" }),
          }),
          bizCtx
        ),
    ],
    [
      "PATCH /api/reviews/[id]/flag",
      () =>
        flagPatch(
          new Request("http://localhost", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:3000",
            },
            body: JSON.stringify({ staffNotes: "n" }),
          }),
          reviewCtx
        ),
    ],
  ])("%s returns 403 for Business Admin", async (_label, call) => {
    requireSuperAdminMock.mockImplementation(async () => ({
      response: forbiddenResponse(),
    }));
    const res = await call();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("forbidden");
  });

  it.each([
    ["GET /api/admin/stats", () => statsGet()],
    ["GET /api/admin/owners", () => ownersGet()],
    ["GET /api/admin/groups", () => groupsGet()],
    [
      "GET /api/business/[id]/flags",
      () => flagsGet(new Request("http://localhost"), bizCtx),
    ],
    [
      "GET /api/admin/auto-publish/process",
      () =>
        autoPublishProcessGet(
          new Request("http://localhost/api/admin/auto-publish/process")
        ),
    ],
  ])("%s returns 401 when signed out", async (_label, call) => {
    requireSuperAdminMock.mockImplementation(async () => ({
      response: unauthorizedResponse(),
    }));
    const res = await call();
    expect(res.status).toBe(401);
  });
});
