export const SEARCH_DEBOUNCE_MS = 300;

export type ReviewsFilterState = {
  locationId: string;
  starRating: string;
  groupId: string;
  flagged: string;
  from: string;
  to: string;
  q: string;
};

export type FilterChip = {
  key: keyof ReviewsFilterState | "q";
  label: string;
};

export const EMPTY_REVIEWS_FILTERS: ReviewsFilterState = {
  locationId: "",
  starRating: "",
  groupId: "",
  flagged: "",
  from: "",
  to: "",
  q: "",
};

export function hasActiveSecondaryFilters(f: ReviewsFilterState): boolean {
  return Boolean(
    f.locationId ||
      f.starRating ||
      f.groupId ||
      f.flagged ||
      f.from ||
      f.to ||
      f.q.trim()
  );
}

export function buildFilterChips(
  f: ReviewsFilterState,
  labels: {
    locationTitle?: string;
    groupName?: string;
  } = {}
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.q.trim()) chips.push({ key: "q", label: `Search: ${f.q.trim()}` });
  if (f.locationId) {
    chips.push({
      key: "locationId",
      label: `Location: ${labels.locationTitle || f.locationId}`,
    });
  }
  if (f.starRating) {
    chips.push({ key: "starRating", label: `Rating: ${f.starRating}★` });
  }
  if (f.groupId) {
    chips.push({
      key: "groupId",
      label: `Group: ${labels.groupName || f.groupId}`,
    });
  }
  if (f.flagged === "true") chips.push({ key: "flagged", label: "Flagged only" });
  if (f.flagged === "false") {
    chips.push({ key: "flagged", label: "Not flagged" });
  }
  if (f.from) chips.push({ key: "from", label: `From: ${f.from}` });
  if (f.to) chips.push({ key: "to", label: `To: ${f.to}` });
  return chips;
}

export function clearFilterKey(
  f: ReviewsFilterState,
  key: FilterChip["key"]
): ReviewsFilterState {
  return { ...f, [key]: "" };
}
