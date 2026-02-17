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
        const authenticated = await auth.init();
        
        if (!authenticated) {
            window.location.href = '/login';
            return;
        }

        this.renderDashboard();
    }

    renderDashboard() {
        fetch('/views/pages/dashboard.html')
            .then(res => res.text())
            .then(html => {
                document.getElementById('app').innerHTML = html;
                
                this.sidebar = new Sidebar();
                this.chat = new ChatArea();
                
                document.querySelector('.sidebar-container').innerHTML = this.sidebar.render();
                document.querySelector('.chat-area-container').innerHTML = this.chat.render();
                
                this.sidebar.attachEvents();
                this.chat.attachEvents();
                
                this.loadSessions();
            });
    }

    async loadSessions() {
        try {
            const sessions = await api.getSessions();
            
            if (sessions.length === 0) {
                this.modals.show('session-manager', { onCreate: () => this.loadSessions() });
            } else {
                const activeSession = sessions.find(s => s.connected) || sessions[0];
                this.setCurrentSession(activeSession.sid);
            }
        } catch (error) {
            console.error('Failed to load sessions:', error);
        }
    }

    setCurrentSession(sid) {
        this.currentSession = sid;
        
        ws.connect(sid);
        this.sidebar.loadChats(sid);
        
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
        
        api.getContact(this.currentSession, jid).then(contact => {
            this.chat.contact = contact;
            this.chat.render();
        }).catch(() => {
            this.chat.contact = { name: jid.split('@')[0] };
            this.chat.render();
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
    app.init();
});