// src/core/SessionHandler.js
const SQLiteStores = require('./SQLiteStores');
const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const logger = require('../utils/logger');
const { sleep, retry, isValidJid, formatDuration } = require('../utils/helpers');
const { MESSAGE_TYPES, MESSAGE_STATUS, PRESENCE_STATES, CALL_TYPES, CALL_STATUS } = require('../utils/constants');

class SessionHandler {
    /**
     * Create new session handler
     * @param {string} sessionId - Session ID
     * @param {string} userId - User ID
     * @param {WebSocket.Server} wss - WebSocket server
     */
    constructor(sessionId, userId, wss = null) {
        this.sid = sessionId;
        this.uid = userId;
        this.wss = wss;
        this.db = null;
        this.sock = null;
        this.unsub = [];
        this.state = 'disconnected';
        this.qr = null;
        this.reconn = 0;
        this.maxReconn = 5;
        this.reconnDelay = 1000;
        this.loggingOut = false;
        this.connecting = false;
        this.startTime = Date.now();
        this.lastActivity = Date.now();
        this.messageQueue = [];
        this.processingQueue = false;
        this.stats = {
            msgsRx: 0,
            msgsTx: 0,
            events: 0,
            errors: 0,
            reconnects: 0,
            webhooks: 0
        };
        this.pendingPromises = new Map();
        this.webhookCache = new Map();
        this.webhookCacheTime = 0;
    }

    // ==================== INIT ====================

    /**
     * Initialize session handler
     * @param {string} dbPath - Database path
     * @returns {Promise<this>}
     */
    async init(dbPath = './data/db.db') {
        const context = { sid: this.sid, uid: this.uid };

        try {
            logger.info('Initializing session', context);

            // Initialize database with retry
            this.db = new SQLiteStores(this.sid, dbPath);
            await retry(() => this.db.init(), {
                maxAttempts: 3,
                onRetry: ({ attempt }) => logger.debug(`DB init retry ${attempt}`, context)
            });

            this._setupCallbacks();

            // Load session from DB
            const session = await this.db.getSession(this.sid);
            if (!session) {
                await this.db.createSession(this.sid, {
                    device_id: `device-${Date.now()}`,
                    platform: 'web',
                    status: 'initializing'
                });
            }

            // Load webhooks into cache
            await this._refreshWebhookCache();

            // Connect WhatsApp socket
            await this._connect(session?.creds);

            logger.info('Session initialized', { ...context, state: this.state });
            return this;

        } catch (error) {
            logger.error('Init failed', { ...context, error: error.message });
            this._emit('error', { type: 'init_failed', error: error.message });
            throw error;
        }
    }

    /**
     * Setup database callbacks
     * @private
     */
    _setupCallbacks() {
        const events = ['message', 'presence', 'chat', 'reaction', 'group', 'lid', 'error'];

        events.forEach(e => {
            const fn = this.db.on(e, (data) => {
                this.stats.events++;
                this._emit(e, data);
                this._sendToWebhook(e, data).catch(err => {
                    logger.debug(`Webhook failed for ${e}`, { sid: this.sid, error: err.message });
                });
            });
            if (fn) this.unsub.push(fn);
        });

        this.unsub.push(
            this.db.on('init', () => logger.debug('DB ready', { sid: this.sid })),
            this.db.on('close', () => logger.debug('DB closed', { sid: this.sid }))
        );
    }

    /**
     * Refresh webhook cache
     * @private
     */
    async _refreshWebhookCache() {
        try {
            const webhooks = await this.db.getAllWebhooks();
            this.webhookCache.clear();
            for (const w of webhooks) {
                if (w.enabled) {
                    this.webhookCache.set(w.event, {
                        url: w.url,
                        headers: w.headers ? JSON.parse(w.headers) : {},
                        retry_count: w.retry_count,
                        timeout: w.timeout,
                        secret: w.secret
                    });
                }
            }
            this.webhookCacheTime = Date.now();
            logger.debug(`Webhook cache refreshed: ${this.webhookCache.size} hooks`, { sid: this.sid });
        } catch (error) {
            logger.error('Failed to refresh webhook cache', { sid: this.sid, error: error.message });
        }
    }

    // ==================== CONNECTION ====================

    /**
     * Connect to WhatsApp
     * @private
     * @param {string} creds - Serialized credentials
     */
    async _connect(creds = null) {
        if (this.connecting || this.loggingOut) {
            logger.debug('Already connecting or logging out', { sid: this.sid });
            return;
        }

        this.connecting = true;

        try {
            logger.info('Connecting to WhatsApp', { sid: this.sid, attempt: this.reconn + 1 });

            const { version } = await fetchLatestBaileysVersion();

            let auth = null;
            if (creds) {
                try {
                    auth = JSON.parse(creds);
                } catch (e) {
                    logger.warn('Failed to parse creds', { sid: this.sid });
                }
            }

            this.sock = makeWASocket({
                version,
                auth,
                printQRInTerminal: true,
                browser: ['WhatsApp Clone', 'Chrome', '1.0.0'],
                syncFullHistory: true,
                markOnlineOnConnect: true,
                maxMsgRetryCount: 5,
                qrTimeout: 30000,
                defaultQueryTimeoutMs: 10000,
                keepAliveIntervalMs: 30000,
                logger: {
                    level: 'fatal', // Suppress Baileys logs
                    info: () => { },
                    error: (msg) => logger.debug('Baileys error', { sid: this.sid, msg }),
                    warn: () => { },
                    debug: () => { }
                }
            });

            this._bindEvents();
            this.connecting = false;

        } catch (error) {
            this.connecting = false;
            logger.error('Connection failed', { sid: this.sid, error: error.message });
            this._scheduleReconnect();
        }
    }

    /**
     * Schedule reconnection with exponential backoff
     * @private
     */
    _scheduleReconnect() {
        if (this.reconn >= this.maxReconn) {
            logger.error('Max reconnection attempts reached', { sid: this.sid });
            this._emit('error', { type: 'max_reconnects_reached' });
            return;
        }

        this.reconn++;
        const delay = this.reconnDelay * Math.pow(2, this.reconn - 1);

        logger.info(`Reconnecting in ${formatDuration(delay)}`, {
            sid: this.sid,
            attempt: this.reconn,
            max: this.maxReconn
        });

        this._emit('reconnecting', { attempt: this.reconn, delay });

        setTimeout(() => {
            this._connect().catch(err => {
                logger.error('Reconnect failed', { sid: this.sid, error: err.message });
            });
        }, delay);
    }

