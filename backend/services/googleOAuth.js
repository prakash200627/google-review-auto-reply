const crypto = require("crypto");
const axios = require("axios");

const OAuthState = require("../models/OAuthState");
const GoogleConnection = require("../models/GoogleConnection");
const { encrypt, decrypt, isEncryptionConfigured, TokenEncryptionError } = require("./tokenEncryption");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const BUSINESS_MANAGE_SCOPE = "https://www.googleapis.com/auth/business.manage";
const OPENID_SCOPES = ["openid", "email", "profile"];
const STATE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;

const SAFE_RETURN_PATHS = new Set([
    "/dashboard",
    "/summary",
    "/analysis",
    "/pending",
    "/reviews",
    "/settings/google",
]);

class GoogleOAuthError extends Error {
    constructor(message, { code = "oauth_error", status = 400 } = {}) {
        super(message);
        this.name = "GoogleOAuthError";
        this.code = code;
        this.status = status;
    }
}

function getOAuthConfig(env = process.env) {
    const clientId = (env.GOOGLE_CLIENT_ID || "").trim();
    const clientSecret = (env.GOOGLE_CLIENT_SECRET || "").trim();
    const redirectUri = (env.GOOGLE_REDIRECT_URI || "").trim();
    return { clientId, clientSecret, redirectUri };
}

function isOAuthConfigured(env = process.env) {
    const { clientId, clientSecret, redirectUri } = getOAuthConfig(env);
    return Boolean(clientId && clientSecret && redirectUri && isEncryptionConfigured(env));
}

function assertOAuthConfigured(env = process.env) {
    if (!isOAuthConfigured(env)) {
        throw new GoogleOAuthError(
            "Google OAuth is not configured (client credentials, redirect URI, or encryption key missing)",
            { code: "not_configured", status: 503 }
        );
    }
}

function validateReturnPath(returnPath) {
    const path = typeof returnPath === "string" ? returnPath.trim() : "/dashboard";
    if (!SAFE_RETURN_PATHS.has(path)) {
        return "/dashboard";
    }
    return path;
}

function base64Url(buffer) {
    return buffer.toString("base64url");
}

function createPkcePair() {
    const codeVerifier = base64Url(crypto.randomBytes(32));
    const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
    return { codeVerifier, codeChallenge };
}

async function startAuthorization({ orgId, returnPath }, env = process.env) {
    assertOAuthConfigured(env);
    const { clientId, redirectUri } = getOAuthConfig(env);
    const state = base64Url(crypto.randomBytes(32));
    const { codeVerifier, codeChallenge } = createPkcePair();
    const safeReturn = validateReturnPath(returnPath);
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    await OAuthState.create({
        state,
        codeVerifier,
        orgId,
        returnPath: safeReturn,
        expiresAt,
    });

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: [...OPENID_SCOPES, BUSINESS_MANAGE_SCOPE].join(" "),
        state,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
    });

    return {
        authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
        state,
        returnPath: safeReturn,
        expiresAt,
    };
}

async function consumeOAuthState(state) {
    if (typeof state !== "string" || state.length < 16) {
        throw new GoogleOAuthError("Invalid OAuth state", { code: "invalid_state", status: 400 });
    }

    const record = await OAuthState.findOneAndUpdate(
        {
            state,
            usedAt: null,
            expiresAt: { $gt: new Date() },
        },
        { $set: { usedAt: new Date() } },
        {
            returnDocument: "after",
            // codeVerifier is select:false; include it explicitly for the PKCE exchange.
            projection: {
                state: 1,
                orgId: 1,
                returnPath: 1,
                codeVerifier: 1,
                usedAt: 1,
                expiresAt: 1,
            },
        }
    );

    if (!record) {
        const existing = await OAuthState.findOne({ state });
        if (existing && existing.usedAt) {
            throw new GoogleOAuthError("OAuth state has already been used", { code: "state_replay", status: 400 });
        }
        throw new GoogleOAuthError("OAuth state is invalid or expired", { code: "invalid_state", status: 400 });
    }

    return record;
}

async function exchangeCodeForTokens(code, codeVerifier, env = process.env) {
    assertOAuthConfigured(env);
    const { clientId, clientSecret, redirectUri } = getOAuthConfig(env);

    try {
        const { data } = await axios.post(
            GOOGLE_TOKEN_URL,
            new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: "authorization_code",
                code_verifier: codeVerifier,
            }).toString(),
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                timeout: 15000,
            }
        );
        return data;
    } catch (err) {
        const detail = err.response && err.response.data && err.response.data.error;
        throw new GoogleOAuthError(
            detail === "invalid_grant"
                ? "Authorization code is invalid or expired"
                : "Failed to exchange authorization code",
            { code: detail || "token_exchange_failed", status: 400 }
        );
    }
}

