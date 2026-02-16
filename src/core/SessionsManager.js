// src/core/SessionsManager.js
const SessionHandler = require('./SessionHandler');
const SQLiteStores = require('./SQLiteStores');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { sleep, retry, formatDuration } = require('../utils/helpers');

class SessionsManager {
    /**
     * Create new sessions manager
     * @param {Object} options - Manager options
     * @param {WebSocket.Server} options.wss - WebSocket server
     * @param {string} options.dbPath - Database path
     * @param {number} options.maxPerUser - Max sessions per user
     * @param {number} options.maxTotal - Max total sessions
     * @param {number} options.sessionTimeout - Session timeout in ms
     */
    constructor(options = {}) {
        this.sessions = new Map();           // sid -> SessionHandler
        this.userSessions = new Map();       // uid -> Set of sids
        this.wss = options.wss || null;
        this.dbPath = options.dbPath || './data/db.db';
        this.maxPerUser = options.maxPerUser || 5;
        this.maxTotal = options.maxTotal || 100;
        this.sessionTimeout = options.sessionTimeout || 30 * 60 * 1000; // 30 mins
        this.cleanupInterval = null;
        this.restoreInProgress = false;
        this.isShuttingDown = false;
        this.stats = {
            created: 0,
            closed: 0,
            errors: 0,
            restored: 0,
            startTime: Date.now()
        };
        this.limits = new Map(); // User-specific limits cache
        this.limitsCacheTime = 0;
        this.store = null;
    }

    // ==================== INIT ====================

    /**
     * Initialize manager
     * @returns {Promise<this>}
     */
    async init() {
        logger.info('Initializing sessions manager');

        try {
            // Initialize global store with retry
            const store = new SQLiteStores(null, this.dbPath);
            await retry(() => store.init(), {
                maxAttempts: 3,
                onRetry: ({ attempt }) => logger.debug(`Store init retry ${attempt}`)
            });
            this.store = store;

            // Restore active sessions
            await this._restoreSessions();

            // Load user limits from DB
            await this._refreshLimits();

            // Start cleanup interval
            this._startCleanup();

            logger.info('Sessions manager initialized', {
                sessions: this.sessions.size,
                users: this.userSessions.size,
                limits: { maxPerUser: this.maxPerUser, maxTotal: this.maxTotal }
            });

            return this;

        } catch (error) {
            logger.error('Failed to initialize sessions manager', error);
            throw error;
        }
    }

    /**
     * Restore sessions from database
     * @private
     */
    async _restoreSessions() {
        if (this.restoreInProgress) return;
        this.restoreInProgress = true;

        logger.info('Restoring active sessions...');

        try {
            const sessions = await this.store.all('sessions', 'WHERE logged_in = 1');
            let restored = 0;
            let failed = 0;

            for (const s of sessions) {
                try {
                    const user = await this.store.getSessionUser(s.id);
                    if (user) {
                        await this._add(s.id, user.username, true);
                        restored++;
                        this.stats.restored++;
                    }
                } catch (err) {
                    failed++;
                    logger.error(`Failed to restore session ${s.id}`, { error: err.message });

                    // Mark as logged out in DB
                    await this.store.updateSession(s.id, { logged_in: 0 }).catch(() => { });
                }
            }

            logger.info(`Restored ${restored} sessions, ${failed} failed`);

        } catch (error) {
            logger.error('Restore failed', error);
        } finally {
            this.restoreInProgress = false;
        }
    }

    /**
     * Refresh user limits from database
     * @private
     */
    async _refreshLimits() {
        try {
            const users = await this.store.getAllUsers();
            this.limits.clear();

            for (const user of users) {
                const meta = await this.store.getAllUserMeta(user.username);
                const sessionLimit = meta.session_limit ? parseInt(meta.session_limit) : this.maxPerUser;
                this.limits.set(user.username, sessionLimit);
            }

            this.limitsCacheTime = Date.now();
            logger.debug(`Refreshed limits for ${users.length} users`);

        } catch (error) {
            logger.error('Failed to refresh limits', error);
        }
    }

