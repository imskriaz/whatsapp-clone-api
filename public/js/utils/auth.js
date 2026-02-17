// public/js/utils/auth.js
class AuthManager {
    constructor() {
        this.apiKey = localStorage.getItem('apiKey');
        this.user = null;
        this.listeners = [];
    }

    async init() {
        if (this.apiKey) {
            try {
                this.user = await api.getUser();
                this.notifyListeners();
                return true;
            } catch (error) {
                this.logout();
                return false;
            }
        }
        return false;
    }

    async login(username, password) {
        try {
            const data = await api.login(username, password);
            this.apiKey = data.apiKey;
            this.user = await api.getUser();
            this.notifyListeners();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async register(username, password) {
        try {
            await api.register(username, password);
            return this.login(username, password);
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    logout() {
        localStorage.removeItem('apiKey');
        this.apiKey = null;
        this.user = null;
        this.notifyListeners();
        window.location.href = '/login';
    }

    addListener(callback) {
        this.listeners.push(callback);
    }

    notifyListeners() {
        this.listeners.forEach(cb => cb(this.user));
    }

    isAuthenticated() {
        return !!this.apiKey;
    }
}

window.auth = new AuthManager();