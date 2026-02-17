import { create } from 'zustand';
import api from '../services/api.js';

const useAuthStore = create((set, get) => ({
    user: null,
    isLoading: false,
    error: null,

    login: async (username, password) => {
        set({ isLoading: true, error: null });
        try {
            await api.login(username, password);
            const user = await api.getUser();
            set({ user, isLoading: false });
            return { success: true };
        } catch (error) {
            set({ error: error.message, isLoading: false });
            return { success: false, error: error.message };
        }
    },

    register: async (username, password) => {
        set({ isLoading: true, error: null });
        try {
            await api.register(username, password);
            set({ isLoading: false });
            return { success: true, message: 'Registration successful! Please login.' };
        } catch (error) {
            set({ error: error.message, isLoading: false });
            return { success: false, error: error.message };
        }
    },

    logout: () => {
        api.clearApiKey();
        set({ user: null });
    },

    checkAuth: async () => {
        if (!api.getApiKey()) return false;
        
        set({ isLoading: true });
        try {
            const user = await api.getUser();
            set({ user, isLoading: false });
            return true;
        } catch (error) {
            api.clearApiKey();
            set({ user: null, isLoading: false });
            return false;
        }
    },
}));

export default useAuthStore;