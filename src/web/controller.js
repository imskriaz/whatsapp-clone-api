// src/web/controller.js
const path = require('path');

/**
 * Render a page from the views directory
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {string} pageName - Name of the page file (without .html)
 */
const renderPage = (req, res, pageName) => {
    res.sendFile(path.join(__dirname, `../../public/views/pages/${pageName}.html`));
};

/**
 * Render a page with data
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {string} pageName - Name of the page file
 * @param {Object} data - Data to pass to the page
 */
const renderPageWithData = (req, res, pageName, data = {}) => {
    // In a real EJS setup, you'd render with data
    // For static HTML, we'll just send the file
    // You could implement template injection here if needed
    res.sendFile(path.join(__dirname, `../../public/views/pages/${pageName}.html`));
};

/**
 * Handle 404 for web routes
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
const notFound = (req, res) => {
    res.status(404).sendFile(path.join(__dirname, '../../public/views/pages/404.html'));
};

module.exports = {
    renderPage,
    renderPageWithData,
    notFound
};