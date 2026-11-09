import { describe, expect, it } from "vitest";
import { validateGbpProfile, type GbpEditableProfile } from "@/lib/google/updateGbpProfile";

const base: GbpEditableProfile = {
  title: "Cafe", phoneNumbers: { primaryPhone: "+14155550100", additionalPhones: [] }, websiteUri: "",
  categories: { primaryCategory: { name: "gcid:cafe" }, additionalCategories: [] },
  storefrontAddress: { revision: 0, addressLines: [], locality: "", administrativeArea: "", postalCode: "", regionCode: "" },
  regularHours: { periods: [] }, specialHours: { specialHourPeriods: [] },
};
const timePeriod = (openDay: string, openHour: number, closeDay: string, closeHour: number) => ({
  openDay, openTime: { hours: openHour, minutes: 0 }, closeDay, closeTime: { hours: closeHour, minutes: 0 },
});

describe("Google Business Profile hours validation", () => {
  const messages = (issues: ReturnType<typeof validateGbpProfile>) => issues.map((item) => item.message).join(" ");
  it("accepts a valid overnight regular-hours period ending the next day", () => {
    const result = validateGbpProfile({ ...base, regularHours: { periods: [timePeriod("MONDAY", 22, "TUESDAY", 2)] } }, ["Regular business hours"]);
    expect(result).toEqual([]);
  });

  it("rejects nonnumeric or out-of-range Google TimeOfDay values", () => {
    const bad = { ...timePeriod("MONDAY", 9, "MONDAY", 17), openTime: { hours: "09", minutes: 0 } };
    expect(messages(validateGbpProfile({ ...base, regularHours: { periods: [bad] } }, ["Regular business hours"]))).toContain("valid open and close days and times");
  });

  it("rejects backward, longer-than-a-day, and overlapping regular periods", () => {
    const backward = validateGbpProfile({ ...base, regularHours: { periods: [timePeriod("MONDAY", 17, "MONDAY", 9)] } }, ["Regular business hours"]);
    expect(messages(backward)).toContain("closes after opening");
    const tooLong = validateGbpProfile({ ...base, regularHours: { periods: [timePeriod("MONDAY", 9, "SUNDAY", 8)] } }, ["Regular business hours"]);
    expect(messages(tooLong)).toContain("spans no more than 24 hours");
    const overlap = validateGbpProfile({ ...base, regularHours: { periods: [timePeriod("MONDAY", 9, "MONDAY", 13), timePeriod("MONDAY", 12, "MONDAY", 17)] } }, ["Regular business hours"]);
    expect(messages(overlap)).toContain("Regular-hours periods cannot overlap.");
  });

  it("rejects invalid special dates and time ordering", () => {
    const invalidDate = validateGbpProfile({ ...base, regularHours: { periods: [timePeriod("MONDAY", 9, "MONDAY", 17)] }, specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 13, day: 1 }, openTime: { hours: 9 }, closeTime: { hours: 17 } }] } }, ["Special hours"]);
    expect(messages(invalidDate)).toContain("valid start date");
    const invalidTimes = validateGbpProfile({ ...base, regularHours: { periods: [timePeriod("MONDAY", 9, "MONDAY", 17)] }, specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, openTime: { hours: 13 }, closeTime: { hours: 11 } }] } }, ["Special hours"]);
    expect(messages(invalidTimes)).toContain("last less than 24 hours");
  });

  it("enforces Google's next-day special-hours closing limit", () => {
    const issues = validateGbpProfile({ ...base, regularHours: { periods: [timePeriod("MONDAY", 9, "MONDAY", 17)] }, specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, openTime: { hours: 13 }, endDate: { year: 2026, month: 12, day: 26 }, closeTime: { hours: 12 } }] } }, ["Special hours"]);
    expect(messages(issues)).toContain("11:59 a.m.");
  });

  it("requires regular hours when special hours are present", () => {
    const issues = validateGbpProfile({ ...base, specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, closed: true }] } }, ["Special hours"]);
    expect(messages(issues)).toContain("Regular business hours are required when special hours are set.");
  });
});
