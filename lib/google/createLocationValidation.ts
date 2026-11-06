/**
 * Pure validation for GBP location create payloads (no DB / network).
 * Does not invent or silently rewrite address components.
 */

export type StorefrontAddressInput = {
  addressLines?: string[];
  locality?: string;
  administrativeArea?: string;
  postalCode?: string;
  regionCode?: string;
};

export type CreateLocationFieldIssue = {
  field: string;
  message: string;
};

export class CreateLocationValidationError extends Error {
  code: string;
  status: number;
  fieldIssues: CreateLocationFieldIssue[];

  constructor(
    message: string,
    fieldIssues: CreateLocationFieldIssue[],
    { code = "invalid_create_payload", status = 400 }: { code?: string; status?: number } = {}
  ) {
    super(message);
    this.name = "CreateLocationValidationError";
    this.code = code;
    this.status = status;
    this.fieldIssues = fieldIssues;
  }
}

const GCID_RE = /^gcid:[a-z0-9_]+$/i;
const REGION_CODE_RE = /^[A-Z]{2}$/;

/**
 * Trim and validate a Google category resource name.
 * Rejects spaces (e.g. "gcid: software_company") — does not rewrite them.
 */
export function validatePrimaryCategoryName(
  raw: string | undefined
): string | undefined {
  const value = String(raw || "").trim();
  if (!value) return undefined;
  if (!GCID_RE.test(value)) {
    throw new CreateLocationValidationError(
      "Primary category must look like gcid:software_company (no spaces after gcid:).",
      [
        {
          field: "primaryCategoryName",
          message:
            "Use the Google category id format gcid:category_id with no spaces.",
        },
      ],
      { code: "invalid_category", status: 400 }
    );
  }
  return value;
}

/**
 * Normalize/validate PostalAddress for create.
 * When any address component is present, regionCode (CLDR, e.g. IN, US) is required.
 * Does not copy locality into administrativeArea or invent street lines.
 */
export function validateStorefrontAddress(
  raw: StorefrontAddressInput | undefined
): StorefrontAddressInput | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const addressLines = Array.isArray(raw.addressLines)
    ? raw.addressLines
        .map((line) => String(line || "").trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];
  const locality = String(raw.locality || "").trim();
  const administrativeArea = String(raw.administrativeArea || "").trim();
  const postalCode = String(raw.postalCode || "").trim();
  const regionCode = String(raw.regionCode || "").trim().toUpperCase();

  const hasAny =
    addressLines.length > 0 ||
    Boolean(locality) ||
    Boolean(administrativeArea) ||
    Boolean(postalCode) ||
    Boolean(regionCode);

  if (!hasAny) return undefined;

  const issues: CreateLocationFieldIssue[] = [];

  if (!regionCode) {
    issues.push({
      field: "storefrontAddress.regionCode",
      message:
        "Region code is required when any address field is set (CLDR 2-letter code, e.g. IN or US).",
    });
  } else if (!REGION_CODE_RE.test(regionCode)) {
    issues.push({
      field: "storefrontAddress.regionCode",
      message: "Region code must be a 2-letter CLDR code (e.g. IN, US).",
    });
  }

  if (addressLines.length === 0) {
    issues.push({
      field: "storefrontAddress.addressLines",
      message:
        "Provide at least one street address line. Do not put only the city in address lines.",
    });
  }

  const localityLower = locality.toLowerCase();
  const adminLower = administrativeArea.toLowerCase();

  if (locality && administrativeArea && localityLower === adminLower) {
    issues.push({
      field: "storefrontAddress.administrativeArea",
      message:
        "State / administrative area must not be the same as city / locality (e.g. use Telangana, not Hyderabad, for IN).",
    });
  }

  for (let i = 0; i < addressLines.length; i++) {
    const line = addressLines[i].toLowerCase();
    if (
      (localityLower && line === localityLower) ||
      (adminLower && line === adminLower)
    ) {
      issues.push({
        field: `storefrontAddress.addressLines[${i}]`,
        message:
          "Address lines should be the street / building, not a copy of city or state.",
      });
    }
  }

  if (issues.length > 0) {
    throw new CreateLocationValidationError(
      issues.map((i) => i.message).join(" "),
      issues,
      { code: "invalid_address", status: 400 }
    );
  }

  return {
    ...(addressLines.length ? { addressLines } : {}),
    ...(locality ? { locality } : {}),
    ...(administrativeArea ? { administrativeArea } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(regionCode ? { regionCode } : {}),
  };
}
