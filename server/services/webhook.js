// src/services/webhook.js
const axios = require('axios');
const logger = require('../utils/logger');
const { sleep, retry } = require('../utils/helpers');

class WebhookService {
    constructor(manager, store, config) {
        this.manager = manager;
        this.store = store;
        this.config = config;
        this.isRunning = false;
        this.interval = null;
        this.queue = [];
        this.processing = false;
        this.stats = {
            delivered: 0,
            failed: 0,
            retries: 0,
            queueSize: 0
        };
    }

    /**
     * Start webhook service
     */
    async start() {
        if (this.isRunning) return;

        logger.info('Webhook service starting...');

        // Load failed webhooks from DB
        await this.loadFailedWebhooks();

        // Start processing interval
        this.interval = setInterval(() => this.processQueue(), 5000);
        this.isRunning = true;

        logger.info('Webhook service started');
    }

    /**
     * Stop webhook service
     */
    async stop() {
        if (!this.isRunning) return;

        logger.info('Webhook service stopping...');

        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }

        // Save queue state? Could be implemented if needed

        this.isRunning = false;
        logger.info('Webhook service stopped');
    }

    /**
     * Load failed webhooks from database
     */
    async loadFailedWebhooks() {
        try {
            // Fix: Use db.all directly instead of store.getAll
            const failed = await this.store.db.all(
                `SELECT * FROM webhooks WHERE failure_count > 0 AND enabled = 1`
            );

            for (const webhook of failed) {
                this.queue.push({
                    id: webhook.id,
                    event: webhook.event,
                    url: webhook.url,
                    headers: webhook.headers ? JSON.parse(webhook.headers) : {},
                    retryCount: 0,
                    maxRetries: webhook.retry_count || 3,
                    timeout: webhook.timeout || 10000
                });
            }

            this.stats.queueSize = this.queue.length;
            logger.info(`Loaded ${this.queue.length} failed webhooks`);

        } catch (error) {
            logger.error('Failed to load failed webhooks', error);
        }
    }

    /**
     * Get failed webhooks
     */
    async getFailedWebhooks() {
        try {
            return await this.store.db.all(
                `SELECT * FROM webhooks WHERE failure_count > 0 AND enabled = 1`
            );
        } catch (error) {
            logger.error('Failed to get failed webhooks', error);
            return [];
        }
    }

    /**
     * Queue webhook for delivery
     * @param {Object} webhook - Webhook data
     * @param {Object} payload - Payload to send
     */
    async queueWebhook(webhook, payload) {
        this.queue.push({
            id: webhook.id,
            event: webhook.event,
            url: webhook.url,
            headers: webhook.headers ? JSON.parse(webhook.headers) : {},
            payload,
            retryCount: 0,
            maxRetries: webhook.retry_count || 3,
            timeout: webhook.timeout || 10000,
            queuedAt: Date.now()
        });

        this.stats.queueSize = this.queue.length;
    }

    /**
     * Process webhook queue
     */
    async processQueue() {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;

        try {
            const batch = this.queue.splice(0, 10); // Process 10 at a time
            this.stats.queueSize = this.queue.length;

            await Promise.all(batch.map(item => this.deliver(item)));

        } catch (error) {
            logger.error('Error processing webhook queue', error);
        } finally {
            this.processing = false;
        }
    }

    /**
     * Deliver webhook with retry logic
     * @param {Object} item - Queue item
     */
    async deliver(item) {
        const startTime = Date.now();

        try {
            await retry(
                async () => {
                    const response = await axios({
                        method: 'POST',
                        url: item.url,
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': 'WhatsApp-Clone-API/1.0',
                            ...item.headers
                        },
                        data: item.payload,
                        timeout: item.timeout,
                        validateStatus: null // Don't throw on non-2xx
                    });

                    // Log delivery
                    await this.store.logWebhookDelivery(item.id, item.event, {
                        payload: item.payload,
                        response_status: response.status,
                        response_body: response.data,
                        success: response.status >= 200 && response.status < 300,
                        attempt: item.retryCount + 1,
                        duration: Date.now() - startTime
                    });

                    if (response.status >= 200 && response.status < 300) {
                        // Success
                        await this.store.updateWebhookStats(item.id, true, response.status);
                        this.stats.delivered++;
                        logger.debug('Webhook delivered', {
                            id: item.id,
                            event: item.event,
                            status: response.status
                        });
                    } else {
                        // HTTP error
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }
                },
                {
                    maxAttempts: item.maxRetries,
                    initialDelay: this.config.webhookRetryDelay,
                    onRetry: async ({ attempt, error }) => {
                        this.stats.retries++;
                        logger.warn(`Webhook retry ${attempt}/${item.maxRetries}`, {
                            id: item.id,
                            error: error.message
                        });

                        // Update failure count in DB
                        await this.store.updateWebhookStats(item.id, false);
                    }
                }
            );

        } catch (error) {
            // Final failure
            this.stats.failed++;
            logger.error('Webhook delivery failed permanently', {
                id: item.id,
                event: item.event,
                error: error.message
            });

            // Log final failure
            await this.store.logWebhookDelivery(item.id, item.event, {
                payload: item.payload,
                success: false,
                attempt: item.maxRetries,
                duration: Date.now() - startTime,
                error: error.message
            });
        }
    }

    /**
     * Get service status
     * @returns {Object} Status
     */
    getStatus() {
        return {
            running: this.isRunning,
            queueSize: this.queue.length,
            ...this.stats
        };
    }
}

module.exports = WebhookService;