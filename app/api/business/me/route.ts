import { NextResponse } from "next/server";
import {
  isAuthUser,
  listActiveBusinessIdsForUser,
  requireAuthUser,
} from "@/lib/auth/authorize";
import { connectToDatabase } from "@/lib/mongodb";
import { Business } from "@/models/Business";
import { Review } from "@/models/Review";

export const runtime = "nodejs";

/** List active businesses the signed-in owner may access (no secrets). */
export async function GET() {
  const auth = await requireAuthUser();
  if (!isAuthUser(auth)) return auth.response;

  await connectToDatabase();
  const ids = await listActiveBusinessIdsForUser(auth.user);
  if (ids.length === 0) {
    return NextResponse.json({ success: true, businesses: [] });
  }

  const businesses = await Business.find({
    _id: { $in: ids },
    ...(auth.user.role === "superadmin" ? {} : { active: true }),
  })
    .sort({ name: 1 })
    .lean();

  const rows = await Promise.all(
    businesses.map(async (b) => {
      const [reviewCount, published] = await Promise.all([
        Review.countDocuments({ businessId: b._id }),
        Review.countDocuments({
          businessId: b._id,
          replyComment: { $exists: true, $nin: ["", null] },
        }),
      ]);
      return {
        id: String(b._id),
        name: b.name,
        active: Boolean(b.active),
        replyMode: b.replyMode,
        brandVoice: b.brandVoice,
        preferredLanguage: b.preferredLanguage,
        locationCount: (b.locationIds || []).length,
        reviewCount,
        pendingReviews: Math.max(0, reviewCount - published),
        publishedReplies: published,
      };
    })
  );

  return NextResponse.json({ success: true, businesses: rows });
}
