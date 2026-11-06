import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  getTokenMock,
  listAccountsMock,
  locationFindOneAndUpdateMock,
  locationFindByIdMock,
  createReqFindOneMock,
  createReqCreateMock,
  createReqUpdateOneMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  getTokenMock: vi.fn(),
  listAccountsMock: vi.fn(),
  locationFindOneAndUpdateMock: vi.fn(),
  locationFindByIdMock: vi.fn(),
  createReqFindOneMock: vi.fn(),
  createReqCreateMock: vi.fn(),
  createReqUpdateOneMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/lib/google/accessToken", () => ({
  getValidAccessTokenForOrg: getTokenMock,
}));

vi.mock("@/lib/google/gbpDiscovery", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/google/gbpDiscovery")
  >("@/lib/google/gbpDiscovery");
  return {
    ...actual,
    listAllAccounts: listAccountsMock,
  };
});

vi.mock("@/models/Location", () => ({
  Location: {
    findOneAndUpdate: locationFindOneAndUpdateMock,
    findById: locationFindByIdMock,
  },
}));

vi.mock("@/models/GbpCreateLocationRequest", () => ({
  GbpCreateLocationRequest: {
    findOne: createReqFindOneMock,
    create: createReqCreateMock,
    updateOne: createReqUpdateOneMock,
  },
}));

import {
  buildGoogleLocationBody,
  createGbpLocationForOrg,
  CreateGbpLocationError,
  validateCreateGbpLocationInput,
} from "@/lib/google/createLocation";
import { GoogleBusinessApiError } from "@/lib/google/gbpErrors";

const ORG = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();
const LOC_ID = new mongoose.Types.ObjectId();

