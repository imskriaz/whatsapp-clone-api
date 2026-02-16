// src/api/middleware.js
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { maskString } = require('../utils/helpers');
const { ROLES, DEFAULT_PERMISSIONS, ERROR_CODES } = require('../utils/constants');

/**
 * Role definitions and default permissions
 */
const ROLES_CONFIG = {
    SUPERADMIN: 'superadmin',     // Full system access
    ADMIN: 'admin',                // Can manage everything except users & sessions
    MODERATOR: 'moderator',        // Can moderate WhatsApp content
    USER: 'user',                   // Can send, read, use features
    SUBSCRIBER: 'subscriber'        // Read-only access
};

/**
 * Default permissions by role
 */
const PERMISSIONS = {
    // User management
    MANAGE_USERS: ['superadmin'],
    MANAGE_SESSIONS: ['superadmin'],
    
    // System management
    MANAGE_SYSTEM: ['superadmin', 'admin'],
    VIEW_SYSTEM: ['superadmin', 'admin', 'moderator'],
    
    // WhatsApp operations
    SEND_MESSAGES: ['superadmin', 'admin', 'moderator', 'user'],
    READ_MESSAGES: ['superadmin', 'admin', 'moderator', 'user', 'subscriber'],
    MODERATE_CONTENT: ['superadmin', 'admin', 'moderator'],
    
    // Group management
    MANAGE_GROUPS: ['superadmin', 'admin', 'moderator', 'user'],
    MODERATE_GROUPS: ['superadmin', 'admin', 'moderator'],
    
    // Settings
    MANAGE_SETTINGS: ['superadmin', 'admin'],
    VIEW_SETTINGS: ['superadmin', 'admin', 'moderator', 'user'],
    
    // Webhooks
    MANAGE_WEBHOOKS: ['superadmin', 'admin', 'moderator', 'user'],
    
    // Labels & Tags
    MANAGE_LABELS: ['superadmin', 'admin', 'moderator', 'user'],
    
    // Backups
    MANAGE_BACKUPS: ['superadmin', 'admin'],
    CREATE_BACKUP: ['superadmin', 'admin', 'moderator', 'user'],
    
    // Media
    UPLOAD_MEDIA: ['superadmin', 'admin', 'moderator', 'user'],
    DOWNLOAD_MEDIA: ['superadmin', 'admin', 'moderator', 'user', 'subscriber'],
    
    // API Access
    API_ACCESS: ['superadmin', 'admin', 'moderator', 'user', 'subscriber'],
    BULK_OPERATIONS: ['superadmin', 'admin', 'moderator']
};

/**
 * User meta cache with TTL
 */
const userMetaCache = new Map();
const META_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get user meta with caching
 * @param {Object} store - SQLiteStores instance
 * @param {string} username - Username
 * @returns {Promise<Object>}
 */
const getUserMeta = async (store, username) => {
    const cacheKey = `meta:${username}`;
    const cached = userMetaCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < META_CACHE_TTL) {
        return cached.data;
    }
    
    try {
        const meta = await store.getAllUserMeta(username);
        
        // Parse special fields
        const parsed = {
            session_limit: meta.session_limit ? parseInt(meta.session_limit) : null,
            rate_limit: meta.rate_limit ? parseInt(meta.rate_limit) : null,
            media_limit: meta.media_limit ? parseInt(meta.media_limit) : null,
            expiry: meta.expiry ? new Date(meta.expiry) : null,
            permissions: {}
        };
        
        // Parse permission overrides
        Object.keys(meta).forEach(key => {
            if (key.startsWith('perm_')) {
                const permName = key.replace('perm_', '');
                parsed.permissions[permName] = meta[key] === 'true' || meta[key] === true;
            }
        });
        
        // Cache the result
        userMetaCache.set(cacheKey, {
            data: parsed,
            timestamp: Date.now()
        });
        
        return parsed;
        
    } catch (error) {
        logger.error('Error getting user meta', { username, error: error.message });
        return {};
    }
};

/**
 * Clear user meta cache
 * @param {string} username - Username (optional)
 */
const clearUserMetaCache = (username = null) => {
    if (username) {
        userMetaCache.delete(`meta:${username}`);
    } else {
        userMetaCache.clear();
    }
};

/**
 * Check if user has permission (considering user meta overrides)
 * @param {Object} user - User object
 * @param {string} permission - Permission to check
 * @returns {boolean}
 */
