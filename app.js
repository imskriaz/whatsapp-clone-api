// app.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

// Backend imports
const routes = require('./server/api/routes');
const web = require('./client/routes');  // Client web routes
const { initWebSocket } = require('./server/websocket/server');
const SessionsManager = require('./server/core/SessionsManager');
const SQLiteStores = require('./server/core/SQLiteStores');
const { startServices } = require('./server/services');
const logger = require('./server/utils/logger');

class App {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.manager = null;
        this.store = null;
        this.isDev = process.env.NODE_ENV !== 'production';
    }

    async initialize() {
        try {
            const PORT = process.env.PORT || 3000;
            
            logger.info('🚀 Starting WhatsApp Clone on port', PORT);

            // Initialize backend
            await this.initBackend();

            // Setup middleware
            this.setupMiddleware();

            // API Routes - /api/*
            this.app.use('/api', routes(this.manager, this.store));
            logger.info('✅ API routes ready');

            // Web Routes - /web/*
            this.app.use('/web', web);
            logger.info('✅ Web routes ready');

            // Frontend - Static files
            this.setupFrontend();

            // WebSocket
            this.initWebSocket();

            // Start server
            this.startServer(PORT);

        } catch (error) {
            logger.error('❌ Failed to start:', error);
            process.exit(1);
        }
    }

    async initBackend() {
        // Database
        this.store = new SQLiteStores(null, process.env.DB_PATH || './data/db.db');
        await this.store.init();
        logger.info('✅ Database ready');

        // Session manager
        this.manager = new SessionsManager({ dbPath: process.env.DB_PATH });
        await this.manager.init();
        logger.info('✅ Session manager ready');

        // Background services
        const config = await this.store.getAllGlobalSettings();
        await startServices(this.manager, this.store, config);
        logger.info('✅ Background services ready');
    }

    setupMiddleware() {
        this.app.use(helmet({ 
            contentSecurityPolicy: false,
            crossOriginEmbedderPolicy: false 
        }));
        this.app.use(cors());
        this.app.use(compression());
        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));
        
        // Static files
        this.app.use('/public', express.static(path.join(__dirname, 'client/public')));
    }

    setupFrontend() {
        const clientPath = path.join(__dirname, 'client');
        
        if (this.isDev) {
            // DEVELOPMENT: Serve raw files with correct MIME types
            this.app.use((req, res, next) => {
                if (req.url.endsWith('.js') || req.url.endsWith('.jsx')) {
                    res.setHeader('Content-Type', 'application/javascript');
                }
                if (req.url.endsWith('.css')) {
                    res.setHeader('Content-Type', 'text/css');
                }
                if (req.url.endsWith('.json')) {
                    res.setHeader('Content-Type', 'application/json');
                }
                next();
            });

            // Serve static files
            this.app.use(express.static(clientPath, {
                setHeaders: (res, filePath) => {
                    if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
                        res.setHeader('Content-Type', 'application/javascript');
                    }
                    if (filePath.endsWith('.css')) {
                        res.setHeader('Content-Type', 'text/css');
                    }
                }
            }));

            // Serve JSX files explicitly
            this.app.get('*.jsx', (req, res) => {
                res.setHeader('Content-Type', 'application/javascript');
                res.sendFile(path.join(clientPath, req.path));
            });

            logger.info('📡 Development mode: Serving raw files');
        } else {
            // PRODUCTION: Serve built files
            const distPath = path.join(clientPath, 'dist');
            
            if (fs.existsSync(distPath)) {
                this.app.use(express.static(distPath));
                logger.info('✅ Serving built frontend from dist');
            } else {
                logger.warn('⚠️  client/dist not found. Run "npm run build" first');
            }
        }

        // Catch-all route for SPA (must be last)
        this.app.get('*', (req, res) => {
            // Skip API and web routes
            if (req.path.startsWith('/api') || req.path.startsWith('/web')) {
                return;
            }
            
            if (this.isDev) {
                res.sendFile(path.join(clientPath, 'index.html'));
            } else {
                const distPath = path.join(clientPath, 'dist', 'index.html');
                if (fs.existsSync(distPath)) {
                    res.sendFile(distPath);
                } else {
                    res.status(404).send('Frontend not found');
                }
            }
        });
    }

    initWebSocket() {
        initWebSocket(this.server, this.manager, this.store);
        logger.info('✅ WebSocket ready');
    }

    startServer(PORT) {
        this.server.listen(PORT, () => {
            logger.info(`🌍 Server running at http://localhost:${PORT}`);
            logger.info(`📡 API at http://localhost:${PORT}/api`);
            logger.info(`🌐 Web routes at http://localhost:${PORT}/web`);
            logger.info(`🖥️  WebSocket at ws://localhost:${PORT}`);
            logger.info(`📱 App ready at http://localhost:${PORT}`);
        });

        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGINT', () => this.shutdown());
    }

    async shutdown() {
        logger.info('🛑 Shutting down...');
        this.server.close();
        if (this.manager) await this.manager.closeAll();
        if (this.store) await this.store.close();
        process.exit(0);
    }
}

new App().initialize();