    /**
     * Start cleanup interval
     * @private
     */
    _startCleanup() {
        const interval = 5 * 60 * 1000; // 5 minutes

        this.cleanupInterval = setInterval(() => {
            this._cleanupInactive().catch(err => {
                logger.error('Cleanup error', err);
                this.stats.errors++;
            });
        }, interval);

        logger.debug(`Cleanup scheduled every ${formatDuration(interval)}`);
    }

    /**
     * Cleanup inactive sessions
     * @private
     */
    async _cleanupInactive() {
        if (this.isShuttingDown) return;

        const now = Date.now();
        let cleaned = 0;
        const errors = [];

        for (const [sid, sess] of this.sessions) {
            try {
                const dbSession = await this.store.getSession(sid).catch(() => null);
                if (!dbSession) {
                    // Orphaned session, remove
                    await this._remove(sid, 'orphaned');
                    cleaned++;
                    continue;
                }

                const lastSeen = dbSession.last_seen ? new Date(dbSession.last_seen).getTime() : 0;
                const inactive = now - lastSeen;

                // Remove if inactive for too long and not connected
                if (inactive > this.sessionTimeout && sess.state !== 'open') {
                    await this._remove(sid, 'timeout');
                    cleaned++;
                }

            } catch (err) {
                errors.push({ sid, error: err.message });
            }
        }

        if (cleaned > 0) {
            logger.info(`Cleaned ${cleaned} inactive sessions`);
        }

        if (errors.length > 0) {
            logger.warn(`Cleanup errors: ${errors.length}`, { errors });
        }

        // Refresh limits every hour
        if (now - this.limitsCacheTime > 3600000) {
            await this._refreshLimits();
        }
    }

    /**
     * Add session to memory
     * @private
     * @param {string} sid - Session ID
     * @param {string} uid - User ID
     * @param {boolean} restored - Whether restoring
     * @returns {Promise<SessionHandler>}
     */
    async _add(sid, uid, restored = false) {
        // Check if already exists
        if (this.sessions.has(sid)) {
            throw new Error(`Session ${sid} already exists`);
        }

        // Create session
        const sess = new SessionHandler(sid, uid, this.wss);
        await sess.init(this.dbPath);

        // Store in memory
        this.sessions.set(sid, sess);

        const userSet = this.userSessions.get(uid) || new Set();
        userSet.add(sid);
        this.userSessions.set(uid, userSet);

        if (!restored) {
            this.stats.created++;
        }

        logger.debug('Session added', { sid, uid, restored });

        return sess;
    }

    /**
     * Remove session from memory
     * @private
     * @param {string} sid - Session ID
     * @param {string} reason - Removal reason
     */
    async _remove(sid, reason) {
        const sess = this.sessions.get(sid);
        if (!sess) return;

        const uid = sess.uid;

        try {
            await sess.close();
        } catch (err) {
            logger.error(`Error closing session ${sid}`, err);
        }

        this.sessions.delete(sid);

        const userSet = this.userSessions.get(uid);
        if (userSet) {
            userSet.delete(sid);
            if (userSet.size === 0) {
                this.userSessions.delete(uid);
            }
        }

        this.stats.closed++;
        logger.debug('Session removed', { sid, uid, reason });
    }

    // ==================== CORE METHODS ====================

    /**
     * Create new session
     * @param {string} uid - User ID
     * @param {Object} options - Session options
     * @returns {Promise<Object>} Session info
     */
    async create(uid, options = {}) {
        const context = { uid, options };

        try {
            // Check if user exists
            const user = await this.store.getUserByUsername(uid);
            if (!user) {
                throw new Error(`User ${uid} not found`);
            }

            // Get user's session limit
            const userLimit = this.limits.get(uid) || this.maxPerUser;
            const userCount = this.userSessions.get(uid)?.size || 0;

            // Check per-user limit
            if (userCount >= userLimit) {
                throw new Error(`Max sessions (${userLimit}) reached for user`);
            }

            // Check total limit
            if (this.sessions.size >= this.maxTotal) {
                throw new Error('Max total sessions reached');
            }

            const sid = options.sid || uuidv4();

            // Check if session ID already exists
            if (this.sessions.has(sid)) {
                throw new Error(`Session ID ${sid} already exists`);
            }

            // Save to DB with retry
            await retry(() =>
                this.store.createSession(sid, {
                    device_id: options.device || `device-${Date.now()}`,
                    platform: options.platform || 'web',
                    status: 'initializing'
                }), {
                maxAttempts: 3
            });

            await this.store.assignUserSession(uid, sid);

            // Create session
            const sess = await this._add(sid, uid);

            // Log activity
            await this.store.logActivity({
                user_id: uid,
                action: 'create_session',
                resource: sid,
                details: { platform: options.platform, device: options.device }
            }).catch(() => { });

            logger.info('Session created', { sid, uid, platform: options.platform });

            return {
                sid,
                qr: sess.qr,
                state: sess.state
            };

        } catch (error) {
            this.stats.errors++;
            logger.error('Failed to create session', { ...context, error: error.message });
            throw error;
        }
    }

