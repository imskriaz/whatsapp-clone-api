// src/utils/helpers.js
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');

/**
 * Generate random string
 * @param {number} length - String length
 * @returns {string} Random string
 */
const randomString = (length = 32) => {
    return crypto.randomBytes(length).toString('hex').slice(0, length);
};

/**
 * Generate API key
 * @returns {string} API key
 */
const generateApiKey = () => {
    return `wa_${randomString(32)}`;
};

/**
 * Generate session ID
 * @returns {string} UUID v4
 */
const generateSessionId = () => {
    return crypto.randomUUID();
};

/**
 * Validate JID format
 * @param {string} jid - JID to validate
 * @returns {boolean} Valid or not
 */
const isValidJid = (jid) => {
    if (!jid || typeof jid !== 'string') return false;
    return /^[0-9]+@[sg]\.whatsapp\.net$/.test(jid);
};

/**
 * Validate phone number
 * @param {string} phone - Phone number
 * @returns {boolean} Valid or not
 */
const isValidPhone = (phone) => {
    if (!phone || typeof phone !== 'string') return false;
    return /^[0-9]{10,15}$/.test(phone);
};

/**
 * Format phone to JID
 * @param {string} phone - Phone number
 * @returns {string} JID
 */
const phoneToJid = (phone) => {
    const clean = phone.replace(/[^0-9]/g, '');
    return `${clean}@s.whatsapp.net`;
};

/**
 * Extract phone from JID
 * @param {string} jid - JID
 * @returns {string} Phone number
 */
const jidToPhone = (jid) => {
    return jid.split('@')[0];
};

/**
 * Check if JID is group
 * @param {string} jid - JID
 * @returns {boolean} Is group
 */
const isGroupJid = (jid) => {
    return jid && jid.endsWith('@g.us');
};

/**
 * Check if JID is broadcast
 * @param {string} jid - JID
 * @returns {boolean} Is broadcast
 */
const isBroadcastJid = (jid) => {
    return jid && jid.endsWith('@broadcast');
};

/**
 * Sleep for ms
 * @param {number} ms - Milliseconds
 * @returns {Promise}
 */
const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Retry function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {Object} options - Retry options
 * @returns {Promise}
 */
const retry = async (fn, options = {}) => {
    const {
        maxAttempts = 3,
        initialDelay = 1000,
        maxDelay = 30000,
        factor = 2,
        jitter = true,
        onRetry = null
    } = options;

    let lastError;
    let delay = initialDelay;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            if (attempt === maxAttempts) break;
            
            if (onRetry) {
                onRetry({ attempt, error, delay });
            }
            
            // Add jitter to prevent thundering herd
            const jitterValue = jitter ? Math.random() * 100 : 0;
            await sleep(delay + jitterValue);
            
            delay = Math.min(delay * factor, maxDelay);
        }
    }

    throw lastError;
};

/**
 * Format bytes to human readable
 * @param {number} bytes - Bytes
 * @param {number} decimals - Decimal places
 * @returns {string} Formatted string
 */
const formatBytes = (bytes, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

/**
 * Format duration
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted duration
 */
const formatDuration = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    const parts = [];
    
    if (days > 0) parts.push(`${days}d`);
    if (hours % 24 > 0) parts.push(`${hours % 24}h`);
    if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
    if (seconds % 60 > 0) parts.push(`${seconds % 60}s`);
    
    return parts.join(' ') || '0s';
};

/**
 * Parse duration string to ms
 * @param {string} str - Duration string (e.g., "1d", "2h", "30m", "45s")
 * @returns {number} Milliseconds
 */
const parseDuration = (str) => {
    const match = str.match(/^(\d+)([dhms])$/);
    if (!match) return 0;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
        case 'd': return value * 24 * 60 * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'm': return value * 60 * 1000;
        case 's': return value * 1000;
        default: return 0;
    }
};

