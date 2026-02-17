// public/js/components/sidebar.js
class Sidebar {
    constructor() {
        this.element = null;
        this.chats = [];
        this.filter = 'all';
        this.searchQuery = '';
    }

    render() {
        return `
            <div class="sidebar">
                <!-- Profile header -->
                <div class="chat-header">
                    <div class="flex items-center">
                        <div class="chat-avatar">
                            <i class="fa-solid fa-user"></i>
                        </div>
                        <span class="font-semibold ml-2">${auth.user?.username || 'User'}</span>
                    </div>
                    <div class="flex items-center space-x-4">
                        <button class="profile-trigger">
                            <i class="fa-solid fa-ellipsis-vertical"></i>
                        </button>
                    </div>
                    
                    <!-- Profile dropdown -->
                    <div class="profile-dropdown hidden">
                        <div class="dropdown-menu">
                            <div class="py-2">
                                <a href="#" class="block px-4 py-2 hover:bg-gray-100" data-action="profile">Profile</a>
                                <a href="#" class="block px-4 py-2 hover:bg-gray-100" data-action="sessions">Sessions</a>
                                <a href="#" class="block px-4 py-2 hover:bg-gray-100" data-action="settings">Settings</a>
                                <hr class="my-2">
                                <a href="#" class="block px-4 py-2 hover:bg-gray-100 text-red-600" data-action="logout">Logout</a>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Search bar -->
                <div class="search-bar">
                    <input type="text" 
                           placeholder="Search or start a new chat" 
                           class="search-input"
                           value="${this.searchQuery}">
                </div>

                <!-- Chat list -->
                <div class="flex-1 overflow-y-auto">
                    ${this.renderChats()}
                </div>
            </div>
        `;
    }

    renderChats() {
        if (this.chats.length === 0) {
            return `<div class="text-center text-gray-500 p-4">No chats found</div>`;
        }
        return this.chats.map(chat => this.renderChatItem(chat)).join('');
    }

    renderChatItem(chat) {
        return `
            <div class="chat-item" data-jid="${chat.jid}">
                <div class="chat-avatar">${chat.name ? chat.name[0].toUpperCase() : '?'}</div>
                <div class="chat-info">
                    <div class="chat-name">${chat.name || chat.jid.split('@')[0]}</div>
                    <div class="chat-last-msg">${chat.last_msg_id || 'No messages'}</div>
                </div>
            </div>
        `;
    }

    async loadChats(sid) {
        try {
            this.chats = await api.getChats(sid);
        } catch (error) {
            console.error('Failed to load chats:', error);
        }
    }

    attachEvents() {
        document.querySelector('.profile-trigger')?.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelector('.profile-dropdown').classList.toggle('hidden');
        });

        document.addEventListener('click', () => {
            document.querySelector('.profile-dropdown')?.classList.add('hidden');
        });

        document.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const action = btn.dataset.action;
                if (action === 'logout') auth.logout();
                else if (action === 'sessions') Modals?.show('session-manager');
                else if (action === 'settings') Modals?.show('settings');
            });
        });
    }
}

window.Sidebar = Sidebar;