    /**
     * Create session with auth data
     * @param {string} uid - User ID
     * @param {Object} authData - Auth credentials
     * @param {Object} options - Session options
     * @returns {Promise<SessionHandler>}
     */
    async createWithAuth(uid, authData, options = {}) {
        const context = { uid, options };

        try {
            // Check user limits
            const userLimit = this.limits.get(uid) || this.maxPerUser;
            const userCount = this.userSessions.get(uid)?.size || 0;

            if (userCount >= userLimit) {
                throw new Error(`Max sessions (${userLimit}) reached for user`);
            }

            if (this.sessions.size >= this.maxTotal) {
                throw new Error('Max total sessions reached');
            }

            const sid = options.sid || uuidv4();

            // Save to DB
            await this.store.createSession(sid, {
                device_id: authData.deviceId,
                phone: authData.phoneNumber,
                platform: options.platform || 'web',
                status: 'authenticated',
                creds: JSON.stringify(authData.creds),
                logged_in: 1
            });

            await this.store.assignUserSession(uid, sid);

            // Create session
            const sess = await this._add(sid, uid);

            logger.info('Auth session created', { sid, uid });

            return sess;

        } catch (error) {
            this.stats.errors++;
            logger.error('Failed to create auth session', { ...context, error: error.message });
            throw error;
        }
    }

    /**
     * Get session by ID
     * @param {string} sid - Session ID
     * @returns {SessionHandler|undefined}
     */
    get(sid) {
        return this.sessions.get(sid);
    }

    /**
     * Get session info
     * @param {string} sid - Session ID
     * @returns {Promise<Object|null>}
     */
    async getInfo(sid) {
        const sess = this.sessions.get(sid);
        if (!sess) return null;

        try {
            const dbSession = await this.store.getSession(sid);
            const user = await this.store.getSessionUser(sid);
            const info = await sess.getInfo();

            return {
                sid,
                uid: user?.username,
                state: sess.state,
                connected: sess.state === 'open',
                phone: dbSession?.phone,
                platform: dbSession?.platform,
                device: dbSession?.device_id,
                created: dbSession?.created_at,
                lastSeen: dbSession?.last_seen,
                stats: info.stats,
                meta: await this.store.getAllSessionMeta(sid)
            };

        } catch (error) {
            logger.error('Failed to get session info', { sid, error: error.message });
            return null;
        }
    }

    /**
     * Get all sessions for user
     * @param {string} uid - User ID
     * @returns {Promise<Array>}
     */
    async getUserSessions(uid) {
        const sids = this.userSessions.get(uid) || new Set();
        const result = [];

        for (const sid of sids) {
            const info = await this.getInfo(sid);
            if (info) result.push(info);
        }

        return result;
    }

    /**
     * Get all active sessions
     * @returns {Array}
     */
    getAll() {
        const result = [];
        for (const [sid, sess] of this.sessions) {
            result.push({
                sid,
                uid: sess.uid,
                state: sess.state,
                connected: sess.state === 'open',
                uptime: Date.now() - sess.startTime
            });
        }
        return result;
    }

    /**
     * Remove session
     * @param {string} sid - Session ID
     * @param {string} reason - Removal reason
     * @returns {Promise<boolean>}
     */
    async remove(sid, reason = 'manual') {
        const context = { sid, reason };

        try {
            const sess = this.sessions.get(sid);
            if (!sess) {
                logger.debug('Session not found for removal', context);
                return false;
            }

            const uid = sess.uid;

            await this._remove(sid, reason);

            // Update DB
            await this.store.deactivateUserSession(uid, sid).catch(() => { });

            // Log activity
            await this.store.logActivity({
                user_id: uid,
                session_id: sid,
                action: 'remove_session',
                details: { reason }
            }).catch(() => { });

            logger.info('Session removed', { sid, uid, reason });

            return true;

        } catch (error) {
            this.stats.errors++;
            logger.error('Failed to remove session', { ...context, error: error.message });
            return false;
        }
    }

