import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/mongodb";
import { AutoPublishJob } from "@/models/AutoPublishJob";

const OPEN_STATUSES = [
  "queued_auto_publish",
  "awaiting_approval",
  "draft_generated",
  "processing",
] as const;

/** Cancel open/processing auto-publish jobs for a business (no Google calls). */
export async function cancelOpenAutoPublishJobsForBusiness(
  businessId: string,
  reason = "business_lifecycle_change"
): Promise<number> {
  if (!mongoose.isValidObjectId(businessId)) return 0;
  await connectToDatabase();
  const result = await AutoPublishJob.updateMany(
    {
      businessId,
      status: { $in: [...OPEN_STATUSES] },
    },
    {
      $set: {
        status: "cancelled",
        lastError: reason,
        claimOwner: null,
        claimExpiresAt: null,
      },
    }
  );
  return result.modifiedCount || 0;
}
