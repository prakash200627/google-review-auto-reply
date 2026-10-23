const axios = require("axios");

const ACCOUNT_MGMT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const MYBUSINESS_V4_BASE = "https://mybusiness.googleapis.com/v4";

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;

class GoogleApiError extends Error {
    constructor(message, { status = 502, code = "google_api_error", retryable = false } = {}) {
        super(message);
        this.name = "GoogleApiError";
        this.status = status;
        this.code = code;
        this.retryable = retryable;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyAxiosError(err) {
    const status = err.response && err.response.status;
    const data = err.response && err.response.data;
    const googleStatus = data && data.error && (data.error.status || data.error.message);
    const message =
        (data && data.error && data.error.message) ||
        err.message ||
        "Google Business Profile API request failed";

    if (status === 401 || status === 403) {
        return new GoogleApiError(message, {
            status,
            code: status === 401 ? "unauthorized" : "forbidden",
            retryable: false,
        });
    }
    if (status === 404) {
        return new GoogleApiError(message, { status: 404, code: "not_found", retryable: false });
    }
    if (status === 429 || (status >= 500 && status <= 599)) {
        return new GoogleApiError(message, { status: status || 502, code: "transient", retryable: true });
    }
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
        return new GoogleApiError("Google API request timed out", {
            status: 504,
            code: "timeout",
            retryable: true,
        });
    }
    return new GoogleApiError(message, {
        status: status || 502,
        code: googleStatus || err.code || "google_api_error",
        retryable: false,
    });
}

async function googleRequest(accessToken, config) {
    const allowRetry = config.retry !== false;
    const maxAttempts = allowRetry ? MAX_RETRIES : 1;
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            const response = await axios({
                method: config.method,
                url: config.url,
                params: config.params,
                data: config.data,
                timeout: config.timeout || DEFAULT_TIMEOUT_MS,
                headers: {
                    ...(config.headers || {}),
                    Authorization: `Bearer ${accessToken}`,
                },
                validateStatus: (s) => s >= 200 && s < 300,
            });
            return response.data;
        } catch (err) {
            lastError = classifyAxiosError(err);
            if (!allowRetry || !lastError.retryable || attempt === maxAttempts - 1) {
                throw lastError;
            }
            const retryAfter = Number(err.response && err.response.headers && err.response.headers["retry-after"]);
            const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 500 * (2 ** attempt);
            await sleep(delayMs);
        }
    }
    throw lastError;
}

async function listAccounts(accessToken) {
    const data = await googleRequest(accessToken, {
        method: "GET",
        url: `${ACCOUNT_MGMT_BASE}/accounts`,
    });
    return data.accounts || [];
}

async function listLocationsForAccount(accessToken, accountName, { pageToken } = {}) {
    const parent = accountName.startsWith("accounts/") ? accountName : `accounts/${accountName}`;
    const params = {
        readMask: "name,title,storefrontAddress,metadata",
        pageSize: 100,
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await googleRequest(accessToken, {
        method: "GET",
        url: `${BUSINESS_INFO_BASE}/${parent}/locations`,
        params,
    });
    return {
        locations: data.locations || [],
        nextPageToken: data.nextPageToken || "",
    };
}

async function listAllAccessibleLocations(accessToken) {
    const accounts = await listAccounts(accessToken);
    const results = [];

    for (const account of accounts) {
        const accountName = account.name; // accounts/{id}
        const accountId = accountName.replace(/^accounts\//, "");
        let pageToken = "";
        do {
            const page = await listLocationsForAccount(accessToken, accountName, { pageToken });
            for (const loc of page.locations) {
                const locationName = loc.name || ""; // locations/{id}
                const googleLocationId = locationName.replace(/^locations\//, "");
                if (!googleLocationId) continue;
                results.push({
                    googleAccountId: accountId,
                    googleLocationId,
                    name: loc.title || googleLocationId,
                    accountName,
                    locationName,
                    address: loc.storefrontAddress || null,
                });
            }
            pageToken = page.nextPageToken;
        } while (pageToken);
    }

    return results;
}

function reviewsParent(accountId, locationId) {
    return `accounts/${accountId}/locations/${locationId}`;
}

async function listReviews(accessToken, accountId, locationId, { pageToken, pageSize = 50 } = {}) {
    const parent = reviewsParent(accountId, locationId);
    const params = {
        pageSize: Math.min(Math.max(Number(pageSize) || 50, 1), 50),
        orderBy: "updateTime desc",
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await googleRequest(accessToken, {
        method: "GET",
        url: `${MYBUSINESS_V4_BASE}/${parent}/reviews`,
        params,
    });

    return {
        reviews: data.reviews || [],
        nextPageToken: data.nextPageToken || "",
        totalReviewCount: data.totalReviewCount,
        averageRating: data.averageRating,
    };
}

async function getReview(accessToken, reviewResourceName) {
    const name = String(reviewResourceName || "").replace(/^\//, "");
    return googleRequest(accessToken, {
        method: "GET",
        url: `${MYBUSINESS_V4_BASE}/${name}`,
    });
}

async function updateReviewReply(accessToken, reviewResourceName, comment) {
    const name = String(reviewResourceName || "").replace(/^\//, "");
    if (!name.includes("/reviews/")) {
        throw new GoogleApiError("Invalid Google review resource name", { status: 400, code: "invalid_resource" });
    }
    return googleRequest(accessToken, {
        method: "PUT",
        url: `${MYBUSINESS_V4_BASE}/${name}/reply`,
        data: { comment },
        // Do not auto-retry: a timeout after Google accepted the write is ambiguous.
        retry: false,
        timeout: 15000,
    });
}

function parseStarRating(starRating) {
    const map = {
        ONE: 1,
        TWO: 2,
        THREE: 3,
        FOUR: 4,
        FIVE: 5,
        STAR_RATING_UNSPECIFIED: null,
    };
    if (typeof starRating === "number" && starRating >= 1 && starRating <= 5) return starRating;
    if (typeof starRating === "string" && map[starRating] != null) return map[starRating];
    return null;
}

function extractReviewId(review) {
    if (review.reviewId) return String(review.reviewId);
    const name = String(review.name || "");
    const match = name.match(/\/reviews\/([^/]+)$/);
    return match ? match[1] : "";
}

module.exports = {
    GoogleApiError,
    listAccounts,
    listLocationsForAccount,
    listAllAccessibleLocations,
    listReviews,
    getReview,
    updateReviewReply,
    parseStarRating,
    extractReviewId,
    reviewsParent,
};
