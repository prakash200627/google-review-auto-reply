const express = require("express");
const mongoose = require("mongoose");

const authMiddleware = require("../middleware/authMiddleware");
const createRateLimiter = require("../middleware/rateLimit");
const Location = require("../models/Location");
const GoogleConnection = require("../models/GoogleConnection");
const {
    isOAuthConfigured,
    startAuthorization,
    completeAuthorization,
    loadActiveConnectionForOrg,
    getValidAccessToken,
    disconnectOrganization,
    buildFrontendRedirect,
    GoogleOAuthError,
    validateReturnPath,
} = require("../services/googleOAuth");
const { listAllAccessibleLocations, GoogleApiError } = require("../services/googleBusinessApi");
const { runOrganizationSync, getSyncIntervalMs } = require("../services/reviewSync");

const router = express.Router();

// Manual sync is expensive (Google + OpenAI); limit per organization.
const syncNowLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "Too many sync requests. Please wait before syncing again.",
    keyGenerator: (req) => `google-sync:${req.organizationId || req.ip || "unknown"}`,
});

function frontendBaseUrl(env = process.env) {
    const configured = (env.FRONTEND_URL || "").trim().replace(/\/$/, "");
    if (configured) return configured;
    if (env.NODE_ENV === "production") return "https://google-review-auto-reply.vercel.app";
    return "http://localhost:5173";
}

function sendOAuthError(res, err) {
    const status = err.status || 500;
    return res.status(status).json({
        success: false,
        message: err.message || "Google OAuth error",
        code: err.code || "oauth_error",
    });
}

// GET /api/google/status
router.get("/status", authMiddleware, async (req, res) => {
    try {
        const connection = await GoogleConnection.findOne({
            orgId: req.organizationId,
            status: { $in: ["active", "error"] },
        });

        const locations = await Location.find({ orgId: req.organizationId }).select(
            "name googleLocationId googleAccountId connectionId syncEnabled lastSyncAttemptAt lastSyncSuccessAt lastSyncError"
        );

        return res.json({
            success: true,
            oauthConfigured: isOAuthConfigured(),
            syncIntervalMinutes: Math.round(getSyncIntervalMs() / 60000),
            connection: connection
                ? {
                    id: connection._id,
                    email: connection.googleAccountEmail,
                    status: connection.status,
                    connectedAt: connection.connectedAt,
                    lastError: connection.lastError,
                    scopes: connection.scopes,
                }
                : null,
            locations,
        });
    } catch (err) {
        console.error("Google status error:", err.message);
        return res.status(500).json({ success: false, message: "Failed to load Google connection status" });
    }
});

// POST /api/google/oauth/start
router.post("/oauth/start", authMiddleware, async (req, res) => {
    try {
        if (!isOAuthConfigured()) {
            return res.status(503).json({
                success: false,
                message: "Google OAuth is not configured on the server",
                code: "not_configured",
            });
        }

        const returnPath = validateReturnPath(req.body && req.body.returnPath);
        const started = await startAuthorization({
            orgId: req.organizationId,
            returnPath,
        });

        return res.json({
            success: true,
            authUrl: started.authUrl,
            expiresAt: started.expiresAt,
        });
    } catch (err) {
        if (err instanceof GoogleOAuthError) return sendOAuthError(res, err);
        console.error("OAuth start error:", err.message);
        return res.status(500).json({ success: false, message: "Failed to start Google authorization" });
    }
});