const hasPermission = (user, permission) => {
    if (!user) return false;
    
    // Superadmin always has all permissions
    if (user.role === ROLES_CONFIG.SUPERADMIN) return true;
    
    // Check user meta override first
    if (user.meta?.permissions && user.meta.permissions[permission] !== undefined) {
        return user.meta.permissions[permission];
    }
    
    // Check role-based permission
    const allowedRoles = PERMISSIONS[permission];
    return allowedRoles ? allowedRoles.includes(user.role) : false;
};

/**
 * Authentication middleware
 * @param {Object} store - SQLiteStores instance
 * @returns {Function} Express middleware
 */
const auth = (store) => {
    return async (req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        const requestId = req.id || `req_${Date.now()}`;
        
        if (!apiKey) {
            logger.warn('Missing API key', { 
                requestId, 
                ip: req.ip, 
                path: req.path 
            });
            
            return res.status(401).json({ 
                error: 'API key required',
                code: 'MISSING_API_KEY',
                requestId
            });
        }

        try {
            const user = await store.getUserByApiKey(apiKey);
            
            if (!user) {
                logger.warn('Invalid API key', { 
                    requestId, 
                    ip: req.ip,
                    key: maskString(apiKey)
                });
                
                return res.status(401).json({ 
                    error: 'Invalid API key',
                    code: 'INVALID_API_KEY',
                    requestId
                });
            }

            // Get user meta with caching
            const meta = await getUserMeta(store, user.username);

            // Check if user is expired
            if (meta.expiry && meta.expiry < new Date()) {
                logger.warn('Expired account', { 
                    requestId, 
                    username: user.username,
                    expiry: meta.expiry
                });
                
                return res.status(403).json({ 
                    error: 'Account expired',
                    code: 'ACCOUNT_EXPIRED',
                    expiry: meta.expiry,
                    requestId
                });
            }

            req.user = {
                username: user.username,
                role: user.role,
                apiKey: user.api_key,
                meta
            };

            // Check API access permission
            if (!hasPermission(req.user, 'API_ACCESS')) {
                logger.warn('API access denied', { 
                    requestId, 
                    username: user.username,
                    role: user.role
                });
                
                return res.status(403).json({ 
                    error: 'API access denied',
                    code: 'API_ACCESS_DENIED',
                    requestId
                });
            }

            logger.debug('Authentication successful', { 
                requestId, 
                username: user.username,
                role: user.role
            });

            next();

        } catch (error) {
            logger.error('Authentication error', { 
                requestId, 
                error: error.message 
            });
            
            return res.status(500).json({ 
                error: 'Authentication failed',
                code: 'AUTH_ERROR',
                requestId
            });
        }
    };
};

/**
 * Optional authentication (for public routes that can also work with auth)
 * @param {Object} store - SQLiteStores instance
 * @returns {Function} Express middleware
 */
const optionalAuth = (store) => {
    return async (req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        
        if (!apiKey) {
            req.user = null;
            return next();
        }

        try {
            const user = await store.getUserByApiKey(apiKey);
            
            if (user) {
                const meta = await getUserMeta(store, user.username);
                
                // Check expiry but don't block optional auth
                if (!meta.expiry || meta.expiry >= new Date()) {
                    req.user = {
                        username: user.username,
                        role: user.role,
                        apiKey: user.api_key,
                        meta
                    };
                } else {
                    req.user = null;
                }
            } else {
                req.user = null;
            }
            
            next();
            
        } catch (error) {
            req.user = null;
            next();
        }
    };
};

/**
 * Permission-based authorization
 * @param {string} permission - Required permission
 * @returns {Function} Express middleware
 */
const requirePermission = (permission) => {
    return (req, res, next) => {
        const requestId = req.id || `req_${Date.now()}`;
        
        if (!req.user) {
            logger.warn('Authentication required', { 
                requestId, 
                path: req.path,
                permission
            });
            
            return res.status(401).json({ 
                error: 'Authentication required',
                code: 'UNAUTHORIZED',
                requestId
            });
        }

        if (!hasPermission(req.user, permission)) {
            logger.warn('Insufficient permissions', { 
                requestId, 
                username: req.user.username,
                role: req.user.role,
                required: permission,
                path: req.path
            });
            
            return res.status(403).json({ 
                error: 'Insufficient permissions',
                code: 'FORBIDDEN',
                required: permission,
                userRole: req.user.role,
                requestId
            });
        }

        next();
    };
};

