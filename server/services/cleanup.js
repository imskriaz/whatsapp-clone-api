// src/services/cleanup.js
const logger = require('../utils/logger');
const { formatDuration } = require('../utils/helpers');

class CleanupService {
    constructor(manager, store, config) {
        this.manager = manager;
        this.store = store;
        this.config = config;
        this.isRunning = false;
        this.interval = null;
        this.stats = {
            sessionsCleaned: 0,
            messagesCleaned: 0,
            mediaCleaned: 0,
            logsCleaned: 0,
            lastRun: null
        };
    }

    /**
     * Start cleanup service
     */
    async start() {
        if (this.isRunning) return;

        logger.info('Cleanup service starting...');

        // Run cleanup every 5 minutes by default
        const interval = this.config.cleanupInterval || 300000;
        
        this.interval = setInterval(() => {
            this.runCleanup().catch(error => {
                logger.error('Cleanup failed', error);
            });
        }, interval);

        this.isRunning = true;
        logger.info(`Cleanup service started (interval: ${formatDuration(interval)})`);
    }

    /**
     * Stop cleanup service
     */
    async stop() {
        if (!this.isRunning) return;

        logger.info('Cleanup service stopping...');

        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }

        this.isRunning = false;
        logger.info('Cleanup service stopped');
    }

    /**
     * Run cleanup tasks
     */
    async runCleanup() {
        const startTime = Date.now();
        logger.debug('Starting cleanup...');

        try {
            await this.cleanupSessions();
            await this.cleanupMessages();
            await this.cleanupMedia();
            await this.cleanupLogs();
            await this.vacuumDatabase();

            this.stats.lastRun = new Date().toISOString();
            const duration = Date.now() - startTime;

            logger.info(`✅ Cleanup completed in ${duration}ms`, this.stats);

        } catch (error) {
            logger.error('❌ Cleanup failed', error);
        }
    }

    /**
     * Cleanup inactive sessions
     */
    async cleanupSessions() {
        const sessions = this.manager.getAll();
        let cleaned = 0;

        for (const session of sessions) {
            const lastActivity = session.lastActivity || 0;
            const inactive = Date.now() - lastActivity;

            if (inactive > this.config.sessionTimeout && session.state !== 'open') {
                await this.manager.remove(session.sid, 'cleanup');
                cleaned++;
            }
        }

        this.stats.sessionsCleaned += cleaned;
        if (cleaned > 0) {
            logger.info(`Cleaned ${cleaned} inactive sessions`);
        }
    }

    /**
     * Cleanup old messages
     */
    async cleanupMessages() {
        // Keep messages for 30 days by default
        const keepDays = 30;
        const cutoff = Date.now() - (keepDays * 24 * 60 * 60 * 1000);

        const result = await this.store.db.run(
            `UPDATE msgs SET deleted = 1, deleted_at = CURRENT_TIMESTAMP 
             WHERE ts < ? AND starred = 0 AND deleted = 0`,
            [cutoff]
        );

        this.stats.messagesCleaned += result.changes || 0;
        if (result.changes > 0) {
            logger.info(`Cleaned ${result.changes} old messages`);
        }
    }

    /**
     * Cleanup orphaned media files
     */
    async cleanupMedia() {
        const mediaDir = process.env.MEDIA_PATH || './data/media';
        
        try {
            // Find media records without corresponding messages
            const orphaned = await this.store.db.all(`
                SELECT m.* FROM media m
                LEFT JOIN msgs msg ON m.msg_id = msg.id AND m.session_id = msg.session_id
                WHERE msg.id IS NULL OR msg.deleted = 1
            `);

            let cleaned = 0;
            for (const media of orphaned) {
                try {
                    // Delete file
                    if (media.url && require('fs').existsSync(media.url)) {
                        require('fs').unlinkSync(media.url);
                    }

                    // Delete record
                    await this.store.db.run(
                        'DELETE FROM media WHERE session_id = ? AND msg_id = ?',
                        [media.session_id, media.msg_id]
                    );

                    cleaned++;
                } catch (error) {
                    logger.error('Failed to delete orphaned media', error);
                }
            }

            this.stats.mediaCleaned += cleaned;
            if (cleaned > 0) {
                logger.info(`Cleaned ${cleaned} orphaned media files`);
            }

        } catch (error) {
            logger.error('Failed to cleanup media', error);
        }
    }

    /**
     * Cleanup old activity logs
     */
    async cleanupLogs() {
        // Keep logs for 90 days
        const keepDays = 90;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - keepDays);

        const result = await this.store.db.run(
            `DELETE FROM activity_logs WHERE created_at < ?`,
            [cutoff.toISOString()]
        );

        this.stats.logsCleaned += result.changes || 0;
        if (result.changes > 0) {
            logger.info(`Cleaned ${result.changes} old activity logs`);
        }
    }

    /**
     * Vacuum database to reclaim space
     */
    async vacuumDatabase() {
        // Run vacuum weekly
        const lastVacuum = await this.store.getGlobalSetting('last_vacuum');
        const now = Date.now();

        if (lastVacuum && now - parseInt(lastVacuum) < 7 * 24 * 60 * 60 * 1000) {
            return;
        }

        logger.info('Running database vacuum...');
        const startSize = await this.store.getDbSize();

        await this.store.vacuum();

        const endSize = await this.store.getDbSize();
        const saved = startSize - endSize;

        await this.store.setGlobalSetting('last_vacuum', now.toString());

        if (saved > 0) {
            logger.info(`✅ Vacuum completed: saved ${require('../utils/helpers').formatBytes(saved)}`);
        }
    }

    /**
     * Get service status
     * @returns {Object} Status
     */
    getStatus() {
        return {
            running: this.isRunning,
            interval: this.config.cleanupInterval,
            ...this.stats
        };
    }
}

module.exports = CleanupService;