import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  businessFindByIdMock,
  reviewFindOneMock,
  jobFindOneAndUpdateMock,
  jobFindMock,
  jobUpdateOneMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  reviewFindOneMock: vi.fn(),
  jobFindOneAndUpdateMock: vi.fn(),
  jobFindMock: vi.fn(),
  jobUpdateOneMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", () => ({
  Business: { findById: businessFindByIdMock },
}));

vi.mock("@/models/Review", () => ({
  Review: { findOne: reviewFindOneMock },
}));

vi.mock("@/models/AutoPublishJob", () => ({
  AutoPublishJob: {
    findOneAndUpdate: jobFindOneAndUpdateMock,
    find: jobFindMock,
    updateOne: jobUpdateOneMock,
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  },
  AUTO_PUBLISH_CLAIM_LEASE_MS: 300_000,
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: vi.fn(),
}));

import {
  assertAutoPublishAuthorized,
  classifyAutoPublishRisk,
  DEFAULT_AUTO_PUBLISH_CONFIG,
  isAutoPublishGloballyEnabled,
  AutoPublishPolicyError,
} from "@/lib/autoPublish/policy";
import { enqueueAutoPublishJob } from "@/lib/autoPublish/queue";
import { processDueAutoPublishJobs } from "@/lib/autoPublish/processor";
import { PLAN_CATALOG } from "@/lib/entitlements/plans";

const BIZ = new mongoose.Types.ObjectId().toString();
const ORG = new mongoose.Types.ObjectId().toString();
const REVIEW = new mongoose.Types.ObjectId().toString();
const LOC = new mongoose.Types.ObjectId().toString();
const JOB = new mongoose.Types.ObjectId().toString();

describe("auto-publish policy", () => {
  it("defaults to disabled and ignores replyMode for authorization", () => {
    expect(DEFAULT_AUTO_PUBLISH_CONFIG.enabled).toBe(false);
    expect(isAutoPublishGloballyEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(
      false
    );
    expect(
      isAutoPublishGloballyEnabled({
        AUTO_PUBLISH_GLOBALLY_ENABLED: "true",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(true);

    expect(() =>
      assertAutoPublishAuthorized({
        replyMode: "auto",
        autoPublish: { ...DEFAULT_AUTO_PUBLISH_CONFIG, enabled: true },
        planStatus: "active",
        planFeatures: { ...PLAN_CATALOG.custom.features },
        globallyEnabled: false,
      })
    ).toThrow(AutoPublishPolicyError);
  });

  it("requires entitlement even when enabled on the business", () => {
    expect(() =>
      assertAutoPublishAuthorized({
        replyMode: "manual",
        autoPublish: { ...DEFAULT_AUTO_PUBLISH_CONFIG, enabled: true },
        planStatus: "active",
        planFeatures: { ...PLAN_CATALOG.starter.features, automation: false },
        globallyEnabled: true,
      })
    ).toThrow(/automation entitlement/i);
  });

  it("routes low or missing ratings to human approval", () => {
    expect(
      classifyAutoPublishRisk({
        starRating: 2,
        maxAutoStarRatingExclusive: 3,
      })
    ).toEqual({ ok: false, reason: "low_star_manual_required" });
    expect(
      classifyAutoPublishRisk({
        starRating: null,
        maxAutoStarRatingExclusive: 3,
      })
    ).toEqual({ ok: false, reason: "missing_star_rating" });
    expect(
      classifyAutoPublishRisk({
        starRating: 5,
        maxAutoStarRatingExclusive: 3,
        comment: "great coffee",
      })
    ).toEqual({ ok: true });
  });
});

describe("enqueueAutoPublishJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    process.env.AUTO_PUBLISH_GLOBALLY_ENABLED = "true";
  });

  it("queues eligible high-rating reviews", async () => {
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: BIZ,
          orgId: ORG,
          active: true,
          replyMode: "manual",
          plan: {
            code: "custom",
            status: "active",
            features: PLAN_CATALOG.custom.features,
            limits: PLAN_CATALOG.custom.limits,
          },
          autoPublish: { ...DEFAULT_AUTO_PUBLISH_CONFIG, enabled: true },
        }),
      }),
    });
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: REVIEW,
          locationId: LOC,
          starRating: 5,
          comment: "Loved it",
          replyComment: "",
        }),
      }),
    });
    jobFindOneAndUpdateMock.mockReturnValue({
      lean: async () => ({ _id: JOB, status: "queued_auto_publish" }),
    });

    const result = await enqueueAutoPublishJob({
      businessId: BIZ,
      reviewId: REVIEW,
      draftText: "Thank you for visiting!",
    });
    expect(result.status).toBe("queued_auto_publish");
  });

  it("sends risky reviews to awaiting_approval instead of publishing", async () => {
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: BIZ,
          orgId: ORG,
          active: true,
          replyMode: "auto",
          plan: {
            code: "custom",
            status: "active",
            features: PLAN_CATALOG.custom.features,
            limits: PLAN_CATALOG.custom.limits,
          },
          autoPublish: { ...DEFAULT_AUTO_PUBLISH_CONFIG, enabled: true },
        }),
      }),
    });
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: REVIEW,
          locationId: LOC,
          starRating: 1,
          comment: "terrible",
          replyComment: "",
        }),
      }),
    });
    jobFindOneAndUpdateMock.mockReturnValue({
      lean: async () => ({ _id: JOB, status: "awaiting_approval" }),
    });

    const result = await enqueueAutoPublishJob({
      businessId: BIZ,
      reviewId: REVIEW,
      draftText: "Sorry to hear that.",
    });
    expect(result.status).toBe("awaiting_approval");
    expect(result.riskReason).toMatch(/low_star_manual_required|star_rating/);
  });
});

