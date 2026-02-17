const API_BASE = '/api';

class ApiService {
    constructor() {
        this.apiKey = localStorage.getItem('apiKey');
    }

    setApiKey(key) {
        this.apiKey = key;
        localStorage.setItem('apiKey', key);
    }

    getApiKey() {
        return this.apiKey;
    }

    clearApiKey() {
        this.apiKey = null;
        localStorage.removeItem('apiKey');
    }

    async request(endpoint, options = {}) {
        const headers = {
            'Content-Type': 'application/json',
            ...(this.apiKey && { 'x-api-key': this.apiKey }),
            ...options.headers,
        };

        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers,
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Request failed');
        }

        return data;
    }

    async login(username, password) {
        const data = await this.request('/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });
        this.setApiKey(data.apiKey);
        return data;
    }

    async register(username, password) {
        return this.request('/register', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });
    }

    async getUser() {
        return this.request('/user');
    }
}

export default new ApiService();