import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  connectMock,
  countMock,
  findOneMock,
  createMock,
  verifyMock,
  hashMock,
  applyCookieMock,
  checkLimitMock,
  recordFailureMock,
  clearFailuresMock,
  clientIpMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  countMock: vi.fn(),
  findOneMock: vi.fn(),
  createMock: vi.fn(),
  verifyMock: vi.fn(),
  hashMock: vi.fn(),
  applyCookieMock: vi.fn(),
  checkLimitMock: vi.fn(),
  recordFailureMock: vi.fn(),
  clearFailuresMock: vi.fn(),
  clientIpMock: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: connectMock,
}));

vi.mock("@/models/User", () => ({
  User: {
    countDocuments: countMock,
    findOne: findOneMock,
    create: createMock,
  },
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: verifyMock,
  hashPassword: hashMock,
}));

vi.mock("@/lib/auth/userSession", () => ({
  applyUserSessionCookie: applyCookieMock,
}));

vi.mock("@/lib/auth/loginRateLimit", () => ({
  checkLoginRateLimit: checkLimitMock,
  recordLoginFailure: recordFailureMock,
  clearLoginFailures: clearFailuresMock,
  clientIpFromRequest: clientIpMock,
}));

import { POST } from "@/app/api/auth/login/route";

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientIpMock.mockReturnValue("203.0.113.10");
    checkLimitMock.mockReturnValue({ allowed: true });
    connectMock.mockResolvedValue({});
    countMock.mockResolvedValue(1);
  });

  it("rejects malformed JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: "{",
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(res.status).toBe(400);
    expect(checkLimitMock).not.toHaveBeenCalled();
  });

  it("rejects missing credentials without rate-limit side effects", async () => {
    const res = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@example.com" }),
      })
    );
    expect(res.status).toBe(400);
    expect(checkLimitMock).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited before credential checks", async () => {
    checkLimitMock.mockReturnValue({ allowed: false, retryAfterSec: 42 });
    const res = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "a@example.com",
          password: "password123",
        }),
      })
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(findOneMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
    expect(body.message).not.toMatch(/account|registered|exists/i);
  });

  it("records failure with a generic 401 for bad passwords", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: "u1",
          email: "a@example.com",
          role: "business_owner",
          passwordHash: "hash",
        }),
      }),
    });
    verifyMock.mockReturnValue(false);

    const res = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "a@example.com",
          password: "wrong-password",
        }),
      })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe("Invalid email or password.");
    expect(recordFailureMock).toHaveBeenCalledWith({
      ip: "203.0.113.10",
      email: "a@example.com",
    });
    expect(clearFailuresMock).not.toHaveBeenCalled();
  });

  it("uses the same 401 message when the email is unknown", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => null,
      }),
    });

    const res = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "missing@example.com",
          password: "password123",
        }),
      })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe("Invalid email or password.");
    expect(recordFailureMock).toHaveBeenCalled();
  });

  it("clears failures and sets session on successful login", async () => {
    findOneMock.mockReturnValue({
      select: () => ({
        exec: async () => ({
          _id: "u1",
          email: "a@example.com",
          role: "superadmin",
          passwordHash: "hash",
        }),
      }),
    });
    verifyMock.mockReturnValue(true);

    const res = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "a@example.com",
          password: "correct-horse",
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user).toEqual({
      id: "u1",
      email: "a@example.com",
      role: "superadmin",
    });
    expect(clearFailuresMock).toHaveBeenCalledWith({
      ip: "203.0.113.10",
      email: "a@example.com",
    });
    expect(applyCookieMock).toHaveBeenCalled();
    expect(recordFailureMock).not.toHaveBeenCalled();
  });
});