    /**
     * Bind all WhatsApp events
     * @private
     */
    _bindEvents() {
        if (!this.sock) return;

        // Connection
        this.sock.ev.on('connection.update', async (up) => {
            await this._handleConnection(up);
        });

        // Credentials
        this.sock.ev.on('creds.update', async (up) => {
            await this._handleCreds(up);
        });

        // Messages
        this.sock.ev.on('messages.upsert', async (data) => {
            await this._handleMessagesUpsert(data);
        });

        this.sock.ev.on('messages.update', async (ups) => {
            await this._handleMessagesUpdate(ups);
        });

        this.sock.ev.on('messages.delete', async (data) => {
            await this._handleMessagesDelete(data);
        });

        this.sock.ev.on('messages.media-update', async (ups) => {
            await this._handleMediaUpdate(ups);
        });

        this.sock.ev.on('messages.reaction', async (data) => {
            await this._handleReaction(data);
        });

        this.sock.ev.on('message-receipt.update', async (ups) => {
            await this._handleReceipt(ups);
        });

        // Presence
        this.sock.ev.on('presence.update', async (data) => {
            await this._handlePresence(data);
        });

        // Chats
        this.sock.ev.on('chats.upsert', async (chats) => {
            await this._handleChatsUpsert(chats);
        });

        this.sock.ev.on('chats.update', async (ups) => {
            await this._handleChatsUpdate(ups);
        });

        this.sock.ev.on('chats.delete', async (ids) => {
            await this._handleChatsDelete(ids);
        });

        this.sock.ev.on('chats.lock', async ({ id, locked }) => {
            await this._handleChatsLock(id, locked);
        });

        // Contacts
        this.sock.ev.on('contacts.upsert', async (contacts) => {
            await this._handleContactsUpsert(contacts);
        });

        this.sock.ev.on('contacts.update', async (ups) => {
            await this._handleContactsUpdate(ups);
        });

        // Groups
        this.sock.ev.on('groups.upsert', async (groups) => {
            await this._handleGroupsUpsert(groups);
        });

        this.sock.ev.on('groups.update', async (ups) => {
            await this._handleGroupsUpdate(ups);
        });

        this.sock.ev.on('group-participants.update', async (data) => {
            await this._handleGroupParticipants(data);
        });

        this.sock.ev.on('group.join-request', async (data) => {
            await this._handleGroupJoinRequest(data);
        });

        this.sock.ev.on('group.member-tag.update', async (data) => {
            await this._handleGroupMemberTag(data);
        });

        // Blocklist
        this.sock.ev.on('blocklist.set', async ({ blocklist }) => {
            await this._handleBlocklistSet(blocklist);
        });

        this.sock.ev.on('blocklist.update', async ({ blocklist, type }) => {
            await this._handleBlocklistUpdate(blocklist, type);
        });

        // Calls
        this.sock.ev.on('call', async (calls) => {
            await this._handleCalls(calls);
        });

        // Labels
        this.sock.ev.on('labels.edit', async (label) => {
            await this._handleLabelsEdit(label);
        });

        this.sock.ev.on('labels.association', async ({ association, type }) => {
            await this._handleLabelsAssociation(association, type);
        });

        // Newsletter
        this.sock.ev.on('newsletter.reaction', (data) => this._emit('newsletter_reaction', data));
        this.sock.ev.on('newsletter.view', (data) => this._emit('newsletter_view', data));
        this.sock.ev.on('newsletter-participants.update', (data) => this._emit('newsletter_participants', data));
        this.sock.ev.on('newsletter-settings.update', (data) => this._emit('newsletter_settings', data));

        // LID Mapping
        this.sock.ev.on('lid-mapping.update', async (data) => {
            await this._handleLidMapping(data);
        });

        // Settings
        this.sock.ev.on('settings.update', async (up) => {
            await this._handleSettingsUpdate(up);
        });

        // History
        this.sock.ev.on('messaging-history.set', async (hist) => {
            await this._handleMessagingHistory(hist);
        });
    }

    // ==================== CONNECTION HANDLERS ====================

    /**
     * Handle connection update
     * @private
     * @param {Object} up - Connection update
     */
    async _handleConnection(up) {
        const { connection, lastDisconnect, qr } = up;
        const context = { sid: this.sid };

        this.lastActivity = Date.now();

        if (qr) {
            this.qr = qr;
            this._emit('qr', { qr });
            logger.debug('QR code generated', context);
        }

        if (connection) {
            const oldState = this.state;
            this.state = connection;
            this._emit('connection', { connection, qr });

            await this.db.updateSession(this.sid, {
                status: connection,
                qr,
                last_seen: lastDisconnect ? new Date().toISOString() : null
            }).catch(err => logger.error('Failed to update session', { ...context, error: err.message }));

            if (connection === 'open') {
                this.reconn = 0;
                await this.db.updateSession(this.sid, { logged_in: 1 }).catch(() => { });
                this._emit('connected', {});
                logger.info('WhatsApp connected', context);

                // Process any queued messages
                await this._processMessageQueue();

            } else if (connection === 'close') {
                await this.db.updateSession(this.sid, { logged_in: 0 }).catch(() => { });

                const code = lastDisconnect?.error?.output?.statusCode;
                const errorMsg = lastDisconnect?.error?.message || 'Unknown error';

                logger.warn('Disconnected', { ...context, code, error: errorMsg });

                const shouldReconnect = !this.loggingOut &&
                    code !== DisconnectReason.loggedOut &&
                    code !== DisconnectReason.badSession;

                if (shouldReconnect) {
                    this._scheduleReconnect();
                } else {
                    this._emit('disconnected', {
                        reason: code === DisconnectReason.loggedOut ? 'logged_out' : 'closed',
                        code
                    });
                }
            }

            if (oldState !== connection) {
                logger.info(`State changed: ${oldState} -> ${connection}`, context);
            }
        }
    }

    /**
     * Handle credentials update
     * @private
     * @param {Object} up - Credentials update
     */
    async _handleCreds(up) {
        await this.db.updateSession(this.sid, {
            creds: JSON.stringify(up)
        }).catch(err => logger.error('Failed to save creds', { sid: this.sid, error: err.message }));
    }

    // ==================== MESSAGE HANDLERS ====================

    /**
     * Handle new messages
     * @private
     * @param {Object} data - Messages data
     */
    async _handleMessagesUpsert(data) {
        if (!data || !data.messages || !Array.isArray(data.messages)) {
            logger.warn('Invalid messages data', { sid: this.sid });
            return;
        }

        this.stats.msgsRx += data.messages.length;

        try {
            await this.db.handleMsg(data);
        } catch (err) {
            this.stats.errors++;
            logger.error('Failed to save messages', { sid: this.sid, error: err.message });
        }
    }

    /**
     * Handle message updates
     * @private
     * @param {Array} ups - Message updates
     */
    async _handleMessagesUpdate(ups) {
        if (!Array.isArray(ups)) return;

        for (const up of ups) {
            try {
                if (!up.key?.id) continue;

                const status = this._getStatusFromCode(up.status);
                if (status) {
                    await this.db.updateMsgStatus(up.key.id, status);
                }

                if (up.starred !== undefined) {
                    await this.db.starMsg(up.key.id, up.starred);
                }

                this._emit('message_update', {
                    id: up.key.id,
                    status,
                    starred: up.starred
                });

            } catch (err) {
                this.stats.errors++;
                logger.error('Failed to update message', { sid: this.sid, error: err.message });
            }
        }
    }

    /**
     * Handle message deletion
     * @private
     * @param {Object} data - Delete data
     */
    async _handleMessagesDelete(data) {
        try {
            if ('keys' in data) {
                for (const key of data.keys) {
                    if (key?.id) {
                        await this.db.deleteMsg(key.id);
                        this._emit('message_delete', { id: key.id, chat: key.remoteJid });
                    }
                }
            } else if ('jid' in data && data.all) {
                await this.db.clearChatMsgs(data.jid);
                this._emit('chat_clear', { jid: data.jid });
            }
        } catch (err) {
            this.stats.errors++;
            logger.error('Failed to delete messages', { sid: this.sid, error: err.message });
        }
    }

    /**
     * Handle media update
     * @private
     * @param {Array} ups - Media updates
     */
    async _handleMediaUpdate(ups) {
        if (!Array.isArray(ups)) return;

        for (const up of ups) {
            try {
                if (!up.key?.id) continue;

                if (up.media) {
                    await this.db.markMediaDownloaded(up.key.id, up.media.url || 'downloaded');
                    this._emit('media_downloaded', { id: up.key.id });
                } else if (up.error) {
                    await this.db.markMediaFailed(up.key.id, up.error.message);
                    this._emit('media_failed', { id: up.key.id, error: up.error.message });
                }
            } catch (err) {
                logger.error('Failed to update media', { sid: this.sid, error: err.message });
            }
        }
    }

    /**
     * Handle reactions
     * @private
     * @param {Array} data - Reaction data
     */
    async _handleReaction(data) {
        try {
            await this.db.handleReaction(data);
        } catch (err) {
            logger.error('Failed to save reaction', { sid: this.sid, error: err.message });
        }
    }

