/** Validate geographic coordinates for outlet / GBP updates. */

export class GeoValidationError extends Error {
  code: string;
  constructor(message: string, code = "invalid_geo") {
    super(message);
    this.name = "GeoValidationError";
    this.code = code;
  }
}

export function normalizeCoordinates(input: {
  latitude: unknown;
  longitude: unknown;
}): { latitude: number; longitude: number } {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new GeoValidationError("Latitude and longitude must be numbers.");
  }
  if (latitude < -90 || latitude > 90) {
    throw new GeoValidationError("Latitude must be between -90 and 90.");
  }
  if (longitude < -180 || longitude > 180) {
    throw new GeoValidationError("Longitude must be between -180 and 180.");
  }
  return {
    latitude: Math.round(latitude * 1e6) / 1e6,
    longitude: Math.round(longitude * 1e6) / 1e6,
  };
}

export function normalizeAddressLine(raw: unknown): string {
  const address = String(raw || "").trim().slice(0, 500);
  return address;
}
