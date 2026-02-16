// src/api/middleware.js
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

/**
 * Role definitions and default permissions
 */
const ROLES = {
    SUPERADMIN: 'superadmin',     // Full system access
    ADMIN: 'admin',                // Can manage everything except users & sessions
    MODERATOR: 'moderator',        // Can moderate WhatsApp content
    USER: 'user',                   // Can send, read, use features
    SUBSCRIBER: 'subscriber'        // Read-only access
};

/**
 * Default permissions by role
 */
const DEFAULT_PERMISSIONS = {
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
 * Check if user has permission (considering user meta overrides)
 * @param {Object} user - User object
 * @param {string} permission - Permission to check
 * @param {Object} userMeta - User meta data (cached)
 * @returns {boolean}
 */
const hasPermission = (user, permission, userMeta = {}) => {
    if (!user) return false;
    
    // Superadmin always has all permissions
    if (user.role === ROLES.SUPERADMIN) return true;
    
    // Check user meta override first
    const metaPermission = userMeta[`perm_${permission}`];
    if (metaPermission !== undefined) {
        return metaPermission === 'true' || metaPermission === true;
    }
    
    // Check role-based permission
    const allowedRoles = DEFAULT_PERMISSIONS[permission];
    return allowedRoles ? allowedRoles.includes(user.role) : false;
};

/**
 * Get user meta with caching
 * @param {Object} store - SQLiteStores instance
 * @param {string} username - Username
 * @param {Object} cache - Cache object
 * @returns {Promise<Object>}
 */
const getUserMeta = async (store, username, cache = null) => {
    const cacheKey = `user_meta:${username}`;
    
    // Check cache
    if (cache && cache[cacheKey]) {
        return cache[cacheKey];
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
        
        // Cache if cache provided
        if (cache) {
            cache[cacheKey] = parsed;
        }
        
        return parsed;
    } catch (err) {
        console.error('Error getting user meta:', err);
        return {};
    }
};

/**
 * Authentication middleware
 * @param {Object} store - SQLiteStores instance
 * @param {Object} options - Options
 * @returns {Function} Express middleware
 */
const auth = (store, options = {}) => {
    const userMetaCache = {};
    
    return async (req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        
        if (!apiKey) {
            return res.status(401).json({ 
                error: 'API key required',
                code: 'MISSING_API_KEY'
            });
        }

        try {
            const user = await store.getUserByApiKey(apiKey);
            
            if (!user) {
                return res.status(401).json({ 
                    error: 'Invalid API key',
                    code: 'INVALID_API_KEY'
                });
            }

            // Check if user is expired
            const meta = await getUserMeta(store, user.username, userMetaCache);
            if (meta.expiry && meta.expiry < new Date()) {
                return res.status(403).json({ 
                    error: 'Account expired',
                    code: 'ACCOUNT_EXPIRED',
                    expiry: meta.expiry
                });
            }

            req.user = {
                username: user.username,
                role: user.role,
                apiKey: user.api_key,
                meta
            };

            // Check API access permission
            if (!hasPermission(req.user, 'API_ACCESS', meta.permissions)) {
                return res.status(403).json({ 
                    error: 'API access denied',
                    code: 'API_ACCESS_DENIED'
                });
            }

            // Log access for audit
            if (process.env.NODE_ENV === 'development') {
                console.log(`[AUTH] ${user.username} (${user.role}) accessed ${req.method} ${req.url}`);
            }

            next();
        } catch (err) {
            console.error('Auth error:', err.message);
            return res.status(500).json({ 
                error: 'Authentication failed',
                code: 'AUTH_ERROR'
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
    const userMetaCache = {};
    
    return async (req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        
        if (!apiKey) {
            req.user = null;
            return next();
        }

        try {
            const user = await store.getUserByApiKey(apiKey);
            
            if (user) {
                const meta = await getUserMeta(store, user.username, userMetaCache);
                
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
        } catch (err) {
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
        if (!req.user) {
            return res.status(401).json({ 
                error: 'Authentication required',
                code: 'UNAUTHORIZED'
            });
        }

        const hasPerm = hasPermission(
            req.user, 
            permission, 
            req.user.meta?.permissions || {}
        );

        if (!hasPerm) {
            return res.status(403).json({ 
                error: 'Insufficient permissions',
                code: 'FORBIDDEN',
                required: permission,
                userRole: req.user.role
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
        if (!req.user) {
            return res.status(401).json({ 
                error: 'Authentication required',
                code: 'UNAUTHORIZED'
            });
        }

        // Superadmin always passes role checks
        if (req.user.role === ROLES.SUPERADMIN) {
            return next();
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ 
                error: 'Access denied',
                code: 'FORBIDDEN',
                required: allowedRoles,
                userRole: req.user.role
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
        const sid = req.params.sid;
        
        if (!sid) {
            return res.status(400).json({ 
                error: 'Session ID required',
                code: 'MISSING_SESSION_ID'
            });
        }

        const session = manager.get(sid);
        
        if (!session) {
            return res.status(404).json({ 
                error: 'Session not found',
                code: 'SESSION_NOT_FOUND'
            });
        }

        req.session = session;

        // Superadmin can access any session
        if (req.user.role === ROLES.SUPERADMIN) {
            return next();
        }

        // Check ownership
        if (session.uid !== req.user.username) {
            return res.status(403).json({ 
                error: 'Access denied',
                code: 'NOT_SESSION_OWNER'
            });
        }

        // Check user's session limit from meta
        const sessionLimit = req.user.meta?.session_limit || manager.maxPerUser;
        const userSessionCount = manager.countForUser(req.user.username);
        
        if (userSessionCount > sessionLimit) {
            return res.status(403).json({ 
                error: 'Session limit exceeded',
                code: 'SESSION_LIMIT_EXCEEDED',
                limit: sessionLimit,
                current: userSessionCount
            });
        }

        next();
    };
};

/**
 * Rate limiter with user meta override
 * @param {Object} store - SQLiteStores instance
 * @returns {Function} Express middleware
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
            keyGenerator: (req) => req.user?.username || req.ip
        });

        return async (req, res, next) => {
            // Apply user-specific rate limit if available
            if (req.user && req.user.meta?.rate_limit) {
                const userLimit = req.user.meta.rate_limit;
                
                // Create user-specific limiter
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
        if (!req.user) return next();
        
        const mediaLimit = req.user.meta?.media_limit || 100 * 1024 * 1024; // Default 100MB
        
        if (req.file && req.file.size > mediaLimit) {
            return res.status(413).json({
                error: 'Media size exceeds limit',
                code: 'MEDIA_SIZE_EXCEEDED',
                limit: mediaLimit,
                size: req.file.size
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
            .withMessage('Username can only contain letters, numbers, and underscores'),
        body('password')
            .isLength({ min: 6 })
            .withMessage('Password must be at least 6 characters'),
        body('role')
            .optional()
            .isIn([ROLES.USER, ROLES.SUBSCRIBER])
            .withMessage('Role must be user or subscriber')
    ],

    /**
     * Validate login
     */
    login: [
        body('username').notEmpty().withMessage('Username required'),
        body('password').notEmpty().withMessage('Password required')
    ],

    /**
     * Validate user update (admin only)
     */
    updateUser: [
        body('role')
            .optional()
            .isIn([ROLES.ADMIN, ROLES.MODERATOR, ROLES.USER, ROLES.SUBSCRIBER])
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
            .withMessage('Expiry must be a valid date'),
        body('*')
            .custom((value, { req }) => {
                // Allow any key that starts with 'perm_'
                const key = req.path.split('/').pop();
                if (key && key.startsWith('perm_')) {
                    return true;
                }
                return true;
            })
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
            .withMessage('Invalid message type')
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
            .withMessage('Key too long'),
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
        return res.status(400).json({
            error: 'Validation failed',
            code: 'VALIDATION_ERROR',
            details: errors.array().map(e => ({
                field: e.param,
                message: e.msg
            }))
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
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        const log = {
            timestamp: new Date().toISOString(),
            method: req.method,
            url: req.url,
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
            user: req.user?.username || 'anonymous',
            role: req.user?.role || 'none'
        };
        
        console.log(JSON.stringify(log));
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
    console.error('Error:', {
        message: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        user: req.user?.username,
        role: req.user?.role
    });

    // Handle specific error types
    if (err.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({
            error: 'Duplicate or constraint violation',
            code: 'CONSTRAINT_ERROR'
        });
    }

    if (err.code === 'SQLITE_BUSY') {
        return res.status(503).json({
            error: 'Database busy, try again',
            code: 'DB_BUSY'
        });
    }

    if (err.message.includes('socket') || err.message.includes('connection')) {
        return res.status(503).json({
            error: 'WhatsApp connection error',
            code: 'CONNECTION_ERROR'
        });
    }

    if (err.name === 'ValidationError') {
        return res.status(400).json({
            error: err.message,
            code: 'VALIDATION_ERROR'
        });
    }

    // Default error
    const status = err.status || 500;
    res.status(status).json({
        error: err.message || 'Internal server error',
        code: err.code || 'INTERNAL_ERROR',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};

/**
 * Not found handler
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
const notFound = (req, res) => {
    res.status(404).json({
        error: 'Route not found',
        code: 'NOT_FOUND',
        path: req.url
    });
};

/**
 * CORS middleware
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
const cors = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key');
    
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
            return res.status(413).json({
                error: 'Request entity too large',
                code: 'PAYLOAD_TOO_LARGE',
                limit: '50mb'
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

module.exports = {
    ROLES,
    DEFAULT_PERMISSIONS,
    hasPermission,
    getUserMeta,
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
        legacyHeaders: false
    }),
    loginLimiter: rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        message: { error: 'Too many login attempts', code: 'RATE_LIMIT_EXCEEDED' },
        standardHeaders: true,
        legacyHeaders: false
    }),
    validate,
    handleValidationErrors,
    requestLogger,
    errorHandler,
    notFound,
    cors,
    jsonParser,
    isValidSessionId,
    isValidJid,
    isValidContentType
};