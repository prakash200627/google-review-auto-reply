import { redirect } from "next/navigation";
import { requirePageSuperAdmin } from "@/lib/auth/requirePageAuth";

export const dynamic = "force-dynamic";

/** Admin primary landing is the platform dashboard. */
export default async function AdminHubRedirectPage() {
  await requirePageSuperAdmin();
  redirect("/admin/dashboard");
}
