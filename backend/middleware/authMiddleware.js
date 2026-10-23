const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

function authMiddleware(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
            });
        }

        const token = authHeader.slice("Bearer ".length).trim();

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET,
            { algorithms: ["HS256"] }
        );

        if (!decoded || !mongoose.isValidObjectId(decoded.organizationId)) {
            return res.status(401).json({
                success: false,
                message: "Invalid or expired token",
            });
        }

        req.organizationId = decoded.organizationId;

        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: "Invalid or expired token",
        });
    }
}

module.exports = authMiddleware;