// GET /api/google/oauth/callback — browser redirect from Google (no JWT; state binds org)
router.get("/oauth/callback", async (req, res) => {
    const base = frontendBaseUrl();
    try {
        const { code, state, error, error_description: errorDescription } = req.query || {};

        if (error) {
            const redirect = buildFrontendRedirect(base, "/settings/google", {
                google: "error",
                reason: String(error),
            });
            return res.redirect(redirect);
        }

        const result = await completeAuthorization({ code, state });
        // Ensure the state belonged to a real org (already bound in OAuthState).
        if (!result.orgId || !mongoose.isValidObjectId(result.orgId)) {
            const redirect = buildFrontendRedirect(base, "/settings/google", {
                google: "error",
                reason: "invalid_org",
            });
            return res.redirect(redirect);
        }

        const redirect = buildFrontendRedirect(base, result.returnPath || "/settings/google", {
            google: "connected",
        });
        return res.redirect(redirect);
    } catch (err) {
        console.error("OAuth callback error:", err.message);
        const redirect = buildFrontendRedirect(base, "/settings/google", {
            google: "error",
            reason: (err && err.code) || "callback_failed",
        });
        return res.redirect(redirect);
    }
});

// GET /api/google/locations/discover — list locations from Google for the connected account
router.get("/locations/discover", authMiddleware, async (req, res) => {
    try {
        const connection = await loadActiveConnectionForOrg(req.organizationId);
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: "No active Google connection. Connect a Google account first.",
            });
        }

        const accessToken = await getValidAccessToken(connection);
        const discovered = await listAllAccessibleLocations(accessToken);

        const existing = await Location.find({ orgId: req.organizationId });
        const byGoogleId = new Map(existing.map((loc) => [loc.googleLocationId, loc]));

        const locations = discovered.map((item) => {
            const linked = byGoogleId.get(item.googleLocationId);
            return {
                ...item,
                alreadyConnected: Boolean(linked),
                linkedLocationId: linked ? linked._id : null,
                ownedByThisOrg: Boolean(linked),
            };
        });

        return res.json({ success: true, locations });
    } catch (err) {
        if (err instanceof GoogleOAuthError || err instanceof GoogleApiError) {
            return res.status(err.status || 502).json({ success: false, message: err.message, code: err.code });
        }
        console.error("Discover locations error:", err.message);
        return res.status(500).json({ success: false, message: "Failed to discover Google locations" });
    }
});

// POST /api/google/locations/connect — connect selected discovered locations to this org
router.post("/locations/connect", authMiddleware, async (req, res) => {
    try {
        const connection = await loadActiveConnectionForOrg(req.organizationId);
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: "No active Google connection. Connect a Google account first.",
            });
        }

        const selections = Array.isArray(req.body && req.body.locations) ? req.body.locations : null;
        if (!selections || selections.length === 0) {
            return res.status(400).json({ success: false, message: "locations array is required" });
        }
        if (selections.length > 50) {
            return res.status(400).json({ success: false, message: "Connect at most 50 locations at once" });
        }

        // Re-discover to verify the caller can only connect locations Google actually returned.
        const accessToken = await getValidAccessToken(connection);
        const discovered = await listAllAccessibleLocations(accessToken);
        const allowed = new Map(
            discovered.map((d) => [`${d.googleAccountId}:${d.googleLocationId}`, d])
        );

        const connected = [];
        const skipped = [];

        for (const raw of selections) {
            const googleAccountId = raw && String(raw.googleAccountId || "").trim();
            const googleLocationId = raw && String(raw.googleLocationId || "").trim();
            if (!googleAccountId || !googleLocationId || /[\s/]/.test(googleLocationId) || /[\s/]/.test(googleAccountId)) {
                skipped.push({ googleLocationId, reason: "invalid_ids" });
                continue;
            }

            const key = `${googleAccountId}:${googleLocationId}`;
            const allowedLoc = allowed.get(key);
            if (!allowedLoc) {
                skipped.push({ googleLocationId, reason: "not_accessible" });
                continue;
            }

            const existing = await Location.findOne({ googleLocationId });
            if (existing) {
                if (String(existing.orgId) !== String(req.organizationId)) {
                    skipped.push({ googleLocationId, reason: "owned_by_other_org" });
                    continue;
                }
                existing.name = allowedLoc.name || existing.name;
                existing.googleAccountId = googleAccountId;
                existing.connectionId = connection._id;
                existing.syncEnabled = true;
                existing.lastSyncError = "";
                await existing.save();
                connected.push(existing);
                continue;
            }

            const created = await Location.create({
                orgId: req.organizationId,
                name: allowedLoc.name || googleLocationId,
                googleLocationId,
                googleAccountId,
                connectionId: connection._id,
                syncEnabled: true,
            });
            connected.push(created);
        }

        return res.status(201).json({
            success: true,
            connected,
            skipped,
        });
    } catch (err) {
        if (err instanceof GoogleOAuthError || err instanceof GoogleApiError) {
            return res.status(err.status || 502).json({ success: false, message: err.message, code: err.code });
        }
        console.error("Connect locations error:", err.message);
        return res.status(500).json({ success: false, message: "Failed to connect Google locations" });
    }
});

