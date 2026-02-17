// src/web/routes.js
const express = require('express');
const path = require('path');
const router = express.Router();

// SPA - All routes serve the same index.html
router.get('*', (req, res) => {
    // Don't serve index.html for API routes
    if (req.url.startsWith('/api')) {
        return res.status(404).json({ error: 'API route not found' });
    }
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

module.exports = router;