async function fetchUserInfo(accessToken) {
    const { data } = await axios.get(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
    });
    return data;
}

async function storeConnectionTokens({ orgId, tokenResponse, userInfo }) {
    if (!tokenResponse.refresh_token) {
        // Google only returns refresh_token on first consent; require it for offline sync.
        const existing = await GoogleConnection.findOne({ orgId, status: "active" })
            .select("+encryptedRefreshToken");
        if (!existing) {
            throw new GoogleOAuthError(
                "Google did not return a refresh token. Disconnect any prior grant in Google Account permissions and try again.",
                { code: "missing_refresh_token", status: 400 }
            );
        }
    }

    const encryptedAccessToken = encrypt(tokenResponse.access_token);
    const encryptedRefreshToken = tokenResponse.refresh_token
        ? encrypt(tokenResponse.refresh_token)
        : undefined;

    const expiresInSec = Number(tokenResponse.expires_in) || 3600;
    const accessTokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);
    const scopes = String(tokenResponse.scope || BUSINESS_MANAGE_SCOPE).split(/\s+/).filter(Boolean);

    // googleUserSub is the OIDC subject. googleAccountId is a legacy alias of the
    // same value — it is NOT a Business Profile accounts/{id} (see Location.googleAccountId).
    const userSub = (userInfo && userInfo.sub) || "";
    const update = {
        googleAccountEmail: (userInfo && userInfo.email) || "",
        googleUserSub: userSub,
        googleAccountId: userSub,
        encryptedAccessToken,
        accessTokenExpiresAt,
        scopes,
        status: "active",
        lastError: "",
        connectedAt: new Date(),
    };
    if (encryptedRefreshToken) {
        update.encryptedRefreshToken = encryptedRefreshToken;
    }

    const connection = await GoogleConnection.findOneAndUpdate(
        { orgId },
        { $set: update },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );

    return connection;
}

async function completeAuthorization({ code, state }, env = process.env) {
    if (typeof code !== "string" || !code) {
        throw new GoogleOAuthError("Missing authorization code", { code: "missing_code", status: 400 });
    }

    const stateRecord = await consumeOAuthState(state);
    const tokenResponse = await exchangeCodeForTokens(code, stateRecord.codeVerifier, env);

    if (!String(tokenResponse.scope || "").includes("business.manage")) {
        throw new GoogleOAuthError(
            "Granted scopes do not include Google Business Profile access",
            { code: "insufficient_scope", status: 400 }
        );
    }

    let userInfo = {};
    try {
        userInfo = await fetchUserInfo(tokenResponse.access_token);
    } catch {
        // Email is optional metadata; connection can proceed without it.
        userInfo = {};
    }

    const connection = await storeConnectionTokens({
        orgId: stateRecord.orgId,
        tokenResponse,
        userInfo,
    });

    return {
        connection,
        orgId: stateRecord.orgId,
        returnPath: stateRecord.returnPath,
    };
}

async function refreshAccessToken(connection, env = process.env) {
    assertOAuthConfigured(env);
    const { clientId, clientSecret } = getOAuthConfig(env);

    let refreshToken;
    try {
        refreshToken = decrypt(connection.encryptedRefreshToken, env);
    } catch (err) {
        if (err instanceof TokenEncryptionError) throw err;
        throw new GoogleOAuthError("Stored refresh token could not be decrypted", { code: "decrypt_failed", status: 500 });
    }

    try {
        const { data } = await axios.post(
            GOOGLE_TOKEN_URL,
            new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: "refresh_token",
            }).toString(),
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                timeout: 15000,
            }
        );

        const encryptedAccessToken = encrypt(data.access_token, env);
        const expiresInSec = Number(data.expires_in) || 3600;
        const accessTokenExpiresAt = new Date(Date.now() + expiresInSec * 1000);

        const update = {
            encryptedAccessToken,
            accessTokenExpiresAt,
            status: "active",
            lastError: "",
        };
        if (data.refresh_token) {
            update.encryptedRefreshToken = encrypt(data.refresh_token, env);
        }

        await GoogleConnection.updateOne({ _id: connection._id }, { $set: update });
        connection.encryptedAccessToken = encryptedAccessToken;
        connection.accessTokenExpiresAt = accessTokenExpiresAt;
        if (update.encryptedRefreshToken) {
            connection.encryptedRefreshToken = update.encryptedRefreshToken;
        }
        return decrypt(encryptedAccessToken, env);
    } catch (err) {
        const googleError = err.response && err.response.data && err.response.data.error;
        const revoked = googleError === "invalid_grant";
        await GoogleConnection.updateOne(
            { _id: connection._id },
            {
                $set: {
                    status: revoked ? "revoked" : "error",
                    lastError: revoked
                        ? "Google refresh token was revoked or expired"
                        : "Failed to refresh Google access token",
                },
            }
        );
        throw new GoogleOAuthError(
            revoked
                ? "Google access was revoked. Reconnect the Google account."
                : "Failed to refresh Google access token",
            { code: revoked ? "revoked" : "refresh_failed", status: revoked ? 401 : 502 }
        );
    }
}

