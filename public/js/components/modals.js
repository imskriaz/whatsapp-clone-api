class ModalManager {
    constructor() { this.activeModal = null; }
    show(name) { console.log('Showing modal:', name); }
}
class SettingsModal {}
class SessionManagerModal {}
window.ModalManager = ModalManager;
window.Modals = new ModalManager();
