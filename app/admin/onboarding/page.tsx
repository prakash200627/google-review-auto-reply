import Link from "next/link";
import { AdminOnboardingWizard } from "@/components/AdminOnboardingWizard";
import { requirePageSuperAdmin } from "@/lib/auth/requirePageAuth";

export const dynamic = "force-dynamic";

export default async function AdminOnboardingPage() {
  await requirePageSuperAdmin();

  return (
    <>
      <p className="mb-4 text-sm text-zinc-600">
        Guided Super Admin workflow: create an internal business, pick a group,
        link one Google location (existing or newly created), review, and
        confirm. Assignments are never inferred from name or address.
      </p>
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Link className="underline" href="/admin/businesses">
          Businesses
        </Link>
        <Link className="underline" href="/admin/groups">
          Groups
        </Link>
        <Link className="underline" href="/gmb/locations/create">
          Create Google location
        </Link>
        <Link className="underline" href="/gmb/locations">
          GMB locations
        </Link>
      </div>
      <AdminOnboardingWizard />
    </>
  );
}
