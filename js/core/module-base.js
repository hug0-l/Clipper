/**
 * Clipper ModuleBase — base class for all feature modules.
 *
 * Provides consistent lifecycle: constructor → mount(container) → handleServerMessage(msg) → unmount()
 * with isolated error handling and bus integration.
 *
 * Depends on: MessageBus (js/core/message-bus.js), WSManager (js/core/ws-manager.js)
 */
class ClipperModule {
    constructor(name, bus, wsManager) {
        this.name = name;
        this.bus = bus;
        this.wsManager = wsManager;
        this._container = null;
        this._mounted = false;
    }

    get mounted() {
        return this._mounted;
    }

    mount(container) {
        this._container = container;
        try {
            this._mount();
            this._mounted = true;
            return true;
        } catch (err) {
            console.error(`[Module:${this.name}] mount error:`, err);
            this.bus.emit('module-error', { module: this.name, error: err, phase: 'mount' });
            container.innerHTML = `<div class="module-error">⚠️ ${this.name} 載入失敗</div>`;
            return false;
        }
    }

    unmount() {
        try {
            this._unmount();
        } catch (err) {
            console.error(`[Module:${this.name}] unmount error:`, err);
        }
        this._mounted = false;
        this._container = null;
    }

    handleServerMessage(msg) {
        // Override in subclass to handle WS messages
    }

    _mount() {
        // Subclass hook — override with mount logic
    }

    _unmount() {
        // Subclass hook — override with cleanup logic
    }
}
