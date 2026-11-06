import Link from "next/link";
import { requirePageSuperAdmin } from "@/lib/auth/requirePageAuth";
import { connectToDatabase } from "@/lib/mongodb";
import { AuditEvent } from "@/models/AuditEvent";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requirePageSuperAdmin();

  let error: string | null = null;
  let events: Array<{
    id: string;
    at: string | null;
    action: string;
    success: boolean;
    code: string | null;
    actorRole: string | null;
    businessId: string | null;
  }> = [];

  try {
    await connectToDatabase();
    const rows = await AuditEvent.find({})
      .sort({ at: -1 })
      .limit(75)
      .lean();
    events = rows.map((e) => ({
      id: String(e._id),
      at: e.at ? new Date(e.at as Date).toISOString() : null,
      action: String(e.action || ""),
      success: Boolean(e.success),
      code: e.code ? String(e.code) : null,
      actorRole: e.actorRole ? String(e.actorRole) : null,
      businessId: e.businessId ? String(e.businessId) : null,
    }));
  } catch {
    error = "Could not load audit events.";
  }

  return (
      <div className="space-y-4">
        <p className="text-sm text-zinc-700">
          Recent durable audit events (best-effort Mongo + stdout). Secrets and
          full draft text are never stored.{" "}
          <Link href="/admin/dashboard" className="underline">
            Dashboard
          </Link>
        </p>
        {error && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            {error}
          </p>
        )}
        {!error && events.length === 0 && (
          <p className="text-sm text-zinc-600">No audit events recorded yet.</p>
        )}
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white text-sm">
          {events.map((e) => (
            <li key={e.id} className="px-4 py-3">
              <p className="font-medium text-zinc-900">
                {e.action}{" "}
                <span
                  className={
                    e.success ? "text-emerald-700" : "text-red-700"
                  }
                >
                  {e.success ? "ok" : "fail"}
                </span>
                {e.code ? ` · ${e.code}` : ""}
              </p>
              <p className="text-xs text-zinc-500">
                {e.at ? new Date(e.at).toLocaleString() : "—"}
                {e.actorRole ? ` · ${e.actorRole}` : ""}
                {e.businessId ? ` · biz ${e.businessId}` : ""}
              </p>
            </li>
          ))}
        </ul>
      </div>
  );
}
