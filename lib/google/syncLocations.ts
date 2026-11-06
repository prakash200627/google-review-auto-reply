import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { Location } from "@/models/Location";
import { getValidAccessTokenForOrg } from "@/lib/google/accessToken";
import {
  formatAddress,
  listAllAccounts,
  listAllLocationsForAccount,
  toReviewsLocationName,
} from "@/lib/google/gbpDiscovery";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";

type FetchLike = typeof fetch;

export type SyncedLocationSummary = {
  id: string;
  title: string;
  address: string;
  storeCode: string;
  googleLocationName: string;
  googleAccountName: string;
  lastDiscoveryAt: string | null;
  lastReviewsSyncAt: string | null;
  lastReviewsSyncError: string;
};

export function toLocationSummary(doc: {
  _id: mongoose.Types.ObjectId;
  title?: string | null;
  address?: string | null;
  storeCode?: string | null;
  googleLocationName: string;
  googleAccountName: string;
  lastDiscoveryAt?: Date | null;
  lastReviewsSyncAt?: Date | null;
  lastReviewsSyncError?: string | null;
}): SyncedLocationSummary {
  return {
    id: String(doc._id),
    title: doc.title || "",
    address: doc.address || "",
    storeCode: doc.storeCode || "",
    googleLocationName: doc.googleLocationName,
    googleAccountName: doc.googleAccountName,
    lastDiscoveryAt: doc.lastDiscoveryAt
      ? new Date(doc.lastDiscoveryAt).toISOString()
      : null,
    lastReviewsSyncAt: doc.lastReviewsSyncAt
      ? new Date(doc.lastReviewsSyncAt).toISOString()
      : null,
    lastReviewsSyncError: doc.lastReviewsSyncError || "",
  };
}

/**
 * Discover GBP accounts/locations for the org and upsert Location docs.
 * Read-only against Google (list APIs only).
 */
export async function syncLocationsForOrg(
  orgId: string,
  fetchImpl: FetchLike = fetch
): Promise<{ locations: SyncedLocationSummary[]; discovered: number }> {
  if (!mongoose.isValidObjectId(orgId)) {
    throw new GoogleBusinessApiError("Invalid organization", {
      code: "invalid_org",
      status: 400,
    });
  }

  const accessToken = await getValidAccessTokenForOrg(orgId, fetchImpl);
  const accounts = await listAllAccounts(accessToken, fetchImpl);

  const now = new Date();
  let discovered = 0;

  await connectToDatabase();

  for (const account of accounts) {
    if (!account.name?.startsWith("accounts/")) continue;
    let locations;
    try {
      locations = await listAllLocationsForAccount(
        accessToken,
        account.name,
        fetchImpl
      );
    } catch (err) {
      // One account may be inaccessible; continue with others when possible.
      if (
        err instanceof GoogleBusinessApiError &&
        (err.code === "permission_denied" || err.code === "not_found")
      ) {
        console.error(
          "Skipping inaccessible GBP account during location discovery:",
          err.code
        );
        continue;
      }
      throw err;
    }

    for (const loc of locations) {
      if (!loc.name) continue;
      const googleLocationName = toReviewsLocationName(account.name, loc.name);
      if (!googleLocationName) continue;

      await Location.findOneAndUpdate(
        { orgId, googleLocationName },
        {
          $set: {
            orgId,
            googleAccountName: account.name,
            googleLocationName,
            businessInfoName: loc.name,
            title: loc.title || "",
            storeCode: loc.storeCode || "",
            address: formatAddress(loc.storefrontAddress),
            placeId: loc.metadata?.placeId || "",
            lastDiscoveryAt: now,
          },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
      );
      discovered += 1;
    }
  }

  const stored = await Location.find({ orgId })
    .sort({ title: 1 })
    .lean();

  return {
    locations: stored.map(toLocationSummary),
    discovered,
  };
}

export async function listStoredLocationsForOrg(
  orgId: string
): Promise<SyncedLocationSummary[]> {
  if (!mongoose.isValidObjectId(orgId)) {
    return [];
  }
  await connectToDatabase();
  const stored = await Location.find({ orgId }).sort({ title: 1 }).lean();
  return stored.map(toLocationSummary);
}
