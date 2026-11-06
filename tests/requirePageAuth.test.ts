import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const { requireAuthMock, redirectMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireAuthUser: requireAuthMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

import {
  ACCESS_DENIED_PATH,
  requirePageSuperAdmin,
  requirePageUser,
} from "@/lib/auth/requirePageAuth";

const SA = {
  userId: "sa1",
  role: "superadmin" as const,
  email: "sa@example.com",
  businessIds: [] as string[],
};

const BA = {
  userId: "ba1",
  role: "business_owner" as const,
  email: "ba@example.com",
  businessIds: ["biz1"],
};

describe("requirePageAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requirePageUser sends signed-out visitors to login", async () => {
    requireAuthMock.mockResolvedValue({
      response: NextResponse.json({ success: false }, { status: 401 }),
    });
    await expect(requirePageUser()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("requirePageSuperAdmin sends signed-out visitors to login", async () => {
    requireAuthMock.mockResolvedValue({
      response: NextResponse.json({ success: false }, { status: 401 }),
    });
    await expect(requirePageSuperAdmin()).rejects.toThrow(
      "NEXT_REDIRECT:/login"
    );
  });

  it("requirePageSuperAdmin sends Business Admin to access-denied (not login)", async () => {
    requireAuthMock.mockResolvedValue({ user: BA });
    await expect(requirePageSuperAdmin()).rejects.toThrow(
      `NEXT_REDIRECT:${ACCESS_DENIED_PATH}`
    );
    expect(redirectMock).toHaveBeenCalledWith(ACCESS_DENIED_PATH);
  });

  it("requirePageSuperAdmin allows Super Admin through", async () => {
    requireAuthMock.mockResolvedValue({ user: SA });
    await expect(requirePageSuperAdmin()).resolves.toEqual(SA);
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
