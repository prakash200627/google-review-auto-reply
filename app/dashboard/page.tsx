import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** Legacy route → ORM workspace. */
export default async function LegacyDashboardRedirect({
  searchParams,
}: PageProps) {
  const params = (await searchParams) || {};
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") qs.set(key, value);
  }
  const suffix = qs.toString();
  redirect(suffix ? `/orm?${suffix}` : "/orm");
}
