// src/web/routes.js
const express = require('express');
const path = require('path');
const router = express.Router();

// Serve HTML pages
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

router.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/views/pages/login.html'));
});

router.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/views/pages/register.html'));
});

router.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/views/pages/dashboard.html'));
});

router.get('/session/:sid', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/views/pages/session.html'));
});

module.exports = router;