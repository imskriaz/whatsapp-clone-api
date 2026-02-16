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

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        // Refresh item (move to end)
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.value;
    }

    set(key, value) {
        // Enforce size limit
        if (this.cache.size >= this.maxSize) {
            // Remove oldest (first item)
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, { value });
    }

    delete(key) {
        this.cache.delete(key);
    }

    deletePattern(pattern) {
        const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
        for (const key of this.cache.keys()) {
            if (regex.test(key)) {
                this.cache.delete(key);
            }
        }
    }

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
        // Prepared statements cache
        this.stmtCache = new Map();
    }

    // ==================== INIT ====================

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

        // ==================== META TABLES ====================

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS scheduled_msgs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                jid TEXT NOT NULL,
                text TEXT NOT NULL,
                schedule_at INTEGER NOT NULL,
                recurring TEXT DEFAULT 'none',
                status TEXT DEFAULT 'pending',
                media_path TEXT,
                media_type TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                sent_at DATETIME,
                error TEXT,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS auto_responder_rules (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                pattern TEXT NOT NULL,
                response TEXT NOT NULL,
                media_path TEXT,
                media_type TEXT,
                enabled BOOLEAN DEFAULT 1,
                priority INTEGER DEFAULT 0,
                chats TEXT,
                start_time INTEGER,
                end_time INTEGER,
                days TEXT,
                cooldown INTEGER DEFAULT 0,
                response_count INTEGER DEFAULT 0,
                last_triggered DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        `);

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

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS system_jobs (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                schedule TEXT,
                last_run DATETIME,
                next_run DATETIME,
                last_status TEXT,
                last_error TEXT,
                config TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_msgs(session_id, status, schedule_at)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_responder_session ON auto_responder_rules(session_id, enabled, priority)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_session ON webhooks(session_id, enabled)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_event ON webhooks(session_id, event)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id, created_at DESC)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_logs(session_id, created_at DESC)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_logs(action, created_at DESC)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_backups_session ON backups(session_id, created_at DESC)`);
        await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON system_jobs(status, next_run)`);
    }

    // ==================== CALLBACK SYSTEM ====================

    on(event, cb) {
        if (!this.cbs[event]) this.cbs[event] = [];
        this.cbs[event].push(cb);
        return () => {
            this.cbs[event] = this.cbs[event].filter(fn => fn !== cb);
        };
    }

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

    // ==================== GENERIC CRUD WITH EDGE CASES ====================

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

    // ==================== SPECIAL HANDLERS WITH EDGE CASES ====================

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

    _getText(msg) {
        if (msg?.conversation) return msg.conversation;
        if (msg?.extendedTextMessage?.text) return msg.extendedTextMessage.text;
        if (msg?.imageMessage?.caption) return msg.imageMessage.caption;
        if (msg?.videoMessage?.caption) return msg.videoMessage.caption;
        if (msg?.documentMessage?.caption) return msg.documentMessage.caption;
        return null;
    }

    _getCaption(msg) {
        return msg?.imageMessage?.caption || 
               msg?.videoMessage?.caption || 
               msg?.documentMessage?.caption || 
               null;
    }

    _getStatus(msg) {
        if (msg.status === 2) return 'sent';
        if (msg.status === 3) return 'delivered';
        if (msg.status === 4) return 'read';
        if (msg.status === 1) return 'pending';
        return 'unknown';
    }

    // ==================== USER METHODS ====================

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

    async getUserByUsername(username) {
        if (!username) return null;
        return this.get('users', ['username'], [username]);
    }

    async getUserByApiKey(apiKey) {
        if (!apiKey) return null;
        return this.db.get(`SELECT * FROM users WHERE api_key = ?`, [apiKey]);
    }

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

    async deleteUser(username) {
        if (!username) throw new Error('Username required');
        return this.db.run(`DELETE FROM users WHERE username = ?`, [username]);
    }

    async getAllUsers() {
        return this.db.all(
            `SELECT username, api_key, role, created_at FROM users ORDER BY created_at DESC`
        );
    }

    async setUserMeta(username, key, value) {
        if (!username || !key) throw new Error('Username and key required');
        return this.upsert('user_meta', { 
            username, 
            key, 
            value: value !== undefined ? String(value) : null 
        }, ['username', 'key']);
    }

    async getUserMeta(username, key) {
        if (!username || !key) return null;
        const r = await this.get('user_meta', ['username', 'key'], [username, key], false);
        return r?.value;
    }

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

    async deleteUserMeta(username, key) {
        if (!username || !key) throw new Error('Username and key required');
        return this.db.run(
            `DELETE FROM user_meta WHERE username = ? AND key = ?`, 
            [username, key]
        );
    }

    // ==================== SESSION METHODS ====================

    async createSession(id, data = {}) {
        if (!id) throw new Error('Session ID required');
        return this.upsert('sessions', { id, ...data }, ['id']);
    }

    async getSession(id) {
        if (!id) return null;
        return this.get('sessions', ['id'], [id]);
    }

    async updateSession(id, updates) {
        if (!id) throw new Error('Session ID required');
        
        const existing = await this.getSession(id);
        if (!existing) return null;
        
        // Don't allow updating id
        delete updates.id;
        
        return this.upsert('sessions', { id, ...existing, ...updates }, ['id']);
    }

    async deleteSession(id) {
        if (!id) throw new Error('Session ID required');
        return this.db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
    }

    async getAllSessions() {
        return this.db.all(
            `SELECT id, device_id, phone, platform, status, logged_in, last_seen, created_at 
             FROM sessions ORDER BY created_at DESC`
        );
    }

    async setSessionMeta(sessionId, key, value) {
        if (!sessionId || !key) throw new Error('Session ID and key required');
        return this.upsert('session_meta', { 
            session_id: sessionId, 
            key, 
            value: value !== undefined ? String(value) : null 
        }, ['session_id', 'key']);
    }

    async getSessionMeta(sessionId, key) {
        if (!sessionId || !key) return null;
        const r = await this.get('session_meta', ['session_id', 'key'], [sessionId, key], false);
        return r?.value;
    }

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

    async deleteSessionMeta(sessionId, key) {
        if (!sessionId || !key) throw new Error('Session ID and key required');
        return this.db.run(
            `DELETE FROM session_meta WHERE session_id = ? AND key = ?`, 
            [sessionId, key]
        );
    }

    // ==================== GLOBAL SETTINGS ====================

    async setGlobalSetting(key, value, description = '') {
        if (!key) throw new Error('Setting key required');
        return this.upsert('global_settings', { 
            key, 
            value: value !== undefined ? String(value) : null,
            description 
        }, ['key']);
    }

    async getGlobalSetting(key) {
        if (!key) return null;
        const r = await this.get('global_settings', ['key'], [key], false);
        return r?.value;
    }

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

    async deleteGlobalSetting(key) {
        if (!key) throw new Error('Setting key required');
        return this.db.run(`DELETE FROM global_settings WHERE key = ?`, [key]);
    }

    // ==================== USER-SESSION METHODS ====================

    async assignUserSession(username, sessionId, active = true) {
        if (!username || !sessionId) throw new Error('Username and session ID required');
        
        return this.upsert('user_sessions', {
            username, 
            session_id: sessionId, 
            active: active ? 1 : 0
        }, ['username', 'session_id']);
    }

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

    async getSessionUser(sessionId) {
        if (!sessionId) return null;
        
        return this.db.get(
            `SELECT u.* FROM users u 
             JOIN user_sessions us ON u.username = us.username 
             WHERE us.session_id = ?`,
            [sessionId]
        );
    }

    async deactivateUserSession(username, sessionId) {
        if (!username || !sessionId) throw new Error('Username and session ID required');
        
        return this.db.run(
            `UPDATE user_sessions SET active = 0, updated_at = CURRENT_TIMESTAMP 
             WHERE username = ? AND session_id = ?`,
            [username, sessionId]
        );
    }

    async activateUserSession(username, sessionId) {
        if (!username || !sessionId) throw new Error('Username and session ID required');
        
        return this.db.run(
            `UPDATE user_sessions SET active = 1, updated_at = CURRENT_TIMESTAMP 
             WHERE username = ? AND session_id = ?`,
            [username, sessionId]
        );
    }

    // ==================== CHAT METHODS ====================

    async upsertChat(data) {
        if (!data.jid) throw new Error('Chat JID required');
        
        const result = await this.upsert('chats', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'jid']);
        
        this._emit('chat', data);
        return result;
    }

    async getChat(jid) {
        if (!jid) return null;
        return this.get('chats', ['session_id', 'jid'], [this.sessionId, jid]);
    }

    async getAllChats(includeArchived = false) {
        const where = includeArchived ? '' : 'AND archived = 0';
        return this.all('chats', `ORDER BY last_msg_time DESC ${where}`);
    }

    async getUnreadCount() {
        const result = await this.db.get(
            `SELECT COUNT(*) as count FROM chats 
             WHERE session_id = ? AND unread > 0 AND deleted = 0`,
            [this.sessionId]
        );
        return result?.count || 0;
    }

    async markAllRead() {
        return this.db.run(
            `UPDATE chats SET unread = 0 WHERE session_id = ?`,
            [this.sessionId]
        );
    }

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

    async deleteChat(jid, soft = true) {
        if (!jid) throw new Error('Chat JID required');
        return this.del('chats', ['jid'], [jid], soft);
    }

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

    async upsertContact(data) {
        if (!data.jid) throw new Error('Contact JID required');
        
        return this.upsert('contacts', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'jid']);
    }

    async getContact(jid) {
        if (!jid) return null;
        return this.get('contacts', ['session_id', 'jid'], [this.sessionId, jid]);
    }

    async getAllContacts() {
        return this.all('contacts', 'ORDER BY name COLLATE NOCASE');
    }

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

    async isBlocked(jid) {
        if (!jid) return false;
        
        const result = await this.db.get(
            `SELECT 1 FROM blocklist WHERE session_id = ? AND jid = ?`, 
            [this.sessionId, jid]
        );
        return !!result;
    }

    // ==================== MESSAGE METHODS ====================

    async upsertMsg(data) {
        if (!data.id) throw new Error('Message ID required');
        
        return this.upsert('msgs', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'id']);
    }

    async getMsg(id) {
        if (!id) return null;
        return this.get('msgs', ['session_id', 'id'], [this.sessionId, id]);
    }

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

    async getStarredMsgs(limit = 50) {
        return this.db.all(
            `SELECT * FROM msgs 
             WHERE session_id = ? AND starred = 1 AND deleted = 0 
             ORDER BY ts DESC LIMIT ?`,
            [this.sessionId, limit]
        );
    }

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

    async updateMsgStatus(id, status) {
        if (!id) throw new Error('Message ID required');
        
        return this.db.run(
            `UPDATE msgs SET status = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND id = ?`,
            [status, this.sessionId, id]
        );
    }

    async starMsg(id, starred = true) {
        if (!id) throw new Error('Message ID required');
        
        return this.db.run(
            `UPDATE msgs SET starred = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND id = ?`,
            [starred ? 1 : 0, this.sessionId, id]
        );
    }

    async deleteMsg(id, soft = true) {
        if (!id) throw new Error('Message ID required');
        return this.del('msgs', ['id'], [id], soft);
    }

    async clearChatMsgs(chatJid) {
        if (!chatJid) throw new Error('Chat JID required');
        
        return this.db.run(
            `UPDATE msgs SET deleted = 1, deleted_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND chat = ?`,
            [this.sessionId, chatJid]
        );
    }

    // ==================== RECEIPTS METHODS ====================

    async addReceipt(data) {
        if (!data.msg_id || !data.participant || !data.type) {
            throw new Error('Message ID, participant and type required');
        }
        
        return this.upsert('receipts', {
            session_id: this.sessionId,
            ...data
        }, ['session_id', 'msg_id', 'participant', 'type']);
    }

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

    async upsertMedia(data) {
        if (!data.msg_id) throw new Error('Message ID required');
        
        return this.upsert('media', {
            session_id: this.sessionId,
            ...data
        }, ['session_id', 'msg_id']);
    }

    async getMedia(msgId) {
        if (!msgId) return null;
        return this.get('media', ['session_id', 'msg_id'], [this.sessionId, msgId]);
    }

    async markMediaDownloaded(msgId, url) {
        if (!msgId) throw new Error('Message ID required');
        
        return this.db.run(
            `UPDATE media SET downloaded = 1, url = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND msg_id = ?`,
            [url, this.sessionId, msgId]
        );
    }

    async markMediaFailed(msgId, error) {
        if (!msgId) throw new Error('Message ID required');
        
        return this.db.run(
            `UPDATE media SET dl_error = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE session_id = ? AND msg_id = ?`,
            [error, this.sessionId, msgId]
        );
    }

    // ==================== GROUP METHODS ====================

    async upsertGroup(data) {
        if (!data.jid) throw new Error('Group JID required');
        
        return this.upsert('groups', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'jid']);
    }

    async getGroup(jid) {
        if (!jid) return null;
        return this.get('groups', ['session_id', 'jid'], [this.sessionId, jid]);
    }

    async getAllGroups() {
        return this.all('groups', 'ORDER BY subject COLLATE NOCASE');
    }

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

    async getGroupMembers(jid) {
        if (!jid) return [];
        
        return this.db.all(
            `SELECT * FROM group_members 
             WHERE session_id = ? AND group_jid = ? AND active = 1 
             ORDER BY role, member`,
            [this.sessionId, jid]
        );
    }

    async getGroupAdmins(jid) {
        if (!jid) return [];
        
        return this.db.all(
            `SELECT * FROM group_members 
             WHERE session_id = ? AND group_jid = ? AND role = 'admin' AND active = 1`,
            [this.sessionId, jid]
        );
    }

    async getGroupMember(jid, member) {
        if (!jid || !member) return null;
        
        return this.db.get(
            `SELECT * FROM group_members 
             WHERE session_id = ? AND group_jid = ? AND member = ?`,
            [this.sessionId, jid, member]
        );
    }

    async upsertGroupMember(data) {
        if (!data.group_jid || !data.member) {
            throw new Error('Group JID and member required');
        }
        
        return this.upsert('group_members', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'group_jid', 'member']);
    }

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

    async upsertCall(data) {
        if (!data.id) throw new Error('Call ID required');
        
        return this.upsert('calls', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'id']);
    }

    async getCalls(limit = 50, offset = 0) {
        return this.db.all(
            `SELECT * FROM calls 
             WHERE session_id = ? 
             ORDER BY ts DESC LIMIT ? OFFSET ?`,
            [this.sessionId, limit, offset]
        );
    }

    async getMissedCalls(limit = 50) {
        return this.db.all(
            `SELECT * FROM calls 
             WHERE session_id = ? AND status = 'missed' 
             ORDER BY ts DESC LIMIT ?`,
            [this.sessionId, limit]
        );
    }

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

    async upsertLabel(data) {
        if (!data.id || !data.name) throw new Error('Label ID and name required');
        
        return this.upsert('labels', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'id']);
    }

    async getLabels() {
        return this.all('labels', 'AND deleted = 0 ORDER BY name');
    }

    async getLabel(id) {
        if (!id) return null;
        return this.get('labels', ['session_id', 'id'], [this.sessionId, id]);
    }

    async deleteLabel(id, soft = true) {
        if (!id) throw new Error('Label ID required');
        return this.del('labels', ['id'], [id], soft);
    }

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

    async upsertNewsletter(data) {
        if (!data.id) throw new Error('Newsletter ID required');
        
        return this.upsert('newsletters', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'id']);
    }

    async getNewsletters() {
        return this.all('newsletters', 'ORDER BY name');
    }

    async getNewsletter(id) {
        if (!id) return null;
        return this.get('newsletters', ['session_id', 'id'], [this.sessionId, id]);
    }

    async upsertNewsletterPost(data) {
        if (!data.nid || !data.pid) throw new Error('Newsletter ID and post ID required');
        
        return this.upsert('newsletter_posts', { 
            session_id: this.sessionId, 
            ...data 
        }, ['session_id', 'nid', 'pid']);
    }

    async getNewsletterPosts(nid, limit = 50) {
        if (!nid) return [];
        
        return this.db.all(
            `SELECT * FROM newsletter_posts 
             WHERE session_id = ? AND nid = ? 
             ORDER BY posted_ts DESC LIMIT ?`,
            [this.sessionId, nid, limit]
        );
    }

    async incrementNewsletterPostViews(nid, pid) {
        if (!nid || !pid) throw new Error('Newsletter ID and post ID required');
        
        return this.db.run(
            `UPDATE newsletter_posts SET views = views + 1 
             WHERE session_id = ? AND nid = ? AND pid = ?`,
            [this.sessionId, nid, pid]
        );
    }

    // ==================== SCHEDULED MESSAGES ====================

    async createScheduledMsg(data) {
        if (!data.jid || !data.text || !data.schedule_at) {
            throw new Error('JID, text and schedule_at required');
        }
        
        const id = `sched_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        
        return this.upsert('scheduled_msgs', {
            id,
            session_id: this.sessionId,
            jid: data.jid,
            text: data.text,
            schedule_at: data.schedule_at,
            recurring: data.recurring || 'none',
            media_path: data.media_path,
            media_type: data.media_type,
            status: 'pending'
        }, ['id']);
    }

    async getPendingScheduledMsgs() {
        const now = Date.now();
        
        return this.db.all(
            `SELECT * FROM scheduled_msgs 
             WHERE session_id = ? AND status = 'pending' AND schedule_at <= ? 
             ORDER BY schedule_at ASC`,
            [this.sessionId, now]
        );
    }

    async getScheduledMsgs() {
        return this.db.all(
            `SELECT * FROM scheduled_msgs 
             WHERE session_id = ? 
             ORDER BY schedule_at ASC`,
            [this.sessionId]
        );
    }

    async updateScheduledMsgStatus(id, status, error = null) {
        if (!id) throw new Error('Schedule ID required');
        
        const updates = { status };
        if (status === 'sent') {
            updates.sent_at = new Date().toISOString();
        }
        if (error) {
            updates.error = error;
        }
        
        return this.upsert('scheduled_msgs', { id, ...updates }, ['id']);
    }

    async deleteScheduledMsg(id) {
        if (!id) throw new Error('Schedule ID required');
        
        return this.db.run(
            `DELETE FROM scheduled_msgs WHERE id = ? AND session_id = ?`, 
            [id, this.sessionId]
        );
    }

    // ==================== AUTO-RESPONDER RULES ====================

    async createAutoResponderRule(data) {
        if (!data.name || !data.pattern || !data.response) {
            throw new Error('Name, pattern and response required');
        }
        
        const id = `rule_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        
        return this.upsert('auto_responder_rules', {
            id,
            session_id: this.sessionId,
            name: data.name,
            pattern: data.pattern,
            response: data.response,
            media_path: data.media_path,
            media_type: data.media_type,
            enabled: data.enabled !== undefined ? data.enabled : 1,
            priority: data.priority || 0,
            chats: data.chats ? JSON.stringify(data.chats) : null,
            start_time: data.start_time,
            end_time: data.end_time,
            days: data.days ? JSON.stringify(data.days) : null,
            cooldown: data.cooldown || 0
        }, ['id']);
    }

    async getAutoResponderRules(enabled = true) {
        const enabledVal = enabled ? 1 : 0;
        
        return this.db.all(
            `SELECT * FROM auto_responder_rules 
             WHERE session_id = ? AND enabled = ? 
             ORDER BY priority DESC, created_at ASC`,
            [this.sessionId, enabledVal]
        );
    }

    async getAutoResponderRule(id) {
        if (!id) return null;
        return this.get('auto_responder_rules', ['session_id', 'id'], [this.sessionId, id]);
    }

    async updateAutoResponderRule(id, updates) {
        if (!id) throw new Error('Rule ID required');
        
        const rule = await this.getAutoResponderRule(id);
        if (!rule) return null;
        
        // Parse JSON fields if they exist in updates
        if (updates.chats && typeof updates.chats !== 'string') {
            updates.chats = JSON.stringify(updates.chats);
        }
        if (updates.days && typeof updates.days !== 'string') {
            updates.days = JSON.stringify(updates.days);
        }
        
        return this.upsert('auto_responder_rules', { 
            id, 
            ...rule, 
            ...updates 
        }, ['id']);
    }

    async deleteAutoResponderRule(id) {
        if (!id) throw new Error('Rule ID required');
        
        return this.db.run(
            `DELETE FROM auto_responder_rules WHERE id = ? AND session_id = ?`, 
            [id, this.sessionId]
        );
    }

    async incrementRuleResponseCount(id) {
        if (!id) throw new Error('Rule ID required');
        
        return this.db.run(
            `UPDATE auto_responder_rules 
             SET response_count = response_count + 1, last_triggered = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [id]
        );
    }

    async findMatchingRule(chatJid, text) {
        if (!chatJid || !text) return null;
        
        const rules = await this.getAutoResponderRules(true);
        
        // Check time and day constraints
        const now = new Date();
        const currentHour = now.getHours() * 60 + now.getMinutes();
        const currentDay = now.getDay(); // 0-6, 0=Sunday
        
        for (const rule of rules) {
            // Check time range
            if (rule.start_time && rule.end_time) {
                if (currentHour < rule.start_time || currentHour > rule.end_time) {
                    continue;
                }
            }
            
            // Check days
            if (rule.days) {
                const days = JSON.parse(rule.days);
                if (days.length > 0 && !days.includes(currentDay)) {
                    continue;
                }
            }
            
            // Check specific chats
            if (rule.chats) {
                const chats = JSON.parse(rule.chats);
                if (chats.length > 0 && !chats.includes(chatJid)) {
                    continue;
                }
            }
            
            // Test pattern
            try {
                const regex = new RegExp(rule.pattern, 'i');
                if (regex.test(text)) {
                    return rule;
                }
            } catch (e) {
                // Invalid regex, skip
                continue;
            }
        }
        
        return null;
    }

    // ==================== WEBHOOKS ====================

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

    async getWebhookByEvent(event) {
        if (!event) return null;
        return this.get('webhooks', ['session_id', 'event'], [this.sessionId, event]);
    }

    async getAllWebhooks() {
        return this.all('webhooks', 'ORDER BY event');
    }

    async updateWebhook(id, updates) {
        if (!id) throw new Error('Webhook ID required');
        
        const webhook = await this.get('webhooks', ['session_id', 'id'], [this.sessionId, id]);
        if (!webhook) return null;
        
        if (updates.headers && typeof updates.headers !== 'string') {
            updates.headers = JSON.stringify(updates.headers);
        }
        
        return this.upsert('webhooks', { id, ...webhook, ...updates }, ['id']);
    }

    async deleteWebhook(id) {
        if (!id) throw new Error('Webhook ID required');
        
        return this.db.run(
            `DELETE FROM webhooks WHERE id = ? AND session_id = ?`, 
            [id, this.sessionId]
        );
    }

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

    async getWebhookDeliveries(webhookId, limit = 20) {
        if (!webhookId) return [];
        
        return this.db.all(
            `SELECT * FROM webhook_deliveries 
             WHERE webhook_id = ? 
             ORDER BY created_at DESC LIMIT ?`,
            [webhookId, limit]
        );
    }

    async getFailedWebhooks() {
        return this.db.all(
            `SELECT * FROM webhooks 
             WHERE session_id = ? AND enabled = 1 AND failure_count > 0`,
            [this.sessionId]
        );
    }

    // ==================== BACKUPS ====================

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

    async getSessionBackups(limit = 10) {
        return this.db.all(
            `SELECT * FROM backups 
             WHERE session_id = ? 
             ORDER BY created_at DESC LIMIT ?`,
            [this.sessionId, limit]
        );
    }

    async getLatestBackup() {
        return this.db.get(
            `SELECT * FROM backups 
             WHERE session_id = ? 
             ORDER BY created_at DESC LIMIT 1`,
            [this.sessionId]
        );
    }

    async deleteOldBackups(keepCount = 5) {
        const backups = await this.db.all(
            `SELECT id FROM backups 
             WHERE session_id = ? 
             ORDER BY created_at DESC 
             LIMIT -1 OFFSET ?`,
            [this.sessionId, keepCount]
        );
        
        for (const backup of backups) {
            await this.db.run(
                `DELETE FROM backups WHERE id = ?`,
                [backup.id]
            );
            
            // Also delete file if exists
            try {
                const record = await this.get('backups', ['id'], [backup.id]);
                if (record && record.path && fs.existsSync(record.path)) {
                    fs.unlinkSync(record.path);
                }
            } catch (e) {
                // Ignore file deletion errors
            }
        }
        
        return backups.length;
    }

    // ==================== ACTIVITY LOGS ====================

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

    async getUserActivity(userId, limit = 50, offset = 0) {
        if (!userId) return [];
        
        return this.db.all(
            `SELECT * FROM activity_logs 
             WHERE user_id = ? 
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [userId, limit, offset]
        );
    }

    async getSessionActivity(limit = 50) {
        if (!this.sessionId) return [];
        
        return this.db.all(
            `SELECT * FROM activity_logs 
             WHERE session_id = ? 
             ORDER BY created_at DESC LIMIT ?`,
            [this.sessionId, limit]
        );
    }

    async getActivityByAction(action, limit = 50) {
        if (!action) return [];
        
        return this.db.all(
            `SELECT * FROM activity_logs 
             WHERE action = ? 
             ORDER BY created_at DESC LIMIT ?`,
            [action, limit]
        );
    }

    // ==================== SYSTEM JOBS ====================

    async createSystemJob(data) {
        if (!data.type) throw new Error('Job type required');
        
        const id = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        
        return this.upsert('system_jobs', {
            id,
            type: data.type,
            schedule: data.schedule,
            config: data.config ? JSON.stringify(data.config) : null,
            status: 'pending'
        }, ['id']);
    }

    async updateJobStatus(id, status, error = null) {
        if (!id) throw new Error('Job ID required');
        
        const updates = { status };
        if (status === 'running') {
            updates.last_run = new Date().toISOString();
        }
        if (error) {
            updates.last_error = error;
        }
        updates.last_status = status;
        
        // Calculate next run if schedule exists
        if (status === 'completed') {
            const job = await this.get('system_jobs', ['id'], [id], false);
            if (job?.schedule) {
                updates.next_run = this._calculateNextRun(job.schedule);
            }
        }
        
        return this.upsert('system_jobs', { id, ...updates }, ['id']);
    }

    _calculateNextRun(schedule) {
        if (!schedule) return null;
        
        // Simple parser for cron expressions
        // In production, use a proper cron parser library
        const now = new Date();
        const next = new Date(now);
        
        if (schedule.includes('* * * * *')) {
            // Every minute
            next.setMinutes(now.getMinutes() + 1);
        } else if (schedule.includes('0 * * * *')) {
            // Every hour
            next.setHours(now.getHours() + 1);
            next.setMinutes(0);
        } else if (schedule.includes('0 0 * * *')) {
            // Daily at midnight
            next.setDate(now.getDate() + 1);
            next.setHours(0, 0, 0, 0);
        } else {
            // Default to 1 hour
            next.setHours(now.getHours() + 1);
        }
        
        return next.toISOString();
    }

    async getPendingJobs() {
        return this.db.all(
            `SELECT * FROM system_jobs 
             WHERE (status = 'pending' OR status = 'failed')
             AND (next_run IS NULL OR next_run <= CURRENT_TIMESTAMP)
             ORDER BY created_at ASC`
        );
    }

    async getAllJobs() {
        return this.db.all(`SELECT * FROM system_jobs ORDER BY created_at DESC`);
    }

    // ==================== SESSION SETTINGS ====================

    async setSessionSetting(name, value) {
        if (!name) throw new Error('Setting name required');
        
        return this.upsert('session_meta', {
            session_id: this.sessionId, 
            key: `setting_${name}`, 
            value: JSON.stringify(value)
        }, ['session_id', 'key']);
    }

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

    async deleteSessionSetting(name) {
        if (!name) throw new Error('Setting name required');
        
        return this.db.run(
            `DELETE FROM session_meta 
             WHERE session_id = ? AND key = ?`,
            [this.sessionId, `setting_${name}`]
        );
    }

    // ==================== SYNC STATE ====================

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

    async getDbSize() {
        try {
            const stat = await fs.promises.stat(this.dbPath);
            return stat.size;
        } catch {
            return 0;
        }
    }

    async optimize() {
        await this.db.exec('PRAGMA optimize');
        await this.db.exec('ANALYZE');
    }

    async vacuum() {
        await this.db.exec('VACUUM');
    }

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

    async close() {
        if (this.isClosed) return;
        
        this.isClosed = true;
        this.cache.clear();
        
        // Clear all callbacks
        Object.keys(this.cbs).forEach(k => {
            this.cbs[k] = [];
        });
        
        // Clear statement cache
        this.stmtCache.clear();
        
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
        
        this._emit('close', { sessionId: this.sessionId });
    }

    stats() {
        return {
            cacheSize: this.cache.cache.size,
            listeners: Object.fromEntries(
                Object.entries(this.cbs).map(([k, v]) => [k, v.length])
            ),
            uptime: process.uptime()
        };
    }

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