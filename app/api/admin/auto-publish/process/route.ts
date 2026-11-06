import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { assertSchedulerSecret } from "@/lib/auth/schedulerAuth";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { processDueAutoPublishJobs } from "@/lib/autoPublish/processor";
import { isAutoPublishGloballyEnabled } from "@/lib/autoPublish/policy";
import { connectToDatabase } from "@/lib/mongodb";
import { AutoPublishJob } from "@/models/AutoPublishJob";

export const runtime = "nodejs";

/**
 * Process due auto-publish queue jobs — real publishing path.
 *
 * Requires dedicated scheduler secret (x-tronx-scheduler-secret).
 * Super Admin session alone cannot invoke the real publish adapter.
 * Global kill switch must be ON.
 */
export async function POST(request: Request) {
  const scheduler = assertSchedulerSecret(request);
  if (!scheduler.ok) return scheduler.response;

  if (!isAutoPublishGloballyEnabled()) {
    return NextResponse.json(
      {
        success: false,
        code: "global_kill_switch",
        message:
          "Automatic publishing is globally disabled (AUTO_PUBLISH_GLOBALLY_ENABLED is not true).",
      },
      { status: 403 }
    );
  }

  let limit = 10;
  try {
    const body = (await request.json()) as { limit?: unknown };
    if (typeof body.limit === "number") limit = body.limit;
  } catch {
    // empty body ok
  }

  const result = await processDueAutoPublishJobs({
    limit,
    actorId: "scheduler",
  });

  auditLog({
    actorId: null,
    actorRole: "scheduler",
    action: "auto_publish.process",
    success: true,
    target: result,
  });

  return NextResponse.json({
    success: true,
    ...result,
    message:
      "Processed due jobs via scheduler credentials. Prefer mocked tests against production Google listings.",
  });
}

/**
 * Super Admin dry-run / queue status — never calls the publish adapter.
 */
export async function GET(request: Request) {
  const origin = assertMutationOrigin(request);
  // GET is a safe method; origin helper allows it. Still require SA.
  void origin;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  await connectToDatabase();
  const now = new Date();
  const [queued, processing, awaiting, failed] = await Promise.all([
    AutoPublishJob.countDocuments({
      status: "queued_auto_publish",
      publishAfter: { $lte: now },
    }),
    AutoPublishJob.countDocuments({ status: "processing" }),
    AutoPublishJob.countDocuments({ status: "awaiting_approval" }),
    AutoPublishJob.countDocuments({ status: "failed" }),
  ]);

  return NextResponse.json({
    success: true,
    dryRun: true,
    globallyEnabled: isAutoPublishGloballyEnabled(),
    queue: { queuedDue: queued, processing, awaitingApproval: awaiting, failed },
    message:
      "Status only. Real processing requires x-tronx-scheduler-secret and AUTO_PUBLISH_GLOBALLY_ENABLED=true. This endpoint never publishes.",
  });
}
