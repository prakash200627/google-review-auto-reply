const mongoose = require("mongoose");
const request = require("supertest");
const jwt = require("jsonwebtoken");

jest.mock("axios");
const axios = require("axios");

jest.mock("openai", () => ({
    OpenAI: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: jest.fn() } },
    })),
}));

const OAuthState = require("../models/OAuthState");
const GoogleConnection = require("../models/GoogleConnection");
const {
    startAuthorization,
    consumeOAuthState,
    validateReturnPath,
    isOAuthConfigured,
} = require("../services/googleOAuth");
const { encrypt } = require("../services/tokenEncryption");
const app = require("../index");

function tokenFor(orgId) {
    return jwt.sign({ organizationId: orgId }, "testsecret", { expiresIn: "1h" });
}

describe("Google OAuth helpers", () => {
    test("validateReturnPath blocks open redirects", () => {
        expect(validateReturnPath("https://evil.example/phish")).toBe("/dashboard");
        expect(validateReturnPath("/settings/google")).toBe("/settings/google");
        expect(validateReturnPath("/pending")).toBe("/pending");
    });

    test("isOAuthConfigured requires encryption key and client credentials", () => {
        expect(isOAuthConfigured(process.env)).toBe(true);
        expect(
            isOAuthConfigured({
                GOOGLE_CLIENT_ID: "x",
                GOOGLE_CLIENT_SECRET: "y",
                GOOGLE_REDIRECT_URI: "http://localhost/cb",
            })
        ).toBe(false);
    });
});

describe("OAuth state lifecycle", () => {
    const orgId = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    test("startAuthorization stores state and returns Google auth URL with PKCE", async () => {
        jest.spyOn(OAuthState, "create").mockResolvedValue({});
        const started = await startAuthorization({ orgId, returnPath: "/settings/google" });
        expect(started.authUrl).toContain("accounts.google.com");
        expect(started.authUrl).toContain("code_challenge");
        expect(started.authUrl).toContain("business.manage");
        expect(OAuthState.create).toHaveBeenCalledWith(
            expect.objectContaining({
                orgId,
                returnPath: "/settings/google",
                state: expect.any(String),
                codeVerifier: expect.any(String),
            })
        );
    });

    test("consumeOAuthState rejects replayed state", async () => {
        jest.spyOn(OAuthState, "findOneAndUpdate").mockResolvedValue(null);
        jest.spyOn(OAuthState, "findOne").mockResolvedValue({
            state: "abc",
            usedAt: new Date(),
        });
        await expect(consumeOAuthState("abcdefghijklmnopqrstuvwxyz")).rejects.toMatchObject({
            code: "state_replay",
        });
    });

    test("consumeOAuthState rejects expired/missing state", async () => {
        jest.spyOn(OAuthState, "findOneAndUpdate").mockResolvedValue(null);
        jest.spyOn(OAuthState, "findOne").mockResolvedValue(null);
        await expect(consumeOAuthState("abcdefghijklmnopqrstuvwxyz")).rejects.toMatchObject({
            code: "invalid_state",
        });
    });
});

describe("Google OAuth HTTP routes", () => {
    const orgId = new mongoose.Types.ObjectId();

    beforeEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
    });

    test("POST /api/google/oauth/start requires auth", async () => {
        const res = await request(app).post("/api/google/oauth/start").send({});
        expect(res.status).toBe(401);
    });

    test("POST /api/google/oauth/start returns authUrl for authenticated org", async () => {
        jest.spyOn(OAuthState, "create").mockResolvedValue({});
        const res = await request(app)
            .post("/api/google/oauth/start")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`)
            .send({ returnPath: "/settings/google" });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.authUrl).toContain("accounts.google.com");
    });

    test("GET /api/google/status never exposes encrypted tokens", async () => {
        jest.spyOn(GoogleConnection, "findOne").mockResolvedValue({
            _id: new mongoose.Types.ObjectId(),
            googleAccountEmail: "owner@example.com",
            status: "active",
            connectedAt: new Date(),
            lastError: "",
            scopes: ["https://www.googleapis.com/auth/business.manage"],
            encryptedAccessToken: encrypt("secret-access"),
            encryptedRefreshToken: encrypt("secret-refresh"),
        });
        const Location = require("../models/Location");
        jest.spyOn(Location, "find").mockReturnValue({
            select: jest.fn().mockResolvedValue([]),
        });

        const res = await request(app)
            .get("/api/google/status")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`);

        expect(res.status).toBe(200);
        const body = JSON.stringify(res.body);
        expect(body).not.toContain("secret-access");
        expect(body).not.toContain("secret-refresh");
        expect(body).not.toContain("encryptedAccessToken");
        expect(res.body.connection.email).toBe("owner@example.com");
    });

    test("tenant isolation: disconnect only affects the caller's org", async () => {
        const Location = require("../models/Location");
        jest.spyOn(GoogleConnection, "find").mockReturnValue({
            select: jest.fn().mockResolvedValue([]),
        });
        const updateMany = jest.spyOn(Location, "updateMany").mockResolvedValue({ acknowledged: true });
        const deleteMany = jest.spyOn(GoogleConnection, "deleteMany").mockResolvedValue({ acknowledged: true });

        const res = await request(app)
            .post("/api/google/disconnect")
            .set("Authorization", `Bearer ${tokenFor(orgId)}`);

        expect(res.status).toBe(200);
        expect(res.body.localCredentialsDeleted).toBe(true);
        expect(updateMany).toHaveBeenCalledWith({ orgId: orgId.toString() }, expect.any(Object));
        expect(deleteMany).toHaveBeenCalledWith({ orgId: orgId.toString() });
    });
});