describe("validateCreateGbpLocationInput / buildGoogleLocationBody", () => {
  it("requires title, languageCode, accounts/{id}, and requestId", () => {
    expect(() =>
      validateCreateGbpLocationInput({
        orgId: ORG,
        createdByUserId: USER,
        googleAccountName: "not-an-account",
        requestId: "abc",
        title: "Cafe",
        languageCode: "en",
      })
    ).toThrow(CreateGbpLocationError);

    expect(() =>
      validateCreateGbpLocationInput({
        orgId: ORG,
        createdByUserId: USER,
        googleAccountName: "accounts/123",
        requestId: "",
        title: "Cafe",
        languageCode: "en",
      })
    ).toThrow(/requestId/);

    const ok = validateCreateGbpLocationInput({
      orgId: ORG,
      createdByUserId: USER,
      googleAccountName: "accounts/123",
      requestId: "11111111-1111-1111-1111-111111111111",
      title: "  Cafe  ",
      languageCode: "en-US",
      primaryCategoryName: "gcid:cafe",
      storefrontAddress: {
        addressLines: ["1 Main"],
        locality: "Austin",
        administrativeArea: "TX",
        regionCode: "us",
      },
    });
    expect(ok.title).toBe("Cafe");
    expect(ok.storefrontAddress?.regionCode).toBe("US");
    expect(buildGoogleLocationBody(ok)).toEqual({
      title: "Cafe",
      languageCode: "en-US",
      categories: { primaryCategory: { name: "gcid:cafe" } },
      storefrontAddress: {
        addressLines: ["1 Main"],
        locality: "Austin",
        administrativeArea: "TX",
        regionCode: "US",
      },
    });
  });

  it("rejects the observed bad Hyderabad payload shape before Google", () => {
    try {
      validateCreateGbpLocationInput({
        orgId: ORG,
        createdByUserId: USER,
        googleAccountName: "accounts/123",
        requestId: "11111111-1111-1111-1111-111111111111",
        title: "demo",
        languageCode: "en",
        primaryCategoryName: "gcid: software_company",
        storefrontAddress: {
          addressLines: ["hyderabad", "hyderabad"],
          locality: "hyderabad",
          administrativeArea: "hyderabad",
          postalCode: "500018",
        },
      });
      expect.fail("expected invalid_category");
    } catch (err) {
      expect(err).toBeInstanceOf(CreateGbpLocationError);
      expect((err as CreateGbpLocationError).code).toBe("invalid_category");
    }

    try {
      validateCreateGbpLocationInput({
        orgId: ORG,
        createdByUserId: USER,
        googleAccountName: "accounts/123",
        requestId: "11111111-1111-1111-1111-111111111111",
        title: "demo",
        languageCode: "en",
        primaryCategoryName: "gcid:software_company",
        storefrontAddress: {
          addressLines: ["hyderabad", "hyderabad"],
          locality: "hyderabad",
          administrativeArea: "hyderabad",
          postalCode: "500018",
        },
      });
      expect.fail("expected invalid_address");
    } catch (err) {
      expect(err).toBeInstanceOf(CreateGbpLocationError);
      const e = err as CreateGbpLocationError;
      expect(e.code).toBe("invalid_address");
      expect(e.fieldIssues?.some((i) => i.field.includes("regionCode"))).toBe(
        true
      );
      expect(
        e.fieldIssues?.some((i) => i.field.includes("administrativeArea"))
      ).toBe(true);
    }
  });

  it("maps a valid IN storefront address without inventing fields", () => {
    const ok = validateCreateGbpLocationInput({
      orgId: ORG,
      createdByUserId: USER,
      googleAccountName: "accounts/123",
      requestId: "22222222-2222-2222-2222-222222222222",
      title: "Demo Office",
      languageCode: "en",
      primaryCategoryName: "gcid:software_company",
      storefrontAddress: {
        addressLines: ["Plot 12, Road No 36"],
        locality: "Hyderabad",
        administrativeArea: "Telangana",
        postalCode: "500018",
        regionCode: "IN",
      },
    });
    expect(buildGoogleLocationBody(ok)).toEqual({
      title: "Demo Office",
      languageCode: "en",
      categories: {
        primaryCategory: { name: "gcid:software_company" },
      },
      storefrontAddress: {
        addressLines: ["Plot 12, Road No 36"],
        locality: "Hyderabad",
        administrativeArea: "Telangana",
        postalCode: "500018",
        regionCode: "IN",
      },
    });
  });
});

