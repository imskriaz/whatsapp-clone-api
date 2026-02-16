// src/web/auth.js

/**
 * Middleware to check if user is authenticated via session
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
const webAuth = (req, res, next) => {
    if (!req.session || !req.session.apiKey) {
        // Store the original URL to redirect back after login
        req.session.returnTo = req.originalUrl;
        return res.redirect('/login');
    }
    next();
};

/**
 * Middleware to check if user is NOT authenticated (for login/register pages)
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
const webGuest = (req, res, next) => {
    if (req.session && req.session.apiKey) {
        return res.redirect('/dashboard');
    }
    next();
};

/**
 * Get current authenticated user from session
 * @param {Object} req - Express request
 * @returns {Object|null} User object or null
 */
const getCurrentUser = (req) => {
    if (req.session && req.session.username) {
        return {
            username: req.session.username,
            apiKey: req.session.apiKey
        };
    }
    return null;
};

/**
 * Clear user session (logout)
 * @param {Object} req - Express request
 * @returns {Promise}
 */
const logout = (req) => {
    return new Promise((resolve) => {
        req.session.destroy((err) => {
            if (err) {
                console.error('Logout error:', err);
            }
            resolve();
        });
    });
};

module.exports = {
    webAuth,
    webGuest,
    getCurrentUser,
    logout
};