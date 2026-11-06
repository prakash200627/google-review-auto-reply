import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyMessageForTab,
  emptyStateDetail,
  parseReviewsTab,
  tabToReplyStatus,
} from "@/components/reviews/reviewStatus";

describe("Reviews workspace navigation helpers", () => {
  it("maps tabs to inbox replyStatus filters", () => {
    expect(tabToReplyStatus("inbox")).toBe("unreplied");
    expect(tabToReplyStatus("drafts")).toBe("drafts");
    expect(tabToReplyStatus("published")).toBe("replied");
  });

  it("parses tab query values safely", () => {
    expect(parseReviewsTab("drafts")).toBe("drafts");
    expect(parseReviewsTab("published")).toBe("published");
    expect(parseReviewsTab("inbox")).toBe("inbox");
    expect(parseReviewsTab("nope")).toBe("inbox");
    expect(parseReviewsTab(null)).toBe("inbox");
  });

  it("provides empty-state copy per section", () => {
    expect(emptyMessageForTab("inbox")).toMatch(/need attention/i);
    expect(emptyMessageForTab("drafts")).toMatch(/No reply drafts/i);
    expect(emptyMessageForTab("published")).toMatch(/No published replies/i);
  });

  it("distinguishes filter misses from never-synced empty stores", () => {
    const filtered = emptyStateDetail({
      tab: "inbox",
      hasActiveFilters: true,
      locationCount: 3,
      metricsTotal: 10,
    });
    expect(filtered.title).toMatch(/matching/i);

    const neverSynced = emptyStateDetail({
      tab: "inbox",
      hasActiveFilters: false,
      locationCount: 0,
      metricsTotal: 0,
    });
    expect(neverSynced.detail).toMatch(/GMB/i);

    const noStored = emptyStateDetail({
      tab: "published",
      hasActiveFilters: false,
      locationCount: 2,
      metricsTotal: 0,
    });
    expect(noStored.detail).toMatch(/Fetch reviews/i);
  });

  it("orm reviews page uses ReviewsWorkspace and Suspense", () => {
    const src = readFileSync(
      join(process.cwd(), "app/orm/reviews/page.tsx"),
      "utf8"
    );
    expect(src).toMatch(/ReviewsWorkspace/);
    expect(src).toMatch(/Suspense/);
    expect(src).not.toMatch(/ReviewsPanel/);
  });

  it("workspace uses searchable selects and filter chips", () => {
    const src = readFileSync(
      join(process.cwd(), "components/reviews/ReviewsWorkspace.tsx"),
      "utf8"
    );
    expect(src).toMatch(/SearchableSelect/);
    expect(src).toMatch(/buildFilterChips/);
    expect(src).toMatch(/Clear all/);
    expect(src).toMatch(/SEARCH_DEBOUNCE_MS|qDraft/);
    expect(src).toMatch(/requestSeq/);
    expect(src).toMatch(/mobileDetail/);
  });

  it("GMB locations host discovery; ReviewsPanel remains for location detail sync", () => {
    const gmb = readFileSync(
      join(process.cwd(), "app/gmb/locations/page.tsx"),
      "utf8"
    );
    expect(gmb).toMatch(/GmbDiscoverLocationsButton/);
    const detail = readFileSync(
      join(process.cwd(), "app/gmb/locations/[locationId]/page.tsx"),
      "utf8"
    );
    expect(detail).toMatch(/ReviewsPanel/);
  });
});
