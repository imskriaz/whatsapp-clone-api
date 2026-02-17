// app.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');

const logger = require('./src/utils/logger');
const { initWebSocket } = require('./src/websocket/server');
const routes = require('./src/api/routes');
const { 
    cors, 
    jsonParser, 
    requestLogger, 
    errorHandler, 
    notFound,
    apiLimiter 
} = require('./src/api/middleware');
const SessionsManager = require('./src/core/SessionsManager');
const SQLiteStores = require('./src/core/SQLiteStores');
const { startServices, stopServices } = require('./src/services');

class App {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.manager = null;
        this.store = null;
        this.wss = null;
        this.startTime = Date.now();
        this.isShuttingDown = false;
    }

    /**
     * Initialize application
     */
    async initialize() {
        try {
            logger.info('🚀 Initializing WhatsApp Clone API', {
                version: process.env.npm_package_version || '1.0.0',
                nodeEnv: process.env.NODE_ENV,
                port: process.env.PORT || 3000
            });

            // Initialize database
            await this.initDatabase();

            // Load configuration from database
            const config = await this.loadConfig();

            // Initialize session manager
            await this.initSessionManager(config);

            // Setup middleware
            this.setupMiddleware(config);

            // Setup routes
            this.setupRoutes();

            // Setup WebSocket
            this.initWebSocket();

            // Start background services
            await this.startBackgroundServices(config);

            // Start server
            this.startServer();

            // Setup graceful shutdown
            this.setupGracefulShutdown();

            logger.info('✅ Application initialized successfully');
        } catch (error) {
            logger.error('❌ Failed to initialize application', error);
            process.exit(1);
        }
    }

    /**
     * Initialize database
     */
    async initDatabase() {
        logger.info('📦 Initializing database...');

        try {
            this.store = new SQLiteStores(null, process.env.DB_PATH || './data/db.db');
            await this.store.init();

            // Run migrations if needed (with safe checks)
            await this.runMigrations();

            // Set default settings if not exist
            await this.ensureDefaultSettings();

            const dbSize = await this.store.getDbSize();
            logger.info('✅ Database initialized', { 
                path: process.env.DB_PATH,
                size: this.formatBytes(dbSize)
            });

        } catch (error) {
            logger.error('❌ Database initialization failed', error);
            throw error;
        }
    }

    /**
     * Run database migrations safely
     */
    async runMigrations() {
        try {
            // Check if migrations table exists
            const migrationsExist = await this.store.db.get(
                `SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'`
            );

            if (!migrationsExist) {
                await this.store.db.exec(`
                    CREATE TABLE migrations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL,
                        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                logger.info('Created migrations table');
            }

            // Get executed migrations
            const executed = await this.store.db.all('SELECT name FROM migrations');
            const executedNames = new Set(executed.map(m => m.name));

            // Define migrations with proper checks
            const migrations = [
                {
                    name: '001_initial',
                    check: async () => {
                        // Check if any tables exist
                        const tables = await this.store.db.all(
                            "SELECT name FROM sqlite_master WHERE type='table'"
                        );
                        return tables.length > 0;
                    },
                    run: async () => {
                        // Initial schema is already created by SQLiteStores.js
                        logger.info('Initial schema already exists');
                    }
                },
                {
                    name: '002_add_webhook_columns',
                    check: async () => {
                        // Check if columns already exist
                        const tableInfo = await this.store.db.all(
                            "PRAGMA table_info(webhooks)"
                        );
                        const columns = tableInfo.map(c => c.name);
                        return !columns.includes('last_triggered');
                    },
                    run: async () => {
                        logger.info('Adding webhook columns...');
                        
                        // Check if table exists first
                        const tableExists = await this.store.db.get(
                            "SELECT name FROM sqlite_master WHERE type='table' AND name='webhooks'"
                        );
                        
                        if (tableExists) {
                            // Add columns one by one with error handling
                            try {
                                await this.store.db.exec(
                                    "ALTER TABLE webhooks ADD COLUMN last_triggered DATETIME"
                                );
                                logger.info('Added last_triggered column');
                            } catch (err) {
                                if (!err.message.includes('duplicate column')) {
                                    throw err;
                                }
                                logger.debug('last_triggered column already exists');
                            }

                            try {
                                await this.store.db.exec(
                                    "ALTER TABLE webhooks ADD COLUMN last_response INTEGER"
                                );
                                logger.info('Added last_response column');
                            } catch (err) {
                                if (!err.message.includes('duplicate column')) {
                                    throw err;
                                }
                                logger.debug('last_response column already exists');
                            }

                            try {
                                await this.store.db.exec(
                                    "ALTER TABLE webhooks ADD COLUMN failure_count INTEGER DEFAULT 0"
                                );
                                logger.info('Added failure_count column');
                            } catch (err) {
                                if (!err.message.includes('duplicate column')) {
                                    throw err;
                                }
                                logger.debug('failure_count column already exists');
                            }
                        }
                    }
                },
                {
                    name: '003_add_indexes',
                    check: async () => {
                        // Check if indexes exist
                        const indexes = await this.store.db.all(
                            "SELECT name FROM sqlite_master WHERE type='index'"
                        );
                        return !indexes.some(i => i.name === 'idx_webhook_session');
                    },
                    run: async () => {
                        logger.info('Creating indexes...');
                        
                        const indexes = [
                            `CREATE INDEX IF NOT EXISTS idx_webhook_session ON webhooks(session_id, enabled)`,
                            `CREATE INDEX IF NOT EXISTS idx_webhook_event ON webhooks(session_id, event)`,
                            `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries ON webhook_deliveries(webhook_id, created_at DESC)`,
                            `CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id, created_at DESC)`,
                            `CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_logs(session_id, created_at DESC)`,
                            `CREATE INDEX IF NOT EXISTS idx_backups_session ON backups(session_id, created_at DESC)`
                        ];

                        for (const sql of indexes) {
                            try {
                                await this.store.db.exec(sql);
                            } catch (err) {
                                logger.warn(`Failed to create index: ${sql}`, err.message);
                            }
                        }
                    }
                }
            ];

            // Run pending migrations
            for (const migration of migrations) {
                if (!executedNames.has(migration.name)) {
                    logger.info(`Checking migration: ${migration.name}`);
                    
                    // Check if migration is needed
                    const needed = await migration.check();
                    
                    if (needed) {
                        logger.info(`Running migration: ${migration.name}`);
                        
                        await this.store.db.exec('BEGIN TRANSACTION');
                        try {
                            await migration.run();
                            await this.store.db.run(
                                'INSERT INTO migrations (name) VALUES (?)',
                                [migration.name]
                            );
                            await this.store.db.exec('COMMIT');
                            logger.info(`✅ Migration completed: ${migration.name}`);
                        } catch (error) {
                            await this.store.db.exec('ROLLBACK');
                            logger.error(`❌ Migration failed: ${migration.name}`, error);
                            
                            // Don't throw for non-critical migrations
                            if (!migration.name.includes('webhook')) {
                                throw error;
                            }
                        }
                    } else {
                        logger.info(`Migration not needed: ${migration.name}`);
                        
                        // Mark as executed even if not needed
                        await this.store.db.run(
                            'INSERT INTO migrations (name) VALUES (?)',
                            [migration.name]
                        ).catch(() => {});
                    }
                }
            }

        } catch (error) {
            logger.error('❌ Migrations failed', error);
            throw error;
        }
    }

    /**
     * Ensure default settings exist
     */
    async ensureDefaultSettings() {
        const defaults = {
            max_sessions_per_user: process.env.MAX_SESSIONS_PER_USER || '5',
            max_total_sessions: process.env.MAX_TOTAL_SESSIONS || '100',
            session_timeout: process.env.SESSION_TIMEOUT || '1800000',
            rate_limit: process.env.RATE_LIMIT_MAX || '100',
            webhook_retry_count: process.env.WEBHOOK_RETRY_COUNT || '3',
            webhook_retry_delay: process.env.WEBHOOK_RETRY_DELAY || '5000',
            webhook_timeout: process.env.WEBHOOK_TIMEOUT || '10000',
            backup_schedule: process.env.BACKUP_SCHEDULE || '0 0 * * *',
            cleanup_interval: process.env.CLEANUP_INTERVAL || '300000'
        };

        for (const [key, value] of Object.entries(defaults)) {
            const existing = await this.store.getGlobalSetting(key);
            if (!existing) {
                await this.store.setGlobalSetting(key, value, `Default ${key.replace(/_/g, ' ')}`);
                logger.debug(`Created default setting: ${key}`);
            }
        }
    }

    /**
     * Load configuration from database
     */
    async loadConfig() {
        try {
            const settings = await this.store.getAllGlobalSettings();
            
            return {
                maxSessionsPerUser: parseInt(settings.max_sessions_per_user?.value) || 5,
                maxTotalSessions: parseInt(settings.max_total_sessions?.value) || 100,
                sessionTimeout: parseInt(settings.session_timeout?.value) || 1800000,
                rateLimit: parseInt(settings.rate_limit?.value) || 100,
                webhookRetryCount: parseInt(settings.webhook_retry_count?.value) || 3,
                webhookRetryDelay: parseInt(settings.webhook_retry_delay?.value) || 5000,
                webhookTimeout: parseInt(settings.webhook_timeout?.value) || 10000,
                backupSchedule: settings.backup_schedule?.value || '0 0 * * *',
                cleanupInterval: parseInt(settings.cleanup_interval?.value) || 300000
            };
        } catch (error) {
            logger.warn('Failed to load settings from DB, using defaults', error);
            return {
                maxSessionsPerUser: parseInt(process.env.MAX_SESSIONS_PER_USER) || 5,
                maxTotalSessions: parseInt(process.env.MAX_TOTAL_SESSIONS) || 100,
                sessionTimeout: parseInt(process.env.SESSION_TIMEOUT) || 1800000,
                rateLimit: parseInt(process.env.RATE_LIMIT_MAX) || 100,
                webhookRetryCount: parseInt(process.env.WEBHOOK_RETRY_COUNT) || 3,
                webhookRetryDelay: parseInt(process.env.WEBHOOK_RETRY_DELAY) || 5000,
                webhookTimeout: parseInt(process.env.WEBHOOK_TIMEOUT) || 10000,
                backupSchedule: process.env.BACKUP_SCHEDULE || '0 0 * * *',
                cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL) || 300000
            };
        }
    }

    /**
     * Initialize session manager
     */
    async initSessionManager(config) {
        logger.info('🎮 Initializing session manager...');

        this.manager = new SessionsManager({
            wss: this.wss,
            dbPath: process.env.DB_PATH || './data/db.db',
            maxPerUser: config.maxSessionsPerUser,
            maxTotal: config.maxTotalSessions,
            sessionTimeout: config.sessionTimeout
        });

        await this.manager.init();

        logger.info('✅ Session manager initialized', {
            activeSessions: this.manager.sessions.size,
            activeUsers: this.manager.userSessions.size
        });
    }

    /**
     * Setup Express middleware
     */
    setupMiddleware(config) {
        logger.info('🛡️ Setting up middleware...');

        // Security headers
        this.app.use(helmet({
            contentSecurityPolicy: false,
            crossOriginEmbedderPolicy: false
        }));

        // CORS
        this.app.use(cors);

        // Compression
        this.app.use(compression({
            level: 6,
            threshold: 1024,
            filter: (req, res) => {
                if (req.headers['x-no-compression']) return false;
                return compression.filter(req, res);
            }
        }));

        // Body parsing
        this.app.use(jsonParser);
        this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

        // Request logging
        this.app.use(requestLogger);

        // Global rate limiter
        this.app.use('/api', apiLimiter);

        // Request ID
        this.app.use((req, res, next) => {
            req.id = uuidv4();
            res.setHeader('X-Request-ID', req.id);
            next();
        });

        // Response time header
        this.app.use((req, res, next) => {
            const start = Date.now();
            
            // Use a listener instead of trying to set header after response
            res.on('finish', () => {
                const duration = Date.now() - start;
                // This is safe because response is already finished
                // But we can't set headers here
                logger.debug(`${req.method} ${req.url} - ${duration}ms`);
            });
            
            next();
        });

        logger.info('✅ Middleware setup complete');
    }

    setupRoutes() {
        logger.info('🛣️ Setting up routes...');

        // ⚠️ IMPORTANT: Static files MUST come first
        this.app.use('/css', express.static(path.join(__dirname, 'public/css')));
        this.app.use('/js', express.static(path.join(__dirname, 'public/js')));
        this.app.use('/views', express.static(path.join(__dirname, 'public/views')));
        this.app.use('/public', express.static(path.join(__dirname, 'public')));

        // Health check - only ONCE
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                sessions: this.manager?.sessions.size || 0,
                memory: process.memoryUsage(),
                version: process.env.npm_package_version || '1.0.0'
            });
        });

        // Web routes (UI)
        const webRoutes = require('./src/web/routes');
        this.app.use('/', webRoutes);

        // API routes
        this.app.use('/api', routes(this.manager, this.store));

        // 404 handler for API routes
        this.app.use('/api/*', (req, res) => {
            res.status(404).json({ error: 'API route not found' });
        });

        // SPA catch-all - THIS IS CRITICAL
        // Any route not matched above will serve index.html
        this.app.get('*', (req, res) => {
            res.sendFile(path.join(__dirname, 'public/index.html'));
        });

        // Error handler
        this.app.use(errorHandler);

        logger.info('✅ Routes setup complete');
    }

    /**
     * Initialize WebSocket server
     */
    initWebSocket() {
        logger.info('🔌 Initializing WebSocket server...');

        this.wss = initWebSocket(this.server, this.manager, this.store);

        this.wss.on('connection', (ws) => {
            logger.debug('WebSocket client connected', { 
                clients: this.wss.clients.size 
            });
        });

        this.wss.on('error', (error) => {
            logger.error('WebSocket server error', error);
        });

        logger.info('✅ WebSocket server initialized');
    }

    /**
     * Start background services
     */
    async startBackgroundServices(config) {
        logger.info('⚙️ Starting background services...');

        try {
            await startServices(this.manager, this.store, config);
            logger.info('✅ Background services started');
        } catch (error) {
            logger.error('❌ Failed to start background services', error);
            throw error;
        }
    }

    /**
     * Start HTTP server
     */
    startServer() {
        const PORT = process.env.PORT || 3000;
        const HOST = process.env.HOST || '0.0.0.0';

        this.server.listen(PORT, HOST, () => {
            logger.info(`🌍 Server running at http://${HOST}:${PORT}`);
            logger.info(`📚 API documentation available at http://${HOST}:${PORT}/api-docs`);
            logger.info(`🖥️  WebSocket server ready at ws://${HOST}:${PORT}`);
        });

        this.server.on('error', (error) => {
            logger.error('❌ Server error', error);
            if (error.code === 'EADDRINUSE') {
                logger.error(`Port ${PORT} is already in use`);
                process.exit(1);
            }
        });
    }

    /**
     * Setup graceful shutdown
     */
    setupGracefulShutdown() {
        const shutdownSignals = ['SIGTERM', 'SIGINT', 'SIGQUIT'];

        shutdownSignals.forEach(signal => {
            process.on(signal, async () => {
                await this.shutdown(signal);
            });
        });

        process.on('uncaughtException', async (error) => {
            logger.error('💥 Uncaught Exception', error);
            await this.shutdown('uncaughtException');
        });

        process.on('unhandledRejection', async (reason, promise) => {
            logger.error('💥 Unhandled Rejection', { reason, promise });
            await this.shutdown('unhandledRejection');
        });
    }

    /**
     * Graceful shutdown
     */
    async shutdown(signal) {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        logger.info(`🛑 Received ${signal}, starting graceful shutdown...`);

        // Stop accepting new connections
        this.server.close(() => {
            logger.info('✅ HTTP server closed');
        });

        // Close WebSocket connections
        if (this.wss) {
            this.wss.clients.forEach(client => {
                client.close(1001, 'Server shutting down');
            });
            this.wss.close(() => {
                logger.info('✅ WebSocket server closed');
            });
        }

        // Stop background services
        try {
            await stopServices();
            logger.info('✅ Background services stopped');
        } catch (error) {
            logger.error('❌ Error stopping services', error);
        }

        // Close all sessions
        if (this.manager) {
            try {
                await this.manager.closeAll();
                logger.info('✅ All sessions closed');
            } catch (error) {
                logger.error('❌ Error closing sessions', error);
            }
        }

        // Close database
        if (this.store) {
            try {
                await this.store.close();
                logger.info('✅ Database connection closed');
            } catch (error) {
                logger.error('❌ Error closing database', error);
            }
        }

        const uptime = Date.now() - this.startTime;
        logger.info(`👋 Shutdown complete. Server was up for ${this.formatUptime(uptime)}`);

        process.exit(0);
    }

    /**
     * Format bytes to human readable
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Format uptime to human readable
     */
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }
}

// Create and initialize application
const app = new App();
app.initialize().catch(error => {
    console.error('Fatal error during initialization:', error);
    process.exit(1);
});

// Export for testing
module.exports = app;