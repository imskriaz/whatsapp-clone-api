// public/js/api.js
class WhatsAppAPI {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = '/api';
    }

    async request(endpoint, options = {}) {
        const headers = {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            ...options.headers
        };

        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            ...options,
            headers
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'API request failed');
        }

        return data;
    }

    // Auth
    async login(username, password) {
        const data = await this.request('/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
        this.apiKey = data.apiKey;
        localStorage.setItem('apiKey', data.apiKey);
        return data;
    }

    async register(username, password) {
        return this.request('/register', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
    }

    // User
    async getUser() {
        return this.request('/user');
    }

    // Sessions
    async getSessions() {
        return this.request('/sessions');
    }

    async createSession(platform = 'web', device = null) {
        return this.request('/sessions', {
            method: 'POST',
            body: JSON.stringify({ platform, device })
        });
    }

    async getSession(sid) {
        return this.request(`/sessions/${sid}`);
    }

    async deleteSession(sid) {
        return this.request(`/sessions/${sid}`, {
            method: 'DELETE'
        });
    }

    async getSessionQR(sid) {
        return this.request(`/sessions/${sid}/qr`);
    }

    // Chats
    async getChats(sid, archived = false) {
        return this.request(`/sessions/${sid}/chats?archived=${archived}`);
    }

    async getChat(sid, jid) {
        return this.request(`/sessions/${sid}/chats/${encodeURIComponent(jid)}`);
    }

    // Messages
    async getMessages(sid, jid, limit = 50, before = null) {
        let url = `/sessions/${sid}/chats/${encodeURIComponent(jid)}/messages?limit=${limit}`;
        if (before) url += `&before=${before}`;
        return this.request(url);
    }

    async sendMessage(sid, jid, text) {
        return this.request(`/sessions/${sid}/send/text`, {
            method: 'POST',
            body: JSON.stringify({ jid, text })
        });
    }

    async sendReaction(sid, jid, msgId, emoji) {
        return this.request(`/sessions/${sid}/send/reaction`, {
            method: 'POST',
            body: JSON.stringify({ jid, msgId, emoji })
        });
    }

    // Contacts
    async getContacts(sid) {
        return this.request(`/sessions/${sid}/contacts`);
    }

    // Groups
    async getGroups(sid) {
        return this.request(`/sessions/${sid}/groups`);
    }

    async createGroup(sid, subject, participants = []) {
        return this.request(`/sessions/${sid}/groups`, {
            method: 'POST',
            body: JSON.stringify({ subject, participants })
        });
    }

    // Settings
    async getSettings(sid) {
        return this.request(`/sessions/${sid}/settings`);
    }

    async updateSetting(sid, name, value) {
        return this.request(`/sessions/${sid}/settings/${name}`, {
            method: 'PUT',
            body: JSON.stringify({ value })
        });
    }
}

window.api = new WhatsAppAPI(localStorage.getItem('apiKey'));