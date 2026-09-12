const express = require('express');
const Organization = require('../models/Organization');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// GET /api/organization/mode
router.get('/mode', authMiddleware, async (req, res) => {
    try {
        const organization = await Organization.findById(req.organizationId).select('-password');
        if (!organization) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found.',
            });
        }
        return res.json({
            success: true,
            mode: organization.mode || 'manual',
            organizationId: organization._id,
        });
    } catch (err) {
        console.error('Get mode error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error retrieving mode.' });
    }
});

// GET /api/organization/me
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const organization = await Organization.findById(req.organizationId).select('-password');
        if (!organization) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found.',
            });
        }
        return res.json({
            success: true,
            organization: {
                id: organization._id,
                name: organization.name,
                email: organization.email,
                mode: organization.mode || 'manual',
                brandVoice: organization.brandVoice,
                language: organization.language,
            },
        });
    } catch (err) {
        console.error('Get organization error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error retrieving organization.' });
    }
});

// PATCH /api/organization/mode
router.patch('/mode', authMiddleware, async (req, res) => {
    try {
        const { mode } = req.body || {};
        if (!mode || !['manual', 'auto'].includes(mode)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid mode. Must be "manual" or "auto".',
            });
        }
        const organization = await Organization.findById(req.organizationId);
        if (!organization) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found.',
            });
        }
        organization.mode = mode;
        await organization.save();
        return res.json({
            success: true,
            mode: organization.mode,
            organizationId: organization._id,
        });
    } catch (err) {
        console.error('Update mode error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error updating mode.' });
    }
});

module.exports = router;
