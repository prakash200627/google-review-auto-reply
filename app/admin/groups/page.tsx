import { AdminGroupsPanel } from "@/components/AdminGroupsPanel";
import { requirePageSuperAdmin } from "@/lib/auth/requirePageAuth";

export const dynamic = "force-dynamic";

export default async function AdminGroupsPage() {
  await requirePageSuperAdmin();

  return (
    <>
      <p className="mb-4 text-sm text-zinc-600">
        Create internal business groups, assign Google-linked businesses, and
        assign Business Admins. Groups never invent Google location ownership.
        Business Admins sign in with email/password — not Google OAuth.
      </p>
      <AdminGroupsPanel />
    </>
  );
}
