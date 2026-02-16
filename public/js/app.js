// public/js/app.js
class App {
    constructor() {
        this.currentSession = null;
        this.currentChat = null;
        this.sidebar = null;
        this.chat = null;
        this.modals = new ModalManager();
    }

    async init() {
        // Check authentication
        const authenticated = await auth.init();
        
        if (!authenticated) {
            window.location.href = '/login';
            return;
        }

        // Load dashboard
        this.renderDashboard();
    }

    renderDashboard() {
        const container = document.getElementById('app');
        
        // Load dashboard HTML
        fetch('/views/pages/dashboard.html')
            .then(res => res.text())
            .then(html => {
                container.innerHTML = html;
                
                // Initialize components
                this.sidebar = new Sidebar();
                this.chat = new ChatArea();
                
                // Render components
                document.querySelector('.sidebar-container').innerHTML = this.sidebar.render();
                document.querySelector('.chat-container').innerHTML = this.chat.render();
                
                // Attach events
                this.sidebar.attachEvents();
                this.chat.attachEvents();
                
                // Load sessions
                this.loadSessions();
            });
    }

    async loadSessions() {
        try {
            const sessions = await api.getSessions();
            
            if (sessions.length === 0) {
                // Show create session modal
                this.modals.show('session-manager', { onCreate: () => this.loadSessions() });
            } else {
                // Use first active session
                const activeSession = sessions.find(s => s.connected) || sessions[0];
                this.setCurrentSession(activeSession.sid);
            }
        } catch (error) {
            console.error('Failed to load sessions:', error);
        }
    }

    setCurrentSession(sid) {
        this.currentSession = sid;
        
        // Connect WebSocket
        ws.connect(sid);
        
        // Load chats
        this.sidebar.loadChats(sid);
        
        // Set up WebSocket listeners
        ws.on('message', (data) => {
            if (data.chat === this.currentChat) {
                this.chat.loadMessages(sid, this.currentChat);
            }
            this.sidebar.loadChats(sid);
        });

        ws.on('presence', (data) => {
            if (data.participant === this.currentChat) {
                document.querySelector('.presence').textContent = data.presence;
            }
        });
    }

    openChat(jid) {
        this.currentChat = jid;
        this.chat.currentChat = jid;
        this.chat.loadMessages(this.currentSession, jid);
        
        // Load contact info
        api.getContact(this.currentSession, jid).then(contact => {
            this.chat.contact = contact;
            this.chat.render();
        }).catch(() => {
            this.chat.contact = { name: jid.split('@')[0] };
            this.chat.render();
        });
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
    app.init();
});