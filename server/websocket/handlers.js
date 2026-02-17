// src/websocket/handlers.js
const logger = require('../utils/logger');
const { isValidJid } = require('../utils/helpers');

/**
 * Setup WebSocket message handlers
 * @param {WebSocket} ws - WebSocket client
 * @param {Object} manager - SessionsManager instance
 */
const setupHandlers = (ws, manager) => {
    
    // Handle incoming messages
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            const { type, payload, requestId } = message;

            logger.debug('WebSocket message received', {
                connectionId: ws.connectionId,
                sessionId: ws.sessionId,
                type,
                requestId
            });

            // Get session
            const session = manager.get(ws.sessionId);
            if (!session) {
                sendError(ws, 'Session not found', requestId);
                return;
            }

            // Route to appropriate handler
            switch (type) {
                case 'ping':
                    handlePing(ws, payload, requestId);
                    break;
                case 'send_message':
                    await handleSendMessage(ws, session, payload, requestId);
                    break;
                case 'send_reaction':
                    await handleSendReaction(ws, session, payload, requestId);
                    break;
                case 'mark_read':
                    await handleMarkRead(ws, session, payload, requestId);
                    break;
                case 'set_presence':
                    await handleSetPresence(ws, session, payload, requestId);
                    break;
                case 'get_chats':
                    await handleGetChats(ws, session, payload, requestId);
                    break;
                case 'get_messages':
                    await handleGetMessages(ws, session, payload, requestId);
                    break;
                case 'get_contacts':
                    await handleGetContacts(ws, session, payload, requestId);
                    break;
                case 'get_groups':
                    await handleGetGroups(ws, session, payload, requestId);
                    break;
                case 'group_action':
                    await handleGroupAction(ws, session, payload, requestId);
                    break;
                case 'block_user':
                    await handleBlockUser(ws, session, payload, requestId);
                    break;
                case 'profile_action':
                    await handleProfileAction(ws, session, payload, requestId);
                    break;
                case 'subscribe':
                    handleSubscribe(ws, payload, requestId);
                    break;
                case 'unsubscribe':
                    handleUnsubscribe(ws, payload, requestId);
                    break;
                default:
                    sendError(ws, `Unknown message type: ${type}`, requestId);
            }

        } catch (error) {
            logger.error('WebSocket message handling error', {
                connectionId: ws.connectionId,
                error: error.message
            });
            sendError(ws, 'Invalid message format');
        }
    });

    // Handle pong responses
    ws.on('pong', () => {
        ws.isAlive = true;
    });
};

/**
 * Handle ping message
 */
const handlePing = (ws, payload, requestId) => {
    sendResponse(ws, {
        type: 'pong',
        timestamp: Date.now(),
        serverTime: new Date().toISOString()
    }, requestId);
};

/**
 * Handle send message
 */