    /**
     * Remove all sessions for user
     * @param {string} uid - User ID
     * @param {string} reason - Removal reason
     * @returns {Promise<number>} Number removed
     */
    async removeAllForUser(uid, reason = 'user_kill') {
        const sids = this.userSessions.get(uid);
        if (!sids) return 0;

        let count = 0;
        const errors = [];

        for (const sid of [...sids]) {
            try {
                await this.remove(sid, reason);
                count++;
            } catch (err) {
                errors.push({ sid, error: err.message });
            }
        }

        if (errors.length > 0) {
            logger.warn(`Removed ${count}/${sids.size} sessions for user ${uid}`, { errors });
        } else {
            logger.info(`Removed all ${count} sessions for user ${uid}`);
        }

        return count;
    }

    /**
     * Update session
     * @param {string} sid - Session ID
     * @param {Object} updates - Updates
     * @returns {Promise<Object>} Updated session
     */
    async updateSession(sid, updates) {
        const sess = this.sessions.get(sid);
        if (!sess) throw new Error(`Session ${sid} not found`);

        return this.store.updateSession(sid, updates);
    }

    // ==================== VALIDATION ====================

    /**
     * Check if user can create session
     * @param {string} uid - User ID
     * @returns {Promise<Object>} { allowed, reason, current, limit }
     */
    async canCreateSession(uid) {
        const userLimit = this.limits.get(uid) || this.maxPerUser;
        const userCount = this.userSessions.get(uid)?.size || 0;

        if (userCount >= userLimit) {
            return {
                allowed: false,
                reason: 'user_limit',
                current: userCount,
                limit: userLimit
            };
        }

        if (this.sessions.size >= this.maxTotal) {
            return {
                allowed: false,
                reason: 'total_limit',
                current: this.sessions.size,
                limit: this.maxTotal
            };
        }

        return { allowed: true };
    }

    /**
     * Check if session belongs to user
     * @param {string} sid - Session ID
     * @param {string} uid - User ID
     * @returns {boolean}
     */
    isOwner(sid, uid) {
        const sess = this.sessions.get(sid);
        return sess ? sess.uid === uid : false;
    }

    /**
     * Check if session exists
     * @param {string} sid - Session ID
     * @returns {boolean}
     */
    has(sid) {
        return this.sessions.has(sid);
    }

    /**
     * Get session count for user
     * @param {string} uid - User ID
     * @returns {number}
     */
    countForUser(uid) {
        return this.userSessions.get(uid)?.size || 0;
    }

    // ==================== ACTION PROXIES ====================

    /**
     * Execute session method
     * @param {string} sid - Session ID
     * @param {string} method - Method name
     * @param {...*} args - Arguments
     * @returns {Promise<*>}
     */
    async exec(sid, method, ...args) {
        const sess = this.sessions.get(sid);
        if (!sess) throw new Error(`Session ${sid} not found`);
        if (typeof sess[method] !== 'function') {
            throw new Error(`Method ${method} not found`);
        }
        return sess[method](...args);
    }

    /**
     * Send message
     * @param {string} sid - Session ID
     * @param {string} jid - Recipient JID
     * @param {*} content - Message content
     * @param {string} type - Message type
     * @returns {Promise<Object>}
     */
    async sendMessage(sid, jid, content, type = 'text') {
        return this.exec(sid, 'sendMessage', jid, content, type);
    }

    /**
     * Send reaction
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @param {string} msgId - Message ID
     * @param {string} emoji - Reaction emoji
     * @returns {Promise<Object>}
     */
    async sendReaction(sid, jid, msgId, emoji) {
        return this.exec(sid, 'sendReaction', jid, msgId, emoji);
    }

    /**
     * Mark as read
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @param {string} msgId - Message ID
     */
    async markRead(sid, jid, msgId) {
        return this.exec(sid, 'markRead', jid, msgId);
    }

