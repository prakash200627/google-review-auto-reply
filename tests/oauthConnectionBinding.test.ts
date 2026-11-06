import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  connectMock,
  oauthFindOneAndUpdateMock,
  connectionFindOneAndUpdateMock,
  encryptMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  oauthFindOneAndUpdateMock: vi.fn(),
  connectionFindOneAndUpdateMock: vi.fn(),
  encryptMock: vi.fn((value: string) => `enc:${value}`),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/OAuthState", () => ({
  OAuthState: {
    findOneAndUpdate: oauthFindOneAndUpdateMock,
  },
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: {
    findOneAndUpdate: connectionFindOneAndUpdateMock,
  },
}));

vi.mock("@/lib/crypto/tokenEncryption", () => ({
  encryptToken: encryptMock,
}));

vi.mock("@/lib/google/oauthConfig", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/oauthConfig")>(
    "@/lib/google/oauthConfig"
  );
  return {
    ...actual,
    assertOAuthConfigured: () => undefined,
    getOAuthEnv: () => ({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "http://localhost:3000/api/auth/google/callback",
    }),
  };
});

import { completeAuthorization } from "@/lib/google/oauth";

const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();
const BIZ = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();

describe("completeAuthorization connection binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    connectionFindOneAndUpdateMock.mockResolvedValue({});
  });

  it("upserts platform GoogleConnection only for the OAuth-state orgId", async () => {
    oauthFindOneAndUpdateMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          orgId: ORG_A,
          codeVerifier: "verifier-value",
          returnPath: "/settings/google",
          connectionSource: "platform",
          businessId: null,
          initiatedByUserId: USER,
        }),
      }),
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
            scope:
              "openid email https://www.googleapis.com/auth/business.manage",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          sub: "google-sub-1",
          email: "admin@example.com",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeAuthorization({
      code: "auth-code",
      state: "abcdefghijklmnopqrstuv",
    });

    expect(result.orgId).toBe(ORG_A);
    expect(result.connectionSource).toBe("platform");
    expect(connectionFindOneAndUpdateMock).toHaveBeenCalledWith(
      { orgId: ORG_A, businessId: null },
      expect.objectContaining({
        $set: expect.objectContaining({
          orgId: ORG_A,
          connectionSource: "platform",
          businessId: null,
          googleUserSub: "google-sub-1",
          status: "active",
        }),
      }),
      expect.objectContaining({ upsert: true })
    );
    expect(connectionFindOneAndUpdateMock.mock.calls[0][0]).not.toEqual({
      orgId: ORG_B,
    });

    vi.unstubAllGlobals();
  });

  it("upserts business_owner connection for the OAuth-state businessId only", async () => {
    oauthFindOneAndUpdateMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          orgId: ORG_A,
          codeVerifier: "verifier-value",
          returnPath: "/dashboard",
          connectionSource: "business_owner",
          businessId: BIZ,
          initiatedByUserId: USER,
        }),
      }),
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
            scope:
              "openid email https://www.googleapis.com/auth/business.manage",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          sub: "google-sub-owner",
          email: "owner@example.com",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeAuthorization({
      code: "auth-code",
      state: "abcdefghijklmnopqrstuv",
    });

    expect(result.businessId).toBe(BIZ);
    expect(result.connectionSource).toBe("business_owner");
    expect(connectionFindOneAndUpdateMock).toHaveBeenCalledWith(
      { businessId: BIZ, connectionSource: "business_owner" },
      expect.objectContaining({
        $set: expect.objectContaining({
          businessId: BIZ,
          connectionSource: "business_owner",
          connectedByUserId: USER,
        }),
      }),
      expect.objectContaining({ upsert: true })
    );

    vi.unstubAllGlobals();
  });
});
