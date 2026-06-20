/**
 * Clipper MessageBus — inter-module event bus using DOM CustomEvent.
 *
 * Events:
 *   'connect'         — { peerId, room }  — WS connected + joined room
 *   'disconnect'      — { wasIntentional } — WS disconnected
 *   'server-message'  — { msg, type }     — Raw WS message received, BEFORE module handling
 *   'readonly-change' — { enabled }       — Read-only mode toggled
 *   'room-joined'     — { room, peerId }  — Successfully joined a room
 *   'peer-joined'     — { peerId }        — A peer connected
 *   'peer-left'       — { peerId }        — A peer disconnected
 *   'error'           — { message }       — Global error
 *   'module-error'    — { module, error } — A module's handler threw (no crash propagation)
 *   'state-synced'    — {}                — Server room-state merge completed
 */
class MessageBus {
    constructor() {
        this._el = document.createElement('div');
        this._el.style.display = 'none';
        document.body.appendChild(this._el);
    }

    /**
     * Subscribe to an event.
     * @param {string} event - Event name
     * @param {function} handler - Callback receiving { detail: eventData }
     * @returns {function} unsubscribe function
     */
    on(event, handler) {
        const wrapped = (e) => handler(e.detail);
        this._el.addEventListener(event, wrapped);
        return () => this._el.removeEventListener(event, wrapped);
    }

    /**
     * Subscribe to an event once.
     * @param {string} event
     * @param {function} handler
     * @returns {function} unsubscribe function
     */
    once(event, handler) {
        const wrapped = (e) => handler(e.detail);
        this._el.addEventListener(event, wrapped, { once: true });
        return () => this._el.removeEventListener(event, wrapped);
    }

    /**
     * Emit an event with data.
     * @param {string} event - Event name
     * @param {*} detail - Event payload
     */
    emit(event, detail = {}) {
        this._el.dispatchEvent(new CustomEvent(event, { detail }));
    }

    /**
     * Remove all listeners for a specific event by replacing the DOM element.
     * @param {string} event
     */
    clear(event) {
        const newEl = document.createElement('div');
        newEl.style.display = 'none';
        this._el.parentNode.replaceChild(newEl, this._el);
        this._el = newEl;
    }

    /**
     * Remove the DOM element, cleaning up all listeners.
     */
    destroy() {
        if (this._el && this._el.parentNode) {
            this._el.parentNode.removeChild(this._el);
        }
    }
}