    /**
     * Update presence
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @param {string} state - Presence state
     */
    async setPresence(sid, jid, state) {
        return this.exec(sid, 'setPresence', jid, state);
    }

    /**
     * Group action
     * @param {string} sid - Session ID
     * @param {string} cmd - Command
     * @param {string} jid - Group JID
     * @param {Array} data - Additional data
     * @returns {Promise<*>}
     */
    async groupAction(sid, cmd, jid, data = []) {
        return this.exec(sid, 'groupAction', cmd, jid, data);
    }

    /**
     * Block/unblock user
     * @param {string} sid - Session ID
     * @param {string} jid - User JID
     * @param {boolean} block - True to block
     */
    async blockUser(sid, jid, block = true) {
        return this.exec(sid, 'blockUser', jid, block);
    }

    /**
     * Archive chat
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @param {boolean} archive - True to archive
     */
    async archiveChat(sid, jid, archive = true) {
        return this.exec(sid, 'archiveChat', jid, archive);
    }

    /**
     * Pin chat
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @param {boolean} pin - True to pin
     */
    async pinChat(sid, jid, pin = true) {
        return this.exec(sid, 'pinChat', jid, pin);
    }

    /**
     * Mute chat
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @param {number} muteUntil - Timestamp to unmute
     */
    async muteChat(sid, jid, muteUntil = null) {
        return this.exec(sid, 'muteChat', jid, muteUntil);
    }

    /**
     * Mark chat read
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @param {boolean} read - True to mark read
     */
    async markChatRead(sid, jid, read = true) {
        return this.exec(sid, 'markChatRead', jid, read);
    }

    /**
     * Delete chat
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     */
    async deleteChat(sid, jid) {
        return this.exec(sid, 'deleteChat', jid);
    }

    /**
     * Delete message
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @param {string} msgId - Message ID
     */
    async deleteMessage(sid, jid, msgId) {
        return this.exec(sid, 'deleteMessage', jid, msgId);
    }

    /**
     * Star message
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @param {string} msgId - Message ID
     * @param {boolean} star - True to star
     */
    async starMessage(sid, jid, msgId, star = true) {
        return this.exec(sid, 'starMessage', jid, msgId, star);
    }

    /**
     * Profile action
     * @param {string} sid - Session ID
     * @param {string} cmd - Command
     * @param {string} jid - JID
     * @param {*} data - Data
     * @returns {Promise<*>}
     */
    async profileAction(sid, cmd, jid = null, data = null) {
        return this.exec(sid, 'profileAction', cmd, jid, data);
    }

    /**
     * Newsletter action
     * @param {string} sid - Session ID
     * @param {string} cmd - Command
     * @param {string} id - Newsletter ID
     * @param {*} data - Data
     * @returns {Promise<*>}
     */
    async newsletterAction(sid, cmd, id = null, data = null) {
        return this.exec(sid, 'newsletterAction', cmd, id, data);
    }

    /**
     * Create webhook
     * @param {string} sid - Session ID
     * @param {Object} data - Webhook data
     * @returns {Promise<Object>}
     */
    async createWebhook(sid, data) {
        return this.exec(sid, 'createWebhook', data);
    }

    /**
     * Get webhooks
     * @param {string} sid - Session ID
     * @returns {Promise<Array>}
     */
    async getWebhooks(sid) {
        return this.exec(sid, 'getWebhooks');
    }

    /**
     * Update webhook
     * @param {string} sid - Session ID
     * @param {string} id - Webhook ID
     * @param {Object} updates - Updates
     * @returns {Promise<Object>}
     */
    async updateWebhook(sid, id, updates) {
        return this.exec(sid, 'updateWebhook', id, updates);
    }

    /**
     * Delete webhook
     * @param {string} sid - Session ID
     * @param {string} id - Webhook ID
     * @returns {Promise<Object>}
     */
    async deleteWebhook(sid, id) {
        return this.exec(sid, 'deleteWebhook', id);
    }

    /**
     * Test webhook
     * @param {string} sid - Session ID
     * @param {string} id - Webhook ID
     * @returns {Promise<Object>}
     */
    async testWebhook(sid, id) {
        return this.exec(sid, 'testWebhook', id);
    }