async function getValidAccessToken(connection, env = process.env) {
    if (!connection || connection.status === "revoked") {
        throw new GoogleOAuthError("Google connection is not active", { code: "revoked", status: 401 });
    }

    const expiresAt = connection.accessTokenExpiresAt
        ? new Date(connection.accessTokenExpiresAt).getTime()
        : 0;
    const stillValid = expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now();

    if (stillValid && connection.encryptedAccessToken) {
        return decrypt(connection.encryptedAccessToken, env);
    }
    return refreshAccessToken(connection, env);
}

async function loadActiveConnectionForOrg(orgId) {
    return GoogleConnection.findOne({ orgId, status: { $in: ["active", "error"] } })
        .select("+encryptedAccessToken +encryptedRefreshToken");
}

async function revokeGoogleToken(token, env = process.env) {
    if (!token) return { revoked: false, reason: "missing_token" };
    try {
        await axios.post(
            "https://oauth2.googleapis.com/revoke",
            new URLSearchParams({ token }).toString(),
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                timeout: 10000,
                validateStatus: (s) => s === 200 || s === 400,
            }
        );
        // 200 = revoked; 400 invalid_token often means already expired/revoked.
        return { revoked: true };
    } catch (err) {
        return { revoked: false, reason: "revoke_request_failed" };
    }
}

/**
 * Disconnect an organization's Google link.
 * Best-effort: calls Google's revoke endpoint with the refresh token, then
 * always deletes local credentials. Local deletion alone does not guarantee
 * Google-side revocation if the revoke call fails.
 */
async function disconnectOrganization(orgId) {
    const Location = require("../models/Location");
    const connections = await GoogleConnection.find({ orgId })
        .select("+encryptedRefreshToken +encryptedAccessToken");

    let googleRevokeAttempted = false;
    let googleRevokeSucceeded = false;

    for (const connection of connections) {
        let refreshToken = "";
        try {
            refreshToken = decrypt(connection.encryptedRefreshToken);
        } catch {
            refreshToken = "";
        }
        if (refreshToken) {
            googleRevokeAttempted = true;
            const result = await revokeGoogleToken(refreshToken);
            if (result.revoked) googleRevokeSucceeded = true;
        }
    }

    await Location.updateMany(
        { orgId },
        {
            $set: {
                connectionId: null,
                syncEnabled: false,
                lastSyncError: "Google connection disconnected",
                syncCheckpointPageToken: "",
                syncFenceToken: "",
            },
        }
    );
    await GoogleConnection.deleteMany({ orgId });

    return {
        localCredentialsDeleted: true,
        googleRevokeAttempted,
        googleRevokeSucceeded,
        // Callers must not assume Google access is gone unless googleRevokeSucceeded.
        note: googleRevokeSucceeded
            ? "Local credentials removed and Google token revocation requested"
            : "Local credentials removed; Google-side revocation was not confirmed — the user may still need to revoke access in their Google Account settings",
    };
}

function buildFrontendRedirect(frontendBaseUrl, returnPath, query) {
    const base = (frontendBaseUrl || "").replace(/\/$/, "");
    const path = validateReturnPath(returnPath);
    const qs = new URLSearchParams(query).toString();
    return `${base}${path}${qs ? `?${qs}` : ""}`;
}

module.exports = {
    BUSINESS_MANAGE_SCOPE,
    GoogleOAuthError,
    isOAuthConfigured,
    assertOAuthConfigured,
    validateReturnPath,
    startAuthorization,
    completeAuthorization,
    getValidAccessToken,
    loadActiveConnectionForOrg,
    disconnectOrganization,
    revokeGoogleToken,
    buildFrontendRedirect,
    refreshAccessToken,
    consumeOAuthState,
    exchangeCodeForTokens,
};