    /**
     * Handle message receipts
     * @private
     * @param {Array} ups - Receipt updates
     */
    async _handleReceipt(ups) {
        if (!Array.isArray(ups)) return;

        for (const up of ups) {
            try {
                if (!up.key?.id || !up.userReceipt) continue;

                for (const r of up.userReceipt) {
                    await this.db.addReceipt({
                        msg_id: up.key.id,
                        participant: r.userJid,
                        type: r.receiptTimestamp ? 'read' : 'delivered',
                        ts: r.receiptTimestamp || Date.now()
                    });
                }

                const hasRead = up.userReceipt.some(r => r.receiptTimestamp);
                await this.db.updateMsgStatus(up.key.id, hasRead ? 'read' : 'delivered');

                this._emit('receipt', { id: up.key.id, receipts: up.userReceipt });

            } catch (err) {
                logger.error('Failed to handle receipt', { sid: this.sid, error: err.message });
            }
        }
    }

    // ==================== PRESENCE HANDLER ====================

    /**
     * Handle presence updates
     * @private
     * @param {Object} data - Presence data
     */
    async _handlePresence(data) {
        try {
            await this.db.handlePresence(data);
        } catch (err) {
            logger.error('Failed to save presence', { sid: this.sid, error: err.message });
        }
    }

    // ==================== CHAT HANDLERS ====================

    /**
     * Handle new chats
     * @private
     * @param {Array} chats - New chats
     */
    async _handleChatsUpsert(chats) {
        if (!Array.isArray(chats)) return;

        for (const c of chats) {
            try {
                if (!c.id) continue;

                await this.db.upsertChat({
                    jid: c.id,
                    name: c.name || c.subject,
                    is_group: c.id.endsWith('@g.us'),
                    is_broadcast: c.isBroadcast || false,
                    unread: c.unreadCount || 0,
                    last_msg_time: c.lastMessage?.messageTimestamp
                });

            } catch (err) {
                logger.error('Failed to save chat', { sid: this.sid, error: err.message });
            }
        }
    }

    /**
     * Handle chat updates
     * @private
     * @param {Array} ups - Chat updates
     */
    async _handleChatsUpdate(ups) {
        if (!Array.isArray(ups)) return;

        for (const up of ups) {
            try {
                if (!up.id) continue;

                const chat = await this.db.getChat(up.id).catch(() => null);
                if (chat) {
                    await this.db.upsertChat({
                        jid: up.id,
                        name: up.name,
                        archived: up.archive !== undefined ? up.archive : chat.archived,
                        pinned: up.pin ? 1 : chat.pinned,
                        pin_time: up.pin || chat.pin_time,
                        mute_until: up.mute !== undefined ? up.mute : chat.mute_until,
                        unread: up.unreadCount !== undefined ? up.unreadCount : chat.unread
                    });
                }

                this._emit('chat_update', up);

            } catch (err) {
                logger.error('Failed to update chat', { sid: this.sid, error: err.message });
            }
        }
    }

    /**
     * Handle chat deletion
     * @private
     * @param {Array} ids - Chat IDs
     */
    async _handleChatsDelete(ids) {
        if (!Array.isArray(ids)) return;

        for (const id of ids) {
            try {
                await this.db.deleteChat(id);
                this._emit('chat_delete', { jid: id });
            } catch (err) {
                logger.error('Failed to delete chat', { sid: this.sid, error: err.message });
            }
        }
    }

    /**
     * Handle chat lock
     * @private
     * @param {string} id - Chat ID
     * @param {boolean} locked - Lock status
     */
    async _handleChatsLock(id, locked) {
        try {
            const chat = await this.db.getChat(id).catch(() => null);
            if (chat) {
                await this.db.upsertChat({ jid: id, locked: locked ? 1 : 0 });
            }
        } catch (err) {
            logger.error('Failed to lock chat', { sid: this.sid, error: err.message });
        }
    }

    // ==================== CONTACT HANDLERS ====================

    /**
     * Handle new contacts
     * @private
     * @param {Array} contacts - New contacts
     */
    async _handleContactsUpsert(contacts) {
        if (!Array.isArray(contacts)) return;

        for (const c of contacts) {
            try {
                if (!c.id) continue;

                await this.db.upsertContact({
                    jid: c.id,
                    name: c.name || c.notify,
                    short: c.short,
                    verified: c.verifiedName,
                    phone: c.id.split('@')[0],
                    push: c.notify
                });

            } catch (err) {
                logger.error('Failed to save contact', { sid: this.sid, error: err.message });
            }
        }
    }

    /**
     * Handle contact updates
     * @private
     * @param {Array} ups - Contact updates
     */
    async _handleContactsUpdate(ups) {
        if (!Array.isArray(ups)) return;

        for (const up of ups) {
            try {
                if (!up.id) continue;

                const contact = await this.db.getContact(up.id).catch(() => null);
                if (contact) {
                    await this.db.upsertContact({
                        jid: up.id,
                        name: up.name || up.verifiedName,
                        short: up.short,
                        verified: up.verifiedName,
                        push: up.notify
                    });
                }

            } catch (err) {
                logger.error('Failed to update contact', { sid: this.sid, error: err.message });
            }
        }
    }

    // ==================== GROUP HANDLERS ====================

    /**
     * Handle new groups
     * @private
     * @param {Array} groups - New groups
     */
    async _handleGroupsUpsert(groups) {
        if (!Array.isArray(groups)) return;

        for (const g of groups) {
            try {
                if (!g.id) continue;

                await this.db.upsertGroup({
                    jid: g.id,
                    subject: g.subject,
                    subject_owner: g.subjectOwner,
                    subject_ts: g.subjectTime,
                    desc: g.desc,
                    desc_owner: g.descOwner,
                    desc_id: g.descId,
                    desc_ts: g.descTime,
                    pic: g.profilePicUrl,
                    pic_id: g.picId,
                    announce: g.announce || false,
                    restrict: g.restrict || false,
                    locked: g.locked || false,
                    approval: g.joinApprovalMode || false,
                    created_ts: g.creation
                });

                if (g.participants && Array.isArray(g.participants)) {
                    for (const p of g.participants) {
                        await this.db.upsertGroupMember({
                            group_jid: g.id,
                            member: p.id,
                            lid: p.lid,
                            role: p.role || 'member',
                            active: true,
                            added_ts: g.creation
                        });
                    }
                }

            } catch (err) {
                logger.error('Failed to save group', { sid: this.sid, error: err.message });
            }
        }
    }

    /**
     * Handle group updates
     * @private
     * @param {Array} ups - Group updates
     */
    async _handleGroupsUpdate(ups) {
        if (!Array.isArray(ups)) return;

        for (const up of ups) {
            try {
                if (!up.id) continue;

                const group = await this.db.getGroup(up.id).catch(() => null);
                if (group) {
                    await this.db.upsertGroup({
                        jid: up.id,
                        subject: up.subject,
                        subject_ts: up.subjectTime,
                        desc: up.desc,
                        desc_id: up.descId,
                        desc_ts: up.descTime,
                        pic: up.profilePicUrl,
                        pic_id: up.picId,
                        announce: up.announce !== undefined ? up.announce : group.announce,
                        restrict: up.restrict !== undefined ? up.restrict : group.restrict,
                        locked: up.locked !== undefined ? up.locked : group.locked,
                        approval: up.joinApprovalMode !== undefined ? up.joinApprovalMode : group.approval
                    });
                }

            } catch (err) {
                logger.error('Failed to update group', { sid: this.sid, error: err.message });
            }
        }
    }

    /**
     * Handle group participant updates
     * @private
     * @param {Object} data - Participant update data
     */
    async _handleGroupParticipants(data) {
        try {
            await this.db.handleGroupUpdate(data);
        } catch (err) {
            logger.error('Failed to update group members', { sid: this.sid, error: err.message });
        }
    }

    /**
     * Handle group join requests
     * @private
     * @param {Object} data - Join request data
     */
    async _handleGroupJoinRequest(data) {
        try {
            await this.db.upsertGroupMember({
                group_jid: data.id,
                member: data.participant,
                req_status: data.action,
                req_method: data.method,
                req_ts: Date.now()
            });

            this._emit('group_join_request', data);

        } catch (err) {
            logger.error('Failed to handle group join request', { sid: this.sid, error: err.message });
        }
    }

