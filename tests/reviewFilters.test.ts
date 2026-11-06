import { describe, expect, it } from "vitest";
import { filterSearchableOptions } from "@/components/reviews/SearchableSelect";
import {
  buildFilterChips,
  clearFilterKey,
  EMPTY_REVIEWS_FILTERS,
  hasActiveSecondaryFilters,
  SEARCH_DEBOUNCE_MS,
} from "@/components/reviews/reviewFilters";

describe("review filter helpers", () => {
  it("exports a positive search debounce", () => {
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(200);
    expect(SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(1000);
  });

  it("filters searchable options case-insensitively", () => {
    const options = [
      { id: "1", label: "Downtown Cafe" },
      { id: "2", label: "Airport Kiosk" },
      { id: "3", label: "Main Store" },
    ];
    expect(filterSearchableOptions(options, "main").map((o) => o.id)).toEqual([
      "3",
    ]);
    expect(filterSearchableOptions(options, "  ").length).toBe(3);
    expect(filterSearchableOptions(options, "zzz")).toEqual([]);
  });

  it("builds removable chips for active filters", () => {
    const chips = buildFilterChips(
      {
        ...EMPTY_REVIEWS_FILTERS,
        q: "hello",
        locationId: "loc1",
        starRating: "4",
        flagged: "true",
        from: "2026-01-01",
      },
      { locationTitle: "Main Store" }
    );
    expect(chips.map((c) => c.key)).toEqual([
      "q",
      "locationId",
      "starRating",
      "flagged",
      "from",
    ]);
    expect(chips.find((c) => c.key === "locationId")?.label).toMatch(
      /Main Store/
    );
  });

  it("clearFilterKey and hasActiveSecondaryFilters work together", () => {
    const active = {
      ...EMPTY_REVIEWS_FILTERS,
      starRating: "5",
      locationId: "x",
    };
    expect(hasActiveSecondaryFilters(active)).toBe(true);
    const cleared = clearFilterKey(
      clearFilterKey(active, "starRating"),
      "locationId"
    );
    expect(hasActiveSecondaryFilters(cleared)).toBe(false);
    expect(cleared).toEqual(EMPTY_REVIEWS_FILTERS);
  });
});
