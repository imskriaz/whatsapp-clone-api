// src/utils/constants.js
module.exports = {
    // Role definitions
    ROLES: {
        SUPERADMIN: 'superadmin',
        ADMIN: 'admin',
        MODERATOR: 'moderator',
        USER: 'user',
        SUBSCRIBER: 'subscriber'
    },

    // Default permissions by role
    DEFAULT_PERMISSIONS: {
        MANAGE_USERS: ['superadmin'],
        MANAGE_SESSIONS: ['superadmin'],
        MANAGE_SYSTEM: ['superadmin', 'admin'],
        VIEW_SYSTEM: ['superadmin', 'admin', 'moderator'],
        SEND_MESSAGES: ['superadmin', 'admin', 'moderator', 'user'],
        READ_MESSAGES: ['superadmin', 'admin', 'moderator', 'user', 'subscriber'],
        MODERATE_CONTENT: ['superadmin', 'admin', 'moderator'],
        MANAGE_GROUPS: ['superadmin', 'admin', 'moderator', 'user'],
        MODERATE_GROUPS: ['superadmin', 'admin', 'moderator'],
        MANAGE_SETTINGS: ['superadmin', 'admin'],
        VIEW_SETTINGS: ['superadmin', 'admin', 'moderator', 'user'],
        MANAGE_WEBHOOKS: ['superadmin', 'admin', 'moderator', 'user'],
        MANAGE_LABELS: ['superadmin', 'admin', 'moderator', 'user'],
        MANAGE_BACKUPS: ['superadmin', 'admin'],
        CREATE_BACKUP: ['superadmin', 'admin', 'moderator', 'user'],
        UPLOAD_MEDIA: ['superadmin', 'admin', 'moderator', 'user'],
        DOWNLOAD_MEDIA: ['superadmin', 'admin', 'moderator', 'user', 'subscriber'],
        API_ACCESS: ['superadmin', 'admin', 'moderator', 'user', 'subscriber'],
        BULK_OPERATIONS: ['superadmin', 'admin', 'moderator']
    },

    // Message types
    MESSAGE_TYPES: {
        TEXT: 'text',
        IMAGE: 'image',
        VIDEO: 'video',
        AUDIO: 'audio',
        DOCUMENT: 'document',
        STICKER: 'sticker',
        LOCATION: 'location',
        CONTACT: 'contact',
        REACTION: 'reaction'
    },

    // Message statuses
    MESSAGE_STATUS: {
        PENDING: 'pending',
        SENT: 'sent',
        DELIVERED: 'delivered',
        READ: 'read',
        FAILED: 'failed',
        DELETED: 'deleted'
    },

    // Presence states
    PRESENCE_STATES: {
        AVAILABLE: 'available',
        UNAVAILABLE: 'unavailable',
        COMPOSING: 'composing',
        RECORDING: 'recording',
        PAUSED: 'paused'
    },

    // Call types
    CALL_TYPES: {
        AUDIO: 'audio',
        VIDEO: 'video'
    },

    // Call statuses
    CALL_STATUS: {
        RINGING: 'ringing',
        ACCEPTED: 'accepted',
        REJECTED: 'rejected',
        MISSED: 'missed',
        TIMEOUT: 'timeout',
        ENDED: 'ended'
    },

    // Group actions
    GROUP_ACTIONS: {
        CREATE: 'create',
        UPDATE_SUBJECT: 'subject',
        UPDATE_DESC: 'desc',
        ADD: 'add',
        REMOVE: 'remove',
        PROMOTE: 'promote',
        DEMOTE: 'demote',
        ANNOUNCE: 'announce',
        NOT_ANNOUNCE: 'not_announce',
        LOCK: 'lock',
        UNLOCK: 'unlock',
        INVITE: 'invite',
        REVOKE: 'revoke',
        JOIN: 'join',
        LEAVE: 'leave'
    },

    // Webhook events
    WEBHOOK_EVENTS: {
        MESSAGE: 'message',
        PRESENCE: 'presence',
        CHAT: 'chat',
        REACTION: 'reaction',
        GROUP: 'group',
        CALL: 'call',
        ALL: 'all'
    },

    // Sync types
    SYNC_TYPES: {
        HISTORY: 'history',
        CONTACTS: 'contacts',
        CHATS: 'chats',
        MESSAGES: 'messages'
    },

    // Job types
    JOB_TYPES: {
        BACKUP: 'backup',
        CLEANUP: 'cleanup',
        WEBHOOK_RETRY: 'webhook_retry',
        STATS: 'stats'
    },

    // Job statuses
    JOB_STATUS: {
        PENDING: 'pending',
        RUNNING: 'running',
        COMPLETED: 'completed',
        FAILED: 'failed',
        CANCELLED: 'cancelled'
    },

    // Media types
    MEDIA_TYPES: {
        IMAGE: 'image',
        VIDEO: 'video',
        AUDIO: 'audio',
        DOCUMENT: 'document',
        STICKER: 'sticker'
    },

    // Allowed image types
    ALLOWED_IMAGE_TYPES: ['jpeg', 'jpg', 'png', 'gif', 'webp'],
    
    // Allowed video types
    ALLOWED_VIDEO_TYPES: ['mp4', 'mkv', 'avi', 'mov'],
    
    // Allowed audio types
    ALLOWED_AUDIO_TYPES: ['mp3', 'm4a', 'ogg', 'wav'],
    
    // Allowed document types
    ALLOWED_DOCUMENT_TYPES: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt'],

    // Pagination defaults
    PAGINATION: {
        DEFAULT_LIMIT: 50,
        MAX_LIMIT: 1000,
        DEFAULT_OFFSET: 0
    },

    // Cache TTLs (ms)
    CACHE_TTL: {
        USER: 300000,        // 5 minutes
        SESSION: 300000,     // 5 minutes
        CHAT: 60000,         // 1 minute
        CONTACT: 60000,      // 1 minute
        MESSAGE: 300000,     // 5 minutes
        GROUP: 60000,        // 1 minute
        SETTINGS: 600000     // 10 minutes
    },

    // Rate limit defaults
    RATE_LIMITS: {
        REGISTER: { windowMs: 3600000, max: 5 },     // 5 per hour
        LOGIN: { windowMs: 900000, max: 10 },        // 10 per 15 min
        API: { windowMs: 900000, max: 100 },         // 100 per 15 min
        SEND_MESSAGE: { windowMs: 60000, max: 60 }   // 60 per minute
    },

    // HTTP status codes
    HTTP_STATUS: {
        OK: 200,
        CREATED: 201,
        ACCEPTED: 202,
        NO_CONTENT: 204,
        BAD_REQUEST: 400,
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        CONFLICT: 409,
        TOO_MANY_REQUESTS: 429,
        INTERNAL_SERVER_ERROR: 500,
        SERVICE_UNAVAILABLE: 503
    },

    // Error codes
    ERROR_CODES: {
        // Auth errors (1000-1999)
        MISSING_API_KEY: 1000,
        INVALID_API_KEY: 1001,
        UNAUTHORIZED: 1002,
        FORBIDDEN: 1003,
        ACCOUNT_EXPIRED: 1004,
        SESSION_LIMIT_EXCEEDED: 1005,
        
        // Validation errors (2000-2999)
        VALIDATION_ERROR: 2000,
        MISSING_FIELD: 2001,
        INVALID_FORMAT: 2002,
        
        // Resource errors (3000-3999)
        NOT_FOUND: 3000,
        ALREADY_EXISTS: 3001,
        CONSTRAINT_ERROR: 3002,
        
        // Rate limit errors (4000-4999)
        RATE_LIMIT_EXCEEDED: 4000,
        USER_RATE_LIMIT_EXCEEDED: 4001,
        
        // Database errors (5000-5999)
        DB_ERROR: 5000,
        DB_BUSY: 5001,
        DB_CONSTRAINT: 5002,
        
        // WhatsApp errors (6000-6999)
        CONNECTION_ERROR: 6000,
        SOCKET_ERROR: 6001,
        AUTH_ERROR: 6002,
        
        // File errors (7000-7999)
        FILE_TOO_LARGE: 7000,
        INVALID_FILE_TYPE: 7001,
        FILE_NOT_FOUND: 7002,
        
        // Server errors (8000-8999)
        INTERNAL_ERROR: 8000,
        SERVICE_UNAVAILABLE: 8001
    }
};