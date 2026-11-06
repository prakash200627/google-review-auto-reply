import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { SCHEDULER_SECRET_MIN_LENGTH } from "@/lib/auth/schedulerAuth";

const {
  processMock,
  requireSuperAdminMock,
  connectMock,
  jobCountMock,
} = vi.hoisted(() => ({
  processMock: vi.fn(),
  requireSuperAdminMock: vi.fn(),
  connectMock: vi.fn(),
  jobCountMock: vi.fn(),
}));

vi.mock("@/lib/autoPublish/processor", () => ({
  processDueAutoPublishJobs: processMock,
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/AutoPublishJob", () => ({
  AutoPublishJob: { countDocuments: jobCountMock },
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: vi.fn(),
}));

import { GET, POST } from "@/app/api/admin/auto-publish/process/route";

describe("POST /api/admin/auto-publish/process", () => {
  const prevSecret = process.env.AUTO_PUBLISH_SCHEDULER_SECRET;
  const prevKill = process.env.AUTO_PUBLISH_GLOBALLY_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTO_PUBLISH_SCHEDULER_SECRET = "s".repeat(
      SCHEDULER_SECRET_MIN_LENGTH
    );
    process.env.AUTO_PUBLISH_GLOBALLY_ENABLED = "true";
    processMock.mockResolvedValue({
      processed: 0,
      published: 0,
      failed: 0,
      skipped: 0,
      reclaimed: 0,
    });
  });

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.AUTO_PUBLISH_SCHEDULER_SECRET;
    else process.env.AUTO_PUBLISH_SCHEDULER_SECRET = prevSecret;
    if (prevKill === undefined) delete process.env.AUTO_PUBLISH_GLOBALLY_ENABLED;
    else process.env.AUTO_PUBLISH_GLOBALLY_ENABLED = prevKill;
  });

  it("rejects Super Admin session without scheduler secret", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: "x",
        role: "superadmin",
        email: "a@b.com",
        businessIds: [],
      },
    });
    const res = await POST(
      new Request("http://localhost/api/admin/auto-publish/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    );
    expect(res.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("processes when scheduler secret is valid", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/auto-publish/process", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tronx-scheduler-secret": "s".repeat(SCHEDULER_SECRET_MIN_LENGTH),
        },
        body: "{}",
      })
    );
    expect(res.status).toBe(200);
    expect(processMock).toHaveBeenCalled();
  });
});

describe("GET /api/admin/auto-publish/process", () => {
  it("returns dry-run queue status for Super Admin without publishing", async () => {
    vi.clearAllMocks();
    requireSuperAdminMock.mockResolvedValue({
      user: {
        userId: "x",
        role: "superadmin",
        email: "a@b.com",
        businessIds: [],
      },
    });
    connectMock.mockResolvedValue({});
    jobCountMock.mockResolvedValue(0);
    const res = await GET(
      new Request("http://localhost/api/admin/auto-publish/process")
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(processMock).not.toHaveBeenCalled();
  });
});
