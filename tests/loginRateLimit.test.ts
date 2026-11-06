import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clientIpFromRequest,
  LOGIN_RATE_LIMIT_MAX_EMAIL_IP,
  LOGIN_RATE_LIMIT_MAX_IP,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  normalizeLoginEmail,
  recordLoginFailure,
  resetLoginRateLimitForTests,
} from "@/lib/auth/loginRateLimit";

describe("loginRateLimit", () => {
  beforeEach(() => {
    resetLoginRateLimitForTests();
  });

  afterEach(() => {
    resetLoginRateLimitForTests();
  });

  it("normalizes emails and reads client IP from headers", () => {
    expect(normalizeLoginEmail(" Owner@Example.COM ")).toBe("owner@example.com");
    expect(
      clientIpFromRequest(
        new Request("http://localhost/login", {
          headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
        })
      )
    ).toBe("203.0.113.9");
    expect(
      clientIpFromRequest(
        new Request("http://localhost/login", {
          headers: { "x-real-ip": "198.51.100.2" },
        })
      )
    ).toBe("198.51.100.2");
  });

  it("allows attempts under the email+IP failure budget", () => {
    const base = Date.now();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_EMAIL_IP - 1; i++) {
      expect(
        checkLoginRateLimit({
          ip: "1.1.1.1",
          email: "a@example.com",
          now: base + i,
        }).allowed
      ).toBe(true);
      recordLoginFailure({
        ip: "1.1.1.1",
        email: "a@example.com",
        now: base + i,
      });
    }
    expect(
      checkLoginRateLimit({
        ip: "1.1.1.1",
        email: "a@example.com",
        now: base + 100,
      }).allowed
    ).toBe(true);
  });

  it("throttles after too many failures for the same email+IP", () => {
    const base = Date.now();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_EMAIL_IP; i++) {
      checkLoginRateLimit({
        ip: "1.1.1.1",
        email: "victim@example.com",
        now: base + i,
      });
      recordLoginFailure({
        ip: "1.1.1.1",
        email: "victim@example.com",
        now: base + i,
      });
    }
    const blocked = checkLoginRateLimit({
      ip: "1.1.1.1",
      email: "victim@example.com",
      now: base + 50,
    });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it("does not lock an email when failures come from a different IP", () => {
    const base = Date.now();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_EMAIL_IP; i++) {
      checkLoginRateLimit({
        ip: "9.9.9.9",
        email: "victim@example.com",
        now: base + i,
      });
      recordLoginFailure({
        ip: "9.9.9.9",
        email: "victim@example.com",
        now: base + i,
      });
    }
    const otherIp = checkLoginRateLimit({
      ip: "8.8.8.8",
      email: "victim@example.com",
      now: base + 100,
    });
    expect(otherIp.allowed).toBe(true);
  });

  it("throttles a single IP after many attempts across emails", () => {
    const base = Date.now();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_IP; i++) {
      const result = checkLoginRateLimit({
        ip: "5.5.5.5",
        email: `user${i}@example.com`,
        now: base + i,
      });
      expect(result.allowed).toBe(true);
    }
    const blocked = checkLoginRateLimit({
      ip: "5.5.5.5",
      email: "extra@example.com",
      now: base + LOGIN_RATE_LIMIT_MAX_IP,
    });
    expect(blocked.allowed).toBe(false);
  });

  it("recovers after the window elapses", () => {
    const base = Date.now();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_EMAIL_IP; i++) {
      checkLoginRateLimit({
        ip: "1.2.3.4",
        email: "a@example.com",
        now: base + i,
      });
      recordLoginFailure({
        ip: "1.2.3.4",
        email: "a@example.com",
        now: base + i,
      });
    }
    expect(
      checkLoginRateLimit({
        ip: "1.2.3.4",
        email: "a@example.com",
        now: base + 10,
      }).allowed
    ).toBe(false);

    const recovered = checkLoginRateLimit({
      ip: "1.2.3.4",
      email: "a@example.com",
      now: base + LOGIN_RATE_LIMIT_WINDOW_MS + 1,
    });
    expect(recovered.allowed).toBe(true);
  });

  it("clears email+IP failures after successful auth", () => {
    const base = Date.now();
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_EMAIL_IP; i++) {
      checkLoginRateLimit({
        ip: "7.7.7.7",
        email: "ok@example.com",
        now: base + i,
      });
      recordLoginFailure({
        ip: "7.7.7.7",
        email: "ok@example.com",
        now: base + i,
      });
    }
    expect(
      checkLoginRateLimit({
        ip: "7.7.7.7",
        email: "ok@example.com",
        now: base + 50,
      }).allowed
    ).toBe(false);

    clearLoginFailures({ ip: "7.7.7.7", email: "ok@example.com" });
    const afterClear = checkLoginRateLimit({
      ip: "7.7.7.7",
      email: "ok@example.com",
      now: base + 100,
    });
    expect(afterClear.allowed).toBe(true);
  });
});
