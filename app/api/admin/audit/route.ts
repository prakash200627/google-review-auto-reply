import { NextResponse } from "next/server";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { connectToDatabase } from "@/lib/mongodb";
import { AuditEvent } from "@/models/AuditEvent";

export const runtime = "nodejs";

/** Super Admin read-only recent audit events (no secrets / draft bodies). */
export async function GET(request: Request) {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit") || "50");
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));

  await connectToDatabase();
  const rows = await AuditEvent.find({})
    .sort({ at: -1 })
    .limit(limit)
    .lean();

  return NextResponse.json({
    success: true,
    events: rows.map((e) => ({
      id: String(e._id),
      at: e.at ? new Date(e.at as Date).toISOString() : null,
      action: e.action,
      success: e.success,
      code: e.code || null,
      actorId: e.actorId ? String(e.actorId) : null,
      actorRole: e.actorRole || null,
      orgId: e.orgId ? String(e.orgId) : null,
      businessId: e.businessId ? String(e.businessId) : null,
      target: e.target || {},
    })),
  });
}
