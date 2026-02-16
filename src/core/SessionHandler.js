// src/core/SessionHandler.js
const SQLiteStores = require('./SQLiteStores');
const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

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
        this.stats = {
            msgsRx: 0,
            msgsTx: 0,
            events: 0,
            errors: 0,
            reconnects: 0
        };
    }

    // ==================== INIT ====================

    /**
     * Initialize session handler
     * @param {string} dbPath - Database path
     * @returns {Promise<this>}
     */
    async init(dbPath = './data/db.db') {
        try {
            this._log('info', 'Initializing session');

            // Initialize database
            this.db = new SQLiteStores(this.sid, dbPath);
            await this.db.init();
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

            // Connect WhatsApp socket
            await this._connect(session?.creds);

            this._log('info', 'Session initialized', { state: this.state });
            return this;
        } catch (error) {
            this._log('error', 'Init failed', error);
            this._emit('error', { type: 'init_failed', error: error.message });
            throw error;
        }
    }

    /**
     * Setup database callbacks
     * @private
     */
    _setupCallbacks() {
        const events = ['message', 'presence', 'chat', 'reaction', 'group', 'error'];
        events.forEach(e => {
            const fn = this.db.on(e, (data) => {
                this.stats.events++;
                this._emit(e, data);
                this._sendToWebhook(e, data).catch(() => {});
            });
            if (fn) this.unsub.push(fn);
        });

        this.unsub.push(
            this.db.on('init', () => this._log('debug', 'DB ready')),
            this.db.on('close', () => this._log('debug', 'DB closed'))
        );
    }

    // ==================== CONNECTION ====================

    /**
     * Connect to WhatsApp
     * @private
     * @param {string} creds - Serialized credentials
     */
    async _connect(creds = null) {
        if (this.connecting || this.loggingOut) return;

        this.connecting = true;

        try {
            const { version } = await fetchLatestBaileysVersion();
            
            let auth = null;
            if (creds) {
                try { auth = JSON.parse(creds); } catch (e) {}
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
                defaultQueryTimeoutMs: 10000
            });

            this._bindEvents();
            this.connecting = false;

        } catch (error) {
            this.connecting = false;
            this._log('error', 'Connection failed', error);
            this._scheduleReconnect();
        }
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

        if (qr) {
            this.qr = qr;
            this._emit('qr', { qr });
        }

        if (connection) {
            const oldState = this.state;
            this.state = connection;
            this._emit('connection', { connection, qr });

            await this.db.updateSession(this.sid, {
                status: connection,
                qr,
                last_seen: lastDisconnect ? new Date().toISOString() : null
            }).catch(() => {});

            if (connection === 'open') {
                this.reconn = 0;
                await this.db.updateSession(this.sid, { logged_in: 1 }).catch(() => {});
                this._emit('connected', {});
                this._log('info', 'WhatsApp connected');
            }

            if (connection === 'close') {
                await this.db.updateSession(this.sid, { logged_in: 0 }).catch(() => {});
                
                const code = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = !this.loggingOut && 
                    code !== DisconnectReason.loggedOut &&
                    code !== DisconnectReason.badSession;

                if (shouldReconnect) {
                    this._scheduleReconnect();
                } else {
                    this._emit('disconnected', { 
                        reason: code === DisconnectReason.loggedOut ? 'logged_out' : 'closed'
                    });
                }
            }
        }
    }

    /**
     * Schedule reconnection with exponential backoff
     * @private
     */
    _scheduleReconnect() {
        if (this.reconn >= this.maxReconn) {
            this._log('error', 'Max reconnection attempts reached');
            return;
        }

        this.reconn++;
        const delay = this.reconnDelay * Math.pow(2, this.reconn - 1);

        this._log('info', `Reconnecting in ${delay}ms (${this.reconn}/${this.maxReconn})`);
        this._emit('reconnecting', { attempt: this.reconn, delay });

        setTimeout(() => {
            this._connect().catch(err => {
                this._log('error', 'Reconnect failed', err);
            });
        }, delay);
    }

    /**
     * Handle credentials update
     * @private
     * @param {Object} up - Credentials update
     */
    async _handleCreds(up) {
        await this.db.updateSession(this.sid, { 
            creds: JSON.stringify(up) 
        }).catch(() => {});
    }

    // ==================== MESSAGE HANDLERS ====================

    /**
     * Handle new messages
     * @private
     * @param {Object} data - Messages data
     */
    async _handleMessagesUpsert(data) {
        this.stats.msgsRx += data.messages?.length || 0;
        await this.db.handleMsg(data).catch(err => {
            this.stats.errors++;
            this._log('error', 'Failed to save messages', err);
        });
    }

    /**
     * Handle message updates
     * @private
     * @param {Array} ups - Message updates
     */
    async _handleMessagesUpdate(ups) {
        for (const up of ups) {
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
        }
    }

    /**
     * Handle message deletion
     * @private
     * @param {Object} data - Delete data
     */
    async _handleMessagesDelete(data) {
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
    }

    /**
     * Handle media update
     * @private
     * @param {Array} ups - Media updates
     */
    async _handleMediaUpdate(ups) {
        for (const up of ups) {
            if (!up.key?.id) continue;

            if (up.media) {
                await this.db.markMediaDownloaded(up.key.id, up.media.url || 'downloaded');
                this._emit('media_downloaded', { id: up.key.id });
            } else if (up.error) {
                await this.db.markMediaFailed(up.key.id, up.error.message);
                this._emit('media_failed', { id: up.key.id, error: up.error.message });
            }
        }
    }

    /**
     * Handle reactions
     * @private
     * @param {Array} data - Reaction data
     */
    async _handleReaction(data) {
        await this.db.handleReaction(data).catch(err => {
            this._log('error', 'Failed to save reaction', err);
        });
    }

    /**
     * Handle message receipts
     * @private
     * @param {Array} ups - Receipt updates
     */
    async _handleReceipt(ups) {
        for (const up of ups) {
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
        }
    }

    // ==================== PRESENCE HANDLER ====================

    /**
     * Handle presence updates
     * @private
     * @param {Object} data - Presence data
     */
    async _handlePresence(data) {
        await this.db.handlePresence(data).catch(err => {
            this._log('error', 'Failed to save presence', err);
        });
    }

    // ==================== CHAT HANDLERS ====================

    /**
     * Handle new chats
     * @private
     * @param {Array} chats - New chats
     */
    async _handleChatsUpsert(chats) {
        for (const c of chats) {
            if (!c.id) continue;

            await this.db.upsertChat({
                jid: c.id,
                name: c.name || c.subject,
                is_group: c.id.endsWith('@g.us'),
                is_broadcast: c.isBroadcast || false,
                unread: c.unreadCount || 0,
                last_msg_time: c.lastMessage?.messageTimestamp
            }).catch(err => this._log('error', 'Failed to save chat', err));
        }
    }

    /**
     * Handle chat updates
     * @private
     * @param {Array} ups - Chat updates
     */
    async _handleChatsUpdate(ups) {
        for (const up of ups) {
            if (!up.id) continue;

            const chat = await this.db.getChat(up.id).catch(() => null);
            if (chat) {
                await this.db.upsertChat({
                    jid: up.id,
                    name: up.name,
                    archived: up.archive,
                    pinned: up.pin ? 1 : 0,
                    pin_time: up.pin,
                    mute_until: up.mute,
                    unread: up.unreadCount
                }).catch(() => {});
            }
            this._emit('chat_update', up);
        }
    }

    /**
     * Handle chat deletion
     * @private
     * @param {Array} ids - Chat IDs
     */
    async _handleChatsDelete(ids) {
        for (const id of ids) {
            await this.db.deleteChat(id).catch(() => {});
            this._emit('chat_delete', { jid: id });
        }
    }

    /**
     * Handle chat lock
     * @private
     * @param {string} id - Chat ID
     * @param {boolean} locked - Lock status
     */
    async _handleChatsLock(id, locked) {
        const chat = await this.db.getChat(id).catch(() => null);
        if (chat) {
            await this.db.upsertChat({ jid: id, locked: locked ? 1 : 0 }).catch(() => {});
        }
    }

    // ==================== CONTACT HANDLERS ====================

    /**
     * Handle new contacts
     * @private
     * @param {Array} contacts - New contacts
     */
    async _handleContactsUpsert(contacts) {
        for (const c of contacts) {
            if (!c.id) continue;

            await this.db.upsertContact({
                jid: c.id,
                name: c.name || c.notify,
                short: c.short,
                verified: c.verifiedName,
                phone: c.id.split('@')[0],
                push: c.notify
            }).catch(err => this._log('error', 'Failed to save contact', err));
        }
    }

    /**
     * Handle contact updates
     * @private
     * @param {Array} ups - Contact updates
     */
    async _handleContactsUpdate(ups) {
        for (const up of ups) {
            if (!up.id) continue;

            const contact = await this.db.getContact(up.id).catch(() => null);
            if (contact) {
                await this.db.upsertContact({
                    jid: up.id,
                    name: up.name || up.verifiedName,
                    short: up.short,
                    verified: up.verifiedName,
                    push: up.notify
                }).catch(() => {});
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
        for (const g of groups) {
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
            }).catch(err => this._log('error', 'Failed to save group', err));

            if (g.participants) {
                for (const p of g.participants) {
                    await this.db.upsertGroupMember({
                        group_jid: g.id,
                        member: p.id,
                        lid: p.lid,
                        role: p.role || 'member',
                        active: true
                    }).catch(() => {});
                }
            }
        }
    }

    /**
     * Handle group updates
     * @private
     * @param {Array} ups - Group updates
     */
    async _handleGroupsUpdate(ups) {
        for (const up of ups) {
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
                    announce: up.announce,
                    restrict: up.restrict,
                    locked: up.locked,
                    approval: up.joinApprovalMode
                }).catch(() => {});
            }
        }
    }

    /**
     * Handle group participant updates
     * @private
     * @param {Object} data - Participant update data
     */
    async _handleGroupParticipants(data) {
        await this.db.handleGroupUpdate(data).catch(err => {
            this._log('error', 'Failed to update group members', err);
        });
    }

    /**
     * Handle group join requests
     * @private
     * @param {Object} data - Join request data
     */
    async _handleGroupJoinRequest(data) {
        await this.db.upsertGroupMember({
            group_jid: data.id,
            member: data.participant,
            req_status: data.action,
            req_method: data.method,
            req_ts: Date.now()
        }).catch(() => {});

        this._emit('group_join_request', data);
    }

    /**
     * Handle group member tags
     * @private
     * @param {Object} data - Member tag data
     */
    async _handleGroupMemberTag(data) {
        const member = await this.db.getGroupMember(data.groupId, data.participant).catch(() => null);
        if (member) {
            await this.db.upsertGroupMember({
                group_jid: data.groupId,
                member: data.participant,
                label: data.label
            }).catch(() => {});
        }
    }

    // ==================== BLOCKLIST HANDLERS ====================

    /**
     * Handle blocklist set
     * @private
     * @param {Array} blocklist - Blocked JIDs
     */
    async _handleBlocklistSet(blocklist) {
        for (const jid of blocklist) {
            await this.db.blockContact(jid, true).catch(() => {});
        }
    }

    /**
     * Handle blocklist update
     * @private
     * @param {Array} blocklist - Blocked JIDs
     * @param {string} type - Add or remove
     */
    async _handleBlocklistUpdate(blocklist, type) {
        for (const jid of blocklist) {
            await this.db.blockContact(jid, type === 'add').catch(() => {});
            this._emit('blocklist_update', { jid, type });
        }
    }

    // ==================== CALL HANDLERS ====================

    /**
     * Handle calls
     * @private
     * @param {Array} calls - Call data
     */
    async _handleCalls(calls) {
        for (const c of calls) {
            await this.db.upsertCall({
                id: c.id,
                from_jid: c.from,
                to_jid: c.to,
                type: c.isVideo ? 'video' : 'audio',
                status: c.status,
                ts: c.timestamp,
                video: c.isVideo ? 1 : 0,
                group_jid: c.groupJid,
                meta: JSON.stringify(c)
            }).catch(err => this._log('error', 'Failed to save call', err));

            this._emit('call', c);
        }
    }

    // ==================== LABEL HANDLERS ====================

    /**
     * Handle label edit
     * @private
     * @param {Object} label - Label data
     */
    async _handleLabelsEdit(label) {
        await this.db.upsertLabel({
            id: label.id,
            name: label.name,
            color: label.color,
            predefined_id: label.predefinedId,
            count: label.count || 0,
            meta: JSON.stringify(label)
        }).catch(err => this._log('error', 'Failed to save label', err));

        this._emit('label_edit', label);
    }

    /**
     * Handle label association
     * @private
     * @param {Object} association - Association data
     * @param {string} type - Add or remove
     */
    async _handleLabelsAssociation(association, type) {
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
    }

    // ==================== LID MAPPING HANDLER ====================

    /**
     * Handle LID mapping update
     * @private
     * @param {Object} data - LID mapping data
     */
    async _handleLidMapping(data) {
        await this.db.handleLID(data).catch(err => {
            this._log('error', 'Failed to save LID mapping', err);
        });
    }

    // ==================== SETTINGS HANDLER ====================

    /**
     * Handle settings update
     * @private
     * @param {Object} up - Settings update
     */
    async _handleSettingsUpdate(up) {
        await this.db.setSessionSetting(up.setting, up.value).catch(() => {});
        this._emit('settings_update', up);
    }

    // ==================== MESSAGING HISTORY HANDLER ====================

    /**
     * Handle messaging history
     * @private
     * @param {Object} hist - History data
     */
    async _handleMessagingHistory(hist) {
        const { chats, contacts, messages, lidPnMappings, progress, syncType } = hist;

        await this.db.setSync('history', {
            status: progress === 100 ? 'completed' : 'in_progress',
            progress,
            type: syncType
        }).catch(() => {});

        this._emit('history_progress', { progress, type: syncType });

        // Process in batches
        const batchSize = 100;

        if (chats) {
            for (let i = 0; i < chats.length; i += batchSize) {
                const batch = chats.slice(i, i + batchSize);
                await Promise.all(batch.map(c => 
                    this.db.upsertChat({
                        jid: c.id,
                        name: c.name,
                        is_group: c.id.endsWith('@g.us'),
                        unread: c.unreadCount || 0
                    }).catch(() => {})
                ));
            }
        }

        if (contacts) {
            for (let i = 0; i < contacts.length; i += batchSize) {
                const batch = contacts.slice(i, i + batchSize);
                await Promise.all(batch.map(c => 
                    this.db.upsertContact({
                        jid: c.id,
                        name: c.name,
                        phone: c.id.split('@')[0]
                    }).catch(() => {})
                ));
            }
        }

        if (lidPnMappings) {
            for (const m of lidPnMappings) {
                await this.db.handleLID(m).catch(() => {});
            }
        }

        if (progress === 100) {
            this._emit('history_complete', {
                chats: chats?.length || 0,
                contacts: contacts?.length || 0
            });
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
        try {
            const webhook = await this.db.getWebhookByEvent(event);
            if (!webhook || !webhook.enabled) return;

            const payload = {
                event,
                sessionId: this.sid,
                timestamp: new Date().toISOString(),
                data
            };

            const start = Date.now();
            let response;

            try {
                response = await axios({
                    method: 'POST',
                    url: webhook.url,
                    headers: {
                        'Content-Type': 'application/json',
                        ...(webhook.headers ? JSON.parse(webhook.headers) : {})
                    },
                    data: payload,
                    timeout: webhook.timeout || 10000
                });

                await this.db.logWebhookDelivery(webhook.id, event, {
                    payload,
                    response_status: response.status,
                    response_body: response.data,
                    success: true,
                    duration: Date.now() - start
                });

                await this.db.updateWebhookStats(webhook.id, true, response.status);

            } catch (err) {
                await this.db.logWebhookDelivery(webhook.id, event, {
                    payload,
                    response_status: err.response?.status,
                    success: false,
                    duration: Date.now() - start,
                    error: err.message
                });

                await this.db.updateWebhookStats(webhook.id, false);
            }
        } catch (err) {
            this._log('error', 'Webhook delivery failed', err);
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
    async sendMessage(jid, content, type = 'text') {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid || !content) throw new Error('JID and content required');

        let message;
        switch (type) {
            case 'text':
                message = { text: content };
                break;
            case 'image':
                message = { image: content.buffer, caption: content.caption || '' };
                break;
            case 'video':
                message = { video: content.buffer, caption: content.caption || '' };
                break;
            case 'audio':
                message = { audio: content.buffer };
                break;
            case 'document':
                message = { document: content.buffer, fileName: content.name || 'document' };
                break;
            case 'sticker':
                message = { sticker: content.buffer };
                break;
            case 'location':
                message = {
                    location: {
                        degreesLatitude: content.latitude,
                        degreesLongitude: content.longitude,
                        name: content.name,
                        address: content.address
                    }
                };
                break;
            case 'contact':
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
                throw new Error(`Unsupported type: ${type}`);
        }

        try {
            const sent = await this.sock.sendMessage(jid, message);
            this.stats.msgsTx++;

            await this.db.logActivity({
                user_id: this.uid,
                session_id: this.sid,
                action: 'send_message',
                resource: jid,
                details: { type, id: sent?.key?.id }
            }).catch(() => {});

            return sent;
        } catch (error) {
            this.stats.errors++;
            this._log('error', 'Send failed', error);
            throw error;
        }
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

        try {
            const result = await this.sock.sendMessage(jid, {
                react: { text: emoji, key: { id: msgId, remoteJid: jid } }
            });

            await this.db.logActivity({
                user_id: this.uid,
                session_id: this.sid,
                action: 'send_reaction',
                resource: msgId,
                details: { jid, emoji }
            }).catch(() => {});

            return result;
        } catch (error) {
            this.stats.errors++;
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

        await this.sock.readMessages([{ remoteJid: jid, id: msgId }]);
    }

    /**
     * Update presence
     * @param {string} jid - Chat JID
     * @param {string} state - Presence state
     */
    async setPresence(jid, state) {
        if (!this.sock) throw new Error('Socket not connected');
        if (!jid || !state) throw new Error('JID and state required');

        const valid = ['available', 'unavailable', 'composing', 'recording', 'paused'];
        if (!valid.includes(state)) {
            throw new Error(`Invalid state. Must be: ${valid.join(', ')}`);
        }

        await this.sock.sendPresenceUpdate(state, jid);
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

        const valid = [
            'create', 'subject', 'desc', 'add', 'remove', 'promote', 'demote',
            'announce', 'not_announce', 'lock', 'unlock', 'invite', 'revoke', 'join', 'leave'
        ];
        if (!valid.includes(cmd)) throw new Error(`Invalid command: ${cmd}`);

        try {
            let result;

            switch (cmd) {
                case 'create':
                    result = await this.sock.groupCreate(jid, data);
                    break;
                case 'subject':
                    result = await this.sock.groupUpdateSubject(jid, data[0]);
                    break;
                case 'desc':
                    result = await this.sock.groupUpdateDescription(jid, data[0]);
                    break;
                case 'add':
                case 'remove':
                case 'promote':
                case 'demote':
                    result = await this.sock.groupParticipantsUpdate(jid, data, cmd);
                    break;
                case 'announce':
                case 'not_announce':
                case 'lock':
                case 'unlock':
                    const setting = cmd === 'lock' ? 'locked' : cmd === 'unlock' ? 'unlocked' : cmd;
                    result = await this.sock.groupSettingUpdate(jid, setting);
                    break;
                case 'invite':
                    result = { code: await this.sock.groupInviteCode(jid) };
                    break;
                case 'revoke':
                    result = { code: await this.sock.groupRevokeInvite(jid) };
                    break;
                case 'join':
                    result = await this.sock.groupAcceptInvite(data[0]);
                    break;
                case 'leave':
                    result = await this.sock.groupLeave(jid);
                    break;
            }

            await this.db.logActivity({
                user_id: this.uid,
                session_id: this.sid,
                action: `group_${cmd}`,
                resource: jid || 'group',
                details: { cmd, data }
            }).catch(() => {});

            return result;
        } catch (error) {
            this.stats.errors++;
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

        await this.sock.updateBlockStatus(jid, block ? 'block' : 'unblock');
        await this.db.blockContact(jid, block);

        await this.db.logActivity({
            user_id: this.uid,
            session_id: this.sid,
            action: block ? 'block' : 'unblock',
            resource: jid
        }).catch(() => {});
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

        const valid = ['name', 'status', 'pic', 'pic_rm', 'get_status'];
        if (!valid.includes(cmd)) throw new Error(`Invalid command: ${cmd}`);

        try {
            let result;

            switch (cmd) {
                case 'name':
                    result = await this.sock.updateProfileName(data);
                    break;
                case 'status':
                    result = await this.sock.updateProfileStatus(data);
                    break;
                case 'pic':
                    result = await this.sock.updateProfilePicture(jid || this.sid, data);
                    break;
                case 'pic_rm':
                    result = await this.sock.removeProfilePicture(jid || this.sid);
                    break;
                case 'get_status':
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
            }).catch(() => {});

            return result;
        } catch (error) {
            this.stats.errors++;
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

        const valid = ['create', 'follow', 'unfollow', 'send'];
        if (!valid.includes(cmd)) throw new Error(`Invalid command: ${cmd}`);

        try {
            let result;

            switch (cmd) {
                case 'create':
                    result = await this.sock.newsletterCreate(data.name, data.desc || '');
                    break;
                case 'follow':
                    result = await this.sock.newsletterFollow(id);
                    break;
                case 'unfollow':
                    result = await this.sock.newsletterUnfollow(id);
                    break;
                case 'send':
                    result = await this.sock.sendMessage(id, { text: data });
                    break;
            }

            await this.db.logActivity({
                user_id: this.uid,
                session_id: this.sid,
                action: `newsletter_${cmd}`,
                resource: id,
                details: { cmd, data }
            }).catch(() => {});

            return result;
        } catch (error) {
            this.stats.errors++;
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
        return this.db.createWebhook(data);
    }

    /**
     * Get all webhooks
     * @returns {Promise<Array>} Webhooks
     */
    async getWebhooks() {
        return this.db.getAllWebhooks();
    }

    /**
     * Delete webhook
     * @param {string} id - Webhook ID
     * @returns {Promise<Object>} Result
     */
    async deleteWebhook(id) {
        return this.db.deleteWebhook(id);
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
                timeout: webhook.timeout || 10000
            });

            return {
                success: true,
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
                uptime: Date.now() - this.startTime
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
        if (code === 2) return 'sent';
        if (code === 3) return 'delivered';
        if (code === 4) return 'read';
        return null;
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
        this.wss.clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN && c.sessionId === this.sid) {
                c.send(msg);
            }
        });
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
            if (this.sock) {
                await this.sock.logout();
                this.sock = null;
            }

            await this.db.updateSession(this.sid, {
                status: 'logged_out',
                logged_in: 0
            }).catch(() => {});

            this._emit('logged_out', {});
            this._log('info', 'Logged out');

        } catch (error) {
            this._log('error', 'Logout failed', error);
            throw error;
        } finally {
            this.loggingOut = false;
        }
    }

    /**
     * Close session
     */
    async close() {
        this._log('info', 'Closing session');

        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end();
                this.sock = null;
            } catch (err) {
                this._log('error', 'Error closing socket', err);
            }
        }

        this.unsub.forEach(fn => { try { fn(); } catch {} });
        this.unsub = [];

        if (this.db) {
            await this.db.close().catch(() => {});
            this.db = null;
        }

        this._log('info', 'Session closed');
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
                uptime: Date.now() - this.startTime
            };
        } catch (error) {
            return { status: 'unhealthy', error: error.message };
        }
    }
}

module.exports = SessionHandler;