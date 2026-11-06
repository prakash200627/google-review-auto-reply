import { redirect } from "next/navigation";
import {
  isAuthUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { BusinessGroup } from "@/models/BusinessGroup";

export const dynamic = "force-dynamic";

/**
 * Business Admin read-only groups. Super Admin manages groups under Admin.
 */
export default async function OrmGroupsPage() {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) {
    redirect("/login");
  }

  if (auth.user.role === "superadmin") {
    redirect("/admin/groups");
  }

  await connectToDatabase();
  const groupIds = auth.user.groupIds || [];
  const groups =
    groupIds.length > 0
      ? await BusinessGroup.find({ _id: { $in: groupIds } })
          .select("name description active")
          .lean()
      : [];
  const businesses =
    groupIds.length > 0
      ? await Business.find({ groupId: { $in: groupIds } })
          .select("name groupId")
          .lean()
      : [];

  return (
    <>
      <p className="mb-4 text-sm text-zinc-600">
        Read-only view of groups assigned to your Business Admin account. You
        cannot create, delete, or reassign groups or locations.
      </p>
      {groups.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No groups assigned yet. Ask a Super Admin to assign your account to a
          group.
        </p>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => {
            const biz = businesses.filter(
              (b) => String(b.groupId) === String(g._id)
            );
            return (
              <li
                key={String(g._id)}
                className="rounded-lg border border-zinc-200 bg-white p-4"
              >
                <p className="font-medium text-zinc-900">{g.name}</p>
                <p className="text-xs text-zinc-500">
                  {g.description || "No description"}
                </p>
                <p className="mt-2 text-sm text-zinc-700">
                  Businesses:{" "}
                  {biz.length
                    ? biz.map((b) => b.name).join(", ")
                    : "None yet"}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