    // ==================== GETTER PROXIES ====================

    /**
     * Get chats
     * @param {string} sid - Session ID
     * @param {boolean} archived - Include archived
     * @returns {Promise<Array>}
     */
    async getChats(sid, archived = false) {
        return this.exec(sid, 'getChats', archived);
    }

    /**
     * Get chat
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @returns {Promise<Object>}
     */
    async getChat(sid, jid) {
        return this.exec(sid, 'getChat', jid);
    }

    /**
     * Get contacts
     * @param {string} sid - Session ID
     * @returns {Promise<Array>}
     */
    async getContacts(sid) {
        return this.exec(sid, 'getContacts');
    }

    /**
     * Get contact
     * @param {string} sid - Session ID
     * @param {string} jid - Contact JID
     * @returns {Promise<Object>}
     */
    async getContact(sid, jid) {
        return this.exec(sid, 'getContact', jid);
    }

    /**
     * Get messages
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @param {number} limit - Limit
     * @param {number} offset - Offset
     * @param {number} before - Before timestamp
     * @param {number} after - After timestamp
     * @returns {Promise<Array>}
     */
    async getMessages(sid, jid, limit = 50, offset = 0, before = null, after = null) {
        return this.exec(sid, 'getMessages', jid, limit, offset, before, after);
    }

    /**
     * Get message
     * @param {string} sid - Session ID
     * @param {string} id - Message ID
     * @returns {Promise<Object>}
     */
    async getMessage(sid, id) {
        return this.exec(sid, 'getMessage', id);
    }

    /**
     * Get starred messages
     * @param {string} sid - Session ID
     * @param {number} limit - Limit
     * @returns {Promise<Array>}
     */
    async getStarred(sid, limit = 50) {
        return this.exec(sid, 'getStarred', limit);
    }

    /**
     * Search messages
     * @param {string} sid - Session ID
     * @param {string} query - Search query
     * @param {string} jid - Chat JID (optional)
     * @param {number} limit - Limit
     * @returns {Promise<Array>}
     */
    async searchMessages(sid, query, jid = null, limit = 50) {
        return this.exec(sid, 'searchMessages', query, jid, limit);
    }

    /**
     * Get groups
     * @param {string} sid - Session ID
     * @returns {Promise<Array>}
     */
    async getGroups(sid) {
        return this.exec(sid, 'getGroups');
    }

    /**
     * Get group
     * @param {string} sid - Session ID
     * @param {string} jid - Group JID
     * @returns {Promise<Object>}
     */
    async getGroup(sid, jid) {
        return this.exec(sid, 'getGroup', jid);
    }

    /**
     * Get group members
     * @param {string} sid - Session ID
     * @param {string} jid - Group JID
     * @returns {Promise<Array>}
     */
    async getGroupMembers(sid, jid) {
        return this.exec(sid, 'getGroupMembers', jid);
    }

    /**
     * Get blocked
     * @param {string} sid - Session ID
     * @returns {Promise<Array>}
     */
    async getBlocked(sid) {
        return this.exec(sid, 'getBlocked');
    }

    /**
     * Get calls
     * @param {string} sid - Session ID
     * @param {number} limit - Limit
     * @returns {Promise<Array>}
     */
    async getCalls(sid, limit = 50) {
        return this.exec(sid, 'getCalls', limit);
    }

    /**
     * Get missed calls
     * @param {string} sid - Session ID
     * @returns {Promise<Array>}
     */
    async getMissedCalls(sid) {
        return this.exec(sid, 'getMissedCalls');
    }

    /**
     * Get labels
     * @param {string} sid - Session ID
     * @returns {Promise<Array>}
     */
    async getLabels(sid) {
        return this.exec(sid, 'getLabels');
    }

    /**
     * Get chat labels
     * @param {string} sid - Session ID
     * @param {string} jid - Chat JID
     * @returns {Promise<Array>}
     */
    async getChatLabels(sid, jid) {
        return this.exec(sid, 'getChatLabels', jid);
    }

    /**
     * Get newsletters
     * @param {string} sid - Session ID
     * @returns {Promise<Array>}
     */
    async getNewsletters(sid) {
        return this.exec(sid, 'getNewsletters');
    }