/**
 * Safe JSON parse
 * @param {string} str - JSON string
 * @param {*} defaultValue - Default value on error
 * @returns {*} Parsed object or default
 */
const safeJsonParse = (str, defaultValue = null) => {
    try {
        return JSON.parse(str);
    } catch {
        return defaultValue;
    }
};

/**
 * Deep clone object
 * @param {Object} obj - Object to clone
 * @returns {Object} Cloned object
 */
const deepClone = (obj) => {
    return JSON.parse(JSON.stringify(obj));
};

/**
 * Merge objects deeply
 * @param {Object} target - Target object
 * @param {Object} source - Source object
 * @returns {Object} Merged object
 */
const deepMerge = (target, source) => {
    const output = { ...target };
    
    for (const key in source) {
        if (source[key] instanceof Object && !Array.isArray(source[key])) {
            if (!(key in target)) {
                output[key] = source[key];
            } else {
                output[key] = deepMerge(target[key], source[key]);
            }
        } else {
            output[key] = source[key];
        }
    }
    
    return output;
};

/**
 * Chunk array into smaller arrays
 * @param {Array} array - Array to chunk
 * @param {number} size - Chunk size
 * @returns {Array} Array of chunks
 */
const chunkArray = (array, size) => {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
};

/**
 * Get file extension from mime type
 * @param {string} mimeType - MIME type
 * @returns {string} File extension
 */
const getExtensionFromMime = (mimeType) => {
    return mime.extension(mimeType) || 'bin';
};

/**
 * Get mime type from file extension
 * @param {string} ext - File extension
 * @returns {string} MIME type
 */
const getMimeFromExtension = (ext) => {
    return mime.lookup(ext) || 'application/octet-stream';
};

/**
 * Ensure directory exists
 * @param {string} dirPath - Directory path
 */
const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

/**
 * Clean old files from directory
 * @param {string} dirPath - Directory path
 * @param {number} maxAge - Max age in ms
 */
const cleanOldFiles = async (dirPath, maxAge) => {
    const files = await fs.promises.readdir(dirPath);
    const now = Date.now();
    
    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stat = await fs.promises.stat(filePath);
        
        if (now - stat.mtimeMs > maxAge) {
            await fs.promises.unlink(filePath);
        }
    }
};

/**
 * Get environment variable with default
 * @param {string} key - Environment variable key
 * @param {*} defaultValue - Default value
 * @returns {*} Value
 */
const env = (key, defaultValue = null) => {
    const value = process.env[key];
    if (value === undefined) return defaultValue;
    
    // Try to parse as number
    if (!isNaN(value) && !isNaN(parseFloat(value))) {
        return parseFloat(value);
    }
    
    // Try to parse as boolean
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    
    return value;
};

/**
 * Mask sensitive data
 * @param {string} str - String to mask
 * @param {number} visibleChars - Visible chars at start
 * @returns {string} Masked string
 */
const maskString = (str, visibleChars = 4) => {
    if (!str) return str;
    if (str.length <= visibleChars) return '*'.repeat(str.length);
    
    const visible = str.slice(0, visibleChars);
    const masked = '*'.repeat(Math.min(str.length - visibleChars, 10));
    
    return visible + masked;
};

/**
 * Parse comma separated list
 * @param {string} str - Comma separated string
 * @returns {Array} Array of values
 */
const parseCSV = (str) => {
    if (!str) return [];
    return str.split(',').map(s => s.trim()).filter(Boolean);
};

module.exports = {
    randomString,
    generateApiKey,
    generateSessionId,
    isValidJid,
    isValidPhone,
    phoneToJid,
    jidToPhone,
    isGroupJid,
    isBroadcastJid,
    sleep,
    retry,
    formatBytes,
    formatDuration,
    parseDuration,
    safeJsonParse,
    deepClone,
    deepMerge,
    chunkArray,
    getExtensionFromMime,
    getMimeFromExtension,
    ensureDir,
    cleanOldFiles,
    env,
    maskString,
    parseCSV
};