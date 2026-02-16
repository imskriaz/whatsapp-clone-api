// src/services/index.js
const WebhookService = require('./webhook');
const BackupService = require('./backup');
const CleanupService = require('./cleanup');
const StatsService = require('./stats');
const logger = require('../utils/logger');

class ServiceManager {
    constructor() {
        this.services = new Map();
        this.isRunning = false;
    }

    /**
     * Start all background services
     * @param {Object} manager - SessionsManager instance
     * @param {Object} store - SQLiteStores instance
     * @param {Object} config - Service configuration
     */
    async start(manager, store, config) {
        if (this.isRunning) {
            logger.warn('Services already running');
            return;
        }

        logger.info('Starting background services...');

        // Initialize services
        const services = [
            { name: 'webhook', instance: new WebhookService(manager, store, config) },
            { name: 'backup', instance: new BackupService(store, config) },
            { name: 'cleanup', instance: new CleanupService(manager, store, config) },
            { name: 'stats', instance: new StatsService(manager, store, config) }
        ];

        // Start each service
        for (const { name, instance } of services) {
            try {
                await instance.start();
                this.services.set(name, instance);
                logger.info(`✅ ${name} service started`);
            } catch (error) {
                logger.error(`❌ Failed to start ${name} service`, error);
            }
        }

        this.isRunning = true;
        logger.info('All services started');
    }

    /**
     * Stop all background services
     */
    async stop() {
        if (!this.isRunning) return;

        logger.info('Stopping background services...');

        for (const [name, service] of this.services) {
            try {
                await service.stop();
                logger.info(`✅ ${name} service stopped`);
            } catch (error) {
                logger.error(`❌ Failed to stop ${name} service`, error);
            }
        }

        this.services.clear();
        this.isRunning = false;
        logger.info('All services stopped');
    }

    /**
     * Get service status
     * @returns {Object} Service status
     */
    getStatus() {
        const status = {};
        for (const [name, service] of this.services) {
            status[name] = service.getStatus ? service.getStatus() : { running: true };
        }
        return status;
    }

    /**
     * Restart a specific service
     * @param {string} name - Service name
     */
    async restart(name) {
        const service = this.services.get(name);
        if (!service) {
            throw new Error(`Service ${name} not found`);
        }

        logger.info(`Restarting ${name} service...`);
        await service.stop();
        await service.start();
        logger.info(`✅ ${name} service restarted`);
    }
}

// Create and export singleton instance
const serviceManager = new ServiceManager();

// Export both the manager and individual functions for backward compatibility
module.exports = {
    ServiceManager,
    serviceManager,
    startServices: (manager, store, config) => serviceManager.start(manager, store, config),
    stopServices: () => serviceManager.stop(),
    getServiceStatus: () => serviceManager.getStatus()
};