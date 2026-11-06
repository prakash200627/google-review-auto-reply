import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";
import { GoogleOAuthError } from "@/lib/google/oauthConfig";
import {
  publishReviewReply,
  PublishReplyError,
} from "@/lib/google/publishReply";
import {
  assertUserCanAccessReview,
  isOrgUserResult,
  requireOrgAndUserAccess,
} from "@/lib/auth/googleRouteAuth";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import { TokenEncryptionError } from "@/lib/crypto/tokenEncryption";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ reviewId: string }> };

/**
 * Manually publish (or update) a Google Business Profile review reply.
 * Requires signed-in user + org session + review authorization.
 * Uses PUT .../v4/{review}/reply — never auto-publishes.
 */
export async function POST(
  request: Request,
  context: RouteContext
) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const access = await requireOrgAndUserAccess();
  if (!isOrgUserResult(access)) return access.response;
  const actor = {
    actorId: access.user.userId,
    actorRole: access.user.role,
  };

  const { reviewId } = await context.params;
  if (!mongoose.isValidObjectId(reviewId)) {
    return NextResponse.json(
      {
        success: false,
        code: "invalid_id",
        message: "Invalid review id.",
      },
      { status: 400 }
    );
  }

  const reviewAccess = await assertUserCanAccessReview({
    user: access.user,
    orgId: access.orgId,
    reviewId,
  });
  if (!reviewAccess.ok) return reviewAccess.response;

  let body: { comment?: unknown; confirmReplace?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      {
        success: false,
        code: "invalid_body",
        message: "Request body must be JSON with a comment field.",
      },
      { status: 400 }
    );
  }

  const confirmReplace = body.confirmReplace === true;

  try {
    const result = await publishReviewReply({
      orgId: access.orgId,
      reviewId,
      comment: body.comment,
      confirmReplace,
    });

    // Audit after successful Google publish only — logging must not flip outcome.
    auditLog({
      ...actor,
      action: "review.publish",
      success: true,
      target: {
        orgId: access.orgId,
        reviewId,
        replacedExisting: result.replacedExisting,
      },
    });

    return NextResponse.json({
      success: true,
      published: true,
      reply: {
        comment: result.replyComment,
        updateTime: result.replyUpdateTime,
        state: result.replyState,
      },
      replacedExisting: result.replacedExisting,
      message: result.replacedExisting
        ? "Reply updated on Google Business Profile."
        : "Reply published to Google Business Profile.",
    });
  } catch (err) {
    const failCode =
      err instanceof PublishReplyError ||
      err instanceof GoogleBusinessApiError ||
      err instanceof GoogleOAuthError
        ? err.code
        : err instanceof TokenEncryptionError
          ? "token_error"
          : "publish_failed";
    auditLog({
      ...actor,
      action: "review.publish",
      success: false,
      code: failCode,
      target: { orgId: access.orgId, reviewId },
    });

    if (err instanceof PublishReplyError) {
      return NextResponse.json(
        {
          success: false,
          code: err.code,
          message: err.message,
          ...(err.existingReply
            ? { existingReply: err.existingReply }
            : {}),
        },
        { status: err.status }
      );
    }
    if (
      err instanceof GoogleBusinessApiError ||
      err instanceof GoogleOAuthError
    ) {
      return NextResponse.json(
        {
          success: false,
          code: err.code,
          message: err.message,
        },
        { status: err.status }
      );
    }
    if (err instanceof TokenEncryptionError) {
      return NextResponse.json(
        {
          success: false,
          code: "token_error",
          message:
            "Stored Google credentials could not be decrypted. Reconnect Google.",
        },
        { status: 500 }
      );
    }
    console.error(
      "Publish reply failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      {
        success: false,
        code: "publish_failed",
        message: "Could not publish the reply to Google.",
      },
      { status: 500 }
    );
  }
}
