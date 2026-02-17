const express = require('express');
const path = require('path');
const router = express.Router();

// Serve HTML pages directly (for non-SPA fallback)
router.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages/login.html'));
});

router.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages/register.html'));
});

router.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages/dashboard.html'));
});

module.exports = router;