import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountLogoutButton } from "@/components/AccountLogoutButton";
import { isAuthUser, requireAuthUser } from "@/lib/auth/authorize";
import { homePathForRole } from "@/lib/auth/homePath";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) {
    redirect("/login");
  }

  const { user } = auth;
  const home = homePathForRole(user.role);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight">Your account</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Session details from the server. Passwords are never shown here.
        </p>
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="font-medium text-zinc-800">Email</dt>
            <dd className="mt-0.5 text-zinc-700">{user.email}</dd>
          </div>
          <div>
            <dt className="font-medium text-zinc-800">Role</dt>
            <dd className="mt-0.5 text-zinc-700">
              {user.role === "superadmin" ? "Super Admin" : "Business owner"}
            </dd>
          </div>
          {user.role === "business_owner" && (
            <div>
              <dt className="font-medium text-zinc-800">Linked businesses</dt>
              <dd className="mt-0.5 text-zinc-700">
                {user.businessIds.length > 0
                  ? `${user.businessIds.length} assigned`
                  : "None assigned yet — contact a Super Admin."}
              </dd>
            </div>
          )}
        </dl>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href={home}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Go to workspace
          </Link>
          <AccountLogoutButton />
        </div>
      </section>
      <p className="text-sm text-zinc-500">
        Credential resets for owners are performed by a Super Admin and shared
        out-of-band. This app does not send password emails.
      </p>
    </div>
  );
}
