import Link from "next/link";
import { redirect } from "next/navigation";
import { CreateGbpLocationForm } from "@/components/CreateGbpLocationForm";
import { Breadcrumbs } from "@/components/nav/Breadcrumbs";
import { isAuthUser, requireAuthUser } from "@/lib/auth/authorize";
import { readOrganizationId } from "@/lib/org/session";

export const dynamic = "force-dynamic";

/**
 * Super Admin only — create a GBP location via the central Google connection.
 */
export default async function CreateGbpLocationPage() {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) {
    redirect("/login");
  }
  if (auth.user.role !== "superadmin") {
    redirect("/gmb/locations");
  }

  const orgId = await readOrganizationId();

  return (
    <>
      <div className="mb-4">
        <Breadcrumbs
          items={[
            { label: "GMB", href: "/gmb" },
            { label: "Locations", href: "/gmb/locations" },
            { label: "Create location" },
          ]}
        />
      </div>
      <p className="mb-4 text-sm text-zinc-600">
        Create a Google Business Profile location under a selected{" "}
        <code className="text-xs">accounts/{"{accountId}"}</code> resource.
        Assignment to TRONX businesses stays explicit and separate.
      </p>
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Link className="underline" href="/admin/businesses">
          Assign later under Admin → Businesses
        </Link>
      </div>
      {!orgId && (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          No organization session. Connect Google under /gmb or select an
          organization first.
        </p>
      )}
      {orgId && <CreateGbpLocationForm />}
    </>
  );
}
