import { NextResponse } from "next/server";
import { isAuthUser, requireSuperAdmin } from "@/lib/auth/authorize";
import { getAdminAggregateStats } from "@/lib/business/stats";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireSuperAdmin();
  if (!isAuthUser(auth)) return auth.response;

  try {
    const stats = await getAdminAggregateStats();
    return NextResponse.json({ success: true, stats });
  } catch (err) {
    console.error(
      "Admin stats failed:",
      err instanceof Error ? err.message : "unknown error"
    );
    return NextResponse.json(
      { success: false, message: "Could not load admin statistics." },
      { status: 500 }
    );
  }
}
