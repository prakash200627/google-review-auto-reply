import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const { cookiesGetMock, connectMock, findByIdMock } = vi.hoisted(() => ({
  cookiesGetMock: vi.fn(),
  connectMock: vi.fn(),
  findByIdMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: cookiesGetMock,
    set: vi.fn(),
  }),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Organization", () => ({
  Organization: {
    findById: findByIdMock,
  },
}));

import {
  encodeOrgSession,
  readOrganizationId,
} from "@/lib/org/session";
import { ORG_COOKIE_NAME } from "@/lib/google/oauthConfig";

describe("stale organization cookies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = "test-auth-secret-32chars-minimum!";
    connectMock.mockResolvedValue({});
  });

  it("returns null when the signed cookie org no longer exists", async () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    cookiesGetMock.mockImplementation((name: string) => {
      if (name !== ORG_COOKIE_NAME) return undefined;
      return {
        value: encodeOrgSession({
          orgId,
          exp: Date.now() + 60_000,
        }),
      };
    });
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });

    await expect(readOrganizationId()).resolves.toBeNull();
  });

  it("does not authorize a different org via unsigned cookie forgery", async () => {
    const forged = new mongoose.Types.ObjectId().toString();
    cookiesGetMock.mockReturnValue({ value: forged });
    await expect(readOrganizationId()).resolves.toBeNull();
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});
