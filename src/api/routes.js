// src/api/routes.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { 
    auth, optionalAuth, requirePermission, allowRoles, sessionOwner,
    createRateLimiter, mediaSizeLimit, validate, handleValidationErrors,
    requestLogger, ROLES
} = require('./middleware');

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB default
});

module.exports = (manager, store) => {
    const router = express.Router();
    const rateLimiter = createRateLimiter(store);

    // Apply request logging to all routes
    router.use(requestLogger);

    // ==================== PUBLIC ROUTES ====================

    /**
     * @route   POST /api/register
     * @desc    Register new user
     * @access  Public (rate limited)
     */
    router.post('/register', 
        rateLimiter({ windowMs: 60 * 60 * 1000, max: 5 }),
        validate.register,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { username, password, role = ROLES.USER } = req.body;

                const existing = await store.getUserByUsername(username);
                if (existing) {
                    return res.status(409).json({ 
                        error: 'Username already exists',
                        code: 'USER_EXISTS'
                    });
                }

                const apiKey = crypto.randomBytes(32).toString('hex');
                await store.createUser(username, password, apiKey, role);

                await store.logActivity({
                    user_id: username,
                    action: 'register',
                    ip: req.ip,
                    user_agent: req.get('User-Agent')
                }).catch(() => {});

                res.json({ 
                    username, 
                    apiKey, 
                    role,
                    message: 'User created successfully'
                });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/login
     * @desc    Login user
     * @access  Public (rate limited)
     */
    router.post('/login',
        rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 }),
        validate.login,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { username, password } = req.body;

                const user = await store.getUserByUsername(username);
                if (!user || user.password !== password) {
                    return res.status(401).json({ 
                        error: 'Invalid credentials',
                        code: 'INVALID_CREDENTIALS'
                    });
                }

                await store.logActivity({
                    user_id: username,
                    action: 'login',
                    ip: req.ip,
                    user_agent: req.get('User-Agent')
                }).catch(() => {});

                res.json({
                    username: user.username,
                    apiKey: user.api_key,
                    role: user.role
                });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/health
     * @desc    Health check
     * @access  Public
     */
    router.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            sessions: manager.sessions.size
        });
    });

    // ==================== AUTHENTICATED ROUTES ====================
    // All routes below require valid API key

    router.use(auth(store));

    // ==================== USER ROUTES ====================

    /**
     * @route   GET /api/user
     * @desc    Get current user info
     * @access  Authenticated
     */
    router.get('/user', (req, res) => {
        res.json({
            username: req.user.username,
            role: req.user.role,
            meta: req.user.meta,
            created: req.user.created_at
        });
    });

    /**
     * @route   PUT /api/user/password
     * @desc    Update own password
     * @access  Authenticated
     */
    router.put('/user/password',
        validate.updatePassword,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { password } = req.body;
                await store.updateUser(req.user.username, { password });

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'update_password',
                    ip: req.ip,
                    session_id: req.session?.sid
                }).catch(() => {});

                res.json({ status: 'updated' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/user/reset-key
     * @desc    Reset own API key
     * @access  Authenticated
     */
    router.post('/user/reset-key',
        async (req, res) => {
            try {
                const newKey = crypto.randomBytes(32).toString('hex');
                await store.updateUser(req.user.username, { api_key: newKey });

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'reset_api_key',
                    ip: req.ip
                }).catch(() => {});

                res.json({ apiKey: newKey });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/user/meta
     * @desc    Get own user meta
     * @access  Authenticated
     */
    router.get('/user/meta',
        async (req, res) => {
            try {
                const meta = await store.getAllUserMeta(req.user.username);
                res.json(meta);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/user/meta
     * @desc    Set own user meta (limited keys)
     * @access  Authenticated
     */
    router.post('/user/meta',
        validate.userMeta,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { key, value } = req.body;
                
                // Users can only set certain meta keys
                const allowedKeys = ['theme', 'language', 'notifications', 'timezone'];
                if (!allowedKeys.includes(key)) {
                    return res.status(403).json({ 
                        error: 'Cannot set this meta key',
                        code: 'FORBIDDEN_META_KEY'
                    });
                }

                await store.setUserMeta(req.user.username, key, value);

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'set_user_meta',
                    resource: key,
                    details: { value },
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'set', key, value });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== ADMIN USER MANAGEMENT ====================

    /**
     * @route   GET /api/admin/users
     * @desc    Get all users (admin only)
     * @access  Admin/Superadmin
     */
    router.get('/admin/users',
        allowRoles([ROLES.ADMIN, ROLES.SUPERADMIN]),
        validate.pagination,
        async (req, res) => {
            try {
                const users = await store.getAllUsers();
                res.json(users);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/admin/users/:username
     * @desc    Get user details (admin only)
     * @access  Admin/Superadmin
     */
    router.get('/admin/users/:username',
        allowRoles([ROLES.ADMIN, ROLES.SUPERADMIN]),
        async (req, res) => {
            try {
                const user = await store.getUserByUsername(req.params.username);
                if (!user) {
                    return res.status(404).json({ 
                        error: 'User not found',
                        code: 'USER_NOT_FOUND'
                    });
                }

                const meta = await store.getAllUserMeta(req.params.username);
                const sessions = await store.getUserSessions(req.params.username);

                res.json({
                    username: user.username,
                    role: user.role,
                    api_key: user.api_key,
                    created_at: user.created_at,
                    updated_at: user.updated_at,
                    meta,
                    sessions: sessions.length
                });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   PUT /api/admin/users/:username
     * @desc    Update user (admin only)
     * @access  Admin/Superadmin
     */
    router.put('/admin/users/:username',
        allowRoles([ROLES.ADMIN, ROLES.SUPERADMIN]),
        validate.updateUser,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { username } = req.params;
                const updates = req.body;

                // Only superadmin can change roles to admin/moderator
                if (updates.role && 
                    [ROLES.ADMIN, ROLES.MODERATOR].includes(updates.role) &&
                    req.user.role !== ROLES.SUPERADMIN) {
                    return res.status(403).json({ 
                        error: 'Cannot assign this role',
                        code: 'ROLE_ASSIGNMENT_FORBIDDEN'
                    });
                }

                const user = await store.updateUser(username, updates);
                if (!user) {
                    return res.status(404).json({ 
                        error: 'User not found',
                        code: 'USER_NOT_FOUND'
                    });
                }

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'admin_update_user',
                    resource: username,
                    details: updates,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'updated' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   DELETE /api/admin/users/:username
     * @desc    Delete user (superadmin only)
     * @access  Superadmin
     */
    router.delete('/admin/users/:username',
        allowRoles([ROLES.SUPERADMIN]),
        async (req, res) => {
            try {
                const { username } = req.params;
                
                // Kill all sessions first
                await manager.killUserSessions(username);

                await store.deleteUser(username);

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'admin_delete_user',
                    resource: username,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'deleted' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/admin/users/:username/meta
     * @desc    Get user meta (admin only)
     * @access  Admin/Superadmin
     */
    router.get('/admin/users/:username/meta',
        allowRoles([ROLES.ADMIN, ROLES.SUPERADMIN]),
        async (req, res) => {
            try {
                const meta = await store.getAllUserMeta(req.params.username);
                res.json(meta);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/admin/users/:username/meta
     * @desc    Set user meta (admin can set any key)
     * @access  Admin/Superadmin
     */
    router.post('/admin/users/:username/meta',
        allowRoles([ROLES.ADMIN, ROLES.SUPERADMIN]),
        validate.updateUserMeta,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { username } = req.params;
                const updates = req.body;

                for (const [key, value] of Object.entries(updates)) {
                    await store.setUserMeta(username, key, value);
                }

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'admin_set_user_meta',
                    resource: username,
                    details: updates,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'updated', updates });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   DELETE /api/admin/users/:username/meta/:key
     * @desc    Delete user meta (admin only)
     * @access  Admin/Superadmin
     */
    router.delete('/admin/users/:username/meta/:key',
        allowRoles([ROLES.ADMIN, ROLES.SUPERADMIN]),
        async (req, res) => {
            try {
                const { username, key } = req.params;
                await store.deleteUserMeta(username, key);

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'admin_delete_user_meta',
                    resource: username,
                    details: { key },
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'deleted', key });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== GLOBAL SETTINGS ====================

    /**
     * @route   GET /api/global/settings
     * @desc    Get all global settings
     * @access  Authenticated
     */
    router.get('/global/settings',
        requirePermission('VIEW_SETTINGS'),
        async (req, res) => {
            try {
                const settings = await store.getAllGlobalSettings();
                res.json(settings);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/global/settings
     * @desc    Set global setting (admin only)
     * @access  Admin/Superadmin
     */
    router.post('/global/settings',
        requirePermission('MANAGE_SETTINGS'),
        async (req, res) => {
            try {
                const { key, value, description } = req.body;
                
                if (!key) {
                    return res.status(400).json({ 
                        error: 'Key required',
                        code: 'MISSING_KEY'
                    });
                }

                await store.setGlobalSetting(key, value, description);

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'set_global_setting',
                    resource: key,
                    details: { value },
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'set', key, value });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   DELETE /api/global/settings/:key
     * @desc    Delete global setting (admin only)
     * @access  Admin/Superadmin
     */
    router.delete('/global/settings/:key',
        requirePermission('MANAGE_SETTINGS'),
        async (req, res) => {
            try {
                await store.deleteGlobalSetting(req.params.key);

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'delete_global_setting',
                    resource: req.params.key,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'deleted', key: req.params.key });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== SESSION ROUTES ====================

    /**
     * @route   POST /api/sessions
     * @desc    Create new WhatsApp session
     * @access  Authenticated
     */
    router.post('/sessions',
        requirePermission('MANAGE_SESSIONS'),
        validate.createSession,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { platform, device, sid } = req.body;

                // Check user's session limit from meta
                const sessionLimit = req.user.meta?.session_limit || manager.maxPerUser;
                const userSessionCount = manager.countForUser(req.user.username);
                
                if (userSessionCount >= sessionLimit) {
                    return res.status(403).json({ 
                        error: 'Session limit reached',
                        code: 'SESSION_LIMIT_REACHED',
                        limit: sessionLimit,
                        current: userSessionCount
                    });
                }

                const result = await manager.create(req.user.username, {
                    platform: platform || 'web',
                    device: device || `device-${Date.now()}`,
                    sid
                });

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'create_session',
                    resource: result.sid,
                    details: { platform, device },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(400).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions
     * @desc    Get user's sessions
     * @access  Authenticated
     */
    router.get('/sessions',
        async (req, res) => {
            try {
                const sessions = await manager.getUserSessions(req.user.username);
                res.json(sessions);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/all
     * @desc    Get all sessions (admin only)
     * @access  Admin/Superadmin
     */
    router.get('/sessions/all',
        allowRoles([ROLES.ADMIN, ROLES.SUPERADMIN]),
        async (req, res) => {
            try {
                const sessions = manager.getAll();
                res.json(sessions);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== SESSION DETAIL ROUTES ====================
    // All routes below require session ownership

    router.use('/sessions/:sid', sessionOwner(manager));

    /**
     * @route   GET /api/sessions/:sid
     * @desc    Get session info
     * @access  Session Owner
     */
    router.get('/sessions/:sid',
        async (req, res) => {
            try {
                const info = await req.session.getInfo();
                res.json(info);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   DELETE /api/sessions/:sid
     * @desc    Remove session
     * @access  Session Owner
     */
    router.delete('/sessions/:sid',
        async (req, res) => {
            try {
                await manager.remove(req.params.sid, 'user_removed');

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'delete_session',
                    resource: req.params.sid,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'removed' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/logout
     * @desc    Logout from WhatsApp
     * @access  Session Owner
     */
    router.post('/sessions/:sid/logout',
        async (req, res) => {
            try {
                await req.session.logout();

                await store.logActivity({
                    user_id: req.user.username,
                    action: 'logout_session',
                    resource: req.params.sid,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'logged out' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/qr
     * @desc    Get current QR code
     * @access  Session Owner
     */
    router.get('/sessions/:sid/qr',
        async (req, res) => {
            try {
                res.json({ qr: req.session.qr });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/state
     * @desc    Get connection state
     * @access  Session Owner
     */
    router.get('/sessions/:sid/state',
        async (req, res) => {
            try {
                res.json({ 
                    state: req.session.state,
                    connected: req.session.state === 'open'
                });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/stats
     * @desc    Get session statistics
     * @access  Session Owner
     */
    router.get('/sessions/:sid/stats',
        async (req, res) => {
            try {
                const info = await req.session.getInfo();
                res.json(info.stats);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== CHAT ROUTES ====================

    /**
     * @route   GET /api/sessions/:sid/chats
     * @desc    Get all chats
     * @access  Session Owner
     */
    router.get('/sessions/:sid/chats',
        validate.pagination,
        async (req, res) => {
            try {
                const archived = req.query.archived === 'true';
                const chats = await req.session.getChats(archived);
                res.json(chats);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/chats/search
     * @desc    Search chats
     * @access  Session Owner
     */
    router.get('/sessions/:sid/chats/search',
        async (req, res) => {
            try {
                const { q } = req.query;
                if (!q) {
                    return res.status(400).json({ 
                        error: 'Search query required',
                        code: 'MISSING_QUERY'
                    });
                }

                const results = await req.session.db.searchChats(q);
                res.json(results);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/chats/unread
     * @desc    Get unread count
     * @access  Session Owner
     */
    router.get('/sessions/:sid/chats/unread',
        async (req, res) => {
            try {
                const count = await req.session.db.getUnreadCount();
                res.json({ count });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/chats/read-all
     * @desc    Mark all chats as read
     * @access  Session Owner
     */
    router.post('/sessions/:sid/chats/read-all',
        async (req, res) => {
            try {
                await req.session.db.markAllRead();

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'mark_all_read',
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'marked' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/chats/:jid
     * @desc    Get single chat
     * @access  Session Owner
     */
    router.get('/sessions/:sid/chats/:jid',
        async (req, res) => {
            try {
                const chat = await req.session.getChat(decodeURIComponent(req.params.jid));
                if (!chat) {
                    return res.status(404).json({ 
                        error: 'Chat not found',
                        code: 'CHAT_NOT_FOUND'
                    });
                }
                res.json(chat);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   PUT /api/sessions/:sid/chats/:jid
     * @desc    Update chat (archive, pin, mute)
     * @access  Session Owner
     */
    router.put('/sessions/:sid/chats/:jid',
        async (req, res) => {
            try {
                const { archived, pinned, mute_until } = req.body;
                const jid = decodeURIComponent(req.params.jid);

                const updates = {};
                if (archived !== undefined) updates.archived = archived ? 1 : 0;
                if (pinned !== undefined) updates.pinned = pinned ? 1 : 0;
                if (mute_until !== undefined) updates.mute_until = mute_until;

                await req.session.db.updateChat(jid, updates);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'update_chat',
                    resource: jid,
                    details: updates,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'updated' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   DELETE /api/sessions/:sid/chats/:jid
     * @desc    Delete chat
     * @access  Session Owner
     */
    router.delete('/sessions/:sid/chats/:jid',
        async (req, res) => {
            try {
                const jid = decodeURIComponent(req.params.jid);
                const hard = req.query.hard === 'true';
                
                await req.session.db.deleteChat(jid, !hard);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'delete_chat',
                    resource: jid,
                    details: { hard },
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'deleted' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== MESSAGE ROUTES ====================

    /**
     * @route   GET /api/sessions/:sid/chats/:jid/messages
     * @desc    Get chat messages
     * @access  Session Owner
     */
    router.get('/sessions/:sid/chats/:jid/messages',
        validate.pagination,
        async (req, res) => {
            try {
                const jid = decodeURIComponent(req.params.jid);
                const limit = parseInt(req.query.limit) || 50;
                const offset = parseInt(req.query.offset) || 0;
                const before = req.query.before ? parseInt(req.query.before) : null;
                const after = req.query.after ? parseInt(req.query.after) : null;

                const messages = await req.session.getMessages(jid, limit, offset, before, after);
                res.json(messages);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/chats/:jid/messages/search
     * @desc    Search messages in chat
     * @access  Session Owner
     */
    router.post('/sessions/:sid/chats/:jid/messages/search',
        async (req, res) => {
            try {
                const { q } = req.body;
                const limit = parseInt(req.query.limit) || 50;
                
                if (!q) {
                    return res.status(400).json({ 
                        error: 'Search query required',
                        code: 'MISSING_QUERY'
                    });
                }

                const jid = decodeURIComponent(req.params.jid);
                const results = await req.session.searchMessages(q, jid, limit);
                res.json(results);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/messages/:msgId
     * @desc    Get single message
     * @access  Session Owner
     */
    router.get('/sessions/:sid/messages/:msgId',
        async (req, res) => {
            try {
                const msg = await req.session.getMessage(req.params.msgId);
                if (!msg) {
                    return res.status(404).json({ 
                        error: 'Message not found',
                        code: 'MESSAGE_NOT_FOUND'
                    });
                }
                res.json(msg);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/messages/:msgId/media
     * @desc    Get message media
     * @access  Session Owner
     */
    router.get('/sessions/:sid/messages/:msgId/media',
        async (req, res) => {
            try {
                const media = await req.session.db.getMedia(req.params.msgId);
                if (!media || !media.url || !fs.existsSync(media.url)) {
                    return res.status(404).json({ 
                        error: 'Media not found',
                        code: 'MEDIA_NOT_FOUND'
                    });
                }

                res.sendFile(path.resolve(media.url));
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/messages/:msgId/receipts
     * @desc    Get message receipts
     * @access  Session Owner
     */
    router.get('/sessions/:sid/messages/:msgId/receipts',
        async (req, res) => {
            try {
                const receipts = await req.session.db.getMsgReceipts(req.params.msgId);
                res.json(receipts);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/messages/:msgId/star
     * @desc    Star/unstar message
     * @access  Session Owner
     */
    router.post('/sessions/:sid/messages/:msgId/star',
        async (req, res) => {
            try {
                const { starred } = req.body;
                await req.session.db.starMsg(req.params.msgId, starred);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'star_message',
                    resource: req.params.msgId,
                    details: { starred },
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'updated', starred });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   DELETE /api/sessions/:sid/messages/:msgId
     * @desc    Delete message
     * @access  Session Owner
     */
    router.delete('/sessions/:sid/messages/:msgId',
        async (req, res) => {
            try {
                const hard = req.query.hard === 'true';
                await req.session.db.deleteMsg(req.params.msgId, !hard);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'delete_message',
                    resource: req.params.msgId,
                    details: { hard },
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'deleted' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/messages/starred
     * @desc    Get starred messages
     * @access  Session Owner
     */
    router.get('/sessions/:sid/messages/starred',
        validate.pagination,
        async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 50;
                const starred = await req.session.getStarred(limit);
                res.json(starred);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== SEND ROUTES ====================

    /**
     * @route   POST /api/sessions/:sid/send/text
     * @desc    Send text message
     * @access  Session Owner (requires SEND_MESSAGES permission)
     */
    router.post('/sessions/:sid/send/text',
        requirePermission('SEND_MESSAGES'),
        validate.sendMessage,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { jid, text } = req.body;
                const result = await req.session.sendMessage(
                    decodeURIComponent(jid), 
                    text, 
                    'text'
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'send_text',
                    resource: jid,
                    details: { text: text.substring(0, 100) },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/send/media
     * @desc    Send media message
     * @access  Session Owner (requires SEND_MESSAGES permission)
     */
    router.post('/sessions/:sid/send/media',
        requirePermission('SEND_MESSAGES'),
        upload.single('file'),
        mediaSizeLimit(),
        async (req, res) => {
            try {
                const { jid, type, caption, fileName } = req.body;
                
                if (!req.file) {
                    return res.status(400).json({ 
                        error: 'File required',
                        code: 'MISSING_FILE'
                    });
                }

                const content = {
                    buffer: req.file.buffer,
                    caption,
                    name: fileName || req.file.originalname
                };

                const result = await req.session.sendMessage(
                    decodeURIComponent(jid),
                    content,
                    type
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'send_media',
                    resource: jid,
                    details: { type, size: req.file.size },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/send/location
     * @desc    Send location
     * @access  Session Owner (requires SEND_MESSAGES permission)
     */
    router.post('/sessions/:sid/send/location',
        requirePermission('SEND_MESSAGES'),
        async (req, res) => {
            try {
                const { jid, latitude, longitude, name, address } = req.body;
                
                if (!jid || !latitude || !longitude) {
                    return res.status(400).json({ 
                        error: 'JID, latitude and longitude required',
                        code: 'MISSING_LOCATION_DATA'
                    });
                }

                const location = {
                    latitude: parseFloat(latitude),
                    longitude: parseFloat(longitude),
                    name,
                    address
                };

                const result = await req.session.sendMessage(
                    decodeURIComponent(jid),
                    location,
                    'location'
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'send_location',
                    resource: jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/send/contact
     * @desc    Send contact
     * @access  Session Owner (requires SEND_MESSAGES permission)
     */
    router.post('/sessions/:sid/send/contact',
        requirePermission('SEND_MESSAGES'),
        async (req, res) => {
            try {
                const { jid, name, number } = req.body;
                
                if (!jid || !name || !number) {
                    return res.status(400).json({ 
                        error: 'JID, name and number required',
                        code: 'MISSING_CONTACT_DATA'
                    });
                }

                const contact = { name, number };
                const result = await req.session.sendMessage(
                    decodeURIComponent(jid),
                    contact,
                    'contact'
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'send_contact',
                    resource: jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/send/reaction
     * @desc    Send reaction
     * @access  Session Owner (requires SEND_MESSAGES permission)
     */
    router.post('/sessions/:sid/send/reaction',
        requirePermission('SEND_MESSAGES'),
        validate.sendReaction,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { jid, msgId, emoji } = req.body;
                const result = await req.session.sendReaction(
                    decodeURIComponent(jid),
                    msgId,
                    emoji
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'send_reaction',
                    resource: jid,
                    details: { msgId, emoji },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/send/bulk
     * @desc    Send bulk messages (moderator+)
     * @access  Moderator+ (requires BULK_OPERATIONS permission)
     */
    router.post('/sessions/:sid/send/bulk',
        requirePermission('BULK_OPERATIONS'),
        async (req, res) => {
            try {
                const { jids, text } = req.body;
                
                if (!jids || !Array.isArray(jids) || jids.length === 0) {
                    return res.status(400).json({ 
                        error: 'JIDs array required',
                        code: 'MISSING_JIDS'
                    });
                }

                const results = [];
                for (const jid of jids) {
                    try {
                        const result = await req.session.sendMessage(
                            decodeURIComponent(jid),
                            text,
                            'text'
                        );
                        results.push({ jid, success: true, result });
                    } catch (err) {
                        results.push({ jid, success: false, error: err.message });
                    }
                }

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'bulk_send',
                    details: { count: jids.length, success: results.filter(r => r.success).length },
                    ip: req.ip
                }).catch(() => {});

                res.json({ results });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== ACTION ROUTES ====================

    /**
     * @route   POST /api/sessions/:sid/read
     * @desc    Mark message as read
     * @access  Session Owner
     */
    router.post('/sessions/:sid/read',
        validate.markRead,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { jid, msgId } = req.body;
                await req.session.markRead(decodeURIComponent(jid), msgId);

                res.json({ status: 'marked read' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/presence
     * @desc    Update presence
     * @access  Session Owner
     */
    router.post('/sessions/:sid/presence',
        validate.presence,
        handleValidationErrors,
        async (req, res) => {
            try {
                const { jid, state } = req.body;
                await req.session.setPresence(decodeURIComponent(jid), state);

                res.json({ status: 'updated' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== CONTACT ROUTES ====================

    /**
     * @route   GET /api/sessions/:sid/contacts
     * @desc    Get all contacts
     * @access  Session Owner
     */
    router.get('/sessions/:sid/contacts',
        async (req, res) => {
            try {
                const contacts = await req.session.getContacts();
                res.json(contacts);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/contacts/search
     * @desc    Search contacts
     * @access  Session Owner
     */
    router.get('/sessions/:sid/contacts/search',
        async (req, res) => {
            try {
                const { q } = req.query;
                if (!q) {
                    return res.status(400).json({ 
                        error: 'Search query required',
                        code: 'MISSING_QUERY'
                    });
                }

                const results = await req.session.db.searchContacts(q);
                res.json(results);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/contacts/:jid
     * @desc    Get single contact
     * @access  Session Owner
     */
    router.get('/sessions/:sid/contacts/:jid',
        async (req, res) => {
            try {
                const contact = await req.session.getContact(decodeURIComponent(req.params.jid));
                if (!contact) {
                    return res.status(404).json({ 
                        error: 'Contact not found',
                        code: 'CONTACT_NOT_FOUND'
                    });
                }
                res.json(contact);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   PUT /api/sessions/:sid/contacts/:jid
     * @desc    Update contact name
     * @access  Session Owner
     */
    router.put('/sessions/:sid/contacts/:jid',
        async (req, res) => {
            try {
                const { name } = req.body;
                if (!name) {
                    return res.status(400).json({ 
                        error: 'Name required',
                        code: 'MISSING_NAME'
                    });
                }

                await req.session.db.updateContact(
                    decodeURIComponent(req.params.jid),
                    { name }
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'update_contact',
                    resource: req.params.jid,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'updated' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== BLOCK ROUTES ====================

    /**
     * @route   POST /api/sessions/:sid/block/:jid
     * @desc    Block contact
     * @access  Session Owner
     */
    router.post('/sessions/:sid/block/:jid',
        async (req, res) => {
            try {
                await req.session.blockUser(decodeURIComponent(req.params.jid), true);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'block_user',
                    resource: req.params.jid,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'blocked' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/unblock/:jid
     * @desc    Unblock contact
     * @access  Session Owner
     */
    router.post('/sessions/:sid/unblock/:jid',
        async (req, res) => {
            try {
                await req.session.blockUser(decodeURIComponent(req.params.jid), false);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'unblock_user',
                    resource: req.params.jid,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'unblocked' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/blocked
     * @desc    Get blocked contacts
     * @access  Session Owner
     */
    router.get('/sessions/:sid/blocked',
        async (req, res) => {
            try {
                const blocked = await req.session.getBlocked();
                res.json(blocked);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== GROUP ROUTES ====================

    /**
     * @route   POST /api/sessions/:sid/groups
     * @desc    Create group
     * @access  Session Owner (requires MANAGE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups',
        requirePermission('MANAGE_GROUPS'),
        async (req, res) => {
            try {
                const { subject, participants } = req.body;
                
                if (!subject) {
                    return res.status(400).json({ 
                        error: 'Subject required',
                        code: 'MISSING_SUBJECT'
                    });
                }

                const result = await req.session.groupAction(
                    'create',
                    subject,
                    participants || []
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'create_group',
                    details: { subject, participantsCount: participants?.length },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/groups
     * @desc    Get all groups
     * @access  Session Owner
     */
    router.get('/sessions/:sid/groups',
        async (req, res) => {
            try {
                const groups = await req.session.getGroups();
                res.json(groups);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/groups/search
     * @desc    Search groups
     * @access  Session Owner
     */
    router.get('/sessions/:sid/groups/search',
        async (req, res) => {
            try {
                const { q } = req.query;
                if (!q) {
                    return res.status(400).json({ 
                        error: 'Search query required',
                        code: 'MISSING_QUERY'
                    });
                }

                const results = await req.session.db.searchGroups(q);
                res.json(results);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/groups/:jid
     * @desc    Get single group
     * @access  Session Owner
     */
    router.get('/sessions/:sid/groups/:jid',
        async (req, res) => {
            try {
                const group = await req.session.getGroup(decodeURIComponent(req.params.jid));
                if (!group) {
                    return res.status(404).json({ 
                        error: 'Group not found',
                        code: 'GROUP_NOT_FOUND'
                    });
                }
                res.json(group);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/groups/:jid/members
     * @desc    Get group members
     * @access  Session Owner
     */
    router.get('/sessions/:sid/groups/:jid/members',
        async (req, res) => {
            try {
                const members = await req.session.getGroupMembers(decodeURIComponent(req.params.jid));
                res.json(members);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   PUT /api/sessions/:sid/groups/:jid/subject
     * @desc    Update group subject
     * @access  Session Owner (requires MANAGE_GROUPS permission)
     */
    router.put('/sessions/:sid/groups/:jid/subject',
        requirePermission('MANAGE_GROUPS'),
        async (req, res) => {
            try {
                const { subject } = req.body;
                if (!subject) {
                    return res.status(400).json({ 
                        error: 'Subject required',
                        code: 'MISSING_SUBJECT'
                    });
                }

                const result = await req.session.groupAction(
                    'subject',
                    decodeURIComponent(req.params.jid),
                    [subject]
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'update_group_subject',
                    resource: req.params.jid,
                    details: { subject },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   PUT /api/sessions/:sid/groups/:jid/description
     * @desc    Update group description
     * @access  Session Owner (requires MANAGE_GROUPS permission)
     */
    router.put('/sessions/:sid/groups/:jid/description',
        requirePermission('MANAGE_GROUPS'),
        async (req, res) => {
            try {
                const { description } = req.body;
                if (!description) {
                    return res.status(400).json({ 
                        error: 'Description required',
                        code: 'MISSING_DESCRIPTION'
                    });
                }

                const result = await req.session.groupAction(
                    'desc',
                    decodeURIComponent(req.params.jid),
                    [description]
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'update_group_desc',
                    resource: req.params.jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/:jid/add
     * @desc    Add participants to group
     * @access  Session Owner (requires MANAGE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups/:jid/add',
        requirePermission('MANAGE_GROUPS'),
        async (req, res) => {
            try {
                const { participants } = req.body;
                if (!participants || !participants.length) {
                    return res.status(400).json({ 
                        error: 'Participants required',
                        code: 'MISSING_PARTICIPANTS'
                    });
                }

                const result = await req.session.groupAction(
                    'add',
                    decodeURIComponent(req.params.jid),
                    participants
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_add_participants',
                    resource: req.params.jid,
                    details: { count: participants.length },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/:jid/remove
     * @desc    Remove participants from group
     * @access  Session Owner (requires MANAGE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups/:jid/remove',
        requirePermission('MANAGE_GROUPS'),
        async (req, res) => {
            try {
                const { participants } = req.body;
                if (!participants || !participants.length) {
                    return res.status(400).json({ 
                        error: 'Participants required',
                        code: 'MISSING_PARTICIPANTS'
                    });
                }

                const result = await req.session.groupAction(
                    'remove',
                    decodeURIComponent(req.params.jid),
                    participants
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_remove_participants',
                    resource: req.params.jid,
                    details: { count: participants.length },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/:jid/promote
     * @desc    Promote participants to admin
     * @access  Session Owner (requires MANAGE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups/:jid/promote',
        requirePermission('MANAGE_GROUPS'),
        async (req, res) => {
            try {
                const { participants } = req.body;
                if (!participants || !participants.length) {
                    return res.status(400).json({ 
                        error: 'Participants required',
                        code: 'MISSING_PARTICIPANTS'
                    });
                }

                const result = await req.session.groupAction(
                    'promote',
                    decodeURIComponent(req.params.jid),
                    participants
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_promote',
                    resource: req.params.jid,
                    details: { count: participants.length },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/:jid/demote
     * @desc    Demote participants from admin
     * @access  Session Owner (requires MANAGE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups/:jid/demote',
        requirePermission('MANAGE_GROUPS'),
        async (req, res) => {
            try {
                const { participants } = req.body;
                if (!participants || !participants.length) {
                    return res.status(400).json({ 
                        error: 'Participants required',
                        code: 'MISSING_PARTICIPANTS'
                    });
                }

                const result = await req.session.groupAction(
                    'demote',
                    decodeURIComponent(req.params.jid),
                    participants
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_demote',
                    resource: req.params.jid,
                    details: { count: participants.length },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/:jid/announce
     * @desc    Set group to announcement mode
     * @access  Session Owner (requires MODERATE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups/:jid/announce',
        requirePermission('MODERATE_GROUPS'),
        async (req, res) => {
            try {
                const result = await req.session.groupAction(
                    'announce',
                    decodeURIComponent(req.params.jid)
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_announce_on',
                    resource: req.params.jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/:jid/unannounce
     * @desc    Disable announcement mode
     * @access  Session Owner (requires MODERATE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups/:jid/unannounce',
        requirePermission('MODERATE_GROUPS'),
        async (req, res) => {
            try {
                const result = await req.session.groupAction(
                    'not_announce',
                    decodeURIComponent(req.params.jid)
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_announce_off',
                    resource: req.params.jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/:jid/lock
     * @desc    Lock group
     * @access  Session Owner (requires MODERATE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups/:jid/lock',
        requirePermission('MODERATE_GROUPS'),
        async (req, res) => {
            try {
                const result = await req.session.groupAction(
                    'lock',
                    decodeURIComponent(req.params.jid)
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_lock',
                    resource: req.params.jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/:jid/unlock
     * @desc    Unlock group
     * @access  Session Owner (requires MODERATE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups/:jid/unlock',
        requirePermission('MODERATE_GROUPS'),
        async (req, res) => {
            try {
                const result = await req.session.groupAction(
                    'unlock',
                    decodeURIComponent(req.params.jid)
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_unlock',
                    resource: req.params.jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/groups/:jid/invite
     * @desc    Get group invite code
     * @access  Session Owner (requires MANAGE_GROUPS permission)
     */
    router.get('/sessions/:sid/groups/:jid/invite',
        requirePermission('MANAGE_GROUPS'),
        async (req, res) => {
            try {
                const result = await req.session.groupAction(
                    'invite',
                    decodeURIComponent(req.params.jid)
                );

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/:jid/revoke
     * @desc    Revoke group invite code
     * @access  Session Owner (requires MANAGE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups/:jid/revoke',
        requirePermission('MANAGE_GROUPS'),
        async (req, res) => {
            try {
                const result = await req.session.groupAction(
                    'revoke',
                    decodeURIComponent(req.params.jid)
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_revoke_invite',
                    resource: req.params.jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/join
     * @desc    Join group with invite code
     * @access  Session Owner (requires MANAGE_GROUPS permission)
     */
    router.post('/sessions/:sid/groups/join',
        requirePermission('MANAGE_GROUPS'),
        async (req, res) => {
            try {
                const { code } = req.body;
                if (!code) {
                    return res.status(400).json({ 
                        error: 'Invite code required',
                        code: 'MISSING_CODE'
                    });
                }

                const result = await req.session.groupAction('join', null, [code]);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_join',
                    details: { code },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/groups/leave
     * @desc    Leave group
     * @access  Session Owner
     */
    router.post('/sessions/:sid/groups/leave',
        async (req, res) => {
            try {
                const { jid } = req.body;
                if (!jid) {
                    return res.status(400).json({ 
                        error: 'Group JID required',
                        code: 'MISSING_JID'
                    });
                }

                const result = await req.session.groupAction(
                    'leave',
                    decodeURIComponent(jid)
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'group_leave',
                    resource: jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== PROFILE ROUTES ====================

    /**
     * @route   PUT /api/sessions/:sid/profile/name
     * @desc    Update profile name
     * @access  Session Owner
     */
    router.put('/sessions/:sid/profile/name',
        async (req, res) => {
            try {
                const { name } = req.body;
                if (!name) {
                    return res.status(400).json({ 
                        error: 'Name required',
                        code: 'MISSING_NAME'
                    });
                }

                const result = await req.session.profileAction('name', null, name);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'update_profile_name',
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   PUT /api/sessions/:sid/profile/status
     * @desc    Update profile status
     * @access  Session Owner
     */
    router.put('/sessions/:sid/profile/status',
        async (req, res) => {
            try {
                const { status } = req.body;
                if (!status) {
                    return res.status(400).json({ 
                        error: 'Status required',
                        code: 'MISSING_STATUS'
                    });
                }

                const result = await req.session.profileAction('status', null, status);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'update_profile_status',
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/profile/picture
     * @desc    Update profile picture
     * @access  Session Owner
     */
    router.post('/sessions/:sid/profile/picture',
        upload.single('image'),
        mediaSizeLimit(),
        async (req, res) => {
            try {
                if (!req.file) {
                    return res.status(400).json({ 
                        error: 'Image required',
                        code: 'MISSING_IMAGE'
                    });
                }

                const { jid } = req.body;
                const result = await req.session.profileAction(
                    'pic',
                    jid || req.params.sid,
                    req.file.buffer
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'update_profile_picture',
                    resource: jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   DELETE /api/sessions/:sid/profile/picture
     * @desc    Remove profile picture
     * @access  Session Owner
     */
    router.delete('/sessions/:sid/profile/picture',
        async (req, res) => {
            try {
                const { jid } = req.body;
                const result = await req.session.profileAction(
                    'pic_rm',
                    jid || req.params.sid
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'remove_profile_picture',
                    resource: jid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/profile/status/:jid
     * @desc    Get contact's status
     * @access  Session Owner
     */
    router.get('/sessions/:sid/profile/status/:jid',
        async (req, res) => {
            try {
                const result = await req.session.profileAction(
                    'get_status',
                    decodeURIComponent(req.params.jid)
                );

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== CALL ROUTES ====================

    /**
     * @route   GET /api/sessions/:sid/calls
     * @desc    Get call history
     * @access  Session Owner
     */
    router.get('/sessions/:sid/calls',
        validate.pagination,
        async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 50;
                const calls = await req.session.getCalls(limit);
                res.json(calls);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/calls/missed
     * @desc    Get missed calls
     * @access  Session Owner
     */
    router.get('/sessions/:sid/calls/missed',
        async (req, res) => {
            try {
                const calls = await req.session.getMissedCalls();
                res.json(calls);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== LABEL ROUTES ====================

    /**
     * @route   GET /api/sessions/:sid/labels
     * @desc    Get all labels
     * @access  Session Owner
     */
    router.get('/sessions/:sid/labels',
        async (req, res) => {
            try {
                const labels = await req.session.getLabels();
                res.json(labels);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/labels
     * @desc    Create label
     * @access  Session Owner (requires MANAGE_LABELS permission)
     */
    router.post('/sessions/:sid/labels',
        requirePermission('MANAGE_LABELS'),
        async (req, res) => {
            try {
                const { name, color } = req.body;
                if (!name) {
                    return res.status(400).json({ 
                        error: 'Name required',
                        code: 'MISSING_NAME'
                    });
                }

                const labelId = `label_${Date.now()}`;
                await req.session.db.upsertLabel({
                    id: labelId,
                    name,
                    color: color || '#888888'
                });

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'create_label',
                    resource: labelId,
                    details: { name, color },
                    ip: req.ip
                }).catch(() => {});

                res.json({ id: labelId, name, color });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   PUT /api/sessions/:sid/labels/:labelId
     * @desc    Update label
     * @access  Session Owner (requires MANAGE_LABELS permission)
     */
    router.put('/sessions/:sid/labels/:labelId',
        requirePermission('MANAGE_LABELS'),
        async (req, res) => {
            try {
                const { name, color } = req.body;
                const label = await req.session.db.getLabel(req.params.labelId);
                
                if (!label) {
                    return res.status(404).json({ 
                        error: 'Label not found',
                        code: 'LABEL_NOT_FOUND'
                    });
                }

                await req.session.db.upsertLabel({
                    id: req.params.labelId,
                    name: name || label.name,
                    color: color || label.color
                });

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'update_label',
                    resource: req.params.labelId,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'updated' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   DELETE /api/sessions/:sid/labels/:labelId
     * @desc    Delete label
     * @access  Session Owner (requires MANAGE_LABELS permission)
     */
    router.delete('/sessions/:sid/labels/:labelId',
        requirePermission('MANAGE_LABELS'),
        async (req, res) => {
            try {
                await req.session.db.deleteLabel(req.params.labelId);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'delete_label',
                    resource: req.params.labelId,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'deleted' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/labels/:labelId/chats/:jid
     * @desc    Add label to chat
     * @access  Session Owner (requires MANAGE_LABELS permission)
     */
    router.post('/sessions/:sid/labels/:labelId/chats/:jid',
        requirePermission('MANAGE_LABELS'),
        async (req, res) => {
            try {
                await req.session.db.addLabelToChat(
                    req.params.labelId,
                    decodeURIComponent(req.params.jid)
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'add_label_to_chat',
                    resource: req.params.jid,
                    details: { labelId: req.params.labelId },
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'added' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   DELETE /api/sessions/:sid/labels/:labelId/chats/:jid
     * @desc    Remove label from chat
     * @access  Session Owner (requires MANAGE_LABELS permission)
     */
    router.delete('/sessions/:sid/labels/:labelId/chats/:jid',
        requirePermission('MANAGE_LABELS'),
        async (req, res) => {
            try {
                await req.session.db.removeLabelFromChat(
                    req.params.labelId,
                    decodeURIComponent(req.params.jid)
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'remove_label_from_chat',
                    resource: req.params.jid,
                    details: { labelId: req.params.labelId },
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'removed' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/chats/:jid/labels
     * @desc    Get labels for a chat
     * @access  Session Owner
     */
    router.get('/sessions/:sid/chats/:jid/labels',
        async (req, res) => {
            try {
                const labels = await req.session.getChatLabels(decodeURIComponent(req.params.jid));
                res.json(labels);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== NEWSLETTER ROUTES ====================

    /**
     * @route   POST /api/sessions/:sid/newsletters
     * @desc    Create newsletter
     * @access  Session Owner
     */
    router.post('/sessions/:sid/newsletters',
        async (req, res) => {
            try {
                const { name, description } = req.body;
                if (!name) {
                    return res.status(400).json({ 
                        error: 'Name required',
                        code: 'MISSING_NAME'
                    });
                }

                const result = await req.session.newsletterAction(
                    'create',
                    null,
                    { name, description }
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'create_newsletter',
                    details: { name },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/newsletters
     * @desc    Get all newsletters
     * @access  Session Owner
     */
    router.get('/sessions/:sid/newsletters',
        async (req, res) => {
            try {
                const newsletters = await req.session.getNewsletters();
                res.json(newsletters);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/newsletters/:nid/follow
     * @desc    Follow newsletter
     * @access  Session Owner
     */
    router.post('/sessions/:sid/newsletters/:nid/follow',
        async (req, res) => {
            try {
                const result = await req.session.newsletterAction(
                    'follow',
                    req.params.nid
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'follow_newsletter',
                    resource: req.params.nid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/newsletters/:nid/unfollow
     * @desc    Unfollow newsletter
     * @access  Session Owner
     */
    router.post('/sessions/:sid/newsletters/:nid/unfollow',
        async (req, res) => {
            try {
                const result = await req.session.newsletterAction(
                    'unfollow',
                    req.params.nid
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'unfollow_newsletter',
                    resource: req.params.nid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/newsletters/:nid/send
     * @desc    Send message to newsletter
     * @access  Session Owner
     */
    router.post('/sessions/:sid/newsletters/:nid/send',
        async (req, res) => {
            try {
                const { text } = req.body;
                if (!text) {
                    return res.status(400).json({ 
                        error: 'Text required',
                        code: 'MISSING_TEXT'
                    });
                }

                const result = await req.session.newsletterAction(
                    'send',
                    req.params.nid,
                    text
                );

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'send_newsletter',
                    resource: req.params.nid,
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/newsletters/:nid/posts
     * @desc    Get newsletter posts
     * @access  Session Owner
     */
    router.get('/sessions/:sid/newsletters/:nid/posts',
        validate.pagination,
        async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 50;
                const posts = await req.session.getNewsletterPosts(req.params.nid, limit);
                res.json(posts);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== WEBHOOK ROUTES ====================

    /**
     * @route   POST /api/sessions/:sid/webhooks
     * @desc    Create webhook
     * @access  Session Owner (requires MANAGE_WEBHOOKS permission)
     */
    router.post('/sessions/:sid/webhooks',
        requirePermission('MANAGE_WEBHOOKS'),
        validate.createWebhook,
        handleValidationErrors,
        async (req, res) => {
            try {
                const result = await req.session.createWebhook(req.body);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'create_webhook',
                    resource: result.id,
                    details: { event: req.body.event },
                    ip: req.ip
                }).catch(() => {});

                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/webhooks
     * @desc    Get all webhooks
     * @access  Session Owner (requires MANAGE_WEBHOOKS permission)
     */
    router.get('/sessions/:sid/webhooks',
        requirePermission('MANAGE_WEBHOOKS'),
        async (req, res) => {
            try {
                const webhooks = await req.session.getWebhooks();
                res.json(webhooks);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   DELETE /api/sessions/:sid/webhooks/:id
     * @desc    Delete webhook
     * @access  Session Owner (requires MANAGE_WEBHOOKS permission)
     */
    router.delete('/sessions/:sid/webhooks/:id',
        requirePermission('MANAGE_WEBHOOKS'),
        async (req, res) => {
            try {
                await req.session.deleteWebhook(req.params.id);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'delete_webhook',
                    resource: req.params.id,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'deleted' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   POST /api/sessions/:sid/webhooks/:id/test
     * @desc    Test webhook
     * @access  Session Owner (requires MANAGE_WEBHOOKS permission)
     */
    router.post('/sessions/:sid/webhooks/:id/test',
        requirePermission('MANAGE_WEBHOOKS'),
        async (req, res) => {
            try {
                const result = await req.session.testWebhook(req.params.id);
                res.json(result);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== BACKUP ROUTES ====================

    /**
     * @route   POST /api/sessions/:sid/backup
     * @desc    Create backup
     * @access  Session Owner (requires CREATE_BACKUP permission)
     */
    router.post('/sessions/:sid/backup',
        requirePermission('CREATE_BACKUP'),
        async (req, res) => {
            try {
                const { includes_media = false } = req.body;
                
                const backupPath = path.join(
                    process.env.BACKUP_PATH || './data/backups',
                    `${req.params.sid}_${Date.now()}.db`
                );

                const backup = await req.session.db.backup(backupPath);

                const record = await req.session.db.createBackupRecord({
                    type: 'manual',
                    path: backupPath,
                    size: backup.size,
                    includes_media,
                    status: 'completed',
                    metadata: { requestedBy: req.user.username }
                });

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'create_backup',
                    resource: record.id,
                    details: { size: backup.size },
                    ip: req.ip
                }).catch(() => {});

                res.json({ 
                    id: record.id,
                    path: backupPath,
                    size: backup.size,
                    created: backup.created
                });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/backups
     * @desc    Get session backups
     * @access  Session Owner (requires VIEW_SYSTEM permission)
     */
    router.get('/sessions/:sid/backups',
        requirePermission('VIEW_SYSTEM'),
        async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 10;
                const backups = await req.session.db.getSessionBackups(limit);
                res.json(backups);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== SETTINGS ROUTES ====================

    /**
     * @route   GET /api/sessions/:sid/settings
     * @desc    Get session settings
     * @access  Session Owner
     */
    router.get('/sessions/:sid/settings',
        async (req, res) => {
            try {
                const settings = await req.session.getSettings();
                res.json(settings);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/sessions/:sid/settings/:name
     * @desc    Get specific setting
     * @access  Session Owner
     */
    router.get('/sessions/:sid/settings/:name',
        async (req, res) => {
            try {
                const value = await req.session.getSetting(req.params.name);
                res.json({ [req.params.name]: value });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   PUT /api/sessions/:sid/settings/:name
     * @desc    Update setting
     * @access  Session Owner (requires MANAGE_SETTINGS permission)
     */
    router.put('/sessions/:sid/settings/:name',
        requirePermission('MANAGE_SETTINGS'),
        async (req, res) => {
            try {
                const { value } = req.body;
                await req.session.db.setSessionSetting(req.params.name, value);

                await store.logActivity({
                    user_id: req.user.username,
                    session_id: req.params.sid,
                    action: 'update_setting',
                    resource: req.params.name,
                    ip: req.ip
                }).catch(() => {});

                res.json({ status: 'updated' });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== ACTIVITY ROUTES ====================

    /**
     * @route   GET /api/sessions/:sid/activity
     * @desc    Get session activity logs
     * @access  Session Owner (requires VIEW_SYSTEM permission)
     */
    router.get('/sessions/:sid/activity',
        requirePermission('VIEW_SYSTEM'),
        validate.pagination,
        async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 50;
                const logs = await req.session.db.getSessionActivity(limit);
                res.json(logs);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    /**
     * @route   GET /api/user/activity
     * @desc    Get user activity logs
     * @access  Authenticated
     */
    router.get('/user/activity',
        validate.pagination,
        async (req, res) => {
            try {
                const limit = parseInt(req.query.limit) || 50;
                const offset = parseInt(req.query.offset) || 0;
                const logs = await store.getUserActivity(req.user.username, limit, offset);
                res.json(logs);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    // ==================== STATS ROUTES ====================

    /**
     * @route   GET /api/admin/stats
     * @desc    Get system statistics (admin only)
     * @access  Admin/Superadmin
     */
    router.get('/admin/stats',
        allowRoles([ROLES.ADMIN, ROLES.SUPERADMIN]),
        async (req, res) => {
            try {
                const stats = manager.getStats();
                const dbSize = await store.getDbSize();
                
                res.json({
                    ...stats,
                    dbSize,
                    uptime: process.uptime()
                });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    return router;
};