/**
 * Role-based authorization
 * @param {Array} allowedRoles - Array of allowed roles
 * @returns {Function} Express middleware
 */
const allowRoles = (allowedRoles) => {
    return (req, res, next) => {
        const requestId = req.id || `req_${Date.now()}`;
        
        if (!req.user) {
            logger.warn('Authentication required', { 
                requestId, 
                path: req.path,
                allowedRoles
            });
            
            return res.status(401).json({ 
                error: 'Authentication required',
                code: 'UNAUTHORIZED',
                requestId
            });
        }

        // Superadmin always passes role checks
        if (req.user.role === ROLES_CONFIG.SUPERADMIN) {
            return next();
        }

        if (!allowedRoles.includes(req.user.role)) {
            logger.warn('Access denied by role', { 
                requestId, 
                username: req.user.username,
                userRole: req.user.role,
                required: allowedRoles,
                path: req.path
            });
            
            return res.status(403).json({ 
                error: 'Access denied',
                code: 'FORBIDDEN',
                required: allowedRoles,
                userRole: req.user.role,
                requestId
            });
        }

        next();
    };
};

/**
 * Session ownership and limit middleware
 * @param {Object} manager - SessionsManager instance
 * @returns {Function} Express middleware
 */
const sessionOwner = (manager) => {
    return async (req, res, next) => {
        const requestId = req.id || `req_${Date.now()}`;
        const sid = req.params.sid;
        
        if (!sid) {
            return res.status(400).json({ 
                error: 'Session ID required',
                code: 'MISSING_SESSION_ID',
                requestId
            });
        }

        const session = manager.get(sid);
        
        if (!session) {
            logger.warn('Session not found', { 
                requestId, 
                sid,
                username: req.user?.username
            });
            
            return res.status(404).json({ 
                error: 'Session not found',
                code: 'SESSION_NOT_FOUND',
                requestId
            });
        }

        req.session = session;

        // Superadmin can access any session
        if (req.user.role === ROLES_CONFIG.SUPERADMIN) {
            return next();
        }

        // Check ownership
        if (session.uid !== req.user.username) {
            logger.warn('Session ownership mismatch', { 
                requestId, 
                sid,
                sessionUser: session.uid,
                requestUser: req.user.username
            });
            
            return res.status(403).json({ 
                error: 'Access denied',
                code: 'NOT_SESSION_OWNER',
                requestId
            });
        }

        // Check user's session limit from meta
        const sessionLimit = req.user.meta?.session_limit || manager.maxPerUser;
        const userSessionCount = manager.countForUser(req.user.username);
        
        if (userSessionCount > sessionLimit) {
            logger.warn('Session limit exceeded', { 
                requestId, 
                username: req.user.username,
                limit: sessionLimit,
                current: userSessionCount
            });
            
            return res.status(403).json({ 
                error: 'Session limit exceeded',
                code: 'SESSION_LIMIT_EXCEEDED',
                limit: sessionLimit,
                current: userSessionCount,
                requestId
            });
        }

        next();
    };
};

/**
 * Rate limiter with user meta override
 * @param {Object} store - SQLiteStores instance
 * @returns {Function} Express middleware factory
 */
const createRateLimiter = (store) => {
    const userRateLimits = new Map();
    
    return (options = {}) => {
        const defaultLimiter = rateLimit({
            windowMs: options.windowMs || 15 * 60 * 1000,
            max: options.max || 100,
            message: { 
                error: 'Too many requests',
                code: 'RATE_LIMIT_EXCEEDED'
            },
            standardHeaders: true,
            legacyHeaders: false,
            keyGenerator: (req) => req.user?.username || req.ip,
            skip: (req) => req.user?.role === ROLES_CONFIG.SUPERADMIN // Skip for superadmin
        });

        return async (req, res, next) => {
            // Apply user-specific rate limit if available
            if (req.user && req.user.meta?.rate_limit) {
                const userLimit = req.user.meta.rate_limit;
                
                // Create or get user-specific limiter
                if (!userRateLimits.has(req.user.username)) {
                    userRateLimits.set(req.user.username, rateLimit({
                        windowMs: options.windowMs || 15 * 60 * 1000,
                        max: userLimit,
                        message: { 
                            error: 'User rate limit exceeded',
                            code: 'USER_RATE_LIMIT_EXCEEDED',
                            limit: userLimit
                        },
                        standardHeaders: true,
                        legacyHeaders: false,
                        keyGenerator: () => req.user.username
                    }));
                }
                
                const userLimiter = userRateLimits.get(req.user.username);
                return userLimiter(req, res, next);
            }
            
            // Use default limiter
            return defaultLimiter(req, res, next);
        };
    };
};

