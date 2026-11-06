import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { GoogleConnection } from "@/models/GoogleConnection";
import { ManualPayment } from "@/models/ManualPayment";
import { User } from "@/models/User";
import {
  formatInrFromCents,
  suggestedCatalogExpectedCents,
} from "@/lib/billing/planAmounts";
import { toPlanSnapshot } from "@/lib/entitlements/enforce";

export type PlatformBusinessRow = {
  id: string;
  name: string;
  active: boolean;
  planCode: string;
  planName: string;
  planStatus: string;
  ownerEmail: string | null;
  ownerActive: boolean | null;
  googleConnected: boolean;
  listPriceCents: number;
};

export type PlatformDashboardStats = {
  totalBusinesses: number;
  activeBusinesses: number;
  inactiveBusinesses: number;
  suspendedPlans: number;
  expiredPlans: number;
  byPlan: { code: string; displayName: string; count: number }[];
  ownersActive: number;
  ownersInactive: number;
  googleConnectionsActive: number;
  /** Catalog-based expected MRR for active businesses (not invoice data). */
  monthlyExpectedCents: number;
  monthlyExpectedLabel: string;
  /**
   * Sums from ManualPayment rows for the current UTC month only.
   * Zero does not mean “collected” unless rows exist — see paymentRowsConfigured.
   */
  payments: {
    periodKey: string;
    expectedCents: number;
    receivedCents: number;
    overdueCents: number;
    notRecordedCount: number;
    rowCount: number;
    configured: boolean;
    note: string;
  };
  businesses: PlatformBusinessRow[];
};

function currentPeriodKey(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Super Admin platform metrics — no customer review aggregates.
 */
export async function getPlatformDashboardStats(): Promise<PlatformDashboardStats> {
  await connectToDatabase();

  const businesses = await Business.find({})
    .sort({ name: 1 })
    .select("name active status orgId ownerUserId plan")
    .lean();

  const ownerIds = businesses
    .map((b) => b.ownerUserId)
    .filter(Boolean)
    .map((id) => String(id));

  const orgIds = [
    ...new Set(
      businesses.map((b) => String(b.orgId)).filter((id) => Boolean(id))
    ),
  ];

  const [owners, googleConnectionsActive, paymentRows, activeConns] =
    await Promise.all([
      ownerIds.length
        ? User.find({ _id: { $in: ownerIds } })
            .select("email active")
            .lean()
        : Promise.resolve([]),
      GoogleConnection.countDocuments({
        status: "active",
        businessId: null,
      }),
      ManualPayment.find({ periodKey: currentPeriodKey() }).lean(),
      orgIds.length
        ? GoogleConnection.find({
            orgId: { $in: orgIds },
            status: "active",
            businessId: null,
          })
            .select("orgId")
            .lean()
        : Promise.resolve([]),
    ]);

  const ownerById = new Map(owners.map((o) => [String(o._id), o]));
  const googleOrgs = new Set(activeConns.map((c) => String(c.orgId)));
  const planCounts = new Map<string, { displayName: string; count: number }>();

  let monthlyExpectedCents = 0;
  let suspendedPlans = 0;
  let expiredPlans = 0;
  let ownersActive = 0;
  let ownersInactive = 0;
  const seenOwners = new Set<string>();

  const rows: PlatformBusinessRow[] = [];

  for (const biz of businesses) {
    const plan = toPlanSnapshot(biz.plan as never);
    const listPrice = suggestedCatalogExpectedCents({
      planCode: plan.code,
      business: biz,
    });
    monthlyExpectedCents += listPrice;
    if (plan.status === "suspended") suspendedPlans += 1;
    if (plan.status === "expired") expiredPlans += 1;

    const bucket = planCounts.get(plan.code) || {
      displayName: plan.displayName,
      count: 0,
    };
    bucket.count += 1;
    planCounts.set(plan.code, bucket);

    const owner = biz.ownerUserId
      ? ownerById.get(String(biz.ownerUserId))
      : null;
    if (owner && !seenOwners.has(String(owner._id))) {
      seenOwners.add(String(owner._id));
      if (owner.active) ownersActive += 1;
      else ownersInactive += 1;
    }

    rows.push({
      id: String(biz._id),
      name: biz.name,
      active: Boolean(biz.active),
      planCode: plan.code,
      planName: plan.displayName,
      planStatus: plan.status,
      ownerEmail: owner?.email || null,
      ownerActive: owner ? Boolean(owner.active) : null,
      googleConnected: googleOrgs.has(String(biz.orgId)),
      listPriceCents: listPrice,
    });
  }

  let expectedCents = 0;
  let receivedCents = 0;
  let overdueCents = 0;
  let notRecordedCount = 0;
  for (const row of paymentRows) {
    expectedCents += row.amountExpectedCents || 0;
    receivedCents += row.amountReceivedCents || 0;
    if (row.status === "overdue") {
      overdueCents += Math.max(
        0,
        (row.amountExpectedCents || 0) - (row.amountReceivedCents || 0)
      );
    }
    if (row.status === "not_recorded") notRecordedCount += 1;
  }

  const activeBusinesses = businesses.filter((b) => b.active).length;

  return {
    totalBusinesses: businesses.length,
    activeBusinesses,
    inactiveBusinesses: businesses.length - activeBusinesses,
    suspendedPlans,
    expiredPlans,
    byPlan: [...planCounts.entries()].map(([code, v]) => ({
      code,
      displayName: v.displayName,
      count: v.count,
    })),
    ownersActive,
    ownersInactive,
    googleConnectionsActive,
    monthlyExpectedCents,
    monthlyExpectedLabel: formatInrFromCents(monthlyExpectedCents),
    payments: {
      periodKey: currentPeriodKey(),
      expectedCents,
      receivedCents,
      overdueCents,
      notRecordedCount,
      rowCount: paymentRows.length,
      configured: paymentRows.length > 0,
      note:
        paymentRows.length === 0
          ? "No manual payment rows recorded for this period. Catalog expected MRR is not the same as collected revenue."
          : "Totals are from Super Admin–entered ManualPayment rows only.",
    },
    businesses: rows,
  };
}
