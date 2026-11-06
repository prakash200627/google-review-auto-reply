/**
 * BA cannot open SA-only GMB create-location page (redirect, not API).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const { requireAuthMock, redirectMock, readOrgMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  readOrgMock: vi.fn().mockResolvedValue(null),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("next/link", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/lib/auth/authorize", () => ({
  requireAuthUser: requireAuthMock,
  isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
    "user" in value,
}));

vi.mock("@/lib/org/session", () => ({
  readOrganizationId: readOrgMock,
}));

vi.mock("@/components/CreateGbpLocationForm", () => ({
  CreateGbpLocationForm: () => null,
}));

import CreateGbpLocationPage from "@/app/gmb/locations/create/page";

describe("Create GBP location page auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects Business Admin to /gmb/locations", async () => {
    requireAuthMock.mockResolvedValue({
      user: {
        userId: "ba1",
        role: "business_owner",
        email: "ba@example.com",
        businessIds: ["biz1"],
      },
    });
    await expect(CreateGbpLocationPage()).rejects.toThrow(
      "NEXT_REDIRECT:/gmb/locations"
    );
  });

  it("redirects signed-out visitors to /login", async () => {
    requireAuthMock.mockResolvedValue({
      response: NextResponse.json({ success: false }, { status: 401 }),
    });
    await expect(CreateGbpLocationPage()).rejects.toThrow(
      "NEXT_REDIRECT:/login"
    );
  });
});
