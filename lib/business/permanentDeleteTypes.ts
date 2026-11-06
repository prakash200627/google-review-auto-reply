/** Shared permanent-delete constants/types (safe for client components). */

/** Exact phrase the Super Admin must type as the second confirmation. */
export const PERMANENT_DELETE_CONFIRM_PHRASE = "PERMANENTLY DELETE";

export type PermanentDeleteCounts = {
  locationsAssigned: number;
  reviewsLinked: number;
  draftsPresent: number;
  autoPublishJobs: number;
  autoPublishOpen: number;
  seoKeywords: number;
  seoRankings: number;
  gmbServiceJobs: number;
  fakeReviewFlags: number;
  manualPaymentsRetained: number;
  auditEventsRetained: number;
  businessOwnerConnections: number;
  oauthStates: number;
  ownersLinked: number;
};

export type PermanentDeleteOwnerSummary = {
  id: string;
  email: string;
  active: boolean;
  otherBusinessCount: number;
  willDeleteAccount: boolean;
};

export type PermanentDeletePreview = {
  businessId: string;
  name: string;
  orgId: string;
  status: string;
  canDelete: boolean;
  blockers: string[];
  owners: PermanentDeleteOwnerSummary[];
  counts: PermanentDeleteCounts;
  willDelete: string[];
  willUnlink: string[];
  willRetain: string[];
  deletionInProgress: boolean;
};
