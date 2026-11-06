import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit/log";
import {
  assertBusinessAccess,
  isAuthUser,
  requireAuthUser,
  requireSuperAdmin,
  type AuthUser,
} from "@/lib/auth/authorize";
import {
  assertBusinessOperationAllowed,
  operationalGuardResponse,
  OperationalGuardError,
} from "@/lib/auth/operationalGuard";
import { assertMutationOrigin } from "@/lib/auth/requestOrigin";
import {
  EntitlementError,
  entitlementErrorResponse,
} from "@/lib/entitlements/enforce";
import { connectToDatabase } from "@/lib/mongodb";
import {
  GmbServiceJob,
  GMB_JOB_STATUSES,
  GMB_JOB_TYPES,
} from "@/models/GmbServiceJob";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ businessId: string }> };

async function gate(
  user: AuthUser,
  businessId: string,
  action: "read_services" | "manage_services"
) {
  const access = await assertBusinessAccess(user, businessId);
  if (!access.ok) return access;
  try {
    await assertBusinessOperationAllowed({
      businessId,
      business: access.business,
      action,
      actorRole: user.role,
    });
  } catch (err) {
    if (err instanceof OperationalGuardError) {
      return { ok: false as const, response: operationalGuardResponse(err) };
    }
    if (err instanceof EntitlementError) {
      return { ok: false as const, response: entitlementErrorResponse(err) };
    }
    throw err;
  }
  return { ok: true as const, business: access.business };
}

/** List GMB service jobs. Owners see status/summary only (no staff notes). */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, message: "Invalid business id." },
      { status: 400 }
    );
  }
  // Super Admin staff tools must load GMB jobs even when suspended/archived;
  // owners remain on read_services (active + entitlement).
  const access = await gate(
    auth.user,
    businessId,
    auth.user.role === "superadmin" ? "manage_services" : "read_services"
  );
  if (!access.ok) return access.response;

  await connectToDatabase();
  const jobs = await GmbServiceJob.find({ businessId })
    .sort({ updatedAt: -1 })
    .lean();
  const isAdmin = auth.user.role === "superadmin";

  return NextResponse.json({
    success: true,
    jobs: jobs.map((j) => ({
      id: String(j._id),
      type: j.type,
      status: j.status,
      title: j.title,
      ownerSummary: j.ownerSummary || "",
      checklist: j.checklist || [],
      staffNotes: isAdmin ? j.staffNotes || "" : undefined,
      assignedStaffUserId: j.assignedStaffUserId
        ? String(j.assignedStaffUserId)
        : null,
      createdAt: j.createdAt
        ? new Date(j.createdAt as Date).toISOString()
        : null,
      updatedAt: j.updatedAt
        ? new Date(j.updatedAt as Date).toISOString()
        : null,
    })),
    note: "Tracks TRONX support work on existing Google profiles — does not create or claim Google approval.",
  });
}

/** Super Admin create/update service job. */
export async function POST(request: Request, context: RouteContext) {
  const origin = assertMutationOrigin(request);
  if (!origin.ok) return origin.response;

  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;
  const { businessId } = await context.params;
  if (!mongoose.isValidObjectId(businessId)) {
    return NextResponse.json(
      { success: false, message: "Invalid business id." },
      { status: 400 }
    );
  }
  const access = await gate(auth.user, businessId, "manage_services");
  if (!access.ok) return access.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  await connectToDatabase();
  const jobId = typeof body.jobId === "string" ? body.jobId : "";

  if (jobId && mongoose.isValidObjectId(jobId)) {
    const job = await GmbServiceJob.findOne({ _id: jobId, businessId }).exec();
    if (!job) {
      return NextResponse.json(
        { success: false, message: "Job not found." },
        { status: 404 }
      );
    }
    if (typeof body.title === "string" && body.title.trim()) {
      job.title = body.title.trim().slice(0, 200);
    }
    if (GMB_JOB_STATUSES.includes(body.status as never)) {
      job.status = body.status as (typeof GMB_JOB_STATUSES)[number];
    }
    if (typeof body.ownerSummary === "string") {
      job.ownerSummary = body.ownerSummary.slice(0, 2000);
    }
    if (typeof body.staffNotes === "string") {
      job.staffNotes = body.staffNotes.slice(0, 5000);
    }
    if (Array.isArray(body.checklist)) {
      job.set(
        "checklist",
        body.checklist.slice(0, 50).map((item) => {
          const row = item as { label?: unknown; done?: unknown };
          return {
            label: String(row.label || "").slice(0, 200),
            done: Boolean(row.done),
          };
        })
      );
    }
    await job.save();
    auditLog({
      actorId: auth.user.userId,
      actorRole: auth.user.role,
      action: "gmb_job.update",
      success: true,
      target: {
        businessId,
        orgId: String(access.business.orgId),
        jobId: String(job._id),
        status: job.status,
      },
    });
    return NextResponse.json({
      success: true,
      job: { id: String(job._id), status: job.status, title: job.title },
    });
  }

  const typeRaw = String(body.type || "other");
  if (!GMB_JOB_TYPES.includes(typeRaw as (typeof GMB_JOB_TYPES)[number])) {
    return NextResponse.json(
      { success: false, message: "Invalid job type." },
      { status: 400 }
    );
  }
  const type = typeRaw as (typeof GMB_JOB_TYPES)[number];
  const title = String(body.title || "").trim();
  if (!title) {
    return NextResponse.json(
      { success: false, message: "title is required." },
      { status: 400 }
    );
  }

  const doc = await GmbServiceJob.create({
    businessId,
    orgId: access.business.orgId,
    type,
    title: title.slice(0, 200),
    status: "open",
    ownerSummary: String(body.ownerSummary || "").slice(0, 2000),
    staffNotes: String(body.staffNotes || "").slice(0, 5000),
    createdByUserId: auth.user.userId,
    assignedStaffUserId: auth.user.userId,
  });

  auditLog({
    actorId: auth.user.userId,
    actorRole: auth.user.role,
    action: "gmb_job.create",
    success: true,
    target: {
      businessId,
      orgId: String(access.business.orgId),
      jobId: String(doc._id),
      type,
    },
  });

  return NextResponse.json({
    success: true,
    job: { id: String(doc._id), title: doc.title, status: doc.status },
  });
}