/**
 * Media size limiter
 * @returns {Function} Express middleware
 */
const mediaSizeLimit = () => {
    return (req, res, next) => {
        const requestId = req.id || `req_${Date.now()}`;
        
        if (!req.user) return next();
        
        const mediaLimit = req.user.meta?.media_limit || 100 * 1024 * 1024; // Default 100MB
        
        if (req.file && req.file.size > mediaLimit) {
            logger.warn('Media size exceeded', { 
                requestId, 
                username: req.user.username,
                size: req.file.size,
                limit: mediaLimit
            });
            
            return res.status(413).json({
                error: 'Media size exceeds limit',
                code: 'MEDIA_SIZE_EXCEEDED',
                limit: mediaLimit,
                size: req.file.size,
                requestId
            });
        }
        
        next();
    };
};

/**
 * Validation rules
 */
const validate = {
    /**
     * Validate registration
     */
    register: [
        body('username')
            .trim()
            .isLength({ min: 3, max: 30 })
            .withMessage('Username must be 3-30 characters')
            .matches(/^[a-zA-Z0-9_]+$/)
            .withMessage('Username can only contain letters, numbers, and underscores')
            .toLowerCase(),
        body('password')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters'),
        body('role')
            .optional()
            .isIn([ROLES_CONFIG.USER, ROLES_CONFIG.SUBSCRIBER])
            .withMessage('Role must be user or subscriber')
    ],

    /**
     * Validate login
     */
    login: [
        body('username').notEmpty().withMessage('Username required').toLowerCase(),
        body('password').notEmpty().withMessage('Password required')
    ],

    /**
     * Validate user update (admin only)
     */
    updateUser: [
        body('role')
            .optional()
            .isIn([ROLES_CONFIG.ADMIN, ROLES_CONFIG.MODERATOR, ROLES_CONFIG.USER, ROLES_CONFIG.SUBSCRIBER])
            .withMessage('Invalid role'),
        body('password')
            .optional()
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters')
    ],

    /**
     * Validate user meta update
     */
    updateUserMeta: [
        body('session_limit')
            .optional()
            .isInt({ min: 1, max: 100 })
            .withMessage('Session limit must be 1-100'),
        body('rate_limit')
            .optional()
            .isInt({ min: 1, max: 10000 })
            .withMessage('Rate limit must be 1-10000'),
        body('media_limit')
            .optional()
            .isInt({ min: 1024, max: 1024 * 1024 * 1024 })
            .withMessage('Media limit must be between 1KB and 1GB'),
        body('expiry')
            .optional()
            .isISO8601()
            .withMessage('Expiry must be a valid date')
    ],

    /**
     * Validate session creation
     */
    createSession: [
        body('platform')
            .optional()
            .isIn(['web', 'mobile', 'desktop'])
            .withMessage('Platform must be web, mobile, or desktop'),
        body('device')
            .optional()
            .isString()
            .withMessage('Device must be a string')
            .isLength({ max: 50 })
            .withMessage('Device too long')
    ],

    /**
     * Validate send message
     */
    sendMessage: [
        body('jid')
            .notEmpty()
            .withMessage('JID required')
            .matches(/^[0-9]+@[sg]\.whatsapp\.net$/)
            .withMessage('Invalid JID format'),
        body('type')
            .optional()
            .isIn(['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact'])
            .withMessage('Invalid message type'),
        body('content')
            .notEmpty()
            .withMessage('Content required')
    ],

    /**
     * Validate send reaction
     */
    sendReaction: [
        body('jid')
            .notEmpty()
            .withMessage('JID required')
            .matches(/^[0-9]+@[sg]\.whatsapp\.net$/)
            .withMessage('Invalid JID format'),
        body('msgId')
            .notEmpty()
            .withMessage('Message ID required'),
        body('emoji')
            .notEmpty()
            .withMessage('Emoji required')
            .isLength({ max: 2 })
            .withMessage('Invalid emoji')
    ],

    /**
     * Validate mark read
     */
    markRead: [
        body('jid')
            .notEmpty()
            .withMessage('JID required'),
        body('msgId')
            .notEmpty()
            .withMessage('Message ID required')
    ],

    /**
     * Validate presence
     */
    presence: [
        body('jid')
            .notEmpty()
            .withMessage('JID required'),
        body('state')
            .notEmpty()
            .withMessage('State required')
            .isIn(['available', 'unavailable', 'composing', 'recording', 'paused'])
            .withMessage('Invalid presence state')
    ],

    /**
     * Validate group action
     */
    groupAction: [
        body('jid')
            .optional()
            .matches(/^[0-9]+@g\.us$/)
            .withMessage('Invalid group JID'),
        body('participants')
            .optional()
            .isArray()
            .withMessage('Participants must be an array'),
        body('subject')
            .optional()
            .isString()
            .withMessage('Subject must be a string'),
        body('description')
            .optional()
            .isString()
            .withMessage('Description must be a string'),
        body('code')
            .optional()
            .isString()
            .withMessage('Invite code must be a string')
    ],

    /**
     * Validate webhook creation
     */
    createWebhook: [
        body('event')
            .notEmpty()
            .withMessage('Event required')
            .isIn(['message', 'presence', 'chat', 'reaction', 'group', 'call', 'all'])
            .withMessage('Invalid event type'),
        body('url')
            .notEmpty()
            .withMessage('URL required')
            .isURL()
            .withMessage('Invalid URL'),
        body('headers')
            .optional()
            .isObject()
            .withMessage('Headers must be an object'),
        body('retry_count')
            .optional()
            .isInt({ min: 0, max: 10 })
            .withMessage('Retry count must be 0-10'),
        body('timeout')
            .optional()
            .isInt({ min: 1000, max: 30000 })
            .withMessage('Timeout must be 1000-30000ms')
    ],

    /**
     * Validate user meta
     */
    userMeta: [
        body('key')
            .notEmpty()
            .withMessage('Key required')
            .isLength({ max: 50 })
            .withMessage('Key too long')
            .matches(/^[a-zA-Z0-9_]+$/)
            .withMessage('Key can only contain letters, numbers, and underscores'),
        body('value')
            .optional()
    ],

    /**
     * Validate password update
     */
    updatePassword: [
        body('password')
            .notEmpty()
            .withMessage('Password required')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters')
    ],

    /**
     * Validate pagination
     */
    pagination: [
        (req, res, next) => {
            req.query.limit = req.query.limit ? parseInt(req.query.limit) : 50;
            req.query.offset = req.query.offset ? parseInt(req.query.offset) : 0;
            
            if (isNaN(req.query.limit) || req.query.limit < 1 || req.query.limit > 1000) {
                req.query.limit = 50;
            }
            
            if (isNaN(req.query.offset) || req.query.offset < 0) {
                req.query.offset = 0;
            }
            next();
        }
    ],

    /**
     * Validate backup creation
     */
    createBackup: [
        body('includes_media')
            .optional()
            .isBoolean()
            .withMessage('includes_media must be boolean')
    ]
};

