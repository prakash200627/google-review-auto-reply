import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  connectMock,
  findOneMock,
  updateOneMock,
  decryptMock,
  requireSuperAdminMock,
  requireOrgMock,
  assertOriginMock,
  auditLogMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  findOneMock: vi.fn(),
  updateOneMock: vi.fn(),
  decryptMock: vi.fn(),
  requireSuperAdminMock: vi.fn(),
  requireOrgMock: vi.fn(),
  assertOriginMock: vi.fn(),
  auditLogMock: vi.fn(),
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
}));

vi.mock("@/lib/google/oauthConfig", () => ({
  getOAuthEnv: () => ({
    clientId: "cid",
    clientSecret: "csec",
    redirectUri: "http://localhost/callback",
  }),
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireSuperAdmin: requireSuperAdminMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/org/requireOrg", () => ({
  requireOrganizationId: requireOrgMock,
  isOrgResult: (value: { orgId: string } | { response: NextResponse }) =>
    "orgId" in value,
}));

vi.mock("@/lib/auth/requestOrigin", () => ({
  assertMutationOrigin: assertOriginMock,
}));

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditLogMock,
}));

import {
  disconnectPlatformGoogleConnection,
  GoogleDisconnectError,
  GOOGLE_REVOKE_URL,
} from "@/lib/google/disconnect";
import { POST as disconnectRoute } from "@/app/api/admin/google/disconnect/route";

const ORG = new mongoose.Types.ObjectId();
const CONN = new mongoose.Types.ObjectId();

describe("disconnectPlatformGoogleConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    updateOneMock.mockResolvedValue({ acknowledged: true });
    decryptMock.mockImplementation((cipher: string) => {
      if (cipher === "enc-refresh") return "refresh-token-value";
      if (cipher === "enc-access") return "access-token-value";
      throw new Error("bad cipher");
    });
  });

  it("requires confirm=true", async () => {
    await expect(
      disconnectPlatformGoogleConnection({
        orgId: String(ORG),
        confirm: false,
      })
    ).rejects.toMatchObject({ code: "confirmation_required" });
  });

  it("revokes at Google then clears local tokens without exposing them", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: CONN,
          status: "active",
          encryptedAccessToken: "enc-access",
          encryptedRefreshToken: "enc-refresh",
        }),
      }),
    });

    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await disconnectPlatformGoogleConnection({
      orgId: String(ORG),
      confirm: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("revoked");
    expect(result.googleRevoked).toBe(true);
    expect(result.localTokensCleared).toBe(true);
    expect(result.locationsPreserved).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/refresh-token-value|access-token-value|enc-/);

    expect(fetchImpl).toHaveBeenCalledWith(
      GOOGLE_REVOKE_URL,
      expect.objectContaining({ method: "POST" })
    );
    const body = (fetchImpl.mock.calls[0][1] as { body: URLSearchParams }).body;
    expect(body.get("token")).toBe("refresh-token-value");

    expect(updateOneMock).toHaveBeenCalledWith(
      { _id: CONN },
      {
        $set: expect.objectContaining({
          encryptedAccessToken: "",
          encryptedRefreshToken: "",
          status: "revoked",
        }),
      },
      { runValidators: false }
    );
  });

  it("clears local tokens and reports accurate status when Google revoke fails", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: CONN,
          status: "active",
          encryptedAccessToken: "enc-access",
          encryptedRefreshToken: "enc-refresh",
        }),
      }),
    });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await disconnectPlatformGoogleConnection({
      orgId: String(ORG),
      confirm: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.googleRevoked).toBe(false);
    expect(result.googleRevokeAttempted).toBe(true);
    expect(result.googleRevokeError).toMatch(/google_revoke_http_500/);
    expect(result.localTokensCleared).toBe(true);
    expect(result.status).toBe("revoked");
    expect(result.message).toMatch(/Local tokens are not usable|local credentials cleared/i);
    expect(JSON.stringify(result)).not.toMatch(/refresh-token-value|access-token-value/);
  });
});

describe("POST /api/admin/google/disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertOriginMock.mockReturnValue({ ok: true });
    requireOrgMock.mockResolvedValue({ orgId: String(ORG) });
    connectMock.mockResolvedValue({});
    updateOneMock.mockResolvedValue({});
    decryptMock.mockReturnValue("refresh-token-value");
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: CONN,
          status: "active",
          encryptedAccessToken: "enc-access",
          encryptedRefreshToken: "enc-refresh",
        }),
      }),
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }) as unknown as typeof fetch;
  });

  it("allows Super Admin", async () => {
    requireSuperAdminMock.mockResolvedValue({
      user: { userId: "sa", role: "superadmin", email: "a@b.c", businessIds: [] },
    });
    const res = await disconnectRoute(
      new Request("http://localhost/api/admin/google/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.status).toBe("revoked");
    expect(JSON.stringify(data)).not.toMatch(/refresh-token-value|enc-/);
  });

  it("denies Business Admin", async () => {
    requireSuperAdminMock.mockResolvedValue({
      response: NextResponse.json(
        {
          success: false,
          code: "forbidden",
          message: "Super Admin access required.",
        },
        { status: 403 }
      ),
    });
    const res = await disconnectRoute(
      new Request("http://localhost/api/admin/google/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      })
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe("forbidden");
    expect(updateOneMock).not.toHaveBeenCalled();
  });
});

describe("GoogleDisconnectError", () => {
  it("is thrown for missing connection", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => null,
      }),
    });
    await expect(
      disconnectPlatformGoogleConnection({
        orgId: String(ORG),
        confirm: true,
      })
    ).rejects.toBeInstanceOf(GoogleDisconnectError);
  });
});
