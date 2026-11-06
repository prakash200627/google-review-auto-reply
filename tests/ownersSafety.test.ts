import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const {
  findOneMock,
  createMock,
  updateOneMock,
  findByIdMock,
  businessUpdateOneMock,
  businessFindByIdMock,
  hashMock,
} = vi.hoisted(() => ({
  findOneMock: vi.fn(),
  createMock: vi.fn(),
  updateOneMock: vi.fn(),
  findByIdMock: vi.fn(),
  businessUpdateOneMock: vi.fn(),
  businessFindByIdMock: vi.fn(),
  hashMock: vi.fn((p: string) => `hashed:${p}`),
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: hashMock,
}));

vi.mock("@/models/User", () => ({
  User: {
    findOne: findOneMock,
    create: createMock,
    updateOne: updateOneMock,
    findById: findByIdMock,
  },
}));

vi.mock("@/models/Business", () => ({
  Business: {
    updateOne: businessUpdateOneMock,
    findById: businessFindByIdMock,
  },
}));

import {
  OwnerAccountError,
  resetOwnerPassword,
  upsertBusinessOwner,
} from "@/lib/business/owners";

const BIZ = new mongoose.Types.ObjectId().toString();
const USER = new mongoose.Types.ObjectId();

describe("upsertBusinessOwner safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    businessUpdateOneMock.mockResolvedValue({});
    updateOneMock.mockResolvedValue({});
  });

  it("creates a new owner with a hashed password", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => null,
      }),
    });
    createMock.mockResolvedValue({ _id: USER });

    const result = await upsertBusinessOwner({
      email: "new@example.com",
      password: "password123",
      businessId: BIZ,
      requirePassword: true,
    });

    expect(result).toEqual({
      userId: USER,
      created: true,
      linkedExisting: false,
      passwordSet: true,
    });
    expect(hashMock).toHaveBeenCalledWith("password123");
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "new@example.com",
        passwordHash: "hashed:password123",
        role: "business_owner",
        active: true,
      })
    );
  });

  it("links an existing active owner without changing their password", async () => {
    const existing = {
      _id: USER,
      role: "business_owner",
      active: true,
      name: "Existing",
      save: vi.fn(),
    };
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => existing,
      }),
    });

    const result = await upsertBusinessOwner({
      email: "existing@example.com",
      password: "attacker-overwrite",
      businessId: BIZ,
      requirePassword: true,
    });

    expect(result).toEqual({
      userId: USER,
      created: false,
      linkedExisting: true,
      passwordSet: false,
    });
    expect(hashMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(existing.save).not.toHaveBeenCalled();
    expect(updateOneMock).toHaveBeenCalled();
  });

  it("refuses to silently reactivate an inactive owner", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: USER,
          role: "business_owner",
          active: false,
          name: "",
          save: vi.fn(),
        }),
      }),
    });

    await expect(
      upsertBusinessOwner({
        email: "inactive@example.com",
        password: "password123",
        businessId: BIZ,
        requirePassword: true,
      })
    ).rejects.toMatchObject({
      code: "owner_inactive",
      status: 409,
    });
    expect(hashMock).not.toHaveBeenCalled();
  });

  it("reactivates an inactive owner only when explicitly requested (no password change)", async () => {
    const save = vi.fn();
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: USER,
          role: "business_owner",
          active: false,
          name: "Inactive",
          save,
        }),
      }),
    });

    const result = await upsertBusinessOwner({
      email: "inactive@example.com",
      password: "ignored-password",
      businessId: BIZ,
      requirePassword: true,
      reactivateExisting: true,
    });

    expect(result.linkedExisting).toBe(true);
    expect(result.passwordSet).toBe(false);
    expect(save).toHaveBeenCalled();
    expect(hashMock).not.toHaveBeenCalled();
  });

  it("rejects assigning a Super Admin as an owner", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: USER,
          role: "superadmin",
          active: true,
        }),
      }),
    });

    await expect(
      upsertBusinessOwner({
        email: "admin@example.com",
        password: "password123",
        businessId: BIZ,
        requirePassword: true,
      })
    ).rejects.toBeInstanceOf(OwnerAccountError);
  });

  it("rejects duplicate create attempts for invalid business ids", async () => {
    await expect(
      upsertBusinessOwner({
        email: "a@example.com",
        password: "password123",
        businessId: "not-an-id",
        requirePassword: true,
      })
    ).rejects.toMatchObject({ code: "invalid_id" });
  });
});

describe("resetOwnerPassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates password for business owners only", async () => {
    const save = vi.fn();
    findByIdMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: USER,
          role: "business_owner",
          passwordHash: "old",
          save,
        }),
      }),
    });

    await resetOwnerPassword({
      userId: String(USER),
      newPassword: "new-password-9",
    });

    expect(hashMock).toHaveBeenCalledWith("new-password-9");
    expect(save).toHaveBeenCalled();
  });

  it("refuses password reset for Super Admins via owner API", async () => {
    findByIdMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: USER,
          role: "superadmin",
          passwordHash: "old",
          save: vi.fn(),
        }),
      }),
    });

    await expect(
      resetOwnerPassword({
        userId: String(USER),
        newPassword: "new-password-9",
      })
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
});
