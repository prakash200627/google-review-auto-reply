import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import {
  assertAssignableLocations,
  LocationAssignmentError,
  MAX_LOCATIONS_PER_BUSINESS,
  validateLocationAssignmentInput,
} from "@/lib/business/assignLocations";

const ORG = new mongoose.Types.ObjectId().toString();
const LOC1 = new mongoose.Types.ObjectId().toString();
const LOC2 = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();
const OTHER_BIZ = new mongoose.Types.ObjectId().toString();

describe("location assignment validation", () => {
  it("rejects invalid and duplicate location ids", () => {
    expect(() =>
      validateLocationAssignmentInput({
        orgId: ORG,
        locationIds: ["bad-id"],
      })
    ).toThrow(LocationAssignmentError);

    expect(() =>
      validateLocationAssignmentInput({
        orgId: ORG,
        locationIds: [LOC1, LOC1],
      })
    ).toThrow(/Duplicate location/);
  });

  it("rejects more than one location per business", () => {
    expect(MAX_LOCATIONS_PER_BUSINESS).toBe(1);
    expect(() =>
      validateLocationAssignmentInput({
        orgId: ORG,
        locationIds: [LOC1, LOC2],
      })
    ).toThrow(/at most 1/);

    try {
      validateLocationAssignmentInput({
        orgId: ORG,
        locationIds: [LOC1, LOC2],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LocationAssignmentError);
      expect((err as LocationAssignmentError).code).toBe("too_many_locations");
      expect((err as LocationAssignmentError).status).toBe(400);
    }
  });

  it("rejects organization mismatches and already-assigned locations", () => {
    expect(() =>
      assertAssignableLocations({
        orgId: ORG,
        requestedIds: [LOC1, LOC2],
        found: [
          {
            _id: new mongoose.Types.ObjectId(LOC1),
            orgId: new mongoose.Types.ObjectId(ORG),
            businessId: null,
            googleLocationName: "accounts/1/locations/1",
          },
        ],
      })
    ).toThrow(/at most 1|not found under the selected organization/);

    expect(() =>
      assertAssignableLocations({
        orgId: ORG,
        requestedIds: [LOC1],
        found: [
          {
            _id: new mongoose.Types.ObjectId(LOC1),
            orgId: new mongoose.Types.ObjectId(ORG),
            businessId: new mongoose.Types.ObjectId(OTHER_BIZ),
            googleLocationName: "accounts/1/locations/1",
          },
        ],
        currentBusinessId: BIZ,
      })
    ).toThrow(/already assigned/);
  });

  it("allows re-assigning locations already owned by the same business", () => {
    const found = assertAssignableLocations({
      orgId: ORG,
      requestedIds: [LOC1],
      found: [
        {
          _id: new mongoose.Types.ObjectId(LOC1),
          orgId: new mongoose.Types.ObjectId(ORG),
          businessId: new mongoose.Types.ObjectId(BIZ),
          googleLocationName: "accounts/1/locations/1",
        },
      ],
      currentBusinessId: BIZ,
    });
    expect(found).toHaveLength(1);
  });

  it("accepts a clean first-time single location or empty unassignment", () => {
    expect(
      validateLocationAssignmentInput({
        orgId: ORG,
        locationIds: [LOC1],
      })
    ).toEqual([LOC1]);

    expect(
      validateLocationAssignmentInput({
        orgId: ORG,
        locationIds: [],
      })
    ).toEqual([]);
  });

  it("rejects empty-string and non-array locationIds", () => {
    expect(() =>
      validateLocationAssignmentInput({
        orgId: ORG,
        locationIds: "not-an-array",
      })
    ).toThrow(/must be an array/);
  });

  it("does not steal a location from another business during reassignment", () => {
    expect(() =>
      assertAssignableLocations({
        orgId: ORG,
        requestedIds: [LOC1],
        found: [
          {
            _id: new mongoose.Types.ObjectId(LOC1),
            orgId: new mongoose.Types.ObjectId(ORG),
            businessId: new mongoose.Types.ObjectId(OTHER_BIZ),
            googleLocationName: "accounts/1/locations/1",
          },
        ],
        currentBusinessId: BIZ,
      })
    ).toThrow(LocationAssignmentError);

    try {
      assertAssignableLocations({
        orgId: ORG,
        requestedIds: [LOC1],
        found: [
          {
            _id: new mongoose.Types.ObjectId(LOC1),
            orgId: new mongoose.Types.ObjectId(ORG),
            businessId: new mongoose.Types.ObjectId(OTHER_BIZ),
            googleLocationName: "accounts/1/locations/1",
          },
        ],
        currentBusinessId: BIZ,
      });
    } catch (err) {
      expect((err as LocationAssignmentError).code).toBe(
        "location_already_assigned"
      );
      expect((err as LocationAssignmentError).status).toBe(409);
    }
  });
});