// POST /api/google/locations/:id/disconnect — stop syncing a location (keeps history)
router.post("/locations/:id/disconnect", authMiddleware, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: "Invalid location ID" });
        }

        const location = await Location.findOneAndUpdate(
            { _id: req.params.id, orgId: req.organizationId },
            {
                $set: {
                    syncEnabled: false,
                    connectionId: null,
                    lastSyncError: "Location disconnected from Google sync",
                    syncCheckpointPageToken: "",
                },
            },
            { returnDocument: "after" }
        );

        if (!location) {
            return res.status(404).json({ success: false, message: "Location not found" });
        }

        return res.json({ success: true, location });
    } catch (err) {
        console.error("Disconnect location error:", err.message);
        return res.status(500).json({ success: false, message: "Failed to disconnect location" });
    }
});

// POST /api/google/disconnect — revoke org Google connection and unlink locations
router.post("/disconnect", authMiddleware, async (req, res) => {
    try {
        const result = await disconnectOrganization(req.organizationId);
        return res.json({
            success: true,
            message: result.note || "Google account disconnected",
            localCredentialsDeleted: result.localCredentialsDeleted,
            googleRevokeAttempted: result.googleRevokeAttempted,
            googleRevokeSucceeded: result.googleRevokeSucceeded,
        });
    } catch (err) {
        console.error("Disconnect Google error:", err.message);
        return res.status(500).json({ success: false, message: "Failed to disconnect Google account" });
    }
});

// POST /api/google/sync/now — sync ONLY the authenticated organization's locations.
// Organization is taken from the JWT; client-supplied orgId is ignored.
router.post("/sync/now", authMiddleware, syncNowLimiter, async (req, res) => {
    try {
        if (!isOAuthConfigured()) {
            return res.status(503).json({
                success: false,
                message: "Google OAuth is not configured on the server",
            });
        }

        const orgId = req.organizationId;
        // Ignore any client attempt to target another organization.
        if (req.body && req.body.orgId && String(req.body.orgId) !== String(orgId)) {
            return res.status(403).json({
                success: false,
                message: "Cannot sync another organization",
            });
        }

        const summary = await runOrganizationSync(orgId);
        if (summary.skipped) {
            const status = summary.reason === "org_sync_in_progress" ? 409 : 503;
            return res.status(status).json({
                success: false,
                skipped: true,
                reason: summary.reason,
                message:
                    summary.reason === "org_sync_in_progress"
                        ? "A sync is already running for this organization"
                        : "Sync is unavailable",
            });
        }

        return res.json({
            success: true,
            summary: {
                orgId: summary.orgId,
                locations: summary.locations,
                created: summary.created,
                processed: summary.processed,
                errors: summary.errors,
                skippedUnlinked: summary.skippedUnlinked,
                results: summary.results,
            },
        });
    } catch (err) {
        console.error("Manual sync error:", err.message);
        return res.status(500).json({ success: false, message: "Failed to run review sync" });
    }
});

module.exports = router;
module.exports.syncNowLimiter = syncNowLimiter;