const handleSendMessage = async (ws, session, payload, requestId) => {
    const { jid, content, type } = payload;

    if (!jid || !content) {
        sendError(ws, 'JID and content required', requestId);
        return;
    }

    if (!isValidJid(jid)) {
        sendError(ws, 'Invalid JID format', requestId);
        return;
    }

    try {
        const result = await session.sendMessage(jid, content, type || 'text');
        sendResponse(ws, result, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle send reaction
 */
const handleSendReaction = async (ws, session, payload, requestId) => {
    const { jid, msgId, emoji } = payload;

    if (!jid || !msgId || !emoji) {
        sendError(ws, 'JID, message ID and emoji required', requestId);
        return;
    }

    try {
        const result = await session.sendReaction(jid, msgId, emoji);
        sendResponse(ws, result, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle mark read
 */
const handleMarkRead = async (ws, session, payload, requestId) => {
    const { jid, msgId } = payload;

    if (!jid || !msgId) {
        sendError(ws, 'JID and message ID required', requestId);
        return;
    }

    try {
        await session.markRead(jid, msgId);
        sendResponse(ws, { status: 'marked' }, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle set presence
 */
const handleSetPresence = async (ws, session, payload, requestId) => {
    const { jid, state } = payload;

    if (!jid || !state) {
        sendError(ws, 'JID and state required', requestId);
        return;
    }

    try {
        await session.setPresence(jid, state);
        sendResponse(ws, { status: 'updated' }, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle get chats
 */
const handleGetChats = async (ws, session, payload, requestId) => {
    const { archived = false } = payload || {};

    try {
        const chats = await session.getChats(archived);
        sendResponse(ws, chats, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle get messages
 */
const handleGetMessages = async (ws, session, payload, requestId) => {
    const { jid, limit = 50, before = null, after = null } = payload || {};

    if (!jid) {
        sendError(ws, 'JID required', requestId);
        return;
    }

    try {
        const messages = await session.getMessages(jid, limit, 0, before, after);
        sendResponse(ws, messages, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle get contacts
 */
const handleGetContacts = async (ws, session, payload, requestId) => {
    try {
        const contacts = await session.getContacts();
        sendResponse(ws, contacts, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle get groups
 */
const handleGetGroups = async (ws, session, payload, requestId) => {
    try {
        const groups = await session.getGroups();
        sendResponse(ws, groups, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle group action
 */
const handleGroupAction = async (ws, session, payload, requestId) => {
    const { cmd, jid, data } = payload;

    if (!cmd) {
        sendError(ws, 'Command required', requestId);
        return;
    }

    try {
        const result = await session.groupAction(cmd, jid, data || []);
        sendResponse(ws, result, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle block user
 */
const handleBlockUser = async (ws, session, payload, requestId) => {
    const { jid, block = true } = payload;

    if (!jid) {
        sendError(ws, 'JID required', requestId);
        return;
    }

    try {
        await session.blockUser(jid, block);
        sendResponse(ws, { status: block ? 'blocked' : 'unblocked' }, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle profile action
 */
const handleProfileAction = async (ws, session, payload, requestId) => {
    const { cmd, jid, data } = payload;

    if (!cmd) {
        sendError(ws, 'Command required', requestId);
        return;
    }

    try {
        const result = await session.profileAction(cmd, jid, data);
        sendResponse(ws, result, requestId);
    } catch (error) {
        sendError(ws, error.message, requestId);
    }
};

/**
 * Handle subscribe to events
 */
const handleSubscribe = (ws, payload, requestId) => {
    const { events } = payload || {};

    if (!ws.subscriptions) {
        ws.subscriptions = new Set();
    }

    if (Array.isArray(events)) {
        events.forEach(e => ws.subscriptions.add(e));
    } else if (events === 'all') {
        // Subscribe to all events
        const allEvents = [
            'message', 'presence', 'chat', 'reaction', 
            'group', 'call', 'receipt', 'media', 'qr', // Add 'qr' here
            'connection', 'disconnected', 'connected', 'error'
        ];
        allEvents.forEach(e => ws.subscriptions.add(e));
    }

    sendResponse(ws, { 
        status: 'subscribed',
        subscriptions: Array.from(ws.subscriptions || [])
    }, requestId);
};

/**
 * Handle unsubscribe from events
 */
const handleUnsubscribe = (ws, payload, requestId) => {
    const { events } = payload || {};

    if (!ws.subscriptions) {
        ws.subscriptions = new Set();
    }

    if (Array.isArray(events)) {
        events.forEach(e => ws.subscriptions.delete(e));
    } else if (events === 'all') {
        ws.subscriptions.clear();
    }

    sendResponse(ws, { 
        status: 'unsubscribed',
        subscriptions: Array.from(ws.subscriptions)
    }, requestId);
};

/**
 * Send success response
 */
const sendResponse = (ws, data, requestId = null) => {
    const response = {
        type: 'response',
        success: true,
        data,
        timestamp: Date.now()
    };

    if (requestId) {
        response.requestId = requestId;
    }

    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(response));
    }
};

/**
 * Send error response
 */
const sendError = (ws, error, requestId = null) => {
    const response = {
        type: 'response',
        success: false,
        error,
        timestamp: Date.now()
    };

    if (requestId) {
        response.requestId = requestId;
    }

    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(response));
    }
};

module.exports = {
    setupHandlers,
    sendResponse,
    sendError
};