// src/services/backup.js
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { ensureDir, formatBytes } = require('../utils/helpers');

class BackupService {
    constructor(store, config) {
        this.store = store;
        this.config = config;
        this.isRunning = false;
        this.schedule = null;
        this.stats = {
            totalBackups: 0,
            totalSize: 0,
            lastBackup: null,
            lastStatus: null
        };
    }

    /**
     * Start backup service
     */
    async start() {
        if (this.isRunning) return;

        logger.info('Backup service starting...');

        // Ensure backup directory exists
        const backupDir = process.env.BACKUP_PATH || './data/backups';
        ensureDir(backupDir);

        // Schedule backups
        if (this.config.backupSchedule) {
            this.schedule = cron.schedule(this.config.backupSchedule, () => {
                this.runBackup('scheduled').catch(error => {
                    logger.error('Scheduled backup failed', error);
                });
            });
            logger.info(`Backups scheduled: ${this.config.backupSchedule}`);
        }

        this.isRunning = true;
        logger.info('Backup service started');
    }

    /**
     * Stop backup service
     */
    async stop() {
        if (!this.isRunning) return;

        logger.info('Backup service stopping...');

        if (this.schedule) {
            this.schedule.stop();
            this.schedule = null;
        }

        this.isRunning = false;
        logger.info('Backup service stopped');
    }

    /**
     * Run backup
     * @param {string} type - Backup type (manual/scheduled)
     */
    async runBackup(type = 'manual') {
        const startTime = Date.now();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = process.env.BACKUP_PATH || './data/backups';
        const backupPath = path.join(backupDir, `backup-${timestamp}.db`);

        logger.info(`Starting ${type} backup...`);

        try {
            // Create backup record
            const record = await this.store.createBackupRecord({
                type,
                path: backupPath,
                status: 'in_progress',
                includes_media: false
            });

            // Perform backup
            const backup = await this.store.backup(backupPath);

            // Update record
            await this.store.updateBackupStatus(record.id, 'completed');

            // Update stats
            this.stats.totalBackups++;
            this.stats.totalSize += backup.size;
            this.stats.lastBackup = new Date().toISOString();
            this.stats.lastStatus = 'success';

            logger.info(`✅ Backup completed: ${backup.path} (${formatBytes(backup.size)})`);

            // Clean old backups (keep last 5)
            await this.cleanOldBackups(5);

            return backup;

        } catch (error) {
            this.stats.lastStatus = 'failed';
            logger.error('❌ Backup failed', error);

            // Update record if exists
            if (record) {
                await this.store.updateBackupStatus(record.id, 'failed', error.message);
            }

            throw error;
        }
    }

    /**
     * Clean old backups
     * @param {number} keepCount - Number of backups to keep
     */
    async cleanOldBackups(keepCount = 5) {
        try {
            const backups = await this.store.all('backups', 
                'ORDER BY created_at DESC'
            );

            if (backups.length <= keepCount) return;

            const toDelete = backups.slice(keepCount);

            for (const backup of toDelete) {
                try {
                    // Delete file
                    if (fs.existsSync(backup.path)) {
                        fs.unlinkSync(backup.path);
                    }

                    // Delete record
                    await this.store.db.run(
                        'DELETE FROM backups WHERE id = ?',
                        [backup.id]
                    );

                    logger.debug(`Deleted old backup: ${backup.path}`);
                } catch (error) {
                    logger.error(`Failed to delete backup ${backup.id}`, error);
                }
            }

        } catch (error) {
            logger.error('Failed to clean old backups', error);
        }
    }

    /**
     * Get backup list
     * @param {number} limit - Number of backups
     * @returns {Promise<Array>} Backups
     */
    async getBackups(limit = 10) {
        return this.store.all('backups', 
            'ORDER BY created_at DESC LIMIT ?',
            [limit]
        );
    }

    /**
     * Restore from backup
     * @param {string} backupId - Backup ID
     * @returns {Promise<boolean>} Success
     */
    async restore(backupId) {
        const backup = await this.store.get('backups', ['id'], [backupId]);
        if (!backup) {
            throw new Error('Backup not found');
        }

        if (!fs.existsSync(backup.path)) {
            throw new Error('Backup file not found');
        }

        logger.info(`Restoring from backup: ${backup.path}`);

        try {
            // Close current connection
            await this.store.close();

            // Copy backup to main DB
            const mainDb = process.env.DB_PATH || './data/db.db';
            fs.copyFileSync(backup.path, mainDb);

            // Reopen connection
            await this.store.init();

            logger.info('✅ Restore completed');
            return true;

        } catch (error) {
            logger.error('❌ Restore failed', error);
            throw error;
        }
    }

    /**
     * Get service status
     * @returns {Object} Status
     */
    getStatus() {
        return {
            running: this.isRunning,
            schedule: this.config.backupSchedule,
            ...this.stats
        };
    }
}

module.exports = BackupService;