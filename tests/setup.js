// tests/setup.js
const fs = require('fs');
const path = require('path');

// Create test data directory
const testDir = path.join(__dirname, '../data-test');
if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
}

// Set test environment
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(testDir, 'test.db');
process.env.LOG_LEVEL = 'error';

// Clean up after tests
afterAll(() => {
    try {
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
        console.error('Failed to clean up test directory:', err);
    }
});