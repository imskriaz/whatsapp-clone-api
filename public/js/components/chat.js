class ChatArea {
    render() { return '<div class="chat-area">Chat Area</div>'; }
    attachEvents() {}
    loadMessages(sid, jid) { console.log('Loading messages:', sid, jid); }
}
window.ChatArea = ChatArea;
