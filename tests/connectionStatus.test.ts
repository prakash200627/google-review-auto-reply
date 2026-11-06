import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  isOAuthConfiguredMock,
  connectMock,
  findOneMock,
} = vi.hoisted(() => ({
  isOAuthConfiguredMock: vi.fn(),
  connectMock: vi.fn(),
  findOneMock: vi.fn(),
}));

vi.mock("@/lib/google/oauthConfig", () => ({
  isOAuthConfigured: isOAuthConfiguredMock,
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: {
    findOne: findOneMock,
  },
}));

import {
  getSafeGoogleConnectionStatus,
  GOOGLE_STATUS_LOAD_ERROR_MESSAGE,
} from "@/lib/google/connectionStatus";

describe("getSafeGoogleConnectionStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports oauthConfigured false when env is incomplete", async () => {
    isOAuthConfiguredMock.mockReturnValue(false);

    const status = await getSafeGoogleConnectionStatus("org1");

    expect(status).toEqual({
      oauthConfigured: false,
      connection: null,
      statusError: null,
    });
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("does not invent a connection when none is stored", async () => {
    isOAuthConfiguredMock.mockReturnValue(true);
    connectMock.mockResolvedValue({});
    findOneMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });

    const status = await getSafeGoogleConnectionStatus("org1");

    expect(status.oauthConfigured).toBe(true);
    expect(status.connection).toBeNull();
    expect(status.statusError).toBeNull();
  });

  it("returns no connection when orgId is empty", async () => {
    isOAuthConfiguredMock.mockReturnValue(true);

    const status = await getSafeGoogleConnectionStatus("");

    expect(status).toEqual({
      oauthConfigured: true,
      connection: null,
      statusError: null,
    });
    expect(findOneMock).not.toHaveBeenCalled();
  });

  it("returns a stored platform connection without tokens", async () => {
    isOAuthConfiguredMock.mockReturnValue(true);
    connectMock.mockResolvedValue({});
    findOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          googleAccountEmail: "owner@example.com",
          status: "active",
          connectedAt: new Date("2024-01-01T00:00:00.000Z"),
          scopes: ["openid"],
          lastError: "",
          connectionSource: "platform",
          businessId: null,
          accessTokenEnc: "should-not-appear",
          refreshTokenEnc: "should-not-appear",
        }),
      }),
    });

    const status = await getSafeGoogleConnectionStatus("org1");

    expect(status).toEqual({
      oauthConfigured: true,
      connection: {
        email: "owner@example.com",
        status: "active",
        connectedAt: "2024-01-01T00:00:00.000Z",
        scopes: ["openid"],
        lastError: "",
        connectionSource: "platform",
        businessId: null,
      },
      statusError: null,
    });
    expect(JSON.stringify(status)).not.toMatch(/TokenEnc|accessToken|refreshToken/i);
    expect(findOneMock).toHaveBeenCalledWith({
      orgId: "org1",
      status: { $in: ["active", "error"] },
      businessId: null,
    });
  });

  it("prefers business_owner connection when businessId is provided", async () => {
    const BIZ = new mongoose.Types.ObjectId().toString();
    isOAuthConfiguredMock.mockReturnValue(true);
    connectMock.mockResolvedValue({});
    findOneMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          googleAccountEmail: "biz@example.com",
          status: "active",
          connectedAt: new Date("2024-02-01T00:00:00.000Z"),
          scopes: ["openid"],
          lastError: "",
          connectionSource: "business_owner",
          businessId: new mongoose.Types.ObjectId(BIZ),
        }),
      }),
    });

    const status = await getSafeGoogleConnectionStatus("org1", {
      businessId: BIZ,
    });

    expect(status.connection?.connectionSource).toBe("business_owner");
    expect(status.connection?.businessId).toBe(BIZ);
    expect(findOneMock).toHaveBeenCalledWith({
      orgId: "org1",
      businessId: BIZ,
      connectionSource: "business_owner",
      status: { $in: ["active", "error"] },
    });
  });

  it("keeps oauthConfigured true when database loading fails", async () => {
    isOAuthConfiguredMock.mockReturnValue(true);
    connectMock.mockRejectedValue(new Error("db down"));

    const status = await getSafeGoogleConnectionStatus("org1");

    expect(status.oauthConfigured).toBe(true);
    expect(status.connection).toBeNull();
    expect(status.statusError).toBe(GOOGLE_STATUS_LOAD_ERROR_MESSAGE);
    expect(status.statusError).not.toMatch(/db down/i);
    expect(status.statusError).not.toMatch(/mongodb/i);
  });
});
