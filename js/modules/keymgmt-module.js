/**
 * KeyMgmtModule — key/stream management feature module.
 *
 * Depends on: ClipperModule (js/core/module-base.js)
 * Globals: APP, escapeHtml, showPopup, showConfirmDialog
 */
class KeyMgmtModule extends ClipperModule {
    constructor(bus, wsManager) {
        super('keymgmt', bus, wsManager);
        this._entries = [];

        wsManager.onMessage([
            'keymgmt-create', 'keymgmt-edit', 'keymgmt-delete',
            'keymgmt-toggle-active', 'keymgmt-set-program'
        ], (data) => this._onKeyServerMessage(data), 'keymgmt');
    }

    load() {
        try {
            const raw = localStorage.getItem(APP.roomKey('vcc_keymgmt'));
            this._entries = raw ? JSON.parse(raw) : [];
        } catch (_) {
            this._entries = [];
        }
    }

    _save() {
        try {
            localStorage.setItem(APP.roomKey('vcc_keymgmt'), JSON.stringify(this._entries));
        } catch (_) {}
    }

    /** Handle room-state merge: filter deleted + merge server data + save + render. */
    mergeRoomState(data) {
        if (data.deletedKeyIds) {
            const deletedSet = new Set(data.deletedKeyIds);
            this._entries = this._entries.filter(e => !deletedSet.has(e.id));
        }
        if (data.keyManagements && Array.isArray(data.keyManagements)) {
            const serverIds = new Set(data.keyManagements.map(e => e.id));
            const localOnly = this._entries.filter(e => !serverIds.has(e.id));
            this._entries = [...data.keyManagements, ...localOnly];
        }
        this._save();
        this.render();
    }

    /** Handle keymgmt WS messages from other peers. */
    _onKeyServerMessage(data) {
        switch (data.type) {
            case 'keymgmt-create':
                if (data.entry && !this._entries.some(e => e.id === data.entry.id)) {
                    this._entries.push(data.entry);
                    this._save();
                    this.render();
                    showPopup('📡', '新密鑰', data.entry.label);
                }
                break;
            case 'keymgmt-edit': {
                const editEntry = this._entries.find(e => e.id === data.id);
                if (editEntry) {
                    if (data.label !== undefined) editEntry.label = data.label;
                    if (data.streamKey !== undefined) editEntry.streamKey = data.streamKey;
                    if (data.streamUrl !== undefined) editEntry.streamUrl = data.streamUrl;
                    if (data.currentProgram !== undefined) editEntry.currentProgram = data.currentProgram;
                    this._save();
                    this.render();
                }
                break;
            }
            case 'keymgmt-delete':
                this._entries = this._entries.filter(e => e.id !== data.id);
                this._save();
                this.render();
                break;
            case 'keymgmt-toggle-active': {
                const tglEntry = this._entries.find(e => e.id === data.id);
                if (tglEntry) {
                    tglEntry.isActive = !tglEntry.isActive;
                    this._save();
                    this.render();
                }
                break;
            }
            case 'keymgmt-set-program': {
                const progEntry = this._entries.find(e => e.id === data.id);
                if (progEntry) {
                    progEntry.currentProgram = data.currentProgram || '';
                    this._save();
                    this.render();
                }
                break;
            }
        }
    }

    createEntry(label, streamKey, streamUrl, currentProgram) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        if ((!APP.state.ws || APP.state.ws.readyState !== WebSocket.OPEN) || !APP.state.room) {
            APP.showStatusMsg('❌ 請先建立連線');
            return;
        }
        const entry = {
            id: crypto.randomUUID(),
            label: label,
            streamKey: streamKey,
            streamUrl: streamUrl,
            currentProgram: currentProgram || '',
            isActive: false,
            createdBy: APP.state.displayName,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this._entries.push(entry);
        this._save();
        this.wsManager.send({type: 'keymgmt-create', room: APP.state.room, entry: entry});
        this.render();
        APP.showStatusMsg('✅ 密鑰已新增');
    }

    editEntry(id, updates) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        const entry = this._entries.find(e => e.id === id);
        if (!entry) return;
        Object.assign(entry, updates);
        entry.updatedAt = Date.now();
        this._save();
        this.wsManager.send({type: 'keymgmt-edit', room: APP.state.room, id: id, ...updates});
        this.render();
        APP.showStatusMsg('✅ 密鑰已更新');
    }

    async deleteEntry(id) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        const entry = this._entries.find(e => e.id === id);
        if (!entry) { APP.showStatusMsg('❌ 找不到該密鑰'); return; }
        if (!await showConfirmDialog('確定刪除密鑰「' + entry.label + '」？')) return;
        this._entries = this._entries.filter(e => e.id !== id);
        this._save();
        this.wsManager.send({type: 'keymgmt-delete', room: APP.state.room, id: id});
        this.render();
        APP.showStatusMsg('✅ 密鑰已刪除');
    }

    toggleActive(id) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        const entry = this._entries.find(e => e.id === id);
        if (!entry) return;
        entry.isActive = !entry.isActive;
        entry.updatedAt = Date.now();
        this._save();
        this.wsManager.send({type: 'keymgmt-toggle-active', room: APP.state.room, id: id});
        this.render();
        APP.showStatusMsg(entry.isActive ? '🟢 已設為使用中' : '⚫ 已設為未使用');
    }

    setProgram(id, currentProgram) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        const entry = this._entries.find(e => e.id === id);
        if (!entry) return;
        entry.currentProgram = currentProgram || '';
        entry.updatedAt = Date.now();
        this._save();
        this.wsManager.send({type: 'keymgmt-set-program', room: APP.state.room, id: id, currentProgram: entry.currentProgram});
        this.render();
        APP.showStatusMsg('✅ 節目已設定');
    }

    render() {
        this.renderKeyManagement();
    }

    renderKeyManagement() {
        const cards = document.getElementById('keymgmtCards');
        const stats = document.getElementById('keymgmtStats');
        if (!cards) return;
        const sorted = [...this._entries].sort((a, b) => b.createdAt - a.createdAt);
        const activeCount = this._entries.filter(e => e.isActive).length;
        if (stats) stats.textContent = '共 ' + this._entries.length + ' 個密鑰，' + activeCount + ' 個使用中';
        if (sorted.length === 0) {
            cards.innerHTML = '<div style="color:#475569;text-align:center;padding:40px;">尚無密鑰，點擊上方按鈕新增</div>';
            return;
        }
        cards.innerHTML = sorted.map(entry => {
            const activeClass = entry.isActive ? 'active' : '';
            const badgeClass = entry.isActive ? 'on' : 'off';
            const badgeText = entry.isActive ? '🟢 使用中' : '⚫ 未使用';
            const maskedKey = entry.streamKey ? entry.streamKey.slice(0, 4) + '****' + entry.streamKey.slice(-4) : '----';
            const urlTrunc = entry.streamUrl ? (entry.streamUrl.length > 40 ? entry.streamUrl.slice(0, 40) + '...' : entry.streamUrl) : '';
            const progText = entry.currentProgram ? entry.currentProgram : '未設定節目';
            return '<div class="keymgmt-card ' + activeClass + '">'
                + '<div class="keymgmt-card-header">'
                + '<span class="keymgmt-active-badge ' + badgeClass + '">' + badgeText + '</span>'
                + '<span class="keymgmt-card-label">' + escapeHtml(entry.label) + '</span>'
                + '<button class="btn-icon" data-action="edit" data-id="' + entry.id + '" title="編輯">✏️</button>'
                + '<button class="btn-icon" data-action="toggle" data-id="' + entry.id + '" title="切換啟用狀態">🔀</button>'
                + '<button class="btn-icon" data-action="delete" data-id="' + entry.id + '" title="刪除" style="color:#ef4444;">🗑</button>'
                + '</div>'
                + '<div class="keymgmt-card-url" title="' + escapeHtml(entry.streamUrl) + '">' + escapeHtml(urlTrunc) + '</div>'
                + '<div class="keymgmt-card-key">🔑 ' + maskedKey + ' <button class="keymgmt-copy-btn" data-action="copy-key" data-id="' + entry.id + '">📋 複製</button> <button class="keymgmt-copy-btn" data-action="copy-url" data-id="' + entry.id + '">📋 複製網址</button></div>'
                + '<div class="keymgmt-card-program">🎬 節目: ' + escapeHtml(progText) + ' <button class="keymgmt-copy-btn" data-action="set-program" data-id="' + entry.id + '">✏️ 設定節目</button></div>'
                + '</div>';
        }).join('');
        const self = this;
        cards.querySelectorAll('[data-action="edit"]').forEach(btn => {
            btn.addEventListener('click', function(e) { e.stopPropagation(); const entry = self._entries.find(e => e.id === this.dataset.id); if (entry) self.showKeyForm(entry); });
        });
        cards.querySelectorAll('[data-action="toggle"]').forEach(btn => {
            btn.addEventListener('click', function(e) { e.stopPropagation(); self.toggleActive(this.dataset.id); });
        });
        cards.querySelectorAll('[data-action="delete"]').forEach(btn => {
            btn.addEventListener('click', function(e) { e.stopPropagation(); self.deleteEntry(this.dataset.id); });
        });
        cards.querySelectorAll('[data-action="copy-key"]').forEach(btn => {
            btn.addEventListener('click', function(e) { e.stopPropagation(); const entry = self._entries.find(e => e.id === this.dataset.id); if (entry) { navigator.clipboard.writeText(entry.streamKey).then(() => APP.showStatusMsg('✅ 密鑰已複製')).catch(() => APP.showStatusMsg('❌ 複製失敗')); } });
        });
        cards.querySelectorAll('[data-action="copy-url"]').forEach(btn => {
            btn.addEventListener('click', function(e) { e.stopPropagation(); const entry = self._entries.find(e => e.id === this.dataset.id); if (entry) { navigator.clipboard.writeText(entry.streamUrl).then(() => APP.showStatusMsg('✅ 網址已複製')).catch(() => APP.showStatusMsg('❌ 複製失敗')); } });
        });
        cards.querySelectorAll('[data-action="set-program"]').forEach(btn => {
            btn.addEventListener('click', function(e) { e.stopPropagation(); self.showKeyProgramForm(this.dataset.id); });
        });
    }

    showKeyForm(entry) {
        const existing = document.querySelector('.keymgmt-form-overlay');
        if (existing) existing.remove();
        const isEdit = !!entry;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay keymgmt-form-overlay';
        overlay.innerHTML = '<div class="modal-dialog" style="max-width:420px;">'
            + '<h3 style="font-size:20px;font-weight:600;margin-bottom:16px;">' + (isEdit ? '✏️ 編輯密鑰' : '➕ 新增密鑰') + '</h3>'
            + '<input type="text" class="notice-form-input" id="keymgmtFormLabel" placeholder="標籤（必填）" value="' + (isEdit ? escapeHtml(entry.label) : '') + '">'
            + '<input type="text" class="notice-form-input" id="keymgmtFormKey" placeholder="串流金鑰（必填）" value="' + (isEdit ? escapeHtml(entry.streamKey) : '') + '">'
            + '<input type="text" class="notice-form-input" id="keymgmtFormUrl" placeholder="串流網址（必填）" value="' + (isEdit ? escapeHtml(entry.streamUrl) : '') + '">'
            + '<input type="text" class="notice-form-input" id="keymgmtFormProgram" placeholder="節目名稱（選填）" value="' + (isEdit ? escapeHtml(entry.currentProgram || '') : '') + '">'
            + '<div class="notice-form-buttons">'
            + '<button class="btn btn-secondary" id="keymgmtFormCancel">取消</button>'
            + '<button class="btn btn-primary" id="keymgmtFormSave">' + (isEdit ? '儲存' : '新增') + '</button>'
            + '</div></div>';
        document.body.appendChild(overlay);
        const self = this;
        document.getElementById('keymgmtFormCancel').addEventListener('click', () => overlay.remove());
        document.getElementById('keymgmtFormSave').addEventListener('click', () => {
            const label = document.getElementById('keymgmtFormLabel').value.trim();
            const streamKey = document.getElementById('keymgmtFormKey').value.trim();
            const streamUrl = document.getElementById('keymgmtFormUrl').value.trim();
            const currentProgram = document.getElementById('keymgmtFormProgram').value.trim();
            if (!label || !streamKey || !streamUrl) {
                APP.showStatusMsg('❌ 標籤、金鑰和網址為必填');
                return;
            }
            if (isEdit) {
                self.editEntry(entry.id, {label, streamKey, streamUrl, currentProgram});
            } else {
                self.createEntry(label, streamKey, streamUrl, currentProgram);
            }
            overlay.remove();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('keymgmtFormLabel').focus();
    }

    showKeyProgramForm(entryId) {
        const entry = this._entries.find(e => e.id === entryId);
        if (!entry) return;
        const existing = document.querySelector('.keymgmt-program-overlay');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay keymgmt-program-overlay';
        overlay.innerHTML = '<div class="modal-dialog" style="max-width:360px;">'
            + '<h3 style="font-size:20px;font-weight:600;margin-bottom:16px;">🎬 設定節目</h3>'
            + '<p style="font-size:14px;color:#94a3b8;margin-bottom:8px;">' + escapeHtml(entry.label) + '</p>'
            + '<input type="text" class="notice-form-input" id="keymgmtProgramInput" placeholder="節目名稱" value="' + escapeHtml(entry.currentProgram || '') + '">'
            + '<div class="notice-form-buttons">'
            + '<button class="btn btn-secondary" id="keymgmtProgramCancel">取消</button>'
            + '<button class="btn btn-primary" id="keymgmtProgramSave">設定</button>'
            + '</div></div>';
        document.body.appendChild(overlay);
        const self = this;
        document.getElementById('keymgmtProgramCancel').addEventListener('click', () => overlay.remove());
        document.getElementById('keymgmtProgramSave').addEventListener('click', () => {
            const program = document.getElementById('keymgmtProgramInput').value.trim();
            self.setProgram(entryId, program);
            overlay.remove();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('keymgmtProgramInput').focus();
    }
}
