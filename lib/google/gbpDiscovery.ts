import {
  ACCOUNT_MANAGEMENT_BASE,
  BUSINESS_INFORMATION_BASE,
  MYBUSINESS_V4_BASE,
  buildUrl,
  googleApiGetJson,
} from "@/lib/google/gbpClient";

export const LOCATION_READ_MASK =
  "name,title,storeCode,storefrontAddress,metadata";

/** Hard cap so a runaway nextPageToken cannot loop forever. */
export const MAX_LIST_PAGES = 50;

export interface GbpAccount {
  name: string;
  accountName?: string;
  type?: string;
}

export interface GbpLocation {
  name: string;
  title?: string;
  storeCode?: string;
  storefrontAddress?: {
    addressLines?: string[];
    locality?: string;
    administrativeArea?: string;
    postalCode?: string;
    regionCode?: string;
  };
  metadata?: {
    placeId?: string;
  };
}

export interface GbpReviewer {
  displayName?: string;
  isAnonymous?: boolean;
}

export interface GbpReviewReply {
  comment?: string;
  updateTime?: string;
  reviewReplyState?: string;
}

export interface GbpReview {
  name?: string;
  reviewId?: string;
  reviewer?: GbpReviewer;
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: GbpReviewReply;
}

type FetchLike = typeof fetch;

export function mapStarRating(starRating: string | undefined): number | null {
  switch (starRating) {
    case "ONE":
      return 1;
    case "TWO":
      return 2;
    case "THREE":
      return 3;
    case "FOUR":
      return 4;
    case "FIVE":
      return 5;
    default:
      return null;
  }
}

export function locationIdFromBusinessInfoName(name: string): string | null {
  const match = /^locations\/([^/]+)$/.exec(name.trim());
  return match ? match[1] : null;
}

export function accountIdFromAccountName(name: string): string | null {
  const match = /^accounts\/([^/]+)$/.exec(name.trim());
  return match ? match[1] : null;
}

/** Reviews API parent: accounts/{accountId}/locations/{locationId} */
export function toReviewsLocationName(
  accountName: string,
  businessInfoLocationName: string
): string | null {
  const accountId = accountIdFromAccountName(accountName);
  const locationId = locationIdFromBusinessInfoName(businessInfoLocationName);
  if (!accountId || !locationId) return null;
  return `accounts/${accountId}/locations/${locationId}`;
}

export function formatAddress(
  address: GbpLocation["storefrontAddress"] | undefined
): string {
  if (!address) return "";
  const parts = [
    ...(address.addressLines || []),
    address.locality,
    address.administrativeArea,
    address.postalCode,
    address.regionCode,
  ].filter(Boolean);
  return parts.join(", ");
}

export async function listAllAccounts(
  accessToken: string,
  fetchImpl: FetchLike = fetch
): Promise<GbpAccount[]> {
  const accounts: GbpAccount[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const url = buildUrl(ACCOUNT_MANAGEMENT_BASE, "accounts", {
      pageSize: 20,
      pageToken,
    });
    const data = await googleApiGetJson<{
      accounts?: GbpAccount[];
      nextPageToken?: string;
    }>(url, accessToken, fetchImpl);
    accounts.push(...(data.accounts || []));
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return accounts;
}

export async function listAllLocationsForAccount(
  accessToken: string,
  accountName: string,
  fetchImpl: FetchLike = fetch
): Promise<GbpLocation[]> {
  const locations: GbpLocation[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const url = buildUrl(
      BUSINESS_INFORMATION_BASE,
      `${accountName}/locations`,
      {
        pageSize: 100,
        pageToken,
        readMask: LOCATION_READ_MASK,
      }
    );
    const data = await googleApiGetJson<{
      locations?: GbpLocation[];
      nextPageToken?: string;
    }>(url, accessToken, fetchImpl);
    locations.push(...(data.locations || []));
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return locations;
}

export async function listAllReviewsForLocation(
  accessToken: string,
  reviewsLocationName: string,
  fetchImpl: FetchLike = fetch
): Promise<{ reviews: GbpReview[]; totalReviewCount: number | null }> {
  const reviews: GbpReview[] = [];
  let pageToken: string | undefined;
  let totalReviewCount: number | null = null;

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const url = buildUrl(
      MYBUSINESS_V4_BASE,
      `${reviewsLocationName}/reviews`,
      {
        pageSize: 50,
        pageToken,
        orderBy: "updateTime desc",
      }
    );
    const data = await googleApiGetJson<{
      reviews?: GbpReview[];
      nextPageToken?: string;
      totalReviewCount?: number;
    }>(url, accessToken, fetchImpl);

    if (typeof data.totalReviewCount === "number") {
      totalReviewCount = data.totalReviewCount;
    }
    reviews.push(...(data.reviews || []));
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  }

  return { reviews, totalReviewCount };
}
