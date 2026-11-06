import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const { findOneAndUpdateMock, connectMock } = vi.hoisted(() => ({
  findOneAndUpdateMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/OAuthState", () => ({
  OAuthState: {
    findOneAndUpdate: findOneAndUpdateMock,
  },
}));

import { consumeOAuthState } from "@/lib/google/oauth";
import { GoogleOAuthError } from "@/lib/google/oauthConfig";
import { createOAuthState } from "@/lib/google/pkce";

const ORG = new mongoose.Types.ObjectId().toString();

describe("consumeOAuthState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("rejects implausible state values", async () => {
    await expect(consumeOAuthState("short")).rejects.toBeInstanceOf(
      GoogleOAuthError
    );
    expect(findOneAndUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects missing, used, or expired state (single-use gate)", async () => {
    const state = createOAuthState();
    findOneAndUpdateMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });

    await expect(consumeOAuthState(state)).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(findOneAndUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state,
        usedAt: null,
        expiresAt: expect.any(Object),
      }),
      { $set: { usedAt: expect.any(Date) } },
      expect.any(Object)
    );
  });

  it("returns org and ownership binding once for a valid unused state", async () => {
    const state = createOAuthState();
    const userId = new mongoose.Types.ObjectId().toString();
    findOneAndUpdateMock.mockReturnValue({
      select: () => ({
        lean: async () => ({
          orgId: ORG,
          codeVerifier: "verifier-value",
          returnPath: "/settings/google",
          connectionSource: "platform",
          businessId: null,
          initiatedByUserId: userId,
        }),
      }),
    });

    const consumed = await consumeOAuthState(state);
    expect(consumed).toEqual({
      orgId: ORG,
      codeVerifier: "verifier-value",
      returnPath: "/settings/google",
      connectionSource: "platform",
      businessId: null,
      initiatedByUserId: userId,
    });
  });
});