describe("processDueAutoPublishJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    process.env.AUTO_PUBLISH_GLOBALLY_ENABLED = "true";
    jobUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
  });

  it("atomically claims, rechecks risk, publishes, and marks published", async () => {
    let claimCalls = 0;
    jobFindOneAndUpdateMock.mockImplementation(() => {
      claimCalls += 1;
      if (claimCalls === 1) {
        return {
          lean: async () => ({
            _id: JOB,
            orgId: ORG,
            businessId: BIZ,
            reviewId: REVIEW,
            draftText: "Thanks for visiting!",
            attempts: 0,
            maxAttempts: 3,
            claimOwner: "worker:test",
            status: "processing",
          }),
        };
      }
      return { lean: async () => null };
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          active: true,
          status: "active",
          replyMode: "manual",
          plan: {
            code: "custom",
            status: "active",
            features: PLAN_CATALOG.custom.features,
            limits: PLAN_CATALOG.custom.limits,
          },
          autoPublish: { ...DEFAULT_AUTO_PUBLISH_CONFIG, enabled: true },
        }),
      }),
    });
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          replyComment: "",
          starRating: 5,
          comment: "Great",
        }),
      }),
    });

    const publishAdapter = vi.fn().mockResolvedValue({
      replyComment: "Thanks for visiting!",
      replyUpdateTime: null,
      replyState: "PUBLISHED",
      replacedExisting: false,
    });

    const result = await processDueAutoPublishJobs({
      publishAdapter,
      limit: 5,
      workerId: "worker:test",
    });
    expect(result.published).toBe(1);
    expect(publishAdapter).toHaveBeenCalledOnce();
    expect(jobUpdateOneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: JOB,
        status: "processing",
        claimOwner: "worker:test",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "published" }),
      })
    );
  });

  it("does not publish when business auto-publish is disabled mid-flight", async () => {
    jobFindOneAndUpdateMock
      .mockReturnValueOnce({
        lean: async () => ({
          _id: JOB,
          orgId: ORG,
          businessId: BIZ,
          reviewId: REVIEW,
          draftText: "Thanks!",
          attempts: 0,
          maxAttempts: 3,
          claimOwner: "worker:test",
        }),
      })
      .mockReturnValue({ lean: async () => null });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          active: true,
          status: "active",
          replyMode: "auto",
          plan: {
            code: "custom",
            status: "active",
            features: PLAN_CATALOG.custom.features,
            limits: PLAN_CATALOG.custom.limits,
          },
          autoPublish: { ...DEFAULT_AUTO_PUBLISH_CONFIG, enabled: false },
        }),
      }),
    });

    const publishAdapter = vi.fn();
    const result = await processDueAutoPublishJobs({
      publishAdapter,
      workerId: "worker:test",
    });
    expect(publishAdapter).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it("only one worker wins an atomic claim under concurrency", async () => {
    let claims = 0;
    jobFindOneAndUpdateMock.mockImplementation(() => {
      claims += 1;
      if (claims === 1) {
        return {
          lean: async () => ({
            _id: JOB,
            orgId: ORG,
            businessId: BIZ,
            reviewId: REVIEW,
            draftText: "Thanks!",
            attempts: 0,
            maxAttempts: 3,
            claimOwner: "worker:a",
            status: "processing",
          }),
        };
      }
      // Second worker / subsequent claim attempts lose.
      return { lean: async () => null };
    });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          active: true,
          status: "active",
          replyMode: "manual",
          plan: {
            code: "custom",
            status: "active",
            features: PLAN_CATALOG.custom.features,
            limits: PLAN_CATALOG.custom.limits,
          },
          autoPublish: { ...DEFAULT_AUTO_PUBLISH_CONFIG, enabled: true },
        }),
      }),
    });
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          replyComment: "",
          starRating: 5,
          comment: "Great",
        }),
      }),
    });
    const publishAdapter = vi.fn().mockResolvedValue({
      replyComment: "Thanks!",
      replyUpdateTime: null,
      replyState: "PUBLISHED",
      replacedExisting: false,
    });

    const [a, b] = await Promise.all([
      processDueAutoPublishJobs({
        publishAdapter,
        limit: 1,
        workerId: "worker:a",
      }),
      processDueAutoPublishJobs({
        publishAdapter,
        limit: 1,
        workerId: "worker:b",
      }),
    ]);

    expect(a.published + b.published).toBe(1);
    expect(publishAdapter).toHaveBeenCalledOnce();
  });

  it("fails closed at process time for 1-star reviews", async () => {
    jobFindOneAndUpdateMock
      .mockReturnValueOnce({
        lean: async () => ({
          _id: JOB,
          orgId: ORG,
          businessId: BIZ,
          reviewId: REVIEW,
          draftText: "Sorry",
          attempts: 0,
          maxAttempts: 3,
          claimOwner: "worker:test",
        }),
      })
      .mockReturnValue({ lean: async () => null });
    businessFindByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          active: true,
          status: "active",
          replyMode: "manual",
          plan: {
            code: "custom",
            status: "active",
            features: PLAN_CATALOG.custom.features,
            limits: PLAN_CATALOG.custom.limits,
          },
          autoPublish: { ...DEFAULT_AUTO_PUBLISH_CONFIG, enabled: true },
        }),
      }),
    });
    reviewFindOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          replyComment: "",
          starRating: 1,
          comment: "Bad",
        }),
      }),
    });
    const publishAdapter = vi.fn();
    const result = await processDueAutoPublishJobs({
      publishAdapter,
      workerId: "worker:test",
    });
    expect(publishAdapter).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});
