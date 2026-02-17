// public/js/pages/session.js
document.addEventListener('DOMContentLoaded', async () => {
    const authenticated = await auth.init();
    if (!authenticated) {
        window.location.href = '/login';
        return;
    }

    const sessionId = window.location.pathname.split('/').pop();
    await loadSessionInfo(sessionId);
    await loadSessionQR(sessionId);
});

async function loadSessionInfo(sessionId) {
    try {
        const session = await api.getSession(sessionId);
        const container = document.getElementById('session-info');
        
        container.innerHTML = `
            <div class="grid grid-cols-2 gap-4">
                <div class="p-3 bg-gray-50 rounded">
                    <span class="text-sm text-gray-600">Session ID</span>
                    <p class="font-mono text-sm">${session.sid}</p>
                </div>
                <div class="p-3 bg-gray-50 rounded">
                    <span class="text-sm text-gray-600">Status</span>
                    <p class="font-semibold ${session.connected ? 'text-green-500' : 'text-gray-500'}">
                        ${session.connected ? 'Connected' : 'Disconnected'}
                    </p>
                </div>
                <div class="p-3 bg-gray-50 rounded">
                    <span class="text-sm text-gray-600">Phone</span>
                    <p>${session.phone || 'Not connected'}</p>
                </div>
                <div class="p-3 bg-gray-50 rounded">
                    <span class="text-sm text-gray-600">Platform</span>
                    <p>${session.platform || 'web'}</p>
                </div>
                <div class="p-3 bg-gray-50 rounded">
                    <span class="text-sm text-gray-600">Created</span>
                    <p>${new Date(session.created).toLocaleString()}</p>
                </div>
                <div class="p-3 bg-gray-50 rounded">
                    <span class="text-sm text-gray-600">Last Seen</span>
                    <p>${session.lastSeen ? new Date(session.lastSeen).toLocaleString() : 'Never'}</p>
                </div>
            </div>
            <div class="mt-4 p-3 bg-gray-50 rounded">
                <span class="text-sm text-gray-600">Stats</span>
                <div class="grid grid-cols-3 gap-2 mt-2">
                    <div>Messages RX: ${session.stats?.msgsRx || 0}</div>
                    <div>Messages TX: ${session.stats?.msgsTx || 0}</div>
                    <div>Events: ${session.stats?.events || 0}</div>
                </div>
            </div>
        `;
    } catch (error) {
        console.error('Failed to load session:', error);
        document.getElementById('session-info').innerHTML = `
            <div class="text-red-500 text-center p-4">
                <i class="fa-solid fa-circle-exclamation text-2xl mb-2"></i>
                <p>Failed to load session: ${error.message}</p>
            </div>
        `;
    }
}

async function loadSessionQR(sessionId) {
    try {
        const data = await api.getSessionQR(sessionId);
        const container = document.getElementById('qr-container');
        
        if (data.qr) {
            container.innerHTML = `
                <div class="qr-container">
                    <div class="qr-code">${data.qr}</div>
                    <p class="text-sm text-gray-600 mt-2">Scan with WhatsApp to connect</p>
                </div>
            `;
        } else {
            container.innerHTML = `
                <p class="text-gray-500">QR code not available</p>
            `;
        }
    } catch (error) {
        console.error('Failed to load QR:', error);
    }
}