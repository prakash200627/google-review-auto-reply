import { NextResponse } from "next/server";
import { isAuthUser, requireAuthUser } from "@/lib/auth/authorize";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;
  return NextResponse.json({
    success: true,
    user: {
      id: auth.user.userId,
      email: auth.user.email,
      role: auth.user.role,
      businessIds: auth.user.businessIds,
      groupIds: auth.user.groupIds || [],
    },
  });
}
