import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  findOneMock,
  updateOneMock,
  decryptMock,
  encryptMock,
  getOAuthEnvMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  findOneMock: vi.fn(),
  updateOneMock: vi.fn(),
  decryptMock: vi.fn(),
  encryptMock: vi.fn(),
  getOAuthEnvMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: {
    findOne: findOneMock,
    updateOne: updateOneMock,
  },
}));

vi.mock("@/lib/crypto/tokenEncryption", () => ({
  decryptToken: decryptMock,
  encryptToken: encryptMock,
}));

vi.mock("@/lib/google/oauthConfig", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/oauthConfig")>(
    "@/lib/google/oauthConfig"
  );
  return {
    ...actual,
    getOAuthEnv: getOAuthEnvMock,
  };
});

import {
  accessTokenNeedsRefresh,
  findActiveGoogleConnection,
  getValidAccessTokenForContext,
  getValidAccessTokenForOrg,
} from "@/lib/google/accessToken";

const ORG = new mongoose.Types.ObjectId().toString();
const BIZ_A = new mongoose.Types.ObjectId().toString();
const BIZ_B = new mongoose.Types.ObjectId().toString();

function leanConn(doc: Record<string, unknown> | null) {
  return {
    select: () => ({
      lean: async () => doc,
    }),
  };
}

describe("accessTokenNeedsRefresh", () => {
  it("refreshes when expiry is missing or within skew", () => {
    expect(accessTokenNeedsRefresh(null)).toBe(true);
    const soon = new Date(Date.now() + 10_000);
    expect(accessTokenNeedsRefresh(soon)).toBe(true);
    const later = new Date(Date.now() + 10 * 60_000);
    expect(accessTokenNeedsRefresh(later)).toBe(false);
  });
});

describe("getValidAccessTokenForOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    getOAuthEnvMock.mockReturnValue({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/auth/google/callback",
    });
    encryptMock.mockImplementation((v: string) => `enc:${v}`);
  });

  it("returns existing access token when not near expiry", async () => {
    findOneMock.mockReturnValue(
      leanConn({
        _id: "conn1",
        encryptedAccessToken: "enc-access",
        encryptedRefreshToken: "enc-refresh",
        accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000),
        connectionSource: "platform",
        businessId: null,
      })
    );
    decryptMock.mockImplementation((v: string) =>
      v === "enc-access" ? "access-token" : "refresh-token"
    );

    const fetchImpl = vi.fn();
    const token = await getValidAccessTokenForOrg(ORG, fetchImpl);

    expect(token).toBe("access-token");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it("refreshes, re-encrypts, and persists when expired", async () => {
    findOneMock.mockReturnValue(
      leanConn({
        _id: "conn1",
        encryptedAccessToken: "enc-access",
        encryptedRefreshToken: "enc-refresh",
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        connectionSource: "platform",
        businessId: null,
      })
    );
    decryptMock.mockImplementation((v: string) =>
      v === "enc-access" ? "old-access" : "refresh-token"
    );

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        expires_in: 3600,
      }),
    });

    const token = await getValidAccessTokenForOrg(ORG, fetchImpl);

    expect(token).toBe("new-access");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(encryptMock).toHaveBeenCalledWith("new-access");
    expect(updateOneMock).toHaveBeenCalledWith(
      { _id: "conn1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          encryptedAccessToken: "enc:new-access",
          status: "active",
        }),
      })
    );
  });

  it("marks connection error when refresh is rejected", async () => {
    findOneMock.mockReturnValue(
      leanConn({
        _id: "conn1",
        encryptedAccessToken: "enc-access",
        encryptedRefreshToken: "enc-refresh",
        accessTokenExpiresAt: new Date(Date.now() - 1000),
      })
    );
    decryptMock.mockReturnValue("token");

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      }),
    });

    await expect(getValidAccessTokenForOrg(ORG, fetchImpl)).rejects.toMatchObject({
      code: "refresh_failed",
    });
    expect(updateOneMock).toHaveBeenCalledWith(
      { _id: "conn1" },
      {
        $set: {
          status: "error",
          lastError: "token_refresh_failed",
        },
      }
    );
  });

  it("rejects when no active connection exists", async () => {
    findOneMock.mockReturnValue(leanConn(null));

    await expect(getValidAccessTokenForOrg(ORG, vi.fn())).rejects.toMatchObject({
      code: "not_connected",
    });
  });
});

describe("findActiveGoogleConnection ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("prefers the business_owner connection for the requested business", async () => {
    findOneMock.mockReturnValueOnce(
      leanConn({
        _id: "owner-conn",
        connectionSource: "business_owner",
        businessId: new mongoose.Types.ObjectId(BIZ_A),
        encryptedAccessToken: "a",
        encryptedRefreshToken: "r",
      })
    );

    const conn = await findActiveGoogleConnection({
      orgId: ORG,
      businessId: BIZ_A,
    });
    expect(conn?._id).toBe("owner-conn");
    expect(findOneMock).toHaveBeenCalledWith({
      businessId: BIZ_A,
      connectionSource: "business_owner",
      status: "active",
      orgId: ORG,
    });
  });

  it("does not return another business's owner connection", async () => {
    findOneMock
      .mockReturnValueOnce(leanConn(null))
      .mockReturnValueOnce(
        leanConn({
          _id: "platform",
          connectionSource: "platform",
          businessId: null,
          encryptedAccessToken: "a",
          encryptedRefreshToken: "r",
        })
      );

    const conn = await findActiveGoogleConnection({
      orgId: ORG,
      businessId: BIZ_B,
    });
    expect(conn?._id).toBe("platform");
    expect(String(conn?.businessId || "")).not.toBe(BIZ_A);
  });
});

describe("getValidAccessTokenForContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    getOAuthEnvMock.mockReturnValue({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/auth/google/callback",
    });
    decryptMock.mockReturnValue("access-token");
  });

  it("rejects owner token when it belongs to a different business", async () => {
    findOneMock.mockReturnValue(
      leanConn({
        _id: "stolen",
        connectionSource: "business_owner",
        businessId: new mongoose.Types.ObjectId(BIZ_A),
        encryptedAccessToken: "enc-access",
        encryptedRefreshToken: "enc-refresh",
        accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000),
      })
    );

    await expect(
      getValidAccessTokenForContext(
        { orgId: ORG, businessId: BIZ_B },
        vi.fn()
      )
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