describe("createGbpLocationForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    getTokenMock.mockResolvedValue("access-token");
    listAccountsMock.mockResolvedValue([
      { name: "accounts/aaa", accountName: "Primary" },
      { name: "accounts/bbb", accountName: "Other" },
    ]);
    createReqFindOneMock.mockReturnValue({ lean: async () => null });
    createReqCreateMock.mockResolvedValue({});
    createReqUpdateOneMock.mockResolvedValue({});
  });

  it("creates on the selected Google account and persists unassigned location", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          name: "locations/loc-new",
          title: "New Cafe",
          storeCode: "NC1",
          storefrontAddress: {
            addressLines: ["1 Main"],
            locality: "Austin",
            regionCode: "US",
          },
          metadata: { placeId: "ChIJtest" },
        }),
    });

    locationFindOneAndUpdateMock.mockResolvedValue({
      _id: LOC_ID,
      title: "New Cafe",
      address: "1 Main, Austin, US",
      storeCode: "NC1",
      googleLocationName: "accounts/aaa/locations/loc-new",
      googleAccountName: "accounts/aaa",
      businessInfoName: "locations/loc-new",
      placeId: "ChIJtest",
      businessId: null,
      lastDiscoveryAt: new Date(),
      lastReviewsSyncAt: null,
      lastReviewsSyncError: "",
    });

    const result = await createGbpLocationForOrg(
      {
        orgId: ORG,
        createdByUserId: USER,
        googleAccountName: "accounts/aaa",
        requestId: "req-success-1",
        title: "New Cafe",
        languageCode: "en",
        storeCode: "NC1",
      },
      fetchImpl
    );

    expect(getTokenMock).toHaveBeenCalledWith(ORG, fetchImpl);
    expect(listAccountsMock).toHaveBeenCalled();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      "mybusinessbusinessinformation.googleapis.com/v1/accounts/aaa/locations"
    );
    expect(url).toContain("requestId=req-success-1");
    expect(url).not.toContain("accounts/bbb");
    expect(init.method).toBe("POST");
    expect(url).not.toMatch(/access.token|Bearer/i);
    const authHeader = (init.headers as Record<string, string>).Authorization;
    expect(authHeader).toBe("Bearer access-token");
    expect(JSON.parse(String(init.body))).toMatchObject({
      title: "New Cafe",
      languageCode: "en",
      storeCode: "NC1",
    });

    expect(locationFindOneAndUpdateMock).toHaveBeenCalledWith(
      { orgId: ORG, googleLocationName: "accounts/aaa/locations/loc-new" },
      expect.objectContaining({
        $set: expect.objectContaining({
          googleAccountName: "accounts/aaa",
          businessInfoName: "locations/loc-new",
          title: "New Cafe",
        }),
        $setOnInsert: expect.objectContaining({
          businessId: null,
          verificationStatus: "unknown",
        }),
      }),
      expect.any(Object)
    );

    expect(result.location.businessId).toBeNull();
    expect(result.verificationStatus).toBe("unknown");
    expect(result.googleLocationName).toBe(
      "accounts/aaa/locations/loc-new"
    );
    expect(result.reusedIdempotentResult).toBe(false);
    expect(createReqUpdateOneMock).toHaveBeenCalledWith(
      { orgId: ORG, requestId: "req-success-1" },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "succeeded" }),
      })
    );
  });

  it("does not persist a local location when Google create fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            status: "INVALID_ARGUMENT",
            message: "Missing category",
          },
        }),
    });

    await expect(
      createGbpLocationForOrg(
        {
          orgId: ORG,
          createdByUserId: USER,
          googleAccountName: "accounts/aaa",
          requestId: "req-fail-1",
          title: "Broken",
          languageCode: "en",
        },
        fetchImpl
      )
    ).rejects.toBeInstanceOf(GoogleBusinessApiError);

    expect(locationFindOneAndUpdateMock).not.toHaveBeenCalled();
    expect(createReqUpdateOneMock).toHaveBeenCalledWith(
      { orgId: ORG, requestId: "req-fail-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          locationId: null,
        }),
      })
    );
  });

  it("rejects an account that is not on the connected Google connection", async () => {
    const fetchImpl = vi.fn();
    await expect(
      createGbpLocationForOrg(
        {
          orgId: ORG,
          createdByUserId: USER,
          googleAccountName: "accounts/not-listed",
          requestId: "req-account-1",
          title: "X",
          languageCode: "en",
        },
        fetchImpl
      )
    ).rejects.toMatchObject({ code: "account_not_available" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(locationFindOneAndUpdateMock).not.toHaveBeenCalled();
  });

  it("replays a succeeded requestId without calling Google again", async () => {
    createReqFindOneMock.mockReturnValue({
      lean: async () => ({
        status: "succeeded",
        locationId: LOC_ID,
      }),
    });
    locationFindByIdMock.mockReturnValue({
      lean: async () => ({
        _id: LOC_ID,
        title: "Prior",
        address: "",
        storeCode: "",
        googleLocationName: "accounts/aaa/locations/prior",
        googleAccountName: "accounts/aaa",
        businessInfoName: "locations/prior",
        placeId: "",
        businessId: null,
        lastDiscoveryAt: null,
        lastReviewsSyncAt: null,
        lastReviewsSyncError: "",
      }),
    });
    const fetchImpl = vi.fn();

    const result = await createGbpLocationForOrg(
      {
        orgId: ORG,
        createdByUserId: USER,
        googleAccountName: "accounts/aaa",
        requestId: "req-dup-ok",
        title: "Prior",
        languageCode: "en",
      },
      fetchImpl
    );

    expect(result.reusedIdempotentResult).toBe(true);
    expect(result.location.businessId).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(locationFindOneAndUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate in-progress requestId", async () => {
    createReqFindOneMock.mockReturnValue({
      lean: async () => ({ status: "pending", locationId: null }),
    });
    await expect(
      createGbpLocationForOrg({
        orgId: ORG,
        createdByUserId: USER,
        googleAccountName: "accounts/aaa",
        requestId: "req-inflight",
        title: "X",
        languageCode: "en",
      })
    ).rejects.toMatchObject({ code: "duplicate_in_progress", status: 409 });
  });

  it("marks google_created when Google succeeds but local persist fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          name: "locations/loc-orphan",
          title: "Orphan Cafe",
          metadata: { placeId: "ChIJorphan" },
        }),
    });
    locationFindOneAndUpdateMock.mockResolvedValue(null);

    await expect(
      createGbpLocationForOrg(
        {
          orgId: ORG,
          createdByUserId: USER,
          googleAccountName: "accounts/aaa",
          requestId: "req-persist-fail",
          title: "Orphan Cafe",
          languageCode: "en",
        },
        fetchImpl
      )
    ).rejects.toMatchObject({
      code: "persist_failed_needs_reconcile",
      status: 500,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(createReqUpdateOneMock).toHaveBeenCalledWith(
      { orgId: ORG, requestId: "req-persist-fail" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "google_created",
          googleLocationName: "accounts/aaa/locations/loc-orphan",
          businessInfoName: "locations/loc-orphan",
        }),
      })
    );
    // Must not clear Google names / must not mark plain failed after Google success.
    const failedClear = createReqUpdateOneMock.mock.calls.find(
      (c) =>
        (c[1] as { $set?: { status?: string; googleLocationName?: string } })
          .$set?.status === "failed" &&
        (c[1] as { $set?: { googleLocationName?: string } }).$set
          ?.googleLocationName === ""
    );
    expect(failedClear).toBeUndefined();
  });

  it("reconciles google_created without calling Google create again", async () => {
    createReqFindOneMock.mockReturnValue({
      lean: async () => ({
        _id: new mongoose.Types.ObjectId(),
        status: "google_created",
        googleAccountName: "accounts/aaa",
        googleLocationName: "accounts/aaa/locations/loc-recon",
        businessInfoName: "locations/loc-recon",
        createdTitle: "Recon Cafe",
        createdStoreCode: "",
        createdAddress: "1 Main",
        createdPlaceId: "ChIJrecon",
        locationId: null,
      }),
    });
    locationFindOneAndUpdateMock.mockResolvedValue({
      _id: LOC_ID,
      title: "Recon Cafe",
      address: "1 Main",
      storeCode: "",
      googleLocationName: "accounts/aaa/locations/loc-recon",
      googleAccountName: "accounts/aaa",
      businessInfoName: "locations/loc-recon",
      placeId: "ChIJrecon",
      businessId: null,
      lastDiscoveryAt: new Date(),
      lastReviewsSyncAt: null,
      lastReviewsSyncError: "",
    });
    const fetchImpl = vi.fn();

    const result = await createGbpLocationForOrg(
      {
        orgId: ORG,
        createdByUserId: USER,
        googleAccountName: "accounts/aaa",
        requestId: "req-recon-1",
        title: "Recon Cafe",
        languageCode: "en",
      },
      fetchImpl
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.reusedIdempotentResult).toBe(true);
    expect(result.googleLocationName).toBe(
      "accounts/aaa/locations/loc-recon"
    );
    expect(locationFindOneAndUpdateMock).toHaveBeenCalled();
    expect(createReqUpdateOneMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "succeeded" }),
      })
    );
  });
});

