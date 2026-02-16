// src/core/SessionsManager.js
const SessionHandler = require('./SessionHandler');
const SQLiteStores = require('./SQLiteStores');
const { v4: uuidv4 } = require('uuid');

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
        this.store = null;
        this.cleanupInterval = null;
        this.stats = {
            created: 0,
            closed: 0,
            errors: 0,
            startTime: Date.now()
        };
    }

    // ==================== INIT ====================

    /**
     * Initialize manager
     * @returns {Promise<this>}
     */
    async init() {
        // Initialize global store
        this.store = new SQLiteStores(null, this.dbPath);
        await this.store.init();

        // Restore active sessions
        await this._restoreSessions();

        // Start cleanup interval
        this._startCleanup();

        return this;
    }

    /**
     * Restore sessions from database
     * @private
     */
    async _restoreSessions() {
        try {
            const sessions = await this.store.all('sessions', 'WHERE logged_in = 1');
            
            for (const s of sessions) {
                const user = await this.store.getSessionUser(s.id);
                if (user) {
                    await this._add(s.id, user.username, true);
                    this.stats.created++;
                }
            }

            console.log(`[Manager] Restored ${this.sessions.size} sessions`);
        } catch (err) {
            console.error('[Manager] Restore failed:', err.message);
        }
    }

    /**
     * Start cleanup interval
     * @private
     */
    _startCleanup() {
        this.cleanupInterval = setInterval(() => {
            this._cleanupInactive().catch(err => {
                console.error('[Manager] Cleanup error:', err.message);
                this.stats.errors++;
            });
        }, 5 * 60 * 1000); // Every 5 minutes
    }

    /**
     * Cleanup inactive sessions
     * @private
     */
    async _cleanupInactive() {
        const now = Date.now();
        let cleaned = 0;

        for (const [sid, sess] of this.sessions) {
            const dbSession = await this.store.getSession(sid).catch(() => null);
            if (!dbSession) continue;

            const lastSeen = dbSession.last_seen ? new Date(dbSession.last_seen).getTime() : 0;
            
            // Remove if inactive for too long and not connected
            if (now - lastSeen > this.sessionTimeout && sess.state !== 'open') {
                await this.remove(sid, 'timeout');
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[Manager] Cleaned ${cleaned} inactive sessions`);
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
        const sess = new SessionHandler(sid, uid, this.wss);
        await sess.init(this.dbPath);
        
        this.sessions.set(sid, sess);
        
        const userSet = this.userSessions.get(uid) || new Set();
        userSet.add(sid);
        this.userSessions.set(uid, userSet);

        if (!restored) {
            this.stats.created++;
        }

        return sess;
    }

    // ==================== CORE METHODS ====================

    /**
     * Create new session
     * @param {string} uid - User ID
     * @param {Object} options - Session options
     * @param {string} options.platform - Platform name
     * @param {string} options.device - Device identifier
     * @param {string} options.sid - Custom session ID (optional)
     * @returns {Promise<Object>} Session info
     */
    async create(uid, options = {}) {
        // Check limits
        const userCount = this.userSessions.get(uid)?.size || 0;
        if (userCount >= this.maxPerUser) {
            throw new Error(`Max sessions (${this.maxPerUser}) reached for user`);
        }

        if (this.sessions.size >= this.maxTotal) {
            throw new Error('Max total sessions reached');
        }

        const sid = options.sid || uuidv4();

        // Save to DB
        await this.store.createSession(sid, {
            device_id: options.device || `device-${Date.now()}`,
            platform: options.platform || 'web',
            status: 'initializing'
        });

        await this.store.assignUserSession(uid, sid);

        // Create session
        const sess = await this._add(sid, uid);

        console.log(`[Manager] Session created: ${sid} for user ${uid}`);

        return {
            sid,
            qr: sess.qr,
            state: sess.state
        };
    }

    /**
     * Create session with auth data
     * @param {string} uid - User ID
     * @param {Object} authData - Auth credentials
     * @param {Object} options - Session options
     * @returns {Promise<SessionHandler>}
     */
    async createWithAuth(uid, authData, options = {}) {
        const sid = options.sid || uuidv4();

        await this.store.createSession(sid, {
            device_id: authData.deviceId,
            phone: authData.phoneNumber,
            platform: options.platform || 'web',
            status: 'authenticated',
            creds: JSON.stringify(authData.creds),
            logged_in: 1
        });

        await this.store.assignUserSession(uid, sid);

        const sess = await this._add(sid, uid);
        
        console.log(`[Manager] Auth session created: ${sid}`);

        return sess;
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

        const dbSession = await this.store.getSession(sid);
        const user = await this.store.getSessionUser(sid);

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
            stats: await sess.getInfo().catch(() => ({}))
        };
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
                connected: sess.state === 'open'
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
        const sess = this.sessions.get(sid);
        if (!sess) return false;

        const uid = sess.uid;

        try {
            await sess.close();
        } catch (err) {
            console.error(`[Manager] Error closing session ${sid}:`, err.message);
        }

        this.sessions.delete(sid);

        const userSet = this.userSessions.get(uid);
        if (userSet) {
            userSet.delete(sid);
            if (userSet.size === 0) {
                this.userSessions.delete(uid);
            }
        }

        await this.store.deactivateUserSession(uid, sid).catch(() => {});

        this.stats.closed++;
        console.log(`[Manager] Session removed: ${sid} (${reason})`);

        return true;
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
        for (const sid of [...sids]) {
            await this.remove(sid, reason);
            count++;
        }

        return count;
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
     * @returns {Promise<Array>}
     */
    async getMessages(sid, jid, limit = 50, offset = 0) {
        return this.exec(sid, 'getMessages', jid, limit, offset);
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

    /**
     * Get session info
     * @param {string} sid - Session ID
     * @returns {Promise<Object>}
     */
    async getInfo(sid) {
        return this.exec(sid, 'getInfo');
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
        await this.store.deactivateUserSession(sess.uid, sid).catch(() => {});

        // Remove from memory after logout
        setTimeout(() => {
            this.remove(sid, 'logged_out').catch(() => {});
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

    // ==================== UTILITY ====================

    /**
     * Get manager statistics
     * @returns {Object}
     */
    getStats() {
        return {
            ...this.stats,
            activeSessions: this.sessions.size,
            activeUsers: this.userSessions.size,
            uptime: Date.now() - this.stats.startTime,
            limits: {
                maxPerUser: this.maxPerUser,
                maxTotal: this.maxTotal,
                sessionTimeout: this.sessionTimeout
            }
        };
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

    /**
     * Close all sessions
     */
    async closeAll() {
        console.log('[Manager] Closing all sessions...');

        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        const closePromises = [];
        for (const [sid, sess] of this.sessions) {
            closePromises.push(
                sess.close().catch(err => {
                    console.error(`[Manager] Error closing ${sid}:`, err.message);
                })
            );
        }

        await Promise.all(closePromises);

        this.sessions.clear();
        this.userSessions.clear();

        if (this.store) {
            await this.store.close().catch(() => {});
            this.store = null;
        }

        console.log('[Manager] All sessions closed');
    }

    /**
     * Health check
     * @returns {Promise<Object>}
     */
    async healthCheck() {
        const storeOk = this.store ? await this.store.healthCheck().catch(() => false) : false;

        return {
            status: storeOk ? 'healthy' : 'degraded',
            stats: this.getStats(),
            store: storeOk ? 'ok' : 'error',
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = SessionsManager;