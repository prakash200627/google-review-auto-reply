import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { NextResponse } from "next/server";

const {
  requireAuthMock,
  assertBusinessAccessMock,
  connectMock,
  findByIdMock,
  auditMock,
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  assertBusinessAccessMock: vi.fn(),
  connectMock: vi.fn(),
  findByIdMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock("@/lib/auth/authorize", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/authorize")>(
    "@/lib/auth/authorize"
  );
  return {
    ...actual,
    requireAuthUser: requireAuthMock,
    assertBusinessAccess: assertBusinessAccessMock,
    isAuthUser: (value: { user: unknown } | { response: NextResponse }) =>
      "user" in value,
  };
});

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/Business", async () => {
  const actual = await vi.importActual<typeof import("@/models/Business")>(
    "@/models/Business"
  );
  return {
    ...actual,
    Business: {
      findById: findByIdMock,
    },
  };
});

vi.mock("@/lib/audit/log", () => ({
  auditLog: auditMock,
}));

vi.mock("@/lib/auth/requestOrigin", () => ({
  assertMutationOrigin: () => ({ ok: true as const }),
}));

import { PATCH, GET } from "@/app/api/business/[businessId]/settings/route";

const BIZ = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId().toString();

describe("reply mode settings permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
  });

  it("GET reports canEditReplyMode false for owners by default", async () => {
    requireAuthMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "business_owner",
        email: "o@example.com",
        businessIds: [BIZ],
      },
    });
    assertBusinessAccessMock.mockResolvedValue({
      ok: true,
      business: {
        _id: new mongoose.Types.ObjectId(BIZ),
        name: "Cafe",
        active: true,
        replyMode: "manual",
        ownersMayChangeReplyMode: false,
        autoDraftOnSync: false,
        autoPublish: { enabled: false },
      },
    });

    const res = await GET(new Request("http://localhost/settings"), {
      params: Promise.resolve({ businessId: BIZ }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.business.canEditReplyMode).toBe(false);
    expect(body.business.autoPublishEnabled).toBe(false);
  });

  it("allows owner to change replyMode when SA enabled permission", async () => {
    requireAuthMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "business_owner",
        email: "o@example.com",
        businessIds: [BIZ],
      },
    });
    assertBusinessAccessMock.mockResolvedValue({
      ok: true,
      business: {
        _id: new mongoose.Types.ObjectId(BIZ),
        name: "Cafe",
        active: true,
        status: "active",
        replyMode: "manual",
        ownersMayChangeReplyMode: true,
        autoDraftOnSync: false,
        autoPublish: { enabled: false },
      },
    });

    const save = vi.fn();
    findByIdMock.mockReturnValue({
      exec: async () => ({
        _id: new mongoose.Types.ObjectId(BIZ),
        name: "Cafe",
        active: true,
        status: "active",
        replyMode: "manual",
        ownersMayChangeReplyMode: true,
        autoDraftOnSync: false,
        autoPublish: { enabled: false },
        brandVoice: "friendly",
        preferredLanguage: "English",
        replyToneNotes: "",
        profile: { phone: "" },
        save,
      }),
    });

    const res = await PATCH(
      new Request("http://localhost/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ replyMode: "auto" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.business.replyMode).toBe("auto");
    expect(save).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "business.reply_mode_change" })
    );
  });

  it("blocks owner replyMode change when permission is false", async () => {
    requireAuthMock.mockResolvedValue({
      user: {
        userId: USER,
        role: "business_owner",
        email: "o@example.com",
        businessIds: [BIZ],
      },
    });
    assertBusinessAccessMock.mockResolvedValue({
      ok: true,
      business: {
        _id: new mongoose.Types.ObjectId(BIZ),
        active: true,
        replyMode: "manual",
        ownersMayChangeReplyMode: false,
      },
    });

    const res = await PATCH(
      new Request("http://localhost/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ replyMode: "auto" }),
      }),
      { params: Promise.resolve({ businessId: BIZ }) }
    );
    expect(res.status).toBe(403);
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});