/**
 * Validation error handler
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    
    if (!errors.isEmpty()) {
        const requestId = req.id || `req_${Date.now()}`;
        
        logger.debug('Validation failed', { 
            requestId, 
            errors: errors.array() 
        });
        
        return res.status(400).json({
            error: 'Validation failed',
            code: 'VALIDATION_ERROR',
            details: errors.array().map(e => ({
                field: e.param,
                message: e.msg
            })),
            requestId
        });
    }
    
    next();
};

/**
 * Request logger middleware
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
const requestLogger = (req, res, next) => {
    const start = Date.now();
    const requestId = req.id || `req_${Date.now()}`;
    req.id = requestId;
    
    // Log request
    logger.http(`${req.method} ${req.url}`, {
        requestId,
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('User-Agent')
    });

    // Log response on finish
    res.on('finish', () => {
        const duration = Date.now() - start;
        const logLevel = res.statusCode >= 400 ? 'warn' : 'http';
        
        logger[logLevel](`${req.method} ${req.url} ${res.statusCode} ${duration}ms`, {
            requestId,
            method: req.method,
            url: req.url,
            status: res.statusCode,
            duration,
            user: req.user?.username
        });
    });

    next();
};

/**
 * Error handler middleware
 * @param {Error} err - Error object
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
const errorHandler = (err, req, res, next) => {
    const requestId = req.id || `req_${Date.now()}`;
    
    logger.error('Request error', {
        requestId,
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        user: req.user?.username,
        body: req.body
    });

    // Handle specific error types
    if (err.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({
            error: 'Duplicate or constraint violation',
            code: 'CONSTRAINT_ERROR',
            requestId
        });
    }

    if (err.code === 'SQLITE_BUSY') {
        return res.status(503).json({
            error: 'Database busy, try again',
            code: 'DB_BUSY',
            requestId
        });
    }

    if (err.message.includes('socket') || err.message.includes('connection')) {
        return res.status(503).json({
            error: 'WhatsApp connection error',
            code: 'CONNECTION_ERROR',
            requestId
        });
    }

    if (err.name === 'ValidationError') {
        return res.status(400).json({
            error: err.message,
            code: 'VALIDATION_ERROR',
            requestId
        });
    }

    if (err.name === 'MulterError') {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                error: 'File too large',
                code: 'FILE_TOO_LARGE',
                requestId
            });
        }
        return res.status(400).json({
            error: err.message,
            code: 'UPLOAD_ERROR',
            requestId
        });
    }

    // Default error
    const status = err.status || 500;
    res.status(status).json({
        error: err.message || 'Internal server error',
        code: err.code || 'INTERNAL_ERROR',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
        requestId
    });
};

/**
 * Not found handler
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
const notFound = (req, res) => {
    const requestId = req.id || `req_${Date.now()}`;
    
    logger.warn('Route not found', {
        requestId,
        url: req.url,
        method: req.method
    });
    
    res.status(404).json({
        error: 'Route not found',
        code: 'NOT_FOUND',
        path: req.url,
        requestId
    });
};

/**
 * CORS middleware
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
const cors = (req, res, next) => {
    const origin = process.env.CORS_ORIGIN || '*';
    
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key');
    res.header('Access-Control-Expose-Headers', 'X-Request-ID');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    
    next();
};

/**
 * JSON body parser with size limit
 */
