// src/services/stats.js
const cron = require('node-cron');
const os = require('os');
const logger = require('../utils/logger');
const { formatBytes } = require('../utils/helpers');

class StatsService {
    constructor(manager, store, config) {
        this.manager = manager;
        this.store = store;
        this.config = config;
        this.isRunning = false;
        this.schedule = null;
        this.stats = {
            startTime: Date.now(),
            samples: [],
            current: {}
        };
    }

    /**
     * Start stats service
     */
    async start() {
        if (this.isRunning) return;

        logger.info('Stats service starting...');

        // Collect stats every 5 minutes by default
        this.schedule = cron.schedule('*/5 * * * *', () => {
            this.collectStats().catch(error => {
                logger.error('Stats collection failed', error);
            });
        });

        // Collect initial stats
        await this.collectStats();

        this.isRunning = true;
        logger.info('Stats service started');
    }

    /**
     * Stop stats service
     */
    async stop() {
        if (!this.isRunning) return;

        logger.info('Stats service stopping...');

        if (this.schedule) {
            this.schedule.stop();
            this.schedule = null;
        }

        this.isRunning = false;
        logger.info('Stats service stopped');
    }

    /**
     * Collect system statistics
     */
    async collectStats() {
        try {
            const timestamp = new Date().toISOString();

            // System stats
            const system = {
                cpu: os.loadavg(),
                memory: {
                    total: os.totalmem(),
                    free: os.freemem(),
                    used: os.totalmem() - os.freemem(),
                    usagePercent: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100
                },
                uptime: os.uptime(),
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                cpus: os.cpus().length
            };

            // Application stats
            const app = {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                pid: process.pid,
                version: process.env.npm_package_version || '1.0.0',
                nodeVersion: process.version
            };

            // Database stats
            const dbSize = await this.store.getDbSize();
            const db = {
                size: dbSize,
                sizeFormatted: formatBytes(dbSize),
                sessions: (await this.store.all('sessions')).length,
                users: (await this.store.all('users')).length,
                chats: (await this.store.all('chats')).length,
                messages: (await this.store.all('msgs')).length,
                media: (await this.store.all('media')).length
            };

            // Session manager stats
            const manager = this.manager.getStats();

            const stats = {
                timestamp,
                system,
                app,
                db,
                manager,
                services: this.getServiceStatus()
            };

            // Store in memory (keep last 100 samples)
            this.stats.samples.push(stats);
            if (this.stats.samples.length > 100) {
                this.stats.samples.shift();
            }

            this.stats.current = stats;

            logger.debug('Stats collected', {
                dbSize: db.sizeFormatted,
                sessions: db.sessions,
                users: db.users
            });

        } catch (error) {
            logger.error('Failed to collect stats', error);
        }
    }

    /**
     * Get service status from other services
     * @returns {Object} Service status
     */
    getServiceStatus() {
        // This would ideally come from service manager
        return {
            webhook: { running: true },
            backup: { running: true },
            cleanup: { running: true }
        };
    }

    /**
     * Get current stats
     * @returns {Object} Current stats
     */
    getCurrentStats() {
        return this.stats.current;
    }

    /**
     * Get stats history
     * @param {number} limit - Number of samples
     * @returns {Array} Stats samples
     */
    getStatsHistory(limit = 10) {
        return this.stats.samples.slice(-limit);
    }

    /**
     * Get service status
     * @returns {Object} Status
     */
    getStatus() {
        return {
            running: this.isRunning,
            samples: this.stats.samples.length,
            lastUpdate: this.stats.current?.timestamp
        };
    }

    /**
     * Generate health report
     * @returns {Promise<Object>} Health report
     */
    async getHealthReport() {
        const dbHealth = await this.store.healthCheck();
        const managerHealth = await this.manager.healthCheck();

        const issues = [];

        if (dbHealth.status !== 'healthy') {
            issues.push('Database unhealthy');
        }

        if (managerHealth.status !== 'healthy') {
            issues.push('Session manager unhealthy');
        }

        const memoryUsage = process.memoryUsage();
        const memoryPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

        if (memoryPercent > 90) {
            issues.push('High memory usage');
        }

        const cpuLoad = os.loadavg()[0];
        const cpuCount = os.cpus().length;

        if (cpuLoad > cpuCount * 0.8) {
            issues.push('High CPU load');
        }

        return {
            status: issues.length === 0 ? 'healthy' : 'degraded',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            issues,
            db: dbHealth,
            manager: managerHealth,
            memory: {
                used: memoryUsage.heapUsed,
                total: memoryUsage.heapTotal,
                percent: memoryPercent.toFixed(2)
            },
            cpu: {
                load: cpuLoad,
                cores: cpuCount,
                percent: ((cpuLoad / cpuCount) * 100).toFixed(2)
            },
            sessions: {
                active: this.manager.sessions.size,
                total: this.manager.stats.total
            }
        };
    }
}

module.exports = StatsService;