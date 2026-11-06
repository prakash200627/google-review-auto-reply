import { describe, expect, it } from "vitest";
import {
  CreateLocationValidationError,
  validatePrimaryCategoryName,
  validateStorefrontAddress,
} from "@/lib/google/createLocationValidation";
import {
  classifyGoogleApiErrorBody,
  extractGoogleFieldViolations,
} from "@/lib/google/gbpErrors";

describe("create location validation", () => {
  it("accepts well-formed gcid categories and rejects spaced ones", () => {
    expect(validatePrimaryCategoryName("gcid:software_company")).toBe(
      "gcid:software_company"
    );
    expect(validatePrimaryCategoryName("")).toBeUndefined();
    expect(() =>
      validatePrimaryCategoryName("gcid: software_company")
    ).toThrow(CreateLocationValidationError);
  });

  it("requires regionCode and street lines when any address field is set", () => {
    expect(() =>
      validateStorefrontAddress({
        locality: "Hyderabad",
        postalCode: "500018",
      })
    ).toThrow(/region code/i);

    expect(() =>
      validateStorefrontAddress({
        locality: "Hyderabad",
        administrativeArea: "Telangana",
        regionCode: "IN",
      })
    ).toThrow(/street address line/i);
  });

  it("rejects city copied into state or address lines", () => {
    try {
      validateStorefrontAddress({
        addressLines: ["hyderabad"],
        locality: "hyderabad",
        administrativeArea: "hyderabad",
        regionCode: "IN",
        postalCode: "500018",
      });
      expect.fail("expected validation error");
    } catch (err) {
      expect(err).toBeInstanceOf(CreateLocationValidationError);
      const e = err as CreateLocationValidationError;
      expect(e.fieldIssues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns undefined when address is fully empty", () => {
    expect(validateStorefrontAddress({})).toBeUndefined();
    expect(validateStorefrontAddress(undefined)).toBeUndefined();
  });
});

describe("Google field violation extraction", () => {
  it("surfaces BadRequest fieldViolations in the user-safe message", () => {
    const err = classifyGoogleApiErrorBody(400, {
      error: {
        status: "INVALID_ARGUMENT",
        message: "Request contains an invalid argument.",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [
              {
                field: "storefront_address.region_code",
                description: "Region code is required.",
              },
              {
                field: "categories.primary_category.name",
                description: "Invalid category.",
              },
            ],
          },
        ],
      },
    });
    expect(err.code).toBe("invalid_argument");
    expect(err.fieldViolations).toHaveLength(2);
    expect(err.message).toMatch(/storefront_address\.region_code/);
    expect(err.message).not.toMatch(/Bearer|ya29|AIza/i);
  });

  it("ignores credential-looking violation descriptions", () => {
    const violations = extractGoogleFieldViolations({
      error: {
        details: [
          {
            fieldViolations: [
              {
                field: "auth",
                description: "Bearer token expired ya29.a0af",
              },
              { field: "title", description: "Title is required." },
            ],
          },
        ],
      },
    });
    expect(violations).toEqual([
      { field: "title", description: "Title is required." },
    ]);
  });
});