const jsonParser = (req, res, next) => {
    const express = require('express');
    express.json({ limit: '50mb' })(req, res, err => {
        if (err) {
            const requestId = req.id || `req_${Date.now()}`;
            
            logger.warn('JSON parse error', {
                requestId,
                error: err.message
            });
            
            return res.status(413).json({
                error: 'Request entity too large',
                code: 'PAYLOAD_TOO_LARGE',
                limit: '50mb',
                requestId
            });
        }
        next();
    });
};

/**
 * Session ID validator
 * @param {string} sid - Session ID
 * @returns {boolean}
 */
const isValidSessionId = (sid) => {
    return sid && typeof sid === 'string' && 
           /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid);
};

/**
 * JID validator
 * @param {string} jid - JID
 * @returns {boolean}
 */
const isValidJid = (jid) => {
    return jid && typeof jid === 'string' && 
           /^[0-9]+@[sg]\.whatsapp\.net$/.test(jid);
};

/**
 * Content type validator
 * @param {string} type - Content type
 * @returns {boolean}
 */
const isValidContentType = (type) => {
    const valid = ['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact'];
    return valid.includes(type);
};

/**
 * Cleanup middleware (runs after response)
 */
const cleanup = (req, res, next) => {
    res.on('finish', () => {
        // Cleanup temporary data if any
        if (req.cleanup) {
            req.cleanup();
        }
    });
    next();
};

module.exports = {
    ROLES: ROLES_CONFIG,
    PERMISSIONS,
    hasPermission,
    getUserMeta,
    clearUserMetaCache,
    auth,
    optionalAuth,
    requirePermission,
    allowRoles,
    sessionOwner,
    createRateLimiter,
    mediaSizeLimit,
    createAccountLimiter: rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 5,
        message: { error: 'Too many accounts created', code: 'RATE_LIMIT_EXCEEDED' },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => req.ip
    }),
    loginLimiter: rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        message: { error: 'Too many login attempts', code: 'RATE_LIMIT_EXCEEDED' },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => req.ip
    }),
    apiLimiter: rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        message: { error: 'Too many requests', code: 'RATE_LIMIT_EXCEEDED' },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => req.user?.username || req.ip
    }),
    validate,
    handleValidationErrors,
    requestLogger,
    errorHandler,
    notFound,
    cors,
    jsonParser,
    cleanup,
    isValidSessionId,
    isValidJid,
    isValidContentType
};