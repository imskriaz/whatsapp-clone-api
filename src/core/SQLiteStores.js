// src/core/SQLiteStores.js
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class LRUCache {
    constructor(maxSize = 1000) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    /**
     * Get value from cache
     * @param {string} key - Cache key
     * @returns {any} Cached value or null
     */
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        // Refresh item (move to end)
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.value;
    }

    /**
     * Set value in cache
     * @param {string} key - Cache key
     * @param {any} value - Value to cache
     */
    set(key, value) {
        // Enforce size limit
        if (this.cache.size >= this.maxSize) {
            // Remove oldest (first item)
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, { value });
    }

    /**
     * Delete key from cache
     * @param {string} key - Cache key
     */
    delete(key) {
        this.cache.delete(key);
    }

    /**
     * Delete keys matching pattern
     * @param {string} pattern - Pattern with * wildcard
     */
    deletePattern(pattern) {
        const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
        for (const key of this.cache.keys()) {
            if (regex.test(key)) {
                this.cache.delete(key);
            }
        }
    }

    /**
     * Clear entire cache
     */
    clear() {
        this.cache.clear();
    }
}

class SQLiteStores {
    constructor(sessionId = null, dbPath = './data/db.db') {
        this.sessionId = sessionId;
        this.dbPath = dbPath;
        this.db = null;
        this.cache = new LRUCache(1000);
        this.pragmaSet = false;
        this.isClosed = false;
        this.cbs = {
            message: [], presence: [], chat: [], reaction: [],
            group: [], error: [], init: [], close: []
        };
    }

    // ==================== INIT ====================

    /**
     * Initialize database connection and create tables
     * @returns {Promise<this>}
     */
    async init() {
        try {
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            this.db = await open({
                filename: this.dbPath,
                driver: sqlite3.Database
            });

            if (!this.pragmaSet) {
                await this.db.exec('PRAGMA foreign_keys = ON');
                await this.db.exec('PRAGMA journal_mode = WAL');
                await this.db.exec('PRAGMA synchronous = NORMAL');
                await this.db.exec('PRAGMA cache_size = -2000');
                await this.db.exec('PRAGMA temp_store = MEMORY');
                await this.db.exec('PRAGMA mmap_size = 30000000000');
                await this.db.exec('PRAGMA busy_timeout = 5000');
                this.pragmaSet = true;
            }

            await this.createTables();
            this._emit('init', { sessionId: this.sessionId });
            return this;
        } catch (error) {
            this._emit('error', error);
            throw error;
        }
    }

    /**
     * Create all database tables
     * @private
     */
    async createTables() {
        // ==================== CORE TABLES ====================
        
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password TEXT NOT NULL,
                api_key TEXT UNIQUE NOT NULL,
                role TEXT DEFAULT 'user',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS user_meta (
                username TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE,
                PRIMARY KEY (username, key)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                device_id TEXT,
                phone TEXT,
                platform TEXT,
                status TEXT,
                qr TEXT,
                logged_in BOOLEAN DEFAULT 0,
                creds TEXT,
                last_seen DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_meta (
                session_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, key)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS global_settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                description TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS user_sessions (
                username TEXT NOT NULL,
                session_id TEXT NOT NULL,
                active BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                PRIMARY KEY (username, session_id)
            )
        `);

        // ==================== WHATSAPP DATA TABLES ====================

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS chats (
                session_id TEXT NOT NULL,
                jid TEXT NOT NULL,
                name TEXT,
                pic TEXT,
                is_group BOOLEAN DEFAULT 0,
                is_broadcast BOOLEAN DEFAULT 0,
                locked BOOLEAN DEFAULT 0,
                archived BOOLEAN DEFAULT 0,
                pinned BOOLEAN DEFAULT 0,
                pin_time INTEGER,
                mute_until INTEGER,
                last_msg_time INTEGER,
                last_msg_id TEXT,
                unread INTEGER DEFAULT 0,
                mod_tag INTEGER,
                meta TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted BOOLEAN DEFAULT 0,
                deleted_at DATETIME,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, jid)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS contacts (
                session_id TEXT NOT NULL,
                jid TEXT NOT NULL,
                lid TEXT,
                phone TEXT,
                name TEXT,
                short TEXT,
                verified TEXT,
                push TEXT,
                pic TEXT,
                status TEXT,
                status_time INTEGER,
                presence TEXT,
                presence_last DATETIME,
                presence_dev TEXT,
                blocked BOOLEAN DEFAULT 0,
                meta TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted BOOLEAN DEFAULT 0,
                deleted_at DATETIME,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, jid)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS msgs (
                session_id TEXT NOT NULL,
                id TEXT NOT NULL,
                chat TEXT NOT NULL,
                from_jid TEXT,
                to_jid TEXT,
                type TEXT,
                text TEXT,
                caption TEXT,
                status TEXT,
                from_me BOOLEAN DEFAULT 0,
                fwd BOOLEAN DEFAULT 0,
                starred BOOLEAN DEFAULT 0,
                ts INTEGER,
                server_ts INTEGER,
                reacts_to TEXT,
                reaction TEXT,
                quoted TEXT,
                meta TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted BOOLEAN DEFAULT 0,
                deleted_at DATETIME,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id, chat) REFERENCES chats(session_id, jid) ON DELETE CASCADE,
                PRIMARY KEY (session_id, id)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS receipts (
                session_id TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                participant TEXT NOT NULL,
                type TEXT NOT NULL,
                ts INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id, msg_id) REFERENCES msgs(session_id, id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, msg_id, participant, type)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS media (
                session_id TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                type TEXT,
                url TEXT,
                key TEXT,
                sha256 TEXT,
                enc_sha256 TEXT,
                len INTEGER,
                h INTEGER,
                w INTEGER,
                dur INTEGER,
                mime TEXT,
                fname TEXT,
                downloaded BOOLEAN DEFAULT 0,
                dl_error TEXT,
                meta TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id, msg_id) REFERENCES msgs(session_id, id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, msg_id)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS reactions (
                session_id TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                reaction_msg_id TEXT,
                reactor TEXT NOT NULL,
                reaction TEXT,
                ts INTEGER,
                removed BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id, msg_id) REFERENCES msgs(session_id, id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, msg_id, reactor)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS groups (
                session_id TEXT NOT NULL,
                jid TEXT NOT NULL,
                subject TEXT,
                subject_owner TEXT,
                subject_ts INTEGER,
                desc TEXT,
                desc_owner TEXT,
                desc_id TEXT,
                desc_ts INTEGER,
                pic TEXT,
                pic_id TEXT,
                announce BOOLEAN DEFAULT 0,
                restrict BOOLEAN DEFAULT 0,
                locked BOOLEAN DEFAULT 0,
                approval BOOLEAN DEFAULT 0,
                created_ts INTEGER,
                part_ver TEXT,
                meta TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted BOOLEAN DEFAULT 0,
                deleted_at DATETIME,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id, jid) REFERENCES chats(session_id, jid) ON DELETE CASCADE,
                PRIMARY KEY (session_id, jid)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_members (
                session_id TEXT NOT NULL,
                group_jid TEXT NOT NULL,
                member TEXT NOT NULL,
                lid TEXT,
                role TEXT,
                req_status TEXT,
                req_method TEXT,
                req_ts INTEGER,
                label TEXT,
                active BOOLEAN DEFAULT 1,
                added_by TEXT,
                added_ts INTEGER,
                removed_by TEXT,
                removed_ts INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id, group_jid) REFERENCES groups(session_id, jid) ON DELETE CASCADE,
                PRIMARY KEY (session_id, group_jid, member)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS blocklist (
                session_id TEXT NOT NULL,
                jid TEXT NOT NULL,
                blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, jid)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS calls (
                session_id TEXT NOT NULL,
                id TEXT NOT NULL,
                from_jid TEXT,
                to_jid TEXT,
                type TEXT,
                status TEXT,
                ts INTEGER,
                dur INTEGER,
                video BOOLEAN DEFAULT 0,
                group_jid TEXT,
                meta TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, id)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS labels (
                session_id TEXT NOT NULL,
                id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT,
                predefined_id TEXT,
                count INTEGER DEFAULT 0,
                meta TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted BOOLEAN DEFAULT 0,
                deleted_at DATETIME,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, id)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS label_assoc (
                session_id TEXT NOT NULL,
                label_id TEXT NOT NULL,
                target TEXT NOT NULL,
                type TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id, label_id) REFERENCES labels(session_id, id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, label_id, target)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS newsletters (
                session_id TEXT NOT NULL,
                id TEXT NOT NULL,
                server_id TEXT,
                name TEXT,
                description TEXT,
                picture TEXT,
                subscribers INTEGER DEFAULT 0,
                created_ts INTEGER,
                verified BOOLEAN DEFAULT 0,
                following BOOLEAN DEFAULT 0,
                meta TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, id)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS newsletter_posts (
                session_id TEXT NOT NULL,
                nid TEXT NOT NULL,
                pid TEXT NOT NULL,
                server_id TEXT,
                msg_id TEXT,
                title TEXT,
                content TEXT,
                media_type TEXT,
                media_url TEXT,
                views INTEGER DEFAULT 0,
                reactions INTEGER DEFAULT 0,
                posted_ts INTEGER,
                meta TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id, nid) REFERENCES newsletters(session_id, id) ON DELETE CASCADE,
                PRIMARY KEY (session_id, nid, pid)
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS newsletter_reacts (
                session_id TEXT NOT NULL,
                nid TEXT NOT NULL,
                pid TEXT NOT NULL,
                reactor TEXT,
                code TEXT,
                count INTEGER DEFAULT 1,
                removed BOOLEAN DEFAULT 0,
                meta TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id, nid, pid) REFERENCES newsletter_posts(session_id, nid, pid) ON DELETE CASCADE,
                PRIMARY KEY (session_id, nid, pid, reactor)
            )
        `);

        // ==================== META TABLES (Only essential for n8n) ====================

        // Webhooks - For n8n integration
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS webhooks (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                event TEXT NOT NULL,
                url TEXT NOT NULL,
                headers TEXT,
                enabled BOOLEAN DEFAULT 1,
                retry_count INTEGER DEFAULT 3,
                timeout INTEGER DEFAULT 10000,
                secret TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_triggered DATETIME,
                last_response INTEGER,
                failure_count INTEGER DEFAULT 0,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
                UNIQUE(session_id, event)
            )
        `);

        // Webhook delivery logs - For monitoring
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS webhook_deliveries (
                id TEXT PRIMARY KEY,
                webhook_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                event TEXT NOT NULL,
                payload TEXT,
                response_status INTEGER,
                response_body TEXT,
                success BOOLEAN DEFAULT 0,
                attempt INTEGER DEFAULT 1,
                duration INTEGER,
                error TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        `);

