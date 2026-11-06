import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const { completeAuthMock, classifyMock } = vi.hoisted(() => ({
  completeAuthMock: vi.fn(),
  classifyMock: vi.fn(),
}));

vi.mock("@/lib/google/oauth", () => ({
  completeAuthorization: completeAuthMock,
  classifyCallbackQuery: classifyMock,
}));

vi.mock("@/lib/google/oauthConfig", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google/oauthConfig")>(
    "@/lib/google/oauthConfig"
  );
  return {
    ...actual,
    appBaseUrl: () => "http://localhost:3000",
  };
});

import { GET } from "@/app/api/auth/google/callback/route";
import { decodeOrgSession } from "@/lib/org/session";
import { ORG_COOKIE_NAME } from "@/lib/google/oauthConfig";

const ORG = new mongoose.Types.ObjectId().toString();

describe("OAuth callback organization cookie binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = "test-auth-secret-value-32chars!!";
    classifyMock.mockReturnValue({ ok: true });
  });

  it("sets a signed org cookie only for the OAuth-state orgId", async () => {
    completeAuthMock.mockResolvedValue({
      orgId: ORG,
      returnPath: "/settings/google",
      email: "admin@example.com",
    });

    const res = await GET(
      new Request(
        "http://localhost:3000/api/auth/google/callback?code=abc&state=abcdefghijklmnopqrstuv"
      )
    );

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain(ORG_COOKIE_NAME);
    const match = setCookie.match(new RegExp(`${ORG_COOKIE_NAME}=([^;]+)`));
    expect(match?.[1]).toBeTruthy();
    const decoded = decodeOrgSession(decodeURIComponent(match![1]));
    expect(decoded?.orgId).toBe(ORG);
  });

  it("does not set an org cookie when authorization fails", async () => {
    completeAuthMock.mockRejectedValue(new Error("callback_failed"));
    const res = await GET(
      new Request(
        "http://localhost:3000/api/auth/google/callback?code=abc&state=abcdefghijklmnopqrstuv"
      )
    );
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).not.toContain(ORG_COOKIE_NAME);
  });
});
