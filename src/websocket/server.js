// src/websocket/server.js
const WebSocket = require('ws');
const url = require('url');
const logger = require('../utils/logger');
const { setupHandlers } = require('./handlers');

/**
 * Initialize WebSocket server
 * @param {http.Server} server - HTTP server
 * @param {Object} manager - SessionsManager instance
 * @param {Object} store - SQLiteStores instance
 * @returns {WebSocket.Server} WebSocket server
 */
const initWebSocket = (server, manager, store) => {
    const wss = new WebSocket.Server({ 
        server,
        clientTracking: true,
        perMessageDeflate: {
            zlibDeflateOptions: {
                chunkSize: 1024,
                memLevel: 7,
                level: 3
            },
            zlibInflateOptions: {
                chunkSize: 10 * 1024
            },
            clientNoContextTakeover: true,
            serverNoContextTakeover: true,
            serverMaxWindowBits: 10,
            concurrencyLimit: 10,
            threshold: 1024
        }
    });

    // Connection handler
    wss.on('connection', (ws, req) => {
        const clientIp = req.socket.remoteAddress;
        const clientPort = req.socket.remotePort;
        const connectionId = `${clientIp}:${clientPort}`;

        logger.debug('WebSocket client connected', { 
            connectionId,
            total: wss.clients.size 
        });

        // Parse query parameters
        const parsed = url.parse(req.url, true);
        const sessionId = parsed.query.sid;
        const token = parsed.query.token;

        // Validate connection
        if (!sessionId || !token) {
            logger.warn('WebSocket connection missing credentials', { connectionId });
            ws.close(1008, 'Missing credentials');
            return;
        }

        // Authenticate
        store.getSessionUser(sessionId).then(user => {
            if (!user || user.api_key !== token) {
                logger.warn('WebSocket authentication failed', { 
                    connectionId, 
                    sessionId 
                });
                ws.close(1008, 'Invalid credentials');
                return;
            }

            // Store session info in ws object
            ws.sessionId = sessionId;
            ws.userId = user.username;
            ws.connectionId = connectionId;
            ws.connectedAt = Date.now();

            logger.info('WebSocket authenticated', { 
                connectionId,
                sessionId,
                userId: user.username,
                total: wss.clients.size 
            });

            // Send initial connection success
            ws.send(JSON.stringify({
                type: 'connected',
                data: {
                    sessionId,
                    userId: user.username,
                    timestamp: new Date().toISOString(),
                    clients: wss.clients.size
                }
            }));

            // Setup message handlers
            setupHandlers(ws, manager);

            // Ping/pong for keep-alive
            ws.isAlive = true;
            ws.on('pong', () => {
                ws.isAlive = true;
            });

        }).catch(error => {
            logger.error('WebSocket authentication error', error);
            ws.close(1008, 'Authentication failed');
        });

        // Handle close
        ws.on('close', (code, reason) => {
            logger.info('WebSocket client disconnected', { 
                connectionId,
                sessionId: ws.sessionId,
                code,
                reason: reason.toString(),
                duration: Date.now() - (ws.connectedAt || Date.now()),
                total: wss.clients.size 
            });
        });

        // Handle errors
        ws.on('error', (error) => {
            logger.error('WebSocket error', { 
                connectionId,
                sessionId: ws.sessionId,
                error: error.message 
            });
        });
    });

    // Ping all clients every 30 seconds
    const interval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                logger.debug('Terminating inactive client', { 
                    connectionId: ws.connectionId,
                    sessionId: ws.sessionId 
                });
                return ws.terminate();
            }

            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    // Cleanup on server close
    wss.on('close', () => {
        clearInterval(interval);
        logger.info('WebSocket server closed');
    });

    // Error handling
    wss.on('error', (error) => {
        logger.error('WebSocket server error', error);
    });

    logger.info('WebSocket server initialized');

    return wss;
};

/**
 * Broadcast to all clients in a session
 * @param {WebSocket.Server} wss - WebSocket server
 * @param {string} sessionId - Session ID
 * @param {Object} message - Message to broadcast
 */
const broadcastToSession = (wss, sessionId, message) => {
    let sent = 0;
    const data = JSON.stringify(message);

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId) {
            client.send(data);
            sent++;
        }
    });

    if (sent === 0 && process.env.NODE_ENV === 'development') {
        logger.debug(`No clients for session: ${sessionId}`);
    }

    return sent;
};

/**
 * Send to specific client
 * @param {WebSocket} ws - WebSocket client
 * @param {Object} message - Message to send
 */
const sendToClient = (ws, message) => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
        return true;
    }
    return false;
};

/**
 * Get all connected clients
 * @param {WebSocket.Server} wss - WebSocket server
 * @returns {Array} Connected clients
 */
const getConnectedClients = (wss) => {
    const clients = [];
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            clients.push({
                sessionId: client.sessionId,
                userId: client.userId,
                connectionId: client.connectionId,
                connectedAt: client.connectedAt
            });
        }
    });
    return clients;
};

/**
 * Get session client count
 * @param {WebSocket.Server} wss - WebSocket server
 * @param {string} sessionId - Session ID
 * @returns {number} Client count
 */
const getSessionClientCount = (wss, sessionId) => {
    let count = 0;
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId) {
            count++;
        }
    });
    return count;
};

module.exports = {
    initWebSocket,
    broadcastToSession,
    sendToClient,
    getConnectedClients,
    getSessionClientCount
};