    /**
     * Handle group member tags
     * @private
     * @param {Object} data - Member tag data
     */
    async _handleGroupMemberTag(data) {
        try {
            const member = await this.db.getGroupMember(data.groupId, data.participant);
            if (member) {
                await this.db.upsertGroupMember({
                    group_jid: data.groupId,
                    member: data.participant,
                    label: data.label
                });
            }
        } catch (err) {
            logger.error('Failed to handle group member tag', { sid: this.sid, error: err.message });
        }
    }

    // ==================== BLOCKLIST HANDLERS ====================

    /**
     * Handle blocklist set
     * @private
     * @param {Array} blocklist - Blocked JIDs
     */
    async _handleBlocklistSet(blocklist) {
        if (!Array.isArray(blocklist)) return;

        for (const jid of blocklist) {
            try {
                await this.db.blockContact(jid, true);
            } catch (err) {
                logger.error('Failed to block contact', { sid: this.sid, jid, error: err.message });
            }
        }
    }

    /**
     * Handle blocklist update
     * @private
     * @param {Array} blocklist - Blocked JIDs
     * @param {string} type - Add or remove
     */
    async _handleBlocklistUpdate(blocklist, type) {
        if (!Array.isArray(blocklist)) return;

        for (const jid of blocklist) {
            try {
                await this.db.blockContact(jid, type === 'add');
                this._emit('blocklist_update', { jid, type });
            } catch (err) {
                logger.error('Failed to update blocklist', { sid: this.sid, jid, error: err.message });
            }
        }
    }

    // ==================== CALL HANDLERS ====================

    /**
     * Handle calls
     * @private
     * @param {Array} calls - Call data
     */
    async _handleCalls(calls) {
        if (!Array.isArray(calls)) return;

        for (const c of calls) {
            try {
                await this.db.upsertCall({
                    id: c.id,
                    from_jid: c.from,
                    to_jid: c.to,
                    type: c.isVideo ? CALL_TYPES.VIDEO : CALL_TYPES.AUDIO,
                    status: c.status,
                    ts: c.timestamp,
                    video: c.isVideo ? 1 : 0,
                    group_jid: c.groupJid,
                    meta: JSON.stringify(c)
                });

                this._emit('call', c);

            } catch (err) {
                logger.error('Failed to save call', { sid: this.sid, error: err.message });
            }
        }
    }

    // ==================== LABEL HANDLERS ====================

    /**
     * Handle label edit
     * @private
     * @param {Object} label - Label data
     */
    async _handleLabelsEdit(label) {
        try {
            await this.db.upsertLabel({
                id: label.id,
                name: label.name,
                color: label.color,
                predefined_id: label.predefinedId,
                count: label.count || 0,
                meta: JSON.stringify(label)
            });

            this._emit('label_edit', label);

        } catch (err) {
            logger.error('Failed to save label', { sid: this.sid, error: err.message });
        }
    }

    /**
     * Handle label association
     * @private
     * @param {Object} association - Association data
     * @param {string} type - Add or remove
     */
    async _handleLabelsAssociation(association, type) {
        try {
            const target = association.chatId || association.messageId;
            const assocType = association.chatId ? 'chat' : 'msg';

            if (type === 'add') {
                if (assocType === 'chat') {
                    await this.db.addLabelToChat(association.labelId, target);
                } else {
                    await this.db.addLabelToMsg(association.labelId, target);
                }
            } else {
                if (assocType === 'chat') {
                    await this.db.removeLabelFromChat(association.labelId, target);
                }
            }

            this._emit('label_association', { association, type });

        } catch (err) {
            logger.error('Failed to handle label association', { sid: this.sid, error: err.message });
        }
    }

    // ==================== LID MAPPING HANDLER ====================

    /**
     * Handle LID mapping update
     * @private
     * @param {Object} data - LID mapping data
     */
    async _handleLidMapping(data) {
        try {
            await this.db.handleLID(data);
        } catch (err) {
            logger.error('Failed to save LID mapping', { sid: this.sid, error: err.message });
        }
    }

    // ==================== SETTINGS HANDLER ====================

    /**
     * Handle settings update
     * @private
     * @param {Object} up - Settings update
     */
    async _handleSettingsUpdate(up) {
        try {
            await this.db.setSessionSetting(up.setting, up.value);
            this._emit('settings_update', up);
        } catch (err) {
            logger.error('Failed to save settings', { sid: this.sid, error: err.message });
        }
    }

    // ==================== MESSAGING HISTORY HANDLER ====================

    /**
     * Handle messaging history
     * @private
     * @param {Object} hist - History data
     */
    async _handleMessagingHistory(hist) {
        const { chats, contacts, messages, lidPnMappings, progress, syncType } = hist;
        const context = { sid: this.sid, progress, type: syncType };

        logger.debug('Processing messaging history', context);

        try {
            await this.db.setSync('history', {
                status: progress === 100 ? 'completed' : 'in_progress',
                progress,
                type: syncType
            });

            this._emit('history_progress', { progress, type: syncType });

            // Process in batches to avoid memory issues
            const batchSize = 100;

            // Process chats
            if (chats && Array.isArray(chats)) {
                for (let i = 0; i < chats.length; i += batchSize) {
                    const batch = chats.slice(i, i + batchSize);
                    await Promise.all(batch.map(c =>
                        this.db.upsertChat({
                            jid: c.id,
                            name: c.name,
                            is_group: c.id.endsWith('@g.us'),
                            is_broadcast: c.isBroadcast || false,
                            unread: c.unreadCount || 0,
                            last_msg_time: c.lastMessage?.messageTimestamp
                        }).catch(err => logger.debug('Failed to save chat history', { ...context, error: err.message }))
                    ));
                }
            }

            // Process contacts
            if (contacts && Array.isArray(contacts)) {
                for (let i = 0; i < contacts.length; i += batchSize) {
                    const batch = contacts.slice(i, i + batchSize);
                    await Promise.all(batch.map(c =>
                        this.db.upsertContact({
                            jid: c.id,
                            name: c.name,
                            phone: c.id.split('@')[0]
                        }).catch(err => logger.debug('Failed to save contact history', { ...context, error: err.message }))
                    ));
                }
            }

            // Process LID mappings
            if (lidPnMappings && Array.isArray(lidPnMappings)) {
                for (const m of lidPnMappings) {
                    await this.db.handleLID(m).catch(err =>
                        logger.debug('Failed to save LID mapping', { ...context, error: err.message })
                    );
                }
            }

            if (progress === 100) {
                this._emit('history_complete', {
                    chats: chats?.length || 0,
                    contacts: contacts?.length || 0,
                    messages: messages?.length || 0
                });
                logger.info('History sync completed', context);
            }

        } catch (err) {
            logger.error('Failed to process history', { ...context, error: err.message });
        }
    }

    // ==================== WEBHOOK HANDLER ====================

    /**
     * Send event to webhook
     * @private
     * @param {string} event - Event type
     * @param {Object} data - Event data
     */
    async _sendToWebhook(event, data) {
        // Refresh cache every 5 minutes
        if (Date.now() - this.webhookCacheTime > 300000) {
            await this._refreshWebhookCache();
        }

        const webhook = this.webhookCache.get(event);
        if (!webhook) return;

        this.stats.webhooks++;

        const payload = {
            event,
            sessionId: this.sid,
            userId: this.uid,
            timestamp: new Date().toISOString(),
            data
        };

        // Queue webhook delivery
        setImmediate(() => this._deliverWebhook(event, webhook, payload));
    }