        // Backups - Track backup operations
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS backups (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT DEFAULT 'manual',
                path TEXT NOT NULL,
                size INTEGER,
                status TEXT DEFAULT 'completed',
                includes_media BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                error TEXT,
                metadata TEXT,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        `);

        // Activity logs - Audit trail
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                user_id TEXT NOT NULL,
                action TEXT NOT NULL,
                resource TEXT,
                details TEXT,
                ip TEXT,
                user_agent TEXT,
                status TEXT DEFAULT 'success',
                error TEXT,
                duration INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // ==================== INDEXES ====================

        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_unread ON chats(session_id, unread)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_msgs_chat ON msgs(session_id, chat, ts)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_msgs_ts ON msgs(session_id, ts)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_msgs_status ON msgs(session_id, status)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_msgs_starred ON msgs(session_id, starred)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(session_id, lid)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_presence ON contacts(session_id, presence)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(session_id, name)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_group_members ON group_members(session_id, group_jid, member)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(session_id, ts)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(session_id, status)`);
        
        // Meta table indexes
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_session ON webhooks(session_id, enabled)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_event ON webhooks(session_id, event)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_deliveries ON webhook_deliveries(webhook_id, created_at DESC)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id, created_at DESC)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_logs(session_id, created_at DESC)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_logs(action, created_at DESC)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_backups_session ON backups(session_id, created_at DESC)`);
    }

    // ==================== CALLBACK SYSTEM ====================

    /**
     * Register event callback
     * @param {string} event - Event name (message, presence, chat, reaction, group, error, init, close)
     * @param {Function} cb - Callback function
     * @returns {Function} Unsubscribe function
     */
    on(event, cb) {
        if (!this.cbs[event]) this.cbs[event] = [];
        this.cbs[event].push(cb);
        return () => {
            this.cbs[event] = this.cbs[event].filter(fn => fn !== cb);
        };
    }

    /**
     * Emit event to callbacks
     * @private
     * @param {string} event - Event name
     * @param {any} data - Event data
     */
    _emit(event, data) {
        if (!this.cbs[event]) return;
        for (const cb of this.cbs[event]) {
            try { 
                cb(data); 
            } catch (e) { 
                console.error(`Error in ${event} callback:`, e); 
            }
        }
    }

    // ==================== GENERIC CRUD ====================

    /**
     * Insert or update record
     * @param {string} table - Table name
     * @param {Object} data - Record data
     * @param {Array} keys - Primary key fields
     * @returns {Promise<Object>} SQLite result
     */
    async upsert(table, data, keys) {
        if (this.isClosed) throw new Error('Store closed');
        
        const needsSession = !['users', 'global_settings'].includes(table);
        
        // Handle session ID requirement
        if (needsSession) {
            if (!this.sessionId && !data.session_id) {
                throw new Error('sessionId required for this operation');
            }
            if (!data.session_id) {
                data.session_id = this.sessionId;
            }
        }

        // Filter out internal fields
        const cols = Object.keys(data).filter(k => !k.startsWith('_'));
        if (cols.length === 0) return null;

        const vals = cols.map(c => data[c]);
        
        // Build update clause (exclude keys and created_at)
        const updateCols = cols.filter(c => !keys.includes(c) && c !== 'created_at')
            .map(c => `${c} = ?`).join(',');
        
        // Handle case where no columns to update
        let sql;
        if (updateCols) {
            sql = `
                INSERT INTO ${table} (${cols.join(',')}) 
                VALUES (${cols.map(() => '?').join(',')})
                ON CONFLICT(${keys.join(',')}) DO UPDATE SET 
                ${updateCols}, updated_at = CURRENT_TIMESTAMP
            `;
        } else {
            sql = `
                INSERT INTO ${table} (${cols.join(',')}) 
                VALUES (${cols.map(() => '?').join(',')})
                ON CONFLICT(${keys.join(',')}) DO UPDATE SET 
                updated_at = CURRENT_TIMESTAMP
            `;
        }

        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
            try {
                const result = await this.db.run(sql, vals);
                
                // Clear cache
                const cacheKey = `${table}:${keys.map(k => data[k]).join(':')}`;
                this.cache.delete(cacheKey);
                this.cache.deletePattern(`${table}:list:*`);
                
                return result;
            } catch (error) {
                if (error.message.includes('SQLITE_BUSY') && retryCount < maxRetries - 1) {
                    retryCount++;
                    await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
                } else {
                    this._emit('error', { table, error: error.message, data });
                    throw error;
                }
            }
        }
    }

    /**
     * Get single record
     * @param {string} table - Table name
     * @param {Array} keyFields - Primary key field names
     * @param {Array} keyValues - Primary key values
     * @param {boolean} useCache - Whether to use cache
     * @returns {Promise<Object|null>} Record or null
     */
    async get(table, keyFields, keyValues, useCache = true) {
        if (this.isClosed) throw new Error('Store closed');
        
        const needsSession = !['users', 'global_settings'].includes(table);
        
        // Validate input
        if (keyFields.length !== keyValues.length) {
            throw new Error('Key fields and values length mismatch');
        }

        const cacheKey = `${table}:${keyValues.join(':')}`;
        if (useCache) {
            const cached = this.cache.get(cacheKey);
            if (cached) return cached;
        }

        // Build WHERE clause
        let where = [];
        let params = [];
        
        if (needsSession) {
            if (!this.sessionId) throw new Error('sessionId required');
            where.push('session_id = ?');
            params.push(this.sessionId);
        }
        
        keyFields.forEach((k, i) => {
            where.push(`${k} = ?`);
            params.push(keyValues[i]);
        });

        const softDelete = ['chats', 'contacts', 'msgs', 'groups', 'labels'].includes(table);
        if (softDelete) where.push('deleted = 0');

        const result = await this.db.get(
            `SELECT * FROM ${table} WHERE ${where.join(' AND ')}`, 
            params
        );

        if (result && useCache) {
            this.cache.set(cacheKey, result);
        }
        return result;
    }

    /**
     * Get multiple records
     * @param {string} table - Table name
     * @param {string} whereClause - Additional WHERE clause
     * @param {Array} params - Query parameters
     * @param {boolean} useCache - Whether to use cache
     * @returns {Promise<Array>} Array of records
     */
    async all(table, whereClause = '', params = [], useCache = true) {
        if (this.isClosed) throw new Error('Store closed');
        
        const needsSession = !['users', 'global_settings'].includes(table);

        const cacheKey = `${table}:list:${whereClause}:${params.join(':')}`;
        if (useCache) {
            const cached = this.cache.get(cacheKey);
            if (cached) return cached;
        }

        let where = [];
        let allParams = [];

        if (needsSession) {
            if (!this.sessionId) throw new Error('sessionId required');
            where.push('session_id = ?');
            allParams.push(this.sessionId);
        }

        const softDelete = ['chats', 'contacts', 'msgs', 'groups', 'labels'].includes(table);
        if (softDelete) where.push('deleted = 0');

        const whereString = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        
        const results = await this.db.all(
            `SELECT * FROM ${table} ${whereString} ${whereClause}`,
            [...allParams, ...params]
        );

        if (useCache) {
            this.cache.set(cacheKey, results);
        }
        return results;
    }

    /**
     * Delete record
     * @param {string} table - Table name
     * @param {Array} keyFields - Primary key field names
     * @param {Array} keyValues - Primary key values
     * @param {boolean} soft - Whether to soft delete
     * @returns {Promise<Object>} SQLite result
     */
    async del(table, keyFields, keyValues, soft = true) {
        if (this.isClosed) throw new Error('Store closed');
        if (!this.sessionId) throw new Error('sessionId required');

        // Validate input
        if (keyFields.length !== keyValues.length) {
            throw new Error('Key fields and values length mismatch');
        }

        let where = ['session_id = ?'];
        let params = [this.sessionId];
        
        keyFields.forEach((k, i) => {
            where.push(`${k} = ?`);
            params.push(keyValues[i]);
        });

        const canSoftDelete = ['chats', 'contacts', 'msgs', 'groups', 'labels'].includes(table);
        
        let result;
        if (soft && canSoftDelete) {
            result = await this.db.run(
                `UPDATE ${table} SET deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE ${where.join(' AND ')}`,
                params
            );
        } else {
            result = await this.db.run(
                `DELETE FROM ${table} WHERE ${where.join(' AND ')}`,
                params
            );
        }

        // Clear cache
        const cacheKey = `${table}:${keyValues.join(':')}`;
        this.cache.delete(cacheKey);
        this.cache.deletePattern(`${table}:list:*`);

        return result;
    }

    // ==================== BATCH OPERATIONS ====================

    /**
     * Batch insert/update multiple records in transaction
     * @param {string} table - Table name
     * @param {Array} items - Array of records
     * @param {Array} keys - Primary key fields
     * @returns {Promise<Array>} Array of results
     */
    async batchUpsert(table, items, keys) {
        if (!items.length) return [];
        
        const tx = await this.beginTx();
        try {
            const results = [];
            for (const item of items) {
                results.push(await this.upsert(table, item, keys));
            }
            await tx.commit();
            return results;
        } catch (error) {
            await tx.rollback();
            throw error;
        }
    }

    // ==================== SPECIAL HANDLERS ====================

    /**
     * Handle LID mapping update
     * @param {Object} data - { pn, lid }
     * @returns {Promise<Object>} SQLite result
     */
    async handleLID(data) {
        if (!data || !data.pn || !data.lid) {
            throw new Error('Invalid LID data');
        }

        // Update contact with LID
        const result = await this.db.run(
            `UPDATE contacts SET lid = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND (jid = ? OR jid = ?)`,
            [data.lid, this.sessionId, data.pn, data.lid]
        );

        // If no contact updated, create one
        if (result.changes === 0) {
            await this.upsert('contacts', {
                session_id: this.sessionId,
                jid: data.pn,
                lid: data.lid
            }, ['session_id', 'jid']);
        }

        this.cache.deletePattern('contacts:*');
        this._emit('lid', { pn: data.pn, lid: data.lid });
        
        return result;
    }

    /**
     * Handle presence update
     * @param {Object} data - Presence data from Baileys
     * @returns {Promise<Array>} Array of results
     */
    async handlePresence(data) {
        if (!data || !data.id || !data.presences) {
            throw new Error('Invalid presence data');
        }

        const { id, presences } = data;
        const results = [];

        for (const [participant, presenceData] of Object.entries(presences)) {
            try {
                const result = await this.upsert('contacts', {
                    session_id: this.sessionId,
                    jid: participant,
                    presence: presenceData.lastKnownPresence || 'unavailable',
                    presence_last: presenceData.lastSeen 
                        ? new Date(presenceData.lastSeen * 1000).toISOString() 
                        : null,
                    presence_dev: presenceData.deviceType || null
                }, ['session_id', 'jid']);
                
                results.push(result);
                
                this._emit('presence', { 
                    participant, 
                    presence: presenceData.lastKnownPresence,
                    lastSeen: presenceData.lastSeen,
                    chatJid: id 
                });
            } catch (error) {
                this._emit('error', { error: error.message, data: { participant, presenceData } });
            }
        }

        return results;
    }

    /**
     * Handle message upsert
     * @param {Object} data - Message data from Baileys
     * @returns {Promise<Array>} Array of results
     */
    async handleMsg(data) {
        if (!data || !data.messages || !Array.isArray(data.messages)) {
            throw new Error('Invalid message data');
        }

        const { messages, type } = data;
        const results = [];

        for (const msg of messages) {
            try {
                if (!msg.key || !msg.key.id) continue;

                const key = msg.key;
                const fromMe = key.fromMe ? 1 : 0;
                const messageId = key.id;
                const chatJid = key.remoteJid;

                // Insert message
                const msgResult = await this.upsert('msgs', {
                    session_id: this.sessionId,
                    id: messageId,
                    chat: chatJid,
                    from_jid: fromMe ? this.sessionId : (key.participant || key.remoteJid),
                    to_jid: fromMe ? key.remoteJid : this.sessionId,
                    type: this._getMsgType(msg.message),
                    text: this._getText(msg.message),
                    caption: this._getCaption(msg.message),
                    status: this._getStatus(msg),
                    from_me: fromMe,
                    fwd: msg.message?.extendedTextMessage?.isForwarded ? 1 : 0,
                    starred: msg.starred ? 1 : 0,
                    ts: Number(msg.messageTimestamp) || Date.now(),
                    quoted: msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
                    meta: JSON.stringify({ 
                        type, 
                        pushName: msg.pushName,
                        participant: key.participant
                    })
                }, ['session_id', 'id']);

                results.push(msgResult);

                // Update chat's last message
                await this.db.run(
                    `UPDATE chats SET 
                        last_msg_id = ?, 
                        last_msg_time = ?, 
                        unread = unread + ? 
                     WHERE session_id = ? AND jid = ?`,
                    [messageId, msg.messageTimestamp || Date.now(), fromMe ? 0 : 1, this.sessionId, chatJid]
                );

                this.cache.deletePattern('chats:list:*');
                
                this._emit('message', { 
                    id: messageId, 
                    chat: chatJid, 
                    type, 
                    fromMe: !!fromMe, 
                    ts: msg.messageTimestamp 
                });

            } catch (error) {
                this._emit('error', { error: error.message, msgId: msg.key?.id });
            }
        }

        return results;
    }

    /**
     * Handle reaction update
     * @param {Array} data - Reaction data from Baileys
     * @returns {Promise<Array>} Array of results
     */
    async handleReaction(data) {
        if (!data || !Array.isArray(data)) {
            throw new Error('Invalid reaction data');
        }

        const results = [];

        for (const item of data) {
            try {
                if (!item.key || !item.reaction) continue;

                const { key, reaction } = item;
                const messageId = key.id;
                const reactorJid = key.participant || key.remoteJid;

                const result = await this.upsert('reactions', {
                    session_id: this.sessionId,
                    msg_id: messageId,
                    reaction_msg_id: reaction.key?.id,
                    reactor: reactorJid,
                    reaction: reaction.text,
                    ts: Number(reaction.timestamp) || Date.now(),
                    removed: !reaction.text ? 1 : 0
                }, ['session_id', 'msg_id', 'reactor']);

                results.push(result);

                this._emit('reaction', {
                    msgId: messageId,
                    reactor: reactorJid,
                    reaction: reaction.text,
                    removed: !reaction.text
                });

            } catch (error) {
                this._emit('error', { error: error.message, data: item });
            }
        }

        return results;
    }

    /**
     * Handle group participant update
     * @param {Object} data - Group update data from Baileys
     * @returns {Promise<Array>} Array of results
     */
    async handleGroupUpdate(data) {
        if (!data || !data.id || !data.participants) {
            throw new Error('Invalid group update data');
        }

        const { id: groupJid, author, participants, action } = data;
        const results = [];

        for (const participant of participants) {
            try {
                const memberJid = participant.jid || participant;
                
                if (action.includes('add') || action.includes('remove')) {
                    const isActive = !action.includes('remove');
                    
                    const result = await this.upsert('group_members', {
                        session_id: this.sessionId,
                        group_jid: groupJid,
                        member: memberJid,
                        lid: participant.lid,
                        role: 'member',
                        active: isActive ? 1 : 0,
                        added_by: action.includes('add') ? author : null,
                        added_ts: action.includes('add') ? Date.now() : null,
                        removed_by: action.includes('remove') ? author : null,
                        removed_ts: action.includes('remove') ? Date.now() : null
                    }, ['session_id', 'group_jid', 'member']);

                    results.push(result);

                } else if (action.includes('promote') || action.includes('demote')) {
                    const newRole = action.includes('promote') ? 'admin' : 'member';
                    
                    const result = await this.db.run(
                        `UPDATE group_members SET role = ?, updated_at = CURRENT_TIMESTAMP 
                         WHERE session_id = ? AND group_jid = ? AND member = ?`,
                        [newRole, this.sessionId, groupJid, memberJid]
                    );

                    results.push(result);
                }
            } catch (error) {
                this._emit('error', { error: error.message, participant });
            }
        }

        this.cache.deletePattern('group_members:list:*');
        this._emit('group', { groupJid, action, participants });
        
        return results;
    }

    // ==================== HELPER METHODS ====================

    /**
     * Get message type from message object
     * @private
     * @param {Object} msg - Message object
     * @returns {string} Message type
     */
    _getMsgType(msg) {
        if (!msg) return 'unknown';
        const types = [
            'conversation', 'imageMessage', 'videoMessage', 'audioMessage', 
            'documentMessage', 'stickerMessage', 'locationMessage', 'contactMessage',
            'contactsArrayMessage', 'liveLocationMessage', 'extendedTextMessage',
            'protocolMessage', 'reactionMessage', 'pollCreationMessage'
        ];
        for (const type of types) {
            if (msg[type]) return type.replace('Message', '').toLowerCase();
        }
        return 'unknown';
    }

    /**
     * Get text content from message
     * @private
     * @param {Object} msg - Message object
     * @returns {string|null} Text content
     */
    _getText(msg) {
        if (msg?.conversation) return msg.conversation;
        if (msg?.extendedTextMessage?.text) return msg.extendedTextMessage.text;
        if (msg?.imageMessage?.caption) return msg.imageMessage.caption;
        if (msg?.videoMessage?.caption) return msg.videoMessage.caption;
        if (msg?.documentMessage?.caption) return msg.documentMessage.caption;
        return null;
    }

    /**
     * Get caption from media message
     * @private
     * @param {Object} msg - Message object
     * @returns {string|null} Caption
     */
    _getCaption(msg) {
        return msg?.imageMessage?.caption || 
               msg?.videoMessage?.caption || 
               msg?.documentMessage?.caption || 
               null;
    }

    /**
     * Get message status
     * @private
     * @param {Object} msg - Message object
     * @returns {string} Status string
     */
    _getStatus(msg) {
        if (msg.status === 2) return 'sent';
        if (msg.status === 3) return 'delivered';
        if (msg.status === 4) return 'read';
        if (msg.status === 1) return 'pending';
        return 'unknown';
    }

    // ==================== USER METHODS ====================

    /**
     * Create new user
     * @param {string} username - Username
     * @param {string} pass - Password
     * @param {string} apiKey - API key
     * @param {string} role - User role
     * @returns {Promise<Object>} SQLite result
     */
    async createUser(username, pass, apiKey, role = 'user') {
        if (!username || !pass || !apiKey) {
            throw new Error('Username, password and API key required');
        }
        return this.upsert('users', { 
            username, 
            password: pass, 
            api_key: apiKey, 
            role 
        }, ['username']);
    }

    /**
     * Get user by username
     * @param {string} username - Username
     * @returns {Promise<Object|null>} User object or null
     */
    async getUserByUsername(username) {
        if (!username) return null;
        return this.get('users', ['username'], [username]);
    }

    /**
     * Get user by API key
     * @param {string} apiKey - API key
     * @returns {Promise<Object|null>} User object or null
     */
    async getUserByApiKey(apiKey) {
        if (!apiKey) return null;
        return this.db.get(`SELECT * FROM users WHERE api_key = ?`, [apiKey]);
    }

    /**
     * Update user
     * @param {string} username - Username
     * @param {Object} updates - Fields to update
     * @returns {Promise<Object|null>} SQLite result or null
     */
    async updateUser(username, updates) {
        if (!username) throw new Error('Username required');
        
        const user = await this.getUserByUsername(username);
        if (!user) return null;
        
        // Don't allow updating username
        delete updates.username;
        
        return this.upsert('users', { 
            username, 
            ...user, 
            ...updates 
        }, ['username']);
    }

    /**
     * Delete user
     * @param {string} username - Username
     * @returns {Promise<Object>} SQLite result
     */
    async deleteUser(username) {
        if (!username) throw new Error('Username required');
        return this.db.run(`DELETE FROM users WHERE username = ?`, [username]);
    }

    /**
     * Get all users
     * @returns {Promise<Array>} Array of users
     */
    async getAllUsers() {
        return this.db.all(
            `SELECT username, api_key, role, created_at FROM users ORDER BY created_at DESC`
        );
    }

    /**
     * Set user meta data
     * @param {string} username - Username
     * @param {string} key - Meta key
     * @param {string} value - Meta value
     * @returns {Promise<Object>} SQLite result
     */
    async setUserMeta(username, key, value) {
        if (!username || !key) throw new Error('Username and key required');
        return this.upsert('user_meta', { 
            username, 
            key, 
            value: value !== undefined ? String(value) : null 
        }, ['username', 'key']);
    }

    /**
     * Get user meta value
     * @param {string} username - Username
     * @param {string} key - Meta key
     * @returns {Promise<string|null>} Meta value or null
     */
    async getUserMeta(username, key) {
        if (!username || !key) return null;
        const r = await this.get('user_meta', ['username', 'key'], [username, key], false);
        return r?.value;
    }

    /**
     * Get all user meta
     * @param {string} username - Username
     * @returns {Promise<Object>} Key-value object
     */
    async getAllUserMeta(username) {
        if (!username) return {};
        const rows = await this.db.all(
            `SELECT key, value FROM user_meta WHERE username = ?`, 
            [username]
        );
        return rows.reduce((acc, row) => { 
            acc[row.key] = row.value; 
            return acc; 
        }, {});
    }

    /**
     * Delete user meta
     * @param {string} username - Username
     * @param {string} key - Meta key
     * @returns {Promise<Object>} SQLite result
     */
    async deleteUserMeta(username, key) {
        if (!username || !key) throw new Error('Username and key required');
        return this.db.run(
            `DELETE FROM user_meta WHERE username = ? AND key = ?`, 
            [username, key]
        );
    }

    // ==================== SESSION METHODS ====================

    /**
     * Create new session
     * @param {string} id - Session ID
     * @param {Object} data - Session data
     * @returns {Promise<Object>} SQLite result
     */
    async createSession(id, data = {}) {
        if (!id) throw new Error('Session ID required');
        return this.upsert('sessions', { id, ...data }, ['id']);
    }

    /**
     * Get session by ID
     * @param {string} id - Session ID
     * @returns {Promise<Object|null>} Session object or null
     */
    async getSession(id) {
        if (!id) return null;
        return this.get('sessions', ['id'], [id]);
    }

    /**
     * Update session
     * @param {string} id - Session ID
     * @param {Object} updates - Fields to update
     * @returns {Promise<Object|null>} SQLite result or null
     */
    async updateSession(id, updates) {
        if (!id) throw new Error('Session ID required');
        
        const existing = await this.getSession(id);
        if (!existing) return null;
        
        // Don't allow updating id
        delete updates.id;
        
        return this.upsert('sessions', { id, ...existing, ...updates }, ['id']);
    }

    /**
     * Delete session
     * @param {string} id - Session ID
     * @returns {Promise<Object>} SQLite result
     */
    async deleteSession(id) {
        if (!id) throw new Error('Session ID required');
        return this.db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
    }

    /**
     * Get all sessions
     * @returns {Promise<Array>} Array of sessions
     */
    async getAllSessions() {
        return this.db.all(
            `SELECT id, device_id, phone, platform, status, logged_in, last_seen, created_at 
             FROM sessions ORDER BY created_at DESC`
        );
    }

    /**
     * Set session meta data
     * @param {string} sessionId - Session ID
     * @param {string} key - Meta key
     * @param {string} value - Meta value
     * @returns {Promise<Object>} SQLite result
     */
    async setSessionMeta(sessionId, key, value) {
        if (!sessionId || !key) throw new Error('Session ID and key required');
        return this.upsert('session_meta', { 
            session_id: sessionId, 
            key, 
            value: value !== undefined ? String(value) : null 
        }, ['session_id', 'key']);
    }

    /**
     * Get session meta value
     * @param {string} sessionId - Session ID
     * @param {string} key - Meta key
     * @returns {Promise<string|null>} Meta value or null
     */
    async getSessionMeta(sessionId, key) {
        if (!sessionId || !key) return null;
        const r = await this.get('session_meta', ['session_id', 'key'], [sessionId, key], false);
        return r?.value;
    }

    /**
     * Get all session meta
     * @param {string} sessionId - Session ID
     * @returns {Promise<Object>} Key-value object
     */
    async getAllSessionMeta(sessionId) {
        if (!sessionId) return {};
        const rows = await this.db.all(
            `SELECT key, value FROM session_meta WHERE session_id = ?`, 
            [sessionId]
        );
        return rows.reduce((acc, row) => { 
            acc[row.key] = row.value; 
            return acc; 
        }, {});
    }

    /**
     * Delete session meta
     * @param {string} sessionId - Session ID
     * @param {string} key - Meta key
     * @returns {Promise<Object>} SQLite result
     */
    async deleteSessionMeta(sessionId, key) {
        if (!sessionId || !key) throw new Error('Session ID and key required');
        return this.db.run(
            `DELETE FROM session_meta WHERE session_id = ? AND key = ?`, 
            [sessionId, key]
        );
    }

    // ==================== GLOBAL SETTINGS ====================

    /**
     * Set global setting
     * @param {string} key - Setting key
     * @param {string} value - Setting value
     * @param {string} description - Setting description
     * @returns {Promise<Object>} SQLite result
     */
    async setGlobalSetting(key, value, description = '') {
        if (!key) throw new Error('Setting key required');
        return this.upsert('global_settings', { 
            key, 
            value: value !== undefined ? String(value) : null,
            description 
        }, ['key']);
    }

    /**
     * Get global setting
     * @param {string} key - Setting key
     * @returns {Promise<string|null>} Setting value or null
     */
    async getGlobalSetting(key) {
        if (!key) return null;
        const r = await this.get('global_settings', ['key'], [key], false);
        return r?.value;
    }

    /**
     * Get all global settings
     * @returns {Promise<Object>} Key-value object with metadata
     */
    async getAllGlobalSettings() {
        const rows = await this.db.all(`SELECT * FROM global_settings ORDER BY key`);
        return rows.reduce((acc, row) => {
            acc[row.key] = { 
                value: row.value, 
                description: row.description, 
                updated: row.updated_at 
            };
            return acc;
        }, {});
    }

    /**
     * Delete global setting
     * @param {string} key - Setting key
     * @returns {Promise<Object>} SQLite result
     */
    async deleteGlobalSetting(key) {
        if (!key) throw new Error('Setting key required');
        return this.db.run(`DELETE FROM global_settings WHERE key = ?`, [key]);
    }

    // ==================== USER-SESSION METHODS ====================

    /**
     * Assign session to user
     * @param {string} username - Username
     * @param {string} sessionId - Session ID
     * @param {boolean} active - Active status
     * @returns {Promise<Object>} SQLite result
     */
    async assignUserSession(username, sessionId, active = true) {
        if (!username || !sessionId) throw new Error('Username and session ID required');
        
        return this.upsert('user_sessions', {
            username, 
            session_id: sessionId, 
            active: active ? 1 : 0
        }, ['username', 'session_id']);
    }

    /**
     * Get user's active sessions
     * @param {string} username - Username
     * @returns {Promise<Array>} Array of sessions
     */
    async getUserSessions(username) {
        if (!username) return [];
        
        return this.db.all(
            `SELECT s.* FROM sessions s 
             JOIN user_sessions us ON s.id = us.session_id 
             WHERE us.username = ? AND us.active = 1 
             ORDER BY s.created_at DESC`,
            [username]
        );
    }

    /**
     * Get user who owns a session
     * @param {string} sessionId - Session ID
     * @returns {Promise<Object|null>} User object or null
     */
    async getSessionUser(sessionId) {
        if (!sessionId) return null;
        
        return this.db.get(
            `SELECT u.* FROM users u 
             JOIN user_sessions us ON u.username = us.username 
             WHERE us.session_id = ?`,
            [sessionId]
        );
    }

    /**
     * Deactivate user session
     * @param {string} username - Username
     * @param {string} sessionId - Session ID
     * @returns {Promise<Object>} SQLite result
     */
    async deactivateUserSession(username, sessionId) {
        if (!username || !sessionId) throw new Error('Username and session ID required');
        
        return this.db.run(
            `UPDATE user_sessions SET active = 0, updated_at = CURRENT_TIMESTAMP 
             WHERE username = ? AND session_id = ?`,
            [username, sessionId]
        );
    }

    /**
     * Activate user session
     * @param {string} username - Username
     * @param {string} sessionId - Session ID
     * @returns {Promise<Object>} SQLite result
     */
    async activateUserSession(username, sessionId) {
        if (!username || !sessionId) throw new Error('Username and session ID required');
        
        return this.db.run(
            `UPDATE user_sessions SET active = 1, updated_at = CURRENT_TIMESTAMP 
             WHERE username = ? AND session_id = ?`,
            [username, sessionId]
        );
    }

    // ==================== CHAT METHODS ====================

    /**
     * Insert or update chat
     * @param {Object} data - Chat data
     * @returns {Promise<Object>} SQLite result
     */
    async upsertChat(data) {
        if (!data.jid) throw new Error('Chat JID required');
        
        const result = await this.upsert('chats', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'jid']);
        
        this._emit('chat', data);
        return result;
    }

    /**
     * Get chat by JID
     * @param {string} jid - Chat JID
     * @returns {Promise<Object|null>} Chat object or null
     */
    async getChat(jid) {
        if (!jid) return null;
        return this.get('chats', ['session_id', 'jid'], [this.sessionId, jid]);
    }

    /**
     * Get all chats
     * @param {boolean} includeArchived - Whether to include archived chats
     * @returns {Promise<Array>} Array of chats
     */
    async getAllChats(includeArchived = false) {
        const where = includeArchived ? '' : 'AND archived = 0';
        return this.all('chats', `ORDER BY last_msg_time DESC ${where}`);
    }

    /**
     * Get total unread count
     * @returns {Promise<number>} Unread count
     */
    async getUnreadCount() {
        const result = await this.db.get(
            `SELECT COUNT(*) as count FROM chats 
             WHERE session_id = ? AND unread > 0 AND deleted = 0`,
            [this.sessionId]
        );
        return result?.count || 0;
    }

    /**
     * Mark all chats as read
     * @returns {Promise<Object>} SQLite result
     */
    async markAllRead() {
        return this.db.run(
            `UPDATE chats SET unread = 0 WHERE session_id = ?`,
            [this.sessionId]
        );
    }

    /**
     * Update chat
     * @param {string} jid - Chat JID
     * @param {Object} updates - Fields to update
     * @returns {Promise<Object|null>} SQLite result or null
     */
    async updateChat(jid, updates) {
        if (!jid) throw new Error('Chat JID required');
        
        const chat = await this.getChat(jid);
        if (!chat) return null;
        
        return this.upsert('chats', { 
            session_id: this.sessionId, 
            jid, 
            ...chat, 
            ...updates 
        }, ['session_id', 'jid']);
    }

    /**
     * Delete chat
     * @param {string} jid - Chat JID
     * @param {boolean} soft - Whether to soft delete
     * @returns {Promise<Object>} SQLite result
     */
    async deleteChat(jid, soft = true) {
        if (!jid) throw new Error('Chat JID required');
        return this.del('chats', ['jid'], [jid], soft);
    }

    /**
     * Search chats by name or JID
     * @param {string} query - Search query
     * @returns {Promise<Array>} Array of matching chats
     */
    async searchChats(query) {
        if (!query) return [];
        
        return this.db.all(
            `SELECT * FROM chats 
             WHERE session_id = ? AND deleted = 0 
             AND (name LIKE ? OR jid LIKE ?)
             ORDER BY last_msg_time DESC`,
            [this.sessionId, `%${query}%`, `%${query}%`]
        );
    }

    // ==================== CONTACT METHODS ====================

    /**
     * Insert or update contact
     * @param {Object} data - Contact data
     * @returns {Promise<Object>} SQLite result
     */
    async upsertContact(data) {
        if (!data.jid) throw new Error('Contact JID required');
        
        return this.upsert('contacts', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'jid']);
    }

    /**
     * Get contact by JID
     * @param {string} jid - Contact JID
     * @returns {Promise<Object|null>} Contact object or null
     */
    async getContact(jid) {
        if (!jid) return null;
        return this.get('contacts', ['session_id', 'jid'], [this.sessionId, jid]);
    }

    /**
     * Get all contacts
     * @returns {Promise<Array>} Array of contacts
     */
    async getAllContacts() {
        return this.all('contacts', 'ORDER BY name COLLATE NOCASE');
    }

    /**
     * Search contacts by name, JID or phone
     * @param {string} query - Search query
     * @returns {Promise<Array>} Array of matching contacts
     */
    async searchContacts(query) {
        if (!query) return [];
        
        return this.db.all(
            `SELECT * FROM contacts 
             WHERE session_id = ? AND deleted = 0 
             AND (name LIKE ? OR jid LIKE ? OR phone LIKE ?)
             ORDER BY name COLLATE NOCASE`,
            [this.sessionId, `%${query}%`, `%${query}%`, `%${query}%`]
        );
    }

    /**
     * Update contact
     * @param {string} jid - Contact JID
     * @param {Object} updates - Fields to update
     * @returns {Promise<Object|null>} SQLite result or null
     */
    async updateContact(jid, updates) {
        if (!jid) throw new Error('Contact JID required');
        
        const contact = await this.getContact(jid);
        if (!contact) return null;
        
        return this.upsert('contacts', { 
            session_id: this.sessionId, 
            jid, 
            ...contact, 
            ...updates 
        }, ['session_id', 'jid']);
    }

    /**
     * Block or unblock contact
     * @param {string} jid - Contact JID
     * @param {boolean} block - True to block, false to unblock
     * @returns {Promise<void>}
     */
    async blockContact(jid, block = true) {
        if (!jid) throw new Error('Contact JID required');
        
        if (block) {
            await this.upsert('blocklist', { 
                session_id: this.sessionId, 
                jid 
            }, ['session_id', 'jid']);
            
            await this.db.run(
                `UPDATE contacts SET blocked = 1 WHERE session_id = ? AND jid = ?`, 
                [this.sessionId, jid]
            );
        } else {
            await this.del('blocklist', ['jid'], [jid], false);
            
            await this.db.run(
                `UPDATE contacts SET blocked = 0 WHERE session_id = ? AND jid = ?`, 
                [this.sessionId, jid]
            );
        }
        
        this.cache.deletePattern('contacts:*');
    }

    /**
     * Check if contact is blocked
     * @param {string} jid - Contact JID
     * @returns {Promise<boolean>} True if blocked
     */
    async isBlocked(jid) {
        if (!jid) return false;
        
        const result = await this.db.get(
            `SELECT 1 FROM blocklist WHERE session_id = ? AND jid = ?`, 
            [this.sessionId, jid]
        );
        return !!result;
    }

    // ==================== MESSAGE METHODS ====================

    /**
     * Insert or update message
     * @param {Object} data - Message data
     * @returns {Promise<Object>} SQLite result
     */
    async upsertMsg(data) {
        if (!data.id) throw new Error('Message ID required');
        
        return this.upsert('msgs', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'id']);
    }

    /**
     * Get message by ID
     * @param {string} id - Message ID
     * @returns {Promise<Object|null>} Message object or null
     */
    async getMsg(id) {
        if (!id) return null;
        return this.get('msgs', ['session_id', 'id'], [this.sessionId, id]);
    }

    /**
     * Get messages for a chat
     * @param {string} chatJid - Chat JID
     * @param {number} limit - Number of messages
     * @param {number} offset - Offset for pagination
     * @param {number} before - Get messages before timestamp
     * @param {number} after - Get messages after timestamp
     * @returns {Promise<Array>} Array of messages
     */
    async getChatMsgs(chatJid, limit = 50, offset = 0, before = null, after = null) {
        if (!chatJid) throw new Error('Chat JID required');
        
        let query;
        let params;
        
        if (before) {
            query = `SELECT * FROM msgs 
                     WHERE session_id = ? AND chat = ? AND ts < ? AND deleted = 0 
                     ORDER BY ts DESC LIMIT ?`;
            params = [this.sessionId, chatJid, before, limit];
        } else if (after) {
            query = `SELECT * FROM msgs 
                     WHERE session_id = ? AND chat = ? AND ts > ? AND deleted = 0 
                     ORDER BY ts ASC LIMIT ?`;
            params = [this.sessionId, chatJid, after, limit];
        } else {
            query = `SELECT * FROM msgs 
                     WHERE session_id = ? AND chat = ? AND deleted = 0 
                     ORDER BY ts DESC LIMIT ? OFFSET ?`;
            params = [this.sessionId, chatJid, limit, offset];
        }
        
        return this.db.all(query, params);
    }

    /**
     * Get starred messages
     * @param {number} limit - Number of messages
     * @returns {Promise<Array>} Array of starred messages
     */
    async getStarredMsgs(limit = 50) {
        return this.db.all(
            `SELECT * FROM msgs 
             WHERE session_id = ? AND starred = 1 AND deleted = 0 
             ORDER BY ts DESC LIMIT ?`,
            [this.sessionId, limit]
        );
    }

    /**
     * Search messages
     * @param {string} chatJid - Chat JID (optional)
     * @param {string} query - Search query
     * @param {number} limit - Number of results
     * @returns {Promise<Array>} Array of matching messages
     */
    async searchMsgs(chatJid, query, limit = 50) {
        if (!query) return [];
        
        let sql;
        let params;
        
        if (chatJid) {
            sql = `SELECT * FROM msgs 
                   WHERE session_id = ? AND chat = ? AND text LIKE ? AND deleted = 0 
                   ORDER BY ts DESC LIMIT ?`;
            params = [this.sessionId, chatJid, `%${query}%`, limit];
        } else {
            sql = `SELECT * FROM msgs 
                   WHERE session_id = ? AND text LIKE ? AND deleted = 0 
                   ORDER BY ts DESC LIMIT ?`;
            params = [this.sessionId, `%${query}%`, limit];
        }
        
        return this.db.all(sql, params);
    }

    /**
     * Update message status
     * @param {string} id - Message ID
     * @param {string} status - New status
     * @returns {Promise<Object>} SQLite result
     */
    async updateMsgStatus(id, status) {
        if (!id) throw new Error('Message ID required');
        
        return this.db.run(
            `UPDATE msgs SET status = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND id = ?`,
            [status, this.sessionId, id]
        );
    }

    /**
     * Star or unstar message
     * @param {string} id - Message ID
     * @param {boolean} starred - Star status
     * @returns {Promise<Object>} SQLite result
     */
    async starMsg(id, starred = true) {
        if (!id) throw new Error('Message ID required');
        
        return this.db.run(
            `UPDATE msgs SET starred = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND id = ?`,
            [starred ? 1 : 0, this.sessionId, id]
        );
    }

    /**
     * Delete message
     * @param {string} id - Message ID
     * @param {boolean} soft - Whether to soft delete
     * @returns {Promise<Object>} SQLite result
     */
    async deleteMsg(id, soft = true) {
        if (!id) throw new Error('Message ID required');
        return this.del('msgs', ['id'], [id], soft);
    }

    /**
     * Clear all messages in a chat
     * @param {string} chatJid - Chat JID
     * @returns {Promise<Object>} SQLite result
     */
    async clearChatMsgs(chatJid) {
        if (!chatJid) throw new Error('Chat JID required');
        
        return this.db.run(
            `UPDATE msgs SET deleted = 1, deleted_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND chat = ?`,
            [this.sessionId, chatJid]
        );
    }

    // ==================== RECEIPTS METHODS ====================

    /**
     * Add message receipt
     * @param {Object} data - Receipt data
     * @returns {Promise<Object>} SQLite result
     */
    async addReceipt(data) {
        if (!data.msg_id || !data.participant || !data.type) {
            throw new Error('Message ID, participant and type required');
        }
        
        return this.upsert('receipts', {
            session_id: this.sessionId,
            ...data
        }, ['session_id', 'msg_id', 'participant', 'type']);
    }

    /**
     * Get receipts for a message
     * @param {string} msgId - Message ID
     * @returns {Promise<Array>} Array of receipts
     */
    async getMsgReceipts(msgId) {
        if (!msgId) return [];
        
        return this.db.all(
            `SELECT * FROM receipts 
             WHERE session_id = ? AND msg_id = ? 
             ORDER BY ts ASC`,
            [this.sessionId, msgId]
        );
    }

    // ==================== MEDIA METHODS ====================

    /**
     * Insert or update media
     * @param {Object} data - Media data
     * @returns {Promise<Object>} SQLite result
     */
    async upsertMedia(data) {
        if (!data.msg_id) throw new Error('Message ID required');
        
        return this.upsert('media', {
            session_id: this.sessionId,
            ...data
        }, ['session_id', 'msg_id']);
    }

    /**
     * Get media by message ID
     * @param {string} msgId - Message ID
     * @returns {Promise<Object|null>} Media object or null
     */
    async getMedia(msgId) {
        if (!msgId) return null;
        return this.get('media', ['session_id', 'msg_id'], [this.sessionId, msgId]);
    }

    /**
     * Mark media as downloaded
     * @param {string} msgId - Message ID
     * @param {string} url - Media URL
     * @returns {Promise<Object>} SQLite result
     */
    async markMediaDownloaded(msgId, url) {
        if (!msgId) throw new Error('Message ID required');
        
        return this.db.run(
            `UPDATE media SET downloaded = 1, url = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND msg_id = ?`,
            [url, this.sessionId, msgId]
        );
    }

    /**
     * Mark media as failed
     * @param {string} msgId - Message ID
     * @param {string} error - Error message
     * @returns {Promise<Object>} SQLite result
     */
    async markMediaFailed(msgId, error) {
        if (!msgId) throw new Error('Message ID required');
        
        return this.db.run(
            `UPDATE media SET dl_error = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND msg_id = ?`,
            [error, this.sessionId, msgId]
        );
    }

    // ==================== GROUP METHODS ====================

    /**
     * Insert or update group
     * @param {Object} data - Group data
     * @returns {Promise<Object>} SQLite result
     */
    async upsertGroup(data) {
        if (!data.jid) throw new Error('Group JID required');
        
        return this.upsert('groups', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'jid']);
    }

    /**
     * Get group by JID
     * @param {string} jid - Group JID
     * @returns {Promise<Object|null>} Group object or null
     */
    async getGroup(jid) {
        if (!jid) return null;
        return this.get('groups', ['session_id', 'jid'], [this.sessionId, jid]);
    }

    /**
     * Get all groups
     * @returns {Promise<Array>} Array of groups
     */
    async getAllGroups() {
        return this.all('groups', 'ORDER BY subject COLLATE NOCASE');
    }

    /**
     * Search groups by subject
     * @param {string} query - Search query
     * @returns {Promise<Array>} Array of matching groups
     */
    async searchGroups(query) {
        if (!query) return [];
        
        return this.db.all(
            `SELECT * FROM groups 
             WHERE session_id = ? AND deleted = 0 
             AND subject LIKE ? 
             ORDER BY subject COLLATE NOCASE`,
            [this.sessionId, `%${query}%`]
        );
    }

    /**
     * Get group members
     * @param {string} jid - Group JID
     * @returns {Promise<Array>} Array of members
     */
    async getGroupMembers(jid) {
        if (!jid) return [];
        
        return this.db.all(
            `SELECT * FROM group_members 
             WHERE session_id = ? AND group_jid = ? AND active = 1 
             ORDER BY role, member`,
            [this.sessionId, jid]
        );
    }

    /**
     * Get group admins
     * @param {string} jid - Group JID
     * @returns {Promise<Array>} Array of admins
     */
    async getGroupAdmins(jid) {
        if (!jid) return [];
        
        return this.db.all(
            `SELECT * FROM group_members 
             WHERE session_id = ? AND group_jid = ? AND role = 'admin' AND active = 1`,
            [this.sessionId, jid]
        );
    }

    /**
     * Get specific group member
     * @param {string} jid - Group JID
     * @param {string} member - Member JID
     * @returns {Promise<Object|null>} Member object or null
     */
    async getGroupMember(jid, member) {
        if (!jid || !member) return null;
        
        return this.db.get(
            `SELECT * FROM group_members 
             WHERE session_id = ? AND group_jid = ? AND member = ?`,
            [this.sessionId, jid, member]
        );
    }

    /**
     * Insert or update group member
     * @param {Object} data - Member data
     * @returns {Promise<Object>} SQLite result
     */
    async upsertGroupMember(data) {
        if (!data.group_jid || !data.member) {
            throw new Error('Group JID and member required');
        }
        
        return this.upsert('group_members', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'group_jid', 'member']);
    }

    /**
     * Update group member role
     * @param {string} jid - Group JID
     * @param {string} member - Member JID
     * @param {string} role - New role
     * @returns {Promise<Object>} SQLite result
     */
    async updateGroupMemberRole(jid, member, role) {
        if (!jid || !member || !role) {
            throw new Error('Group JID, member and role required');
        }
        
        return this.db.run(
            `UPDATE group_members SET role = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND group_jid = ? AND member = ?`,
            [role, this.sessionId, jid, member]
        );
    }

    // ==================== CALL METHODS ====================

    /**
     * Insert or update call
     * @param {Object} data - Call data
     * @returns {Promise<Object>} SQLite result
     */
    async upsertCall(data) {
        if (!data.id) throw new Error('Call ID required');
        
        return this.upsert('calls', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'id']);
    }

    /**
     * Get call history
     * @param {number} limit - Number of calls
     * @param {number} offset - Offset for pagination
     * @returns {Promise<Array>} Array of calls
     */
    async getCalls(limit = 50, offset = 0) {
        return this.db.all(
            `SELECT * FROM calls 
             WHERE session_id = ? 
             ORDER BY ts DESC LIMIT ? OFFSET ?`,
            [this.sessionId, limit, offset]
        );
    }

    /**
     * Get missed calls
     * @param {number} limit - Number of calls
     * @returns {Promise<Array>} Array of missed calls
     */
    async getMissedCalls(limit = 50) {
        return this.db.all(
            `SELECT * FROM calls 
             WHERE session_id = ? AND status = 'missed' 
             ORDER BY ts DESC LIMIT ?`,
            [this.sessionId, limit]
        );
    }

    /**
     * Update call status
     * @param {string} id - Call ID
     * @param {string} status - New status
     * @param {number} duration - Call duration
     * @returns {Promise<Object|null>} SQLite result or null
     */
    async updateCallStatus(id, status, duration = null) {
        if (!id) throw new Error('Call ID required');
        
        const updates = { status };
        if (duration !== null) updates.duration = duration;
        
        const call = await this.get('calls', ['session_id', 'id'], [this.sessionId, id]);
        if (!call) return null;
        
        return this.upsert('calls', { 
            id, 
            session_id: this.sessionId, 
            ...call, 
            ...updates 
        }, ['session_id', 'id']);
    }

    // ==================== LABEL METHODS ====================

    /**
     * Insert or update label
     * @param {Object} data - Label data
     * @returns {Promise<Object>} SQLite result
     */
    async upsertLabel(data) {
        if (!data.id || !data.name) throw new Error('Label ID and name required');
        
        return this.upsert('labels', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'id']);
    }

    /**
     * Get all labels
     * @returns {Promise<Array>} Array of labels
     */
    async getLabels() {
        return this.all('labels', 'AND deleted = 0 ORDER BY name');
    }

    /**
     * Get label by ID
     * @param {string} id - Label ID
     * @returns {Promise<Object|null>} Label object or null
     */
    async getLabel(id) {
        if (!id) return null;
        return this.get('labels', ['session_id', 'id'], [this.sessionId, id]);
    }

    /**
     * Delete label
     * @param {string} id - Label ID
     * @param {boolean} soft - Whether to soft delete
     * @returns {Promise<Object>} SQLite result
     */
    async deleteLabel(id, soft = true) {
        if (!id) throw new Error('Label ID required');
        return this.del('labels', ['id'], [id], soft);
    }

    /**
     * Add label to chat
     * @param {string} labelId - Label ID
     * @param {string} chatJid - Chat JID
     * @returns {Promise<Object>} SQLite result
     */
    async addLabelToChat(labelId, chatJid) {
        if (!labelId || !chatJid) throw new Error('Label ID and chat JID required');
        
        // Increment label count
        await this.db.run(
            `UPDATE labels SET count = count + 1 WHERE session_id = ? AND id = ?`,
            [this.sessionId, labelId]
        );
        
        return this.upsert('label_assoc', {
            session_id: this.sessionId, 
            label_id: labelId, 
            target: chatJid, 
            type: 'chat'
        }, ['session_id', 'label_id', 'target']);
    }

    /**
     * Add label to message
     * @param {string} labelId - Label ID
     * @param {string} msgId - Message ID
     * @returns {Promise<Object>} SQLite result
     */
    async addLabelToMsg(labelId, msgId) {
        if (!labelId || !msgId) throw new Error('Label ID and message ID required');
        
        // Increment label count
        await this.db.run(
            `UPDATE labels SET count = count + 1 WHERE session_id = ? AND id = ?`,
            [this.sessionId, labelId]
        );
        
        return this.upsert('label_assoc', {
            session_id: this.sessionId, 
            label_id: labelId, 
            target: msgId, 
            type: 'msg'
        }, ['session_id', 'label_id', 'target']);
    }

    /**
     * Remove label from chat
     * @param {string} labelId - Label ID
     * @param {string} chatJid - Chat JID
     * @returns {Promise<Object>} SQLite result
     */
    async removeLabelFromChat(labelId, chatJid) {
        if (!labelId || !chatJid) throw new Error('Label ID and chat JID required');
        
        // Decrement label count
        await this.db.run(
            `UPDATE labels SET count = count - 1 WHERE session_id = ? AND id = ? AND count > 0`,
            [this.sessionId, labelId]
        );
        
        return this.db.run(
            `DELETE FROM label_assoc 
             WHERE session_id = ? AND label_id = ? AND target = ? AND type = 'chat'`,
            [this.sessionId, labelId, chatJid]
        );
    }

    /**
     * Get labels for a chat
     * @param {string} chatJid - Chat JID
     * @returns {Promise<Array>} Array of labels
     */
    async getChatLabels(chatJid) {
        if (!chatJid) return [];
        
        return this.db.all(
            `SELECT l.* FROM labels l
             JOIN label_assoc la ON l.id = la.label_id
             WHERE la.session_id = ? AND la.target = ? AND la.type = 'chat' AND l.deleted = 0
             ORDER BY l.name`,
            [this.sessionId, chatJid]
        );
    }

    /**
     * Get labels for a message
     * @param {string} msgId - Message ID
     * @returns {Promise<Array>} Array of labels
     */
    async getMsgLabels(msgId) {
        if (!msgId) return [];
        
        return this.db.all(
            `SELECT l.* FROM labels l
             JOIN label_assoc la ON l.id = la.label_id
             WHERE la.session_id = ? AND la.target = ? AND la.type = 'msg' AND l.deleted = 0
             ORDER BY l.name`,
            [this.sessionId, msgId]
        );
    }

    // ==================== NEWSLETTER METHODS ====================

    /**
     * Insert or update newsletter
     * @param {Object} data - Newsletter data
     * @returns {Promise<Object>} SQLite result
     */
    async upsertNewsletter(data) {
        if (!data.id) throw new Error('Newsletter ID required');
        
        return this.upsert('newsletters', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'id']);
    }

    /**
     * Get all newsletters
     * @returns {Promise<Array>} Array of newsletters
     */
    async getNewsletters() {
        return this.all('newsletters', 'ORDER BY name');
    }

    /**
     * Get newsletter by ID
     * @param {string} id - Newsletter ID
     * @returns {Promise<Object|null>} Newsletter object or null
     */
    async getNewsletter(id) {
        if (!id) return null;
        return this.get('newsletters', ['session_id', 'id'], [this.sessionId, id]);
    }

    /**
     * Insert or update newsletter post
     * @param {Object} data - Post data
     * @returns {Promise<Object>} SQLite result
     */
    async upsertNewsletterPost(data) {
        if (!data.nid || !data.pid) throw new Error('Newsletter ID and post ID required');
        
        return this.upsert('newsletter_posts', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'nid', 'pid']);
    }

    /**
     * Get newsletter posts
     * @param {string} nid - Newsletter ID
     * @param {number} limit - Number of posts
     * @returns {Promise<Array>} Array of posts
     */
    async getNewsletterPosts(nid, limit = 50) {
        if (!nid) return [];
        
        return this.db.all(
            `SELECT * FROM newsletter_posts 
             WHERE session_id = ? AND nid = ? 
             ORDER BY posted_ts DESC LIMIT ?`,
            [this.sessionId, nid, limit]
        );
    }

    /**
     * Increment newsletter post view count
     * @param {string} nid - Newsletter ID
     * @param {string} pid - Post ID
     * @returns {Promise<Object>} SQLite result
     */
    async incrementNewsletterPostViews(nid, pid) {
        if (!nid || !pid) throw new Error('Newsletter ID and post ID required');
        
        return this.db.run(
            `UPDATE newsletter_posts SET views = views + 1 
             WHERE session_id = ? AND nid = ? AND pid = ?`,
            [this.sessionId, nid, pid]
        );
    }

    // ==================== WEBHOOK METHODS (for n8n) ====================

    /**
     * Create webhook for n8n
     * @param {Object} data - Webhook data
     * @returns {Promise<Object>} SQLite result
     */
    async createWebhook(data) {
        if (!data.event || !data.url) {
            throw new Error('Event and URL required');
        }
        
        const id = `webhook_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        
        return this.upsert('webhooks', {
            id,
            session_id: this.sessionId,
            event: data.event,
            url: data.url,
            headers: data.headers ? JSON.stringify(data.headers) : null,
            enabled: data.enabled !== undefined ? data.enabled : 1,
            retry_count: data.retry_count || 3,
            timeout: data.timeout || 10000,
            secret: data.secret
        }, ['id']);
    }

    /**
     * Get webhook by event type
     * @param {string} event - Event type
     * @returns {Promise<Object|null>} Webhook object or null
     */
    async getWebhookByEvent(event) {
        if (!event) return null;
        return this.get('webhooks', ['session_id', 'event'], [this.sessionId, event]);
    }

    /**
     * Get all webhooks
     * @returns {Promise<Array>} Array of webhooks
     */
    async getAllWebhooks() {
        return this.all('webhooks', 'ORDER BY event');
    }

    /**
     * Update webhook
     * @param {string} id - Webhook ID
     * @param {Object} updates - Fields to update
     * @returns {Promise<Object|null>} SQLite result or null
     */
    async updateWebhook(id, updates) {
        if (!id) throw new Error('Webhook ID required');
        
        const webhook = await this.get('webhooks', ['session_id', 'id'], [this.sessionId, id]);
        if (!webhook) return null;
        
        if (updates.headers && typeof updates.headers !== 'string') {
            updates.headers = JSON.stringify(updates.headers);
        }
        
        return this.upsert('webhooks', { id, ...webhook, ...updates }, ['id']);
    }

    /**
     * Delete webhook
     * @param {string} id - Webhook ID
     * @returns {Promise<Object>} SQLite result
     */
    async deleteWebhook(id) {
        if (!id) throw new Error('Webhook ID required');
        
        return this.db.run(
            `DELETE FROM webhooks WHERE id = ? AND session_id = ?`, 
            [id, this.sessionId]
        );
    }

    /**
     * Log webhook delivery
     * @param {string} webhookId - Webhook ID
     * @param {string} event - Event type
     * @param {Object} data - Delivery data
     * @returns {Promise<Object>} SQLite result
     */
    async logWebhookDelivery(webhookId, event, data) {
        if (!webhookId || !event) throw new Error('Webhook ID and event required');
        
        const id = `delivery_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        
        return this.upsert('webhook_deliveries', {
            id,
            webhook_id: webhookId,
            session_id: this.sessionId,
            event,
            payload: data.payload ? JSON.stringify(data.payload) : null,
            response_status: data.response_status,
            response_body: data.response_body,
            success: data.success ? 1 : 0,
            attempt: data.attempt || 1,
            duration: data.duration,
            error: data.error
        }, ['id']);
    }

    /**
     * Update webhook statistics
     * @param {string} webhookId - Webhook ID
     * @param {boolean} success - Whether delivery succeeded
     * @param {number} statusCode - HTTP status code
     * @returns {Promise<Object>} SQLite result
     */
    async updateWebhookStats(webhookId, success, statusCode = null) {
        if (!webhookId) throw new Error('Webhook ID required');
        
        if (success) {
            return this.db.run(
                `UPDATE webhooks 
                 SET last_triggered = CURRENT_TIMESTAMP, 
                     last_response = ?, 
                     failure_count = 0 
                 WHERE id = ?`,
                [statusCode || 200, webhookId]
            );
        } else {
            return this.db.run(
                `UPDATE webhooks 
                 SET failure_count = failure_count + 1 
                 WHERE id = ?`,
                [webhookId]
            );
        }
    }

    /**
     * Get webhook delivery history
     * @param {string} webhookId - Webhook ID
     * @param {number} limit - Number of records
     * @returns {Promise<Array>} Array of delivery logs
     */
    async getWebhookDeliveries(webhookId, limit = 20) {
        if (!webhookId) return [];
        
        return this.db.all(
            `SELECT * FROM webhook_deliveries 
             WHERE webhook_id = ? 
             ORDER BY created_at DESC LIMIT ?`,
            [webhookId, limit]
        );
    }

    /**
     * Get failed webhooks that need retry
     * @returns {Promise<Array>} Array of failed webhooks
     */
    async getFailedWebhooks() {
        return this.db.all(
            `SELECT * FROM webhooks 
             WHERE session_id = ? AND enabled = 1 AND failure_count > 0`,
            [this.sessionId]
        );
    }

    // ==================== BACKUPS METHODS ====================

    /**
     * Create backup record
     * @param {Object} data - Backup data
     * @returns {Promise<Object>} SQLite result
     */
    async createBackupRecord(data) {
        if (!data.path) throw new Error('Backup path required');
        
        const id = `backup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        
        return this.upsert('backups', {
            id,
            session_id: this.sessionId,
            type: data.type || 'manual',
            path: data.path,
            size: data.size,
            includes_media: data.includes_media ? 1 : 0,
            status: data.status || 'in_progress',
            metadata: data.metadata ? JSON.stringify(data.metadata) : null
        }, ['id']);
    }

    /**
     * Update backup status
     * @param {string} id - Backup ID
     * @param {string} status - New status
     * @param {string} error - Error message if failed
     * @returns {Promise<Object>} SQLite result
     */
    async updateBackupStatus(id, status, error = null) {
        if (!id) throw new Error('Backup ID required');
        
        const updates = { status };
        if (status === 'completed') {
            updates.completed_at = new Date().toISOString();
        }
        if (error) {
            updates.error = error;
        }
        
        return this.upsert('backups', { id, ...updates }, ['id']);
    }

    /**
     * Get session backups
     * @param {number} limit - Number of backups
     * @returns {Promise<Array>} Array of backups
     */
    async getSessionBackups(limit = 10) {
        return this.db.all(
            `SELECT * FROM backups 
             WHERE session_id = ? 
             ORDER BY created_at DESC LIMIT ?`,
            [this.sessionId, limit]
        );
    }

    /**
     * Get latest backup
     * @returns {Promise<Object|null>} Latest backup or null
     */
    async getLatestBackup() {
        return this.db.get(
            `SELECT * FROM backups 
             WHERE session_id = ? 
             ORDER BY created_at DESC LIMIT 1`,
            [this.sessionId]
        );
    }

    // ==================== ACTIVITY LOGS ====================

    /**
     * Log user activity
     * @param {Object} data - Activity data
     * @returns {Promise<Object>} SQLite result
     */
    async logActivity(data) {
        if (!data.user_id || !data.action) {
            throw new Error('User ID and action required');
        }
        
        const id = `log_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        
        return this.upsert('activity_logs', {
            id,
            session_id: data.session_id || this.sessionId,
            user_id: data.user_id,
            action: data.action,
            resource: data.resource,
            details: data.details ? JSON.stringify(data.details) : null,
            ip: data.ip,
            user_agent: data.user_agent,
            status: data.status || 'success',
            error: data.error,
            duration: data.duration
        }, ['id']);
    }

    /**
     * Get user activity
     * @param {string} userId - User ID
     * @param {number} limit - Number of records
     * @param {number} offset - Offset for pagination
     * @returns {Promise<Array>} Array of activity logs
     */
    async getUserActivity(userId, limit = 50, offset = 0) {
        if (!userId) return [];
        
        return this.db.all(
            `SELECT * FROM activity_logs 
             WHERE user_id = ? 
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [userId, limit, offset]
        );
    }

    /**
     * Get session activity
     * @param {number} limit - Number of records
     * @returns {Promise<Array>} Array of activity logs
     */
    async getSessionActivity(limit = 50) {
        if (!this.sessionId) return [];
        
        return this.db.all(
            `SELECT * FROM activity_logs 
             WHERE session_id = ? 
             ORDER BY created_at DESC LIMIT ?`,
            [this.sessionId, limit]
        );
    }

    // ==================== SESSION SETTINGS ====================

    /**
     * Set session setting
     * @param {string} name - Setting name
     * @param {any} value - Setting value
     * @returns {Promise<Object>} SQLite result
     */
    async setSessionSetting(name, value) {
        if (!name) throw new Error('Setting name required');
        
        return this.upsert('session_meta', {
            session_id: this.sessionId, 
            key: `setting_${name}`, 
            value: JSON.stringify(value)
        }, ['session_id', 'key']);
    }

    /**
     * Get session setting
     * @param {string} name - Setting name
     * @returns {Promise<any>} Setting value or null
     */
    async getSessionSetting(name) {
        if (!name) return null;
        
        const result = await this.get('session_meta', 
            ['session_id', 'key'], 
            [this.sessionId, `setting_${name}`]
        );
        
        if (!result) return null;
        
        try {
            return JSON.parse(result.value);
        } catch {
            return result.value;
        }
    }

    /**
     * Get all session settings
     * @returns {Promise<Object>} Key-value object of settings
     */
    async getAllSessionSettings() {
        const rows = await this.db.all(
            `SELECT key, value FROM session_meta 
             WHERE session_id = ? AND key LIKE 'setting_%'`,
            [this.sessionId]
        );
        
        return rows.reduce((acc, row) => {
            const name = row.key.replace('setting_', '');
            try {
                acc[name] = JSON.parse(row.value);
            } catch {
                acc[name] = row.value;
            }
            return acc;
        }, {});
    }

    // ==================== SYNC STATE ====================

    /**
     * Set sync state
     * @param {string} type - Sync type (history, contacts, etc)
     * @param {Object} data - Sync data
     * @returns {Promise<Object>} SQLite result
     */
    async setSync(type, data) {
        if (!type) throw new Error('Sync type required');
        
        const key = `sync_${type}`;
        const existing = await this.get('session_meta', 
            ['session_id', 'key'], 
            [this.sessionId, key],
            false
        );
        
        const value = JSON.stringify({
            ...(existing?.value ? JSON.parse(existing.value) : {}),
            ...data,
            updated_at: new Date().toISOString()
        });
        
        return this.upsert('session_meta', {
            session_id: this.sessionId, 
            key, 
            value
        }, ['session_id', 'key']);
    }

    /**
     * Get sync state
     * @param {string} type - Sync type
     * @returns {Promise<Object|null>} Sync state or null
     */
    async getSync(type) {
        if (!type) return null;
        
        const result = await this.get('session_meta', 
            ['session_id', 'key'], 
            [this.sessionId, `sync_${type}`]
        );
        
        if (!result) return null;
        
        try {
            return JSON.parse(result.value);
        } catch {
            return null;
        }
    }

    // ==================== TRANSACTIONS ====================

    /**
     * Begin database transaction
     * @returns {Promise<Object>} Transaction object with commit/rollback
     */
    async beginTx() {
        await this.db.exec('BEGIN IMMEDIATE');
        return {
            commit: async () => {
                await this.db.exec('COMMIT');
            },
            rollback: async () => {
                await this.db.exec('ROLLBACK');
            }
        };
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Get database file size
     * @returns {Promise<number>} Size in bytes
     */
    async getDbSize() {
        try {
            const stat = await fs.promises.stat(this.dbPath);
            return stat.size;
        } catch {
            return 0;
        }
    }

    /**
     * Optimize database
     * @returns {Promise<void>}
     */
    async optimize() {
        await this.db.exec('PRAGMA optimize');
        await this.db.exec('ANALYZE');
    }

    /**
     * Vacuum database
     * @returns {Promise<void>}
     */
    async vacuum() {
        await this.db.exec('VACUUM');
    }

    /**
     * Create database backup
     * @param {string} backupPath - Path for backup file
     * @returns {Promise<Object>} Backup info
     */
    async backup(backupPath) {
        const dir = path.dirname(backupPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        await this.db.exec(`VACUUM INTO '${backupPath}'`);
        
        const stats = await fs.promises.stat(backupPath);
        return {
            path: backupPath,
            size: stats.size,
            created: stats.birthtime
        };
    }

    /**
     * Close database connection
     * @returns {Promise<void>}
     */
    async close() {
        if (this.isClosed) return;
        
        this.isClosed = true;
        this.cache.clear();
        
        // Clear all callbacks
        Object.keys(this.cbs).forEach(k => {
            this.cbs[k] = [];
        });
        
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
        
        this._emit('close', { sessionId: this.sessionId });
    }

    /**
     * Get store statistics
     * @returns {Object} Stats object
     */
    stats() {
        return {
            cacheSize: this.cache.cache.size,
            listeners: Object.fromEntries(
                Object.entries(this.cbs).map(([k, v]) => [k, v.length])
            ),
            uptime: process.uptime()
        };
    }

    /**
     * Perform health check
     * @returns {Promise<Object>} Health status
     */
    async healthCheck() {
        try {
            await this.db.get('SELECT 1');
            const size = await this.getDbSize();
            return {
                status: 'healthy',
                dbSize: size,
                sessionId: this.sessionId,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                sessionId: this.sessionId,
                timestamp: new Date().toISOString()
            };
        }
    }
}

module.exports = SQLiteStores;