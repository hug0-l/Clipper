class PluginRegistry {
    constructor(bus, wsManager) {
        this._bus = bus;
        this._wsManager = wsManager;
        this._plugins = new Map();
        this._tabPanes = new Map();
        this._nav = document.querySelector('nav');
        this._mainContent = document.querySelector('.main-content');
        this._dropdown = document.getElementById('moreDropdown');
    }

    registerPlugin(desc) {
        if (!desc || !desc.name) { console.warn('[Plugins] Plugin missing name'); return; }
        if (this._plugins.has(desc.name)) { console.warn('[Plugins] Plugin "' + desc.name + '" already registered'); return; }

        const plugin = {
            name: desc.name,
            version: desc.version || '0.0.0',
            displayName: desc.displayName || desc.name,
            description: desc.description || '',
            icon: desc.icon || '🔌',
            tab: desc.tab || { position: 'dropdown', title: desc.displayName || desc.name },
            mount: typeof desc.mount === 'function' ? desc.mount.bind(desc) : null,
            unmount: typeof desc.unmount === 'function' ? desc.unmount.bind(desc) : null,
            wsHandlers: desc.wsHandlers || {},
            css: desc.css || '',
        };

        // 1. Inject CSS
        if (plugin.css) {
            const styleId = 'plugin-css-' + plugin.name;
            if (!document.getElementById(styleId)) {
                const style = document.createElement('style');
                style.id = styleId;
                style.textContent = plugin.css;
                document.head.appendChild(style);
            }
        }

        // 2. Create tab button
        const tab = plugin.tab;
        const tabName = 'plugin-' + plugin.name;
        const btn = document.createElement('button');
        btn.className = 'tab-btn' + (tab.position === 'nav' ? '' : ' dropdown-item');
        if (tab.position === 'nav') {
            btn.dataset.target = tabName;
        } else {
            btn.dataset.tab = tabName;
            btn.style.cssText = 'display:block;width:100%;text-align:left;border:none;border-radius:6px;';
        }
        btn.textContent = (plugin.icon || '') + ' ' + (tab.title || plugin.displayName);

        // Insert at correct position
        if (tab.position === 'nav') {
            this._insertNavButton(btn, tab.afterTarget);
        } else {
            this._insertDropdownItem(btn, tab.afterTarget);
        }

        // 3. Create tab pane
        const pane = document.createElement('section');
        pane.className = 'tab-pane';
        pane.dataset.tab = tabName;
        pane.innerHTML = '<div class="pane-placeholder"><span style="font-size:40px;">' + (plugin.icon || '🔌') + '</span><p>' + (typeof escapeHtml === 'function' ? escapeHtml(plugin.description) : plugin.description) + '</p></div>';
        if (this._mainContent) this._mainContent.appendChild(pane);

        // 4. Register WS handlers
        const handlerNames = [];
        for (const [type, handler] of Object.entries(plugin.wsHandlers)) {
            if (typeof handler === 'function') {
                this._wsManager.onMessage(type, handler.bind(plugin), 'plugin-' + plugin.name);
                handlerNames.push(type);
            }
        }

        // 5. Mount
        let moduleInstance = null;
        try {
            if (typeof plugin.mount === 'function') {
                plugin.mount(pane);
            }
        } catch (err) {
            console.error('[Plugins] mount error for "' + plugin.name + '":', err);
        }

        // Store
        plugin._btn = btn;
        plugin._pane = pane;
        plugin._handlerTypes = handlerNames;
        this._plugins.set(plugin.name, plugin);
        this._tabPanes.set(plugin.name, pane);
        console.log('[Plugins] Registered: ' + plugin.name + ' v' + plugin.version);
    }

    unregisterPlugin(name) {
        const plugin = this._plugins.get(name);
        if (!plugin) return;

        // 1. Unmount
        try {
            if (typeof plugin.unmount === 'function') {
                plugin.unmount();
            }
        } catch (err) {
            console.error('[Plugins] unmount error for "' + name + '":', err);
        }

        // 2. Remove WS handlers
        this._wsManager.unregisterModule('plugin-' + name);

        // 3. Remove tab pane
        if (plugin._pane && plugin._pane.parentNode) {
            plugin._pane.parentNode.removeChild(plugin._pane);
        }

        // 4. Remove tab button
        if (plugin._btn && plugin._btn.parentNode) {
            plugin._btn.parentNode.removeChild(plugin._btn);
        }

        // 5. Remove CSS
        const styleId = 'plugin-css-' + name;
        const style = document.getElementById(styleId);
        if (style) style.remove();

        this._plugins.delete(name);
        this._tabPanes.delete(name);
        console.log('[Plugins] Unregistered: ' + name);
    }

    getPlugin(name) {
        return this._plugins.get(name) || null;
    }

    getPlugins() {
        return Array.from(this._plugins.values());
    }

    setPluginEnabled(name, enabled) {
        const plugin = this._plugins.get(name);
        if (!plugin) return;
        plugin._disabled = !enabled;
        if (plugin._btn) plugin._btn.style.display = enabled ? '' : 'none';
        if (plugin._pane) {
            if (!enabled) {
                plugin._pane.classList.remove('active');
                plugin._pane.style.display = 'none';
            } else {
                plugin._pane.style.display = '';
            }
        }
        localStorage.setItem('plugin_disabled_' + name, enabled ? '' : '1');
    }

    isPluginEnabled(name) {
        const plugin = this._plugins.get(name);
        if (!plugin) return false;
        if (plugin._disabled !== undefined) return !plugin._disabled;
        return localStorage.getItem('plugin_disabled_' + name) !== '1';
    }

    // Alias for convenience (used by plugin scripts)
    register(desc) {
        return this.registerPlugin(desc);
    }

    // ── helpers ──

    _insertNavButton(btn, afterTarget) {
        if (!this._nav) return;
        if (afterTarget) {
            const ref = this._nav.querySelector('[data-target="' + afterTarget + '"]');
            if (ref && ref.parentNode) {
                ref.parentNode.insertBefore(btn, ref.nextSibling);
                return;
            }
        }
        // Insert before the dropdown
        const dropdown = this._nav.querySelector('.dropdown');
        if (dropdown) {
            this._nav.insertBefore(btn, dropdown);
        } else {
            this._nav.appendChild(btn);
        }
    }

    _insertDropdownItem(btn, afterTarget) {
        if (!this._dropdown) return;
        if (afterTarget) {
            const ref = this._dropdown.querySelector('[data-tab="' + afterTarget + '"]');
            if (ref && ref.parentNode) {
                ref.parentNode.insertBefore(btn, ref.nextSibling);
                return;
            }
        }
        this._dropdown.appendChild(btn);
    }
}
