import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import mongoose from "mongoose";

const {
  cookieGetMock,
  cookieSetMock,
  connectMock,
  findByIdMock,
  createMock,
  connectionFindOneMock,
} = vi.hoisted(() => ({
  cookieGetMock: vi.fn(),
  cookieSetMock: vi.fn(),
  connectMock: vi.fn(),
  findByIdMock: vi.fn(),
  createMock: vi.fn(),
  connectionFindOneMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: cookieGetMock,
    set: cookieSetMock,
  }),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Organization", () => ({
  Organization: {
    findById: findByIdMock,
    create: createMock,
  },
}));

vi.mock("@/models/GoogleConnection", () => ({
  GoogleConnection: {
    findOne: connectionFindOneMock,
  },
}));

import {
  applyOrganizationCookie,
  encodeOrgSession,
  ensureOrganizationSession,
  orgSessionCookieOptions,
  readOrganizationId,
  resumeOrganizationSession,
} from "@/lib/org/session";
import { ORG_COOKIE_NAME } from "@/lib/google/oauthConfig";

const VALID_ORG_ID = new mongoose.Types.ObjectId().toString();

function signedCookie(orgId: string, exp = Date.now() + 60_000): string {
  return encodeOrgSession({ orgId, exp });
}

describe("org session helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    process.env.AUTH_SECRET = "test-auth-secret-value-32chars!!";
  });

  it("readOrganizationId returns null without writing cookies", async () => {
    cookieGetMock.mockReturnValue(undefined);

    await expect(readOrganizationId()).resolves.toBeNull();
    expect(cookieSetMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("readOrganizationId returns verified signed cookie org id", async () => {
    cookieGetMock.mockReturnValue({ value: signedCookie(VALID_ORG_ID) });
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: VALID_ORG_ID }),
      }),
    });

    await expect(readOrganizationId()).resolves.toBe(VALID_ORG_ID);
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("readOrganizationId rejects unsigned bare ObjectIds (tamper / legacy)", async () => {
    cookieGetMock.mockReturnValue({ value: VALID_ORG_ID });

    await expect(readOrganizationId()).resolves.toBeNull();
    expect(connectMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("readOrganizationId ignores invalid ObjectIds without writing", async () => {
    cookieGetMock.mockReturnValue({ value: "not-an-object-id" });

    await expect(readOrganizationId()).resolves.toBeNull();
    expect(connectMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("readOrganizationId rejects a signed cookie for a deleted organization", async () => {
    cookieGetMock.mockReturnValue({ value: signedCookie(VALID_ORG_ID) });
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => null,
      }),
    });
    await expect(readOrganizationId()).resolves.toBeNull();
  });

  it("ensureOrganizationSession reuses the signed cookie org", async () => {
    cookieGetMock.mockReturnValue({ value: signedCookie(VALID_ORG_ID) });
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: VALID_ORG_ID }),
      }),
    });

    await expect(ensureOrganizationSession()).resolves.toBe(VALID_ORG_ID);
    expect(createMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
    expect(connectionFindOneMock).not.toHaveBeenCalled();
  });

  it("resumeOrganizationSession never steals another org via active Google connections", async () => {
    cookieGetMock.mockReturnValue(undefined);

    await expect(resumeOrganizationSession()).resolves.toBeNull();
    expect(connectionFindOneMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("resumeOrganizationSession keeps the signed cookie org", async () => {
    cookieGetMock.mockReturnValue({ value: signedCookie(VALID_ORG_ID) });
    findByIdMock.mockReturnValue({
      select: () => ({
        lean: async () => ({ _id: VALID_ORG_ID }),
      }),
    });

    await expect(resumeOrganizationSession()).resolves.toBe(VALID_ORG_ID);
    expect(connectionFindOneMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("ensureOrganizationSession creates org and writes a signed cookie", async () => {
    cookieGetMock.mockReturnValue(undefined);
    const createdId = new mongoose.Types.ObjectId();
    createMock.mockResolvedValue({ _id: createdId });

    await expect(ensureOrganizationSession()).resolves.toBe(String(createdId));
    expect(createMock).toHaveBeenCalledOnce();
    expect(connectionFindOneMock).not.toHaveBeenCalled();
    expect(cookieSetMock).toHaveBeenCalledWith(
      ORG_COOKIE_NAME,
      expect.stringContaining("."),
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      })
    );
    const written = cookieSetMock.mock.calls[0][1] as string;
    expect(written).not.toBe(String(createdId));
  });

  it("applyOrganizationCookie sets a signed value with secure flags", () => {
    const response = NextResponse.redirect(
      "http://localhost:3000/settings/google"
    );
    applyOrganizationCookie(response, VALID_ORG_ID);

    const cookie = response.cookies.get(ORG_COOKIE_NAME);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.value).toContain(".");
    expect(cookie?.value).not.toBe(VALID_ORG_ID);
    expect(orgSessionCookieOptions()).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("applyOrganizationCookie rejects invalid org ids", () => {
    const response = NextResponse.redirect(
      "http://localhost:3000/settings/google"
    );
    expect(() => applyOrganizationCookie(response, "bad")).toThrow(
      /Invalid organization/
    );
    expect(response.cookies.get(ORG_COOKIE_NAME)).toBeUndefined();
  });
});