    /**
     * Deliver webhook with retry
     * @private
     * @param {string} event - Event type
     * @param {Object} webhook - Webhook config
     * @param {Object} payload - Payload to send
     */
    async _deliverWebhook(event, webhook, payload) {
        const start = Date.now();
        const context = { sid: this.sid, event, url: webhook.url };

        try {
            await retry(
                async () => {
                    const response = await axios({
                        method: 'POST',
                        url: webhook.url,
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': 'WhatsApp-Clone-API/1.0',
                            ...webhook.headers
                        },
                        data: payload,
                        timeout: webhook.timeout || 10000,
                        validateStatus: null
                    });

                    const success = response.status >= 200 && response.status < 300;
                    const duration = Date.now() - start;

                    // Find webhook ID from DB (needed for logging)
                    const dbWebhook = await this.db.getWebhookByEvent(event).catch(() => null);

                    if (dbWebhook) {
                        await this.db.logWebhookDelivery(dbWebhook.id, event, {
                            payload,
                            response_status: response.status,
                            response_body: response.data,
                            success,
                            duration
                        }).catch(() => { });

                        await this.db.updateWebhookStats(dbWebhook.id, success, response.status).catch(() => { });
                    }

                    if (success) {
                        logger.debug('Webhook delivered', { ...context, status: response.status, duration });
                    } else {
                        logger.warn('Webhook failed', { ...context, status: response.status, duration });
                        throw new Error(`HTTP ${response.status}`);
                    }
                },
                {
                    maxAttempts: webhook.retry_count || 3,
                    initialDelay: 5000,
                    onRetry: ({ attempt }) => {
                        logger.debug(`Webhook retry ${attempt}`, context);
                    }
                }
            );

        } catch (err) {
            logger.error('Webhook delivery failed permanently', { ...context, error: err.message });

            // Log final failure
            const dbWebhook = await this.db.getWebhookByEvent(event).catch(() => null);
            if (dbWebhook) {
                await this.db.logWebhookDelivery(dbWebhook.id, event, {
                    payload,
                    success: false,
                    duration: Date.now() - start,
                    error: err.message
                }).catch(() => { });
            }
        }
    }

    // ==================== MESSAGE QUEUE ====================

    /**
     * Queue message for sending
     * @private
     * @param {string} jid - Recipient JID
     * @param {Object} message - Message to send
     * @param {Function} resolve - Promise resolve
     * @param {Function} reject - Promise reject
     */
    _queueMessage(jid, message, resolve, reject) {
        this.messageQueue.push({ jid, message, resolve, reject, queuedAt: Date.now() });

        if (!this.processingQueue) {
            this._processMessageQueue();
        }
    }

    /**
     * Process message queue
     * @private
     */
    async _processMessageQueue() {
        if (this.processingQueue || this.messageQueue.length === 0) return;

        this.processingQueue = true;

        try {
            while (this.messageQueue.length > 0) {
                // Check connection state
                if (this.state !== 'open') {
                    // Wait for reconnection
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }

                const item = this.messageQueue.shift();

                // Check if message is too old (5 minutes)
                if (Date.now() - item.queuedAt > 300000) {
                    item.reject(new Error('Message timeout'));
                    continue;
                }

                try {
                    const result = await this.sock.sendMessage(item.jid, item.message);
                    item.resolve(result);
                } catch (err) {
                    item.reject(err);
                }

                // Small delay between messages
                await sleep(100);
            }
        } finally {
            this.processingQueue = false;
        }
    }

    // ==================== ACTION METHODS ====================

    /**
     * Send message
     * @param {string} jid - Recipient JID
     * @param {*} content - Message content
     * @param {string} type - Message type
     * @returns {Promise<Object>} Sent message
     */
    async sendMessage(jid, content, type = MESSAGE_TYPES.TEXT) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid) throw new Error('JID required');
        if (!content) throw new Error('Content required');

        // Validate JID
        if (!isValidJid(jid)) {
            throw new Error('Invalid JID format');
        }

        this.lastActivity = Date.now();

        // Build message based on type
        let message;

        switch (type) {
            case MESSAGE_TYPES.TEXT:
                if (typeof content !== 'string') throw new Error('Text content must be string');
                message = { text: content };
                break;

            case MESSAGE_TYPES.IMAGE:
                if (!content.buffer) throw new Error('Image buffer required');
                message = {
                    image: content.buffer,
                    caption: content.caption || ''
                };
                break;

            case MESSAGE_TYPES.VIDEO:
                if (!content.buffer) throw new Error('Video buffer required');
                message = {
                    video: content.buffer,
                    caption: content.caption || ''
                };
                break;

            case MESSAGE_TYPES.AUDIO:
                if (!content.buffer) throw new Error('Audio buffer required');
                message = { audio: content.buffer };
                break;

            case MESSAGE_TYPES.DOCUMENT:
                if (!content.buffer) throw new Error('Document buffer required');
                message = {
                    document: content.buffer,
                    fileName: content.name || 'document',
                    caption: content.caption
                };
                break;

            case MESSAGE_TYPES.STICKER:
                if (!content.buffer) throw new Error('Sticker buffer required');
                message = { sticker: content.buffer };
                break;

            case MESSAGE_TYPES.LOCATION:
                if (!content.latitude || !content.longitude) {
                    throw new Error('Latitude and longitude required');
                }
                message = {
                    location: {
                        degreesLatitude: content.latitude,
                        degreesLongitude: content.longitude,
                        name: content.name,
                        address: content.address
                    }
                };
                break;

            case MESSAGE_TYPES.CONTACT:
                if (!content.name || !content.number) {
                    throw new Error('Contact name and number required');
                }
                message = {
                    contacts: {
                        displayName: content.name,
                        contacts: [{
                            vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${content.name}\nTEL;type=CELL:${content.number}\nEND:VCARD`
                        }]
                    }
                };
                break;

            default:
                throw new Error(`Unsupported message type: ${type}`);
        }

        // Queue or send directly
        return new Promise((resolve, reject) => {
            this._queueMessage(jid, message, resolve, reject);
        }).then(async (sent) => {
            this.stats.msgsTx++;

            await this.db.logActivity({
                user_id: this.uid,
                session_id: this.sid,
                action: 'send_message',
                resource: jid,
                details: { type, id: sent?.key?.id }
            }).catch(() => { });

            return sent;
        });
    }

    /**
     * Send reaction
     * @param {string} jid - Chat JID
     * @param {string} msgId - Message ID
     * @param {string} emoji - Reaction emoji
     * @returns {Promise<Object>} Sent reaction
     */
    async sendReaction(jid, msgId, emoji) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid || !msgId || !emoji) throw new Error('JID, message ID and emoji required');
        if (!isValidJid(jid)) throw new Error('Invalid JID format');

        this.lastActivity = Date.now();

        try {
            const result = await this.sock.sendMessage(jid, {
                react: {
                    text: emoji,
                    key: { id: msgId, remoteJid: jid }
                }
            });

            await this.db.logActivity({
                user_id: this.uid,
                session_id: this.sid,
                action: 'send_reaction',
                resource: msgId,
                details: { jid, emoji }
            }).catch(() => { });

            return result;

        } catch (error) {
            this.stats.errors++;
            logger.error('Failed to send reaction', { sid: this.sid, error: error.message });
            throw error;
        }
    }

    /**
     * Mark message as read
     * @param {string} jid - Chat JID
     * @param {string} msgId - Message ID
     */
    async markRead(jid, msgId) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid || !msgId) throw new Error('JID and message ID required');

        this.lastActivity = Date.now();

        try {
            await this.sock.readMessages([{ remoteJid: jid, id: msgId }]);
        } catch (error) {
            logger.error('Failed to mark as read', { sid: this.sid, error: error.message });
            throw error;
        }
    }

    /**
     * Update presence
     * @param {string} jid - Chat JID
     * @param {string} state - Presence state
     */
    async setPresence(jid, state) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid || !state) throw new Error('JID and state required');

        const validStates = Object.values(PRESENCE_STATES);
        if (!validStates.includes(state)) {
            throw new Error(`Invalid state. Must be one of: ${validStates.join(', ')}`);
        }

        this.lastActivity = Date.now();

        try {
            await this.sock.sendPresenceUpdate(state, jid);

            await this.db.upsertContact({
                jid,
                presence: state,
                presence_last: new Date().toISOString()
            }).catch(err => logger.error('Failed to update presence in DB', err));            
        } catch (error) {
            logger.error('Failed to update presence', { sid: this.sid, error: error.message });
            throw error;
        }
    }

    /**
     * Group operations
     * @param {string} cmd - Command
     * @param {string} jid - Group JID
     * @param {Array} data - Additional data
     * @returns {Promise<*>} Result
     */
    async groupAction(cmd, jid, data = []) {
        if (!this.sock) throw new Error('Socket not connected');

        const validCmds = [
            'create', 'subject', 'desc', 'add', 'remove', 'promote', 'demote',
            'announce', 'not_announce', 'lock', 'unlock', 'invite', 'revoke', 'join', 'leave'
        ];

        if (!validCmds.includes(cmd)) {
            throw new Error(`Invalid command: ${cmd}`);
        }

        this.lastActivity = Date.now();

        try {
            let result;

            switch (cmd) {
                case 'create':
                    if (!jid) throw new Error('Group subject required');
                    result = await this.sock.groupCreate(jid, data);
                    break;

                case 'subject':
                    if (!jid) throw new Error('Group JID required');
                    if (!data[0]) throw new Error('Subject required');
                    result = await this.sock.groupUpdateSubject(jid, data[0]);
                    break;

                case 'desc':
                    if (!jid) throw new Error('Group JID required');
                    if (!data[0]) throw new Error('Description required');
                    result = await this.sock.groupUpdateDescription(jid, data[0]);
                    break;

                case 'add':
                case 'remove':
                case 'promote':
                case 'demote':
                    if (!jid) throw new Error('Group JID required');
                    if (!data || !data.length) throw new Error('Participants required');
                    result = await this.sock.groupParticipantsUpdate(jid, data, cmd);
                    break;

                case 'announce':
                case 'not_announce':
                case 'lock':
                case 'unlock':
                    if (!jid) throw new Error('Group JID required');
                    const setting = cmd === 'lock' ? 'locked' :
                        cmd === 'unlock' ? 'unlocked' : cmd;
                    result = await this.sock.groupSettingUpdate(jid, setting);
                    break;

                case 'invite':
                    if (!jid) throw new Error('Group JID required');
                    const code = await this.sock.groupInviteCode(jid);
                    await this.db.upsertGroup({
                        jid,
                        meta: JSON.stringify({
                            ...(await this.db.getGroup(jid)).meta ? JSON.parse(await this.db.getGroup(jid).meta) : {},
                            inviteCode: code,
                            inviteGenerated: Date.now()
                        })
                    }).catch(err => logger.error('Failed to store invite code', err));    
                    result = { code };                
                    break;

                case 'revoke':
                    if (!jid) throw new Error('Group JID required');
                    const newCode = await this.sock.groupRevokeInvite(jid);
                    await this.db.upsertGroup({
                        jid,
                        meta: JSON.stringify({
                            ...(await this.db.getGroup(jid)).meta ? JSON.parse(await this.db.getGroup(jid).meta) : {},
                            inviteCode: newCode,
                            inviteRevoked: Date.now()
                        })
                    }).catch(err => logger.error('Failed to update invite code', err));                    
                    result = { code: newCode };
                    break;

                case 'join':
                    if (!data[0]) throw new Error('Invite code required');
                    result = await this.sock.groupAcceptInvite(data[0]);
                    break;

                case 'leave':
                    if (!jid) throw new Error('Group JID required');
                    result = await this.sock.groupLeave(jid);
                    break;
            }

            await this.db.logActivity({
                user_id: this.uid,
                session_id: this.sid,
                action: `group_${cmd}`,
                resource: jid || 'group',
                details: { cmd, data }
            }).catch(() => { });

            return result;

        } catch (error) {
            this.stats.errors++;
            logger.error(`Group action ${cmd} failed`, { sid: this.sid, error: error.message });
            throw error;
        }
    }

    /**
     * Block/unblock user
     * @param {string} jid - User JID
     * @param {boolean} block - True to block, false to unblock
     */
    async blockUser(jid, block = true) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid) throw new Error('JID required');

        this.lastActivity = Date.now();

        try {
            await this.sock.updateBlockStatus(jid, block ? 'block' : 'unblock');
            await this.db.blockContact(jid, block);

            await this.db.logActivity({
                user_id: this.uid,
                session_id: this.sid,
                action: block ? 'block' : 'unblock',
                resource: jid
            }).catch(() => { });

        } catch (error) {
            this.stats.errors++;
            logger.error(`Failed to ${block ? 'block' : 'unblock'} user`, { sid: this.sid, error: error.message });
            throw error;
        }
    }

    /**
     * Profile operations
     * @param {string} cmd - Command
     * @param {string} jid - JID
     * @param {*} data - Data
     * @returns {Promise<*>} Result
     */
    async profileAction(cmd, jid = null, data = null) {
        if (!this.sock) throw new Error('Socket not connected');

        const validCmds = ['name', 'status', 'pic', 'pic_rm', 'get_status'];
        if (!validCmds.includes(cmd)) throw new Error(`Invalid command: ${cmd}`);

        this.lastActivity = Date.now();

        try {
            let result;

            switch (cmd) {
                case 'name':
                    result = await this.sock.updateProfileName(data);
                    
                    // Store in session meta
                    await this.db.setSessionMeta(this.sid, 'profile_name', data);
                    break;

                case 'status':
                    result = await this.sock.updateProfileStatus(data);
                    
                    // Store in session meta
                    await this.db.setSessionMeta(this.sid, 'profile_status', data);
                    break;

                case 'pic':
                    result = await this.sock.updateProfilePicture(jid || this.sid, data);
                    
                    // Store in session meta or contact
                    if (jid && jid !== this.sid) {
                        await this.db.upsertContact({ jid, pic: 'updated' });
                    } else {
                        await this.db.setSessionMeta(this.sid, 'profile_pic', 'updated');
                    }
                    break;

                case 'get_status':
                    if (!jid) throw new Error('JID required');
                    const status = await this.sock.fetchStatus(jid);
                    result = { status: status?.status || null };
                    break;
            }

            await this.db.logActivity({
                user_id: this.uid,
                session_id: this.sid,
                action: `profile_${cmd}`,
                resource: jid,
                details: { cmd }
            }).catch(() => { });

            return result;

        } catch (error) {
            this.stats.errors++;
            logger.error(`Profile action ${cmd} failed`, { sid: this.sid, error: error.message });
            throw error;
        }
    }

    /**
     * Newsletter operations
     * @param {string} cmd - Command
     * @param {string} id - Newsletter ID
     * @param {*} data - Data
     * @returns {Promise<*>} Result
     */
    async newsletterAction(cmd, id = null, data = null) {
        if (!this.sock) throw new Error('Socket not connected');

        const validCmds = ['create', 'follow', 'unfollow', 'send'];
        if (!validCmds.includes(cmd)) throw new Error(`Invalid command: ${cmd}`);

        this.lastActivity = Date.now();

        try {
            let result;

            switch (cmd) {
                case 'create':
                    if (!data?.name) throw new Error('Newsletter name required');
                    result = await this.sock.newsletterCreate(data.name, data.desc || '');
                    break;

                case 'follow':
                    if (!id) throw new Error('Newsletter ID required');
                    result = await this.sock.newsletterFollow(id);
                    break;

                case 'unfollow':
                    if (!id) throw new Error('Newsletter ID required');
                    result = await this.sock.newsletterUnfollow(id);
                    break;

                case 'send':
                    if (!id) throw new Error('Newsletter ID required');
                    if (!data) throw new Error('Message content required');
                    result = await this.sock.sendMessage(id, { text: data });
                    break;
            }

            await this.db.logActivity({
                user_id: this.uid,
                session_id: this.sid,
                action: `newsletter_${cmd}`,
                resource: id,
                details: { cmd, data }
            }).catch(() => { });

            return result;

        } catch (error) {
            this.stats.errors++;
            logger.error(`Newsletter action ${cmd} failed`, { sid: this.sid, error: error.message });
            throw error;
        }
    }

    // ==================== WEBHOOK METHODS ====================

    /**
     * Create webhook
     * @param {Object} data - Webhook data
     * @returns {Promise<Object>} Created webhook
     */
    async createWebhook(data) {
        const result = await this.db.createWebhook(data);
        await this._refreshWebhookCache();
        return result;
    }

    /**
     * Get all webhooks
     * @returns {Promise<Array>} Webhooks
     */
    async getWebhooks() {
        return this.db.getAllWebhooks();
    }

    /**
     * Update webhook
     * @param {string} id - Webhook ID
     * @param {Object} updates - Updates
     * @returns {Promise<Object>} Updated webhook
     */
    async updateWebhook(id, updates) {
        const result = await this.db.updateWebhook(id, updates);
        await this._refreshWebhookCache();
        return result;
    }

    /**
     * Delete webhook
     * @param {string} id - Webhook ID
     * @returns {Promise<Object>} Result
     */
    async deleteWebhook(id) {
        const result = await this.db.deleteWebhook(id);
        await this._refreshWebhookCache();
        return result;
    }

    /**
     * Test webhook
     * @param {string} id - Webhook ID
     * @returns {Promise<Object>} Test result
     */
    async testWebhook(id) {
        const webhook = await this.db.get('webhooks', ['id'], [id]);
        if (!webhook) throw new Error('Webhook not found');

        const sampleData = {
            message: {
                id: 'test_msg_123',
                from: '5511999999999@s.whatsapp.net',
                text: 'Test message',
                timestamp: Date.now()
            }
        };

        const payload = {
            event: webhook.event,
            sessionId: this.sid,
            timestamp: new Date().toISOString(),
            test: true,
            data: sampleData
        };

        const start = Date.now();

        try {
            const response = await axios({
                method: 'POST',
                url: webhook.url,
                headers: webhook.headers ? JSON.parse(webhook.headers) : {},
                data: payload,
                timeout: webhook.timeout || 10000,
                validateStatus: null
            });

            return {
                success: response.status >= 200 && response.status < 300,
                statusCode: response.status,
                responseTime: Date.now() - start,
                data: response.data
            };

        } catch (error) {
            return {
                success: false,
                error: error.message,
                responseTime: Date.now() - start,
                statusCode: error.response?.status
            };
        }
    }

    /**
     * Archive/unarchive chat
     * @param {string} jid - Chat JID
     * @param {boolean} archive - True to archive
     * @returns {Promise<Object>}
     */
    async archiveChat(jid, archive = true) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid) throw new Error('JID required');

        this.lastActivity = Date.now();

        try {
            // Send archive command to WhatsApp
            const result = await this.sock.chatModify(
                { archive: archive },
                jid
            );

            // Update local DB
            await this.db.upsertChat({
                jid,
                archived: archive ? 1 : 0
            });

            return result;
        } catch (error) {
            this.stats.errors++;
            logger.error('Archive chat failed', { sid: this.sid, jid, error: error.message });
            throw error;
        }
    }

    /**
     * Pin/unpin chat
     * @param {string} jid - Chat JID
     * @param {boolean} pin - True to pin
     * @returns {Promise<Object>}
     */
    async pinChat(jid, pin = true) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid) throw new Error('JID required');

        this.lastActivity = Date.now();

        try {
            // Send pin command to WhatsApp
            const result = await this.sock.chatModify(
                { pin: pin ? 1 : -1 },
                jid
            );

            // Update local DB
            await this.db.upsertChat({
                jid,
                pinned: pin ? 1 : 0,
                pin_time: pin ? Date.now() : null
            });

            return result;
        } catch (error) {
            this.stats.errors++;
            logger.error('Pin chat failed', { sid: this.sid, jid, error: error.message });
            throw error;
        }
    }

    /**
     * Mute/unmute chat
     * @param {string} jid - Chat JID
     * @param {number} muteUntil - Timestamp to unmute (null to unmute)
     * @returns {Promise<Object>}
     */
    async muteChat(jid, muteUntil = null) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid) throw new Error('JID required');

        this.lastActivity = Date.now();

        try {
            // Send mute command to WhatsApp
            const result = await this.sock.chatModify(
                { mute: muteUntil || -1 },
                jid
            );

            // Update local DB
            await this.db.upsertChat({
                jid,
                mute_until: muteUntil
            });

            return result;
        } catch (error) {
            this.stats.errors++;
            logger.error('Mute chat failed', { sid: this.sid, jid, error: error.message });
            throw error;
        }
    }

    /**
     * Mark chat as read/unread
     * @param {string} jid - Chat JID
     * @param {boolean} read - True to mark as read
     * @returns {Promise<Object>}
     */
    async markChatRead(jid, read = true) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid) throw new Error('JID required');

        this.lastActivity = Date.now();

        try {
            // Send mark read command to WhatsApp
            const result = await this.sock.chatModify(
                { markRead: read },
                jid
            );

            // Update local DB
            await this.db.upsertChat({
                jid,
                unread: read ? 0 : 1
            });

            return result;
        } catch (error) {
            this.stats.errors++;
            logger.error('Mark chat read failed', { sid: this.sid, jid, error: error.message });
            throw error;
        }
    }

    /**
     * Delete chat
     * @param {string} jid - Chat JID
     * @returns {Promise<Object>}
     */
    async deleteChat(jid) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid) throw new Error('JID required');

        this.lastActivity = Date.now();

        try {
            // Send delete chat command to WhatsApp
            const result = await this.sock.chatModify(
                { delete: true },
                jid
            );

            // Delete from local DB (soft delete)
            await this.db.deleteChat(jid);

            return result;
        } catch (error) {
            this.stats.errors++;
            logger.error('Delete chat failed', { sid: this.sid, jid, error: error.message });
            throw error;
        }
    }

    /**
     * Delete message for everyone
     * @param {string} jid - Chat JID
     * @param {string} msgId - Message ID
     * @returns {Promise<Object>}
     */
    async deleteMessage(jid, msgId) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid || !msgId) throw new Error('JID and message ID required');

        this.lastActivity = Date.now();

        try {
            // Send delete message command to WhatsApp
            const result = await this.sock.sendMessage(jid, {
                delete: {
                    remoteJid: jid,
                    fromMe: true,
                    id: msgId,
                    participant: jid
                }
            });

            // Delete from local DB (soft delete)
            await this.db.deleteMsg(msgId);

            return result;
        } catch (error) {
            this.stats.errors++;
            logger.error('Delete message failed', { sid: this.sid, jid, msgId, error: error.message });
            throw error;
        }
    }

    /**
     * Star/unstar message
     * @param {string} jid - Chat JID
     * @param {string} msgId - Message ID
     * @param {boolean} star - True to star
     * @returns {Promise<Object>}
     */
    async starMessage(jid, msgId, star = true) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid || !msgId) throw new Error('JID and message ID required');

        this.lastActivity = Date.now();

        try {
            // Send star command to WhatsApp
            const result = await this.sock.chatModify(
                { star: { messages: [{ id: msgId, fromMe: true }], star: star } },
                jid
            );

            // Update local DB
            await this.db.starMsg(msgId, star);

            return result;
        } catch (error) {
            this.stats.errors++;
            logger.error('Star message failed', { sid: this.sid, jid, msgId, error: error.message });
            throw error;
        }
    }

    // ==================== GETTERS ====================

    /**
     * Get all chats
     * @param {boolean} includeArchived - Include archived chats
     * @returns {Promise<Array>} Chats
     */
    async getChats(includeArchived = false) {
        return this.db.getAllChats(includeArchived);
    }

    /**
     * Get chat by JID
     * @param {string} jid - Chat JID
     * @returns {Promise<Object>} Chat
     */
    async getChat(jid) {
        return this.db.getChat(jid);
    }

    /**
     * Get all contacts
     * @returns {Promise<Array>} Contacts
     */
    async getContacts() {
        return this.db.getAllContacts();
    }

    /**
     * Get contact by JID
     * @param {string} jid - Contact JID
     * @returns {Promise<Object>} Contact
     */
    async getContact(jid) {
        return this.db.getContact(jid);
    }

    /**
     * Get messages
     * @param {string} jid - Chat JID
     * @param {number} limit - Limit
     * @param {number} offset - Offset
     * @param {number} before - Before timestamp
     * @param {number} after - After timestamp
     * @returns {Promise<Array>} Messages
     */
    async getMessages(jid, limit = 50, offset = 0, before = null, after = null) {
        return this.db.getChatMsgs(jid, limit, offset, before, after);
    }

    /**
     * Get message by ID
     * @param {string} id - Message ID
     * @returns {Promise<Object>} Message
     */
    async getMessage(id) {
        return this.db.getMsg(id);
    }

    /**
     * Get starred messages
     * @param {number} limit - Limit
     * @returns {Promise<Array>} Starred messages
     */
    async getStarred(limit = 50) {
        return this.db.getStarredMsgs(limit);
    }

    /**
     * Search messages
     * @param {string} query - Search query
     * @param {string} jid - Chat JID (optional)
     * @param {number} limit - Limit
     * @returns {Promise<Array>} Matching messages
     */
    async searchMessages(query, jid = null, limit = 50) {
        return this.db.searchMsgs(jid, query, limit);
    }

    /**
     * Get all groups
     * @returns {Promise<Array>} Groups
     */
    async getGroups() {
        return this.db.getAllGroups();
    }

    /**
     * Get group by JID
     * @param {string} jid - Group JID
     * @returns {Promise<Object>} Group
     */
    async getGroup(jid) {
        return this.db.getGroup(jid);
    }

    /**
     * Get group members
     * @param {string} jid - Group JID
     * @returns {Promise<Array>} Members
     */
    async getGroupMembers(jid) {
        return this.db.getGroupMembers(jid);
    }

    /**
     * Get blocked contacts
     * @returns {Promise<Array>} Blocked JIDs
     */
    async getBlocked() {
        return this.db.all('blocklist');
    }

    /**
     * Get call history
     * @param {number} limit - Limit
     * @returns {Promise<Array>} Calls
     */
    async getCalls(limit = 50) {
        return this.db.getCalls(limit);
    }

    /**
     * Get missed calls
     * @returns {Promise<Array>} Missed calls
     */
    async getMissedCalls() {
        return this.db.getMissedCalls();
    }

    /**
     * Get all labels
     * @returns {Promise<Array>} Labels
     */
    async getLabels() {
        return this.db.getLabels();
    }

    /**
     * Get chat labels
     * @param {string} jid - Chat JID
     * @returns {Promise<Array>} Labels
     */
    async getChatLabels(jid) {
        return this.db.getChatLabels(jid);
    }

    /**
     * Get all newsletters
     * @returns {Promise<Array>} Newsletters
     */
    async getNewsletters() {
        return this.db.getNewsletters();
    }

    /**
     * Get newsletter posts
     * @param {string} nid - Newsletter ID
     * @param {number} limit - Limit
     * @returns {Promise<Array>} Posts
     */
    async getNewsletterPosts(nid, limit = 50) {
        return this.db.getNewsletterPosts(nid, limit);
    }

    /**
     * Get session settings
     * @returns {Promise<Object>} Settings
     */
    async getSettings() {
        return this.db.getAllSessionSettings();
    }

    /**
     * Get specific setting
     * @param {string} name - Setting name
     * @returns {Promise<*>} Setting value
     */
    async getSetting(name) {
        return this.db.getSessionSetting(name);
    }

    /**
     * Get session info
     * @returns {Promise<Object>} Session info
     */
    async getInfo() {
        const dbSession = await this.db.getSession(this.sid).catch(() => null);
        const dbSize = await this.db.getDbSize().catch(() => 0);

        return {
            sid: this.sid,
            uid: this.uid,
            state: this.state,
            connected: this.state === 'open',
            phone: dbSession?.phone,
            platform: dbSession?.platform,
            device: dbSession?.device_id,
            created: dbSession?.created_at,
            lastSeen: dbSession?.last_seen,
            stats: {
                ...this.stats,
                uptime: Date.now() - this.startTime,
                lastActivity: Date.now() - this.lastActivity
            },
            dbSize
        };
    }

    // ==================== UTILITY ====================

    /**
     * Get status from status code
     * @private
     * @param {number} code - Status code
     * @returns {string|null} Status string
     */
    _getStatusFromCode(code) {
        switch (code) {
            case 1: return MESSAGE_STATUS.PENDING;
            case 2: return MESSAGE_STATUS.SENT;
            case 3: return MESSAGE_STATUS.DELIVERED;
            case 4: return MESSAGE_STATUS.READ;
            default: return null;
        }
    }

    /**
     * Emit event to WebSocket clients
     * @private
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    _emit(event, data) {
        if (!this.wss) return;

        const msg = JSON.stringify({ event, data });
        let sent = 0;

        this.wss.clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN && c.sessionId === this.sid) {
                // Check if client is subscribed to this event
                if (!c.subscriptions || c.subscriptions.has(event) || c.subscriptions.has('all')) {
                    c.send(msg);
                    sent++;
                }
            }
        });

        if (sent === 0 && event !== 'presence' && event !== 'typing') {
            logger.debug(`No subscribers for event: ${event}`, { sid: this.sid });
        }
    }

    /**
     * Log message
     * @private
     * @param {string} level - Log level
     * @param {string} msg - Message
     * @param {*} data - Additional data
     */
    _log(level, msg, data = null) {
        const entry = {
            ts: new Date().toISOString(),
            sid: this.sid,
            level,
            msg
        };
        if (data) entry.data = data;

        const logMsg = `[${entry.ts}] [${entry.sid}] ${level.toUpperCase()}: ${msg}`;
        switch (level) {
            case 'error':
                console.error('\x1b[31m%s\x1b[0m', logMsg, data || '');
                break;
            case 'warn':
                console.warn('\x1b[33m%s\x1b[0m', logMsg, data || '');
                break;
            case 'info':
                console.log('\x1b[32m%s\x1b[0m', logMsg, data || '');
                break;
            default:
                console.log(logMsg, data || '');
        }
    }

    // ==================== CLEANUP ====================

    /**
     * Logout from WhatsApp
     */
    async logout() {
        this.loggingOut = true;

        try {
            logger.info('Logging out', { sid: this.sid });

            if (this.sock) {
                await this.sock.logout();
                this.sock = null;
            }

            await this.db.updateSession(this.sid, {
                status: 'logged_out',
                logged_in: 0
            }).catch(() => { });

            this._emit('logged_out', {});
            logger.info('Logged out', { sid: this.sid });

        } catch (error) {
            logger.error('Logout failed', { sid: this.sid, error: error.message });
            throw error;
        } finally {
            this.loggingOut = false;
        }
    }

    /**
     * Close session
     */
    async close() {
        logger.info('Closing session', { sid: this.sid });

        // Clear message queue
        this.messageQueue.forEach(item => {
            item.reject(new Error('Session closed'));
        });
        this.messageQueue = [];

        // Clear pending promises
        for (const [id, { reject }] of this.pendingPromises) {
            reject(new Error('Session closed'));
        }
        this.pendingPromises.clear();

        // Close socket
        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end();
                this.sock = null;
            } catch (err) {
                logger.error('Error closing socket', { sid: this.sid, error: err.message });
            }
        }

        // Unsubscribe callbacks
        this.unsub.forEach(fn => {
            try { fn(); } catch (err) { }
        });
        this.unsub = [];

        // Clear cache
        this.webhookCache.clear();

        // Close database
        if (this.db) {
            await this.db.close().catch(() => { });
            this.db = null;
        }

        logger.info('Session closed', { sid: this.sid });
    }

    /**
     * Health check
     * @returns {Promise<Object>} Health status
     */
    async healthCheck() {
        try {
            const dbOk = this.db ? await this.db.healthCheck().catch(() => false) : false;
            const sockOk = this.sock && this.state === 'open';

            return {
                status: dbOk && sockOk ? 'healthy' : 'unhealthy',
                state: this.state,
                db: dbOk ? 'ok' : 'error',
                socket: sockOk ? 'ok' : 'error',
                stats: this.stats,
                queueSize: this.messageQueue.length,
                uptime: Date.now() - this.startTime,
                lastActivity: Date.now() - this.lastActivity
            };
        } catch (error) {
            return { status: 'unhealthy', error: error.message };
        }
    }
}

module.exports = SessionHandler;