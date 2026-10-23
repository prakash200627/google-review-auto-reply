// Fixed-window, in-memory rate limiter. State is per process and resets on restart,
// which is acceptable for a single backend instance.
function createRateLimiter({ windowMs, max, message, keyGenerator }) {
    const hits = new Map();

    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, windowMs);
    if (sweep.unref) sweep.unref();

    function rateLimiter(req, res, next) {
        const key = (keyGenerator ? keyGenerator(req) : req.ip) || "unknown";
        const now = Date.now();
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;

        if (entry.count > max) {
            res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
            return res.status(429).json({
                success: false,
                message: message || "Too many requests. Please try again later.",
            });
        }
        return next();
    }

    rateLimiter.reset = () => hits.clear();
    return rateLimiter;
}

module.exports = createRateLimiter;