    /**
     * Get newsletter posts
     * @param {string} sid - Session ID
     * @param {string} nid - Newsletter ID
     * @param {number} limit - Limit
     * @returns {Promise<Array>}
     */
    async getNewsletterPosts(sid, nid, limit = 50) {
        return this.exec(sid, 'getNewsletterPosts', nid, limit);
    }

    /**
     * Get settings
     * @param {string} sid - Session ID
     * @returns {Promise<Object>}
     */
    async getSettings(sid) {
        return this.exec(sid, 'getSettings');
    }

    /**
     * Get setting
     * @param {string} sid - Session ID
     * @param {string} name - Setting name
     * @returns {Promise<*>}
     */
    async getSetting(sid, name) {
        return this.exec(sid, 'getSetting', name);
    }

    // ==================== SESSION CONTROL ====================

    /**
     * Logout session
     * @param {string} sid - Session ID
     */
    async logout(sid) {
        const sess = this.sessions.get(sid);
        if (!sess) throw new Error(`Session ${sid} not found`);

        await sess.logout();

        // Remove from memory after logout
        setTimeout(() => {
            this.remove(sid, 'logged_out').catch(() => { });
        }, 1000);
    }

    /**
     * Kill all sessions for user
     * @param {string} uid - User ID
     * @returns {Promise<number>}
     */
    async killUserSessions(uid) {
        return this.removeAllForUser(uid, 'admin_kill');
    }

    /**
     * Broadcast to all sessions
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    broadcast(event, data) {
        const msg = JSON.stringify({ event, data });
        let sent = 0;

        for (const sess of this.sessions.values()) {
            if (sess.wss) {
                sess.wss.clients.forEach(c => {
                    if (c.readyState === WebSocket.OPEN && c.sessionId === sess.sid) {
                        c.send(msg);
                        sent++;
                    }
                });
            }
        }

        logger.debug(`Broadcast ${event} to ${sent} clients`);
    }

    // ==================== UTILITY ====================

    /**
     * Get manager statistics
     * @returns {Object}
     */
    getStats() {
        const sessionsByState = {};
        for (const sess of this.sessions.values()) {
            sessionsByState[sess.state] = (sessionsByState[sess.state] || 0) + 1;
        }

        return {
            ...this.stats,
            activeSessions: this.sessions.size,
            activeUsers: this.userSessions.size,
            sessionsByState,
            limits: {
                maxPerUser: this.maxPerUser,
                maxTotal: this.maxTotal,
                sessionTimeout: this.sessionTimeout
            },
            uptime: Date.now() - this.stats.startTime,
            memory: process.memoryUsage()
        };
    }

    /**
     * Get user limits
     * @param {string} uid - User ID
     * @returns {Object} User limits
     */
    getUserLimits(uid) {
        return {
            sessionLimit: this.limits.get(uid) || this.maxPerUser,
            currentSessions: this.userSessions.get(uid)?.size || 0
        };
    }

    /**
     * Refresh user limits
     */
    async refreshUserLimits() {
        await this._refreshLimits();
    }

    /**
     * Close all sessions
     */
    async closeAll() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        logger.info('Closing all sessions...');

        // Stop cleanup interval
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        // Close all sessions
        const closePromises = [];
        const errors = [];

        for (const [sid, sess] of this.sessions) {
            closePromises.push(
                sess.close().catch(err => {
                    errors.push({ sid, error: err.message });
                })
            );
        }

        await Promise.all(closePromises);

        this.sessions.clear();
        this.userSessions.clear();
        this.limits.clear();

        // Close global store
        if (this.store) {
            await this.store.close().catch(() => { });
            this.store = null;
        }

        if (errors.length > 0) {
            logger.warn(`Closed with ${errors.length} errors`, { errors });
        }

        logger.info('All sessions closed');
    }

    /**
     * Health check
     * @returns {Promise<Object>}
     */
    async healthCheck() {
        try {
            const storeOk = this.store ? await this.store.healthCheck().catch(() => false) : false;
            const dbSize = this.store ? await this.store.getDbSize().catch(() => 0) : 0;

            return {
                status: storeOk ? 'healthy' : 'degraded',
                stats: this.getStats(),
                store: storeOk ? 'ok' : 'error',
                dbSize,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }
}

module.exports = SessionsManager;