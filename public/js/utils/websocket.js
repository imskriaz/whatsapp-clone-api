// public/js/utils/websocket.js
class WhatsAppWebSocket {
    constructor() {
        this.ws = null;
        this.sessionId = null;
        this.listeners = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnect = 5;
    }

    connect(sessionId) {
        this.sessionId = sessionId;
        const apiKey = auth.apiKey;
        
        if (!apiKey || !sessionId) return;

        this.ws = new WebSocket(`ws://${window.location.host}?sid=${sessionId}&token=${apiKey}`);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.reconnectAttempts = 0;
            this.emit('connected', { sessionId });
            
            this.ws.send(JSON.stringify({
                type: 'subscribe',
                payload: { events: ['message', 'presence', 'chat', 'reaction'] }
            }));
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.emit(data.event, data.data);
        };

        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            this.emit('disconnected');
            
            if (this.reconnectAttempts < this.maxReconnect) {
                setTimeout(() => {
                    this.reconnectAttempts++;
                    this.connect(sessionId);
                }, 1000 * Math.pow(2, this.reconnectAttempts));
            }
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.emit('error', error);
        };
    }

    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
    }

    emit(event, data) {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            callbacks.forEach(cb => cb(data));
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    send(type, payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type, payload }));
        }
    }
}

window.ws = new WhatsAppWebSocket();