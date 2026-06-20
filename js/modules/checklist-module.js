/**
 * ChecklistModule — Checklist Board CRUD + Import/Export
 *
 * Extends ClipperModule. Handles creating, editing, deleting, pinning, resetting
 * checklist boards and items, with reminder support and import/export.
 *
 * Depends on: ClipperModule (js/core/module-base.js), MessageBus, WSManager
 * Global deps: window.APP, window.saveToStorage, window.loadFromStorage,
 *   window.sendWsMessage, window.showConfirmDialog, window.escapeHtml,
 *   window.showPopup
 */
class ChecklistModule extends ClipperModule {
    constructor(bus, wsManager) {
        super('checklist', bus, wsManager);
        this.COLORS = [
            { value: '#38bdf8', label: '天藍' },
            { value: '#22c55e', label: '綠色' },
            { value: '#ef4444', label: '紅色' },
            { value: '#f59e0b', label: '琥珀' },
            { value: '#a855f7', label: '紫色' },
            { value: '#ec4899', label: '粉紅' },
            { value: '#06b6d4', label: '青色' },
            { value: '#84cc16', label: '萊姆' },
            { value: '#f97316', label: '橙色' },
            { value: '#64748b', label: '灰色' },
        ];

        // Register WS message handlers
        wsManager.onMessage([
            'checklistboard-create', 'checklistboard-edit', 'checklistboard-delete',
            'checklistboard-pin', 'checklistboard-remind',
            'checklist-add', 'checklist-toggle', 'checklist-delete', 'checklist-reset'
        ], (data) => this.handleServerMessage(data), 'checklist');

        this._reminderTimer = null;
    }

    _mount() {
        // Expose render globally for backward compat (templates-module.js, room-state/joined handlers)
        window.renderChecklistBoards = () => this.renderBoards();
        // Expose COLORS for backward compat
        window.CHECKLIST_COLORS = this.COLORS;

        // Load state
        APP.state.checklists = loadFromStorage(APP.roomKey('vcc_checklists'), []);

        // Render
        this.renderBoards();

        // Wire "新增大綱表" button
        const newBtn = document.getElementById('btnNewChecklist');
        if (newBtn) newBtn.addEventListener('click', () => this.showForm(null));

        // Wire import/export buttons
        const exportBtn = document.getElementById('btnExportChecklist');
        if (exportBtn) exportBtn.addEventListener('click', () => this._showExportMenu());

        const importBtn = document.getElementById('btnImportChecklist');
        if (importBtn) importBtn.addEventListener('click', () => this._showImportPicker());

        // Copy markdown button
        const copyBtn = document.getElementById('btnCopyChecklistMd');
        if (copyBtn) copyBtn.addEventListener('click', () => this._copyMarkdown());

        // Start periodic reminder checker
        this._reminderTimer = setInterval(() => this._checkReminders(), 15000);
    }

    _unmount() {
        if (this._reminderTimer) {
            clearInterval(this._reminderTimer);
            this._reminderTimer = null;
        }
    }

    handleServerMessage(data) {
        switch (data.type) {
            case 'checklistboard-create':
                if (data.board && !APP.state.checklists.some(b => b.id === data.board.id)) {
                    APP.state.checklists.push(data.board);
                    saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                    this.renderBoards();
                    window.showPopup('✅', '新檢查清單',
                        (data.board.createdBy ? data.board.createdBy + '：' : '') +
                        (data.board.title ? data.board.title : ''));
                }
                break;

            case 'checklistboard-edit': {
                const board = APP.state.checklists.find(b => b.id === data.id);
                if (board) {
                    if (data.title !== undefined) board.title = data.title;
                    if (data.category !== undefined) board.category = data.category;
                    if (data.tags !== undefined) board.tags = data.tags;
                    if (data.color !== undefined) board.color = data.color;
                    saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                    this.renderBoards();
                }
                break;
            }

            case 'checklistboard-delete':
                APP.state.checklists = APP.state.checklists.filter(b => b.id !== data.id);
                saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                this.renderBoards();
                break;

            case 'checklistboard-pin': {
                const pinBoard = APP.state.checklists.find(b => b.id === data.id);
                if (pinBoard) {
                    pinBoard.pinned = data.pinned;
                    saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                    this.renderBoards();
                }
                break;
            }

            case 'checklistboard-remind': {
                const remBoard = APP.state.checklists.find(b => b.id === data.id);
                if (remBoard) {
                    remBoard.reminderAt = data.reminderAt;
                    remBoard.reminderTitle = data.reminderTitle || '';
                    saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                    this.renderBoards();
                }
                break;
            }

            case 'checklist-add': {
                const addBoard = APP.state.checklists.find(b => b.id === data.checklistId);
                if (addBoard && data.item && !addBoard.items.some(i => i.id === data.item.id)) {
                    addBoard.items.push(data.item);
                    saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                    this.renderBoards();
                    window.showPopup('✅', '新待辦項目',
                        (data.item.addedBy ? data.item.addedBy + ' 在「' + addBoard.title + '」：' : '') +
                        (data.item.text ? data.item.text : ''));
                }
                break;
            }

            case 'checklist-toggle': {
                const tglBoard = APP.state.checklists.find(b => b.id === data.checklistId);
                if (tglBoard) {
                    const tglItem = tglBoard.items.find(i => i.id === data.id);
                    if (tglItem) {
                        tglItem.checked = data.checked;
                        tglItem.checkedAt = data.checkedAt;
                        saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                        this.renderBoards();
                    }
                }
                break;
            }

            case 'checklist-delete': {
                const delBoard = APP.state.checklists.find(b => b.id === data.checklistId);
                if (delBoard) {
                    delBoard.items = delBoard.items.filter(i => i.id !== data.id);
                    saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                    this.renderBoards();
                }
                break;
            }

            case 'checklist-reset': {
                const rBoard = APP.state.checklists.find(b => b.id === data.id);
                if (rBoard) {
                    for (const item of rBoard.items) {
                        item.checked = false;
                        item.checkedAt = null;
                    }
                    saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                    this.renderBoards();
                }
                break;
            }
        }
    }

    // ==================== RENDERING ====================

    renderBoards() {
        const container = document.getElementById('checklistBoards');
        if (!container) return;
        const boards = APP.state.checklists;
        if (boards.length === 0) {
            container.innerHTML = '<div style="color:#475569;font-size:18px;text-align:center;padding:40px;">暫無檢查清單，點擊上方按鈕新增</div>';
            return;
        }
        const sorted = [...boards].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return (b.createdAt || 0) - (a.createdAt || 0);
        });
        const self = this;
        container.innerHTML = sorted.map(board => {
            const color = board.color || '#38bdf8';
            const expandedClass = board._expanded ? 'expanded' : '';
            const arrowClass = board._expanded ? 'expanded' : '';
            const tagsHtml = self._renderTags(board.tags);
            const itemsHtml = self._renderItems(board);
            const bodyClass = board._expanded ? 'checklist-board-body expanded' : 'checklist-board-body';
            return '<div class="checklist-board' + (board.pinned ? ' pinned' : '') + '" data-id="' + board.id + '" style="border-left-color:' + color + '">'
                + '<div class="checklist-board-header" data-toggle="' + board.id + '">'
                + '<span class="checklist-board-arrow ' + arrowClass + '">▶</span>'
                + '<span class="checklist-board-title">' + escapeHtml(board.title) + '</span>'
                + (board.category ? '<span class="checklist-board-category">' + escapeHtml(board.category) + '</span>' : '')
                + tagsHtml
                + (board.pinned ? '<span class="checklist-board-pin-badge">📌</span>' : '')
                + '<span class="checklist-board-actions">'
                + '<button class="btn-icon" data-action="add-item" data-id="' + board.id + '" title="新增項目">➕</button>'
                + '<button class="btn-icon" data-action="edit" data-id="' + board.id + '" title="編輯">✏️</button>'
                + (board.reminderAt ? '<span class="checklist-board-pin-badge" title="排程提醒於 ' + new Date(board.reminderAt).toLocaleString('zh-TW') + '">🔔 ' + new Date(board.reminderAt).toLocaleTimeString('zh-TW', {hour:'2-digit',minute:'2-digit'}) + '</span>' : '')
                + '<button class="btn-icon" data-action="pin" data-id="' + board.id + '" title="' + (board.pinned ? '取消置頂' : '置頂') + '">📌</button>'
                + '<button class="btn-icon cl-reset-btn" data-action="reset" data-id="' + board.id + '" title="全部重設" style="color:#f59e0b">🔄</button>'
                + '<button class="btn-icon" data-action="remind" data-id="' + board.id + '" title="設定提醒">🔔</button>'
                + '<button class="btn-icon" data-action="delete" data-id="' + board.id + '" title="刪除" style="color:#ef4444">🗑</button>'
                + '</span>'
                + '</div>'
                + '<div class="' + bodyClass + '">'
                + (board.items && board.items.length > 0
                    ? '<div class="checklist-board-items">' + itemsHtml + '</div>'
                    : '<div class="checklist-board-empty">暫無項目</div>')
                + '<div class="checklist-board-add-bar">'
                + '<input type="text" class="checklist-board-item-input" data-board-id="' + board.id + '" placeholder="新增項目，Enter 新增...">'
                + '<button class="btn btn-primary" style="padding:4px 10px;font-size:15px;" data-action="add-item-btn" data-id="' + board.id + '">新增</button>'
                + '</div>'
                + '</div>'
                + '</div>';
        }).join('');
        this._wireEvents(container);
    }

    _wireEvents(container) {
        const self = this;
        container.querySelectorAll('[data-toggle]').forEach(el => {
            el.addEventListener('click', function() {
                const id = this.dataset.toggle;
                const board = APP.state.checklists.find(b => b.id === id);
                if (board) {
                    board._expanded = !board._expanded;
                    self.renderBoards();
                }
            });
        });
        container.querySelectorAll('[data-action="add-item"]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                const id = this.dataset.id;
                const board = APP.state.checklists.find(b => b.id === id);
                if (board) {
                    board._expanded = true;
                    self.renderBoards();
                    setTimeout(() => {
                        const input = container.querySelector('.checklist-board-item-input[data-board-id="' + id + '"]');
                        if (input) input.focus();
                    }, 50);
                }
            });
        });
        container.querySelectorAll('[data-action="edit"]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                self.showForm({ id: this.dataset.id });
            });
        });
        container.querySelectorAll('[data-action="pin"]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                self._togglePin(this.dataset.id);
            });
        });
        container.querySelectorAll('[data-action="reset"]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                self._resetBoard(this.dataset.id);
            });
        });
        container.querySelectorAll('[data-action="remind"]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                self._showReminderForm(this.dataset.id);
            });
        });
        container.querySelectorAll('[data-action="delete"]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                self._deleteBoard(this.dataset.id);
            });
        });
        container.querySelectorAll('.checklist-board-item-input').forEach(input => {
            input.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && this.value.trim()) {
                    self._addItem(this.dataset.boardId, this.value);
                    this.value = '';
                }
            });
        });
        container.querySelectorAll('[data-action="add-item-btn"]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                const id = this.dataset.id;
                const input = container.querySelector('.checklist-board-item-input[data-board-id="' + id + '"]');
                if (input && input.value.trim()) {
                    self._addItem(id, input.value);
                    input.value = '';
                }
            });
        });
        container.querySelectorAll('.checklist-board-item-checkbox').forEach(cb => {
            cb.addEventListener('change', function() {
                self._toggleItem(this.dataset.boardId, this.dataset.itemId);
            });
        });
        container.querySelectorAll('.checklist-board-item-text').forEach(el => {
            el.addEventListener('click', function() {
                self._toggleItem(this.dataset.boardId, this.dataset.itemId);
            });
        });
        container.querySelectorAll('.checklist-board-item-del').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                self._deleteItem(this.dataset.boardId, this.dataset.itemId);
            });
        });
    }

    _renderTags(tags) {
        if (!tags || tags.length === 0) return '';
        const maxShow = 3;
        const visible = tags.slice(0, maxShow);
        const overflow = tags.length - maxShow;
        let html = '<span class="checklist-board-tags">';
        for (const tag of visible) {
            html += '<span class="checklist-board-tag">' + escapeHtml(tag) + '</span>';
        }
        if (overflow > 0) {
            html += '<span class="checklist-board-tag">+' + overflow + '</span>';
        }
        html += '</span>';
        return html;
    }

    _renderItems(board) {
        if (!board.items || board.items.length === 0) return '';
        const items = [...board.items].sort((a, b) => {
            if (a.checked !== b.checked) return a.checked ? 1 : -1;
            if (!a.checked) return a.timestamp - b.timestamp;
            return (b.checkedAt || 0) - (a.checkedAt || 0);
        });
        return items.map(item => {
            const timeStr = new Date(item.timestamp).toLocaleTimeString('zh-TW', {hour:'2-digit',minute:'2-digit'});
            const doneClass = item.checked ? ' done' : '';
            return '<div class="checklist-board-item' + doneClass + '">'
                + '<input type="checkbox" class="checklist-board-item-checkbox" data-board-id="' + board.id + '" data-item-id="' + item.id + '" ' + (item.checked ? 'checked' : '') + '>'
                + '<span class="checklist-board-item-text' + doneClass + '" data-board-id="' + board.id + '" data-item-id="' + item.id + '">' + escapeHtml(item.text) + '</span>'
                + '<span class="checklist-board-item-meta">' + escapeHtml(item.addedBy) + ' · ' + timeStr + '</span>'
                + '<button class="checklist-board-item-del" data-board-id="' + board.id + '" data-item-id="' + item.id + '" title="刪除">🗑</button>'
                + '</div>';
        }).join('');
    }

    // ==================== BOARD CRUD ====================

    showForm(boardOrId) {
        const board = (typeof boardOrId === 'object' && boardOrId)
            ? boardOrId
            : (boardOrId ? APP.state.checklists.find(b => b.id === boardOrId) : null);
        const isEdit = !!board;
        const existingOverlay = document.querySelector('.checklist-v2-form');
        if (existingOverlay) existingOverlay.remove();

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay checklist-v2-form';
        const colorsHtml = this.COLORS.map(c => {
            const selected = isEdit && board.color === c.value ? ' selected' : '';
            return '<span class="color-swatch' + selected + '" data-color="' + c.value + '" style="background:' + c.value + ';" title="' + c.label + '"></span>';
        }).join('');
        overlay.innerHTML = '<div class="modal-dialog" style="max-width:420px;">'
            + '<h3 style="font-size:20px;font-weight:600;margin-bottom:16px;">' + (isEdit ? '✏️ 編輯檢查清單' : '📋 新增檢查清單') + '</h3>'
            + '<input type="text" class="notice-form-input" id="clFormTitle" placeholder="標題（必填）" value="' + (isEdit ? escapeHtml(board.title) : '') + '">'
            + '<input type="text" class="notice-form-input" id="clFormCategory" placeholder="分類（選填）" value="' + (isEdit ? escapeHtml(board.category || '') : '') + '">'
            + '<input type="text" class="notice-form-input" id="clFormTags" placeholder="標籤，逗號分隔" value="' + (isEdit && board.tags ? escapeHtml(board.tags.join(',')) : '') + '">'
            + '<div style="font-size:16px;color:#94a3b8;margin-bottom:8px;">顏色</div>'
            + '<div class="color-picker" id="clFormColorPicker">' + colorsHtml + '</div>'
            + '<div class="notice-form-buttons" style="margin-top:16px;">'
            + '<button class="btn btn-secondary" id="clFormCancel">取消</button>'
            + '<button class="btn btn-primary" id="clFormSave">' + (isEdit ? '儲存' : '新增') + '</button>'
            + '</div></div>';
        document.body.appendChild(overlay);

        let selectedColor = isEdit ? board.color : '#38bdf8';
        const self = this;
        document.getElementById('clFormColorPicker').querySelectorAll('.color-swatch').forEach(el => {
            el.addEventListener('click', function() {
                document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
                this.classList.add('selected');
                selectedColor = this.dataset.color;
            });
        });

        document.getElementById('clFormCancel').addEventListener('click', () => overlay.remove());
        document.getElementById('clFormSave').addEventListener('click', () => {
            const title = document.getElementById('clFormTitle').value.trim();
            if (!title) {
                APP.showStatusMsg('❌ 標題不能為空');
                return;
            }
            const category = document.getElementById('clFormCategory').value.trim();
            const tagsStr = document.getElementById('clFormTags').value.trim();
            const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];
            if (isEdit) {
                const b = APP.state.checklists.find(b => b.id === board.id);
                if (b) {
                    b.title = title;
                    b.category = category;
                    b.tags = tags;
                    b.color = selectedColor;
                    saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                    sendWsMessage({type: 'checklistboard-edit', room: APP.state.room, id: b.id, title, category, tags, color: selectedColor});
                    self.renderBoards();
                    APP.showStatusMsg('✅ 檢查清單已更新');
                }
            } else {
                if (APP.state.readOnly) {
                    APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
                    return;
                }
                if ((!APP.state.ws || APP.state.ws.readyState !== WebSocket.OPEN) || !APP.state.room) {
                    APP.showStatusMsg('❌ 請先建立連線');
                    return;
                }
                const newBoard = {
                    id: crypto.randomUUID(),
                    title: title,
                    category: category,
                    tags: tags,
                    color: selectedColor,
                    pinned: false,
                    createdBy: APP.state.displayName,
                    createdAt: Date.now(),
                    items: []
                };
                APP.state.checklists.push(newBoard);
                saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                sendWsMessage({type: 'checklistboard-create', room: APP.state.room, board: newBoard});
                self.renderBoards();
                APP.showStatusMsg('✅ 檢查清單已新增');
            }
            overlay.remove();
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        document.getElementById('clFormTitle').focus();
    }

    _addItem(checklistId, text) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        if ((!APP.state.ws || APP.state.ws.readyState !== WebSocket.OPEN) || !APP.state.room) {
            APP.showStatusMsg('❌ 請先建立連線');
            return;
        }
        if (!text || !text.trim()) {
            APP.showStatusMsg('💡 請輸入待辦事項內容');
            return;
        }
        const board = APP.state.checklists.find(b => b.id === checklistId);
        if (!board) { APP.showStatusMsg('❌ 找不到該檢查清單'); return; }
        const newItem = {
            id: crypto.randomUUID(),
            text: text.trim(),
            checked: false,
            addedBy: APP.state.displayName,
            timestamp: Date.now(),
            checkedAt: null
        };
        board.items.push(newItem);
        saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
        sendWsMessage({type: 'checklist-add', room: APP.state.room, checklistId, item: newItem});
        this.renderBoards();
    }

    _toggleItem(checklistId, itemId) {
        if (APP.state.readOnly) return;
        const board = APP.state.checklists.find(b => b.id === checklistId);
        if (!board) return;
        const item = board.items.find(i => i.id === itemId);
        if (!item) return;
        item.checked = !item.checked;
        item.checkedAt = item.checked ? Date.now() : null;
        saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
        sendWsMessage({type: 'checklist-toggle', room: APP.state.room, checklistId, id: itemId, checked: item.checked, checkedAt: item.checkedAt});
        this.renderBoards();
    }

    async _deleteItem(checklistId, itemId) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        if (!await showConfirmDialog('確定刪除此項目？')) return;
        const board = APP.state.checklists.find(b => b.id === checklistId);
        if (!board) return;
        board.items = board.items.filter(i => i.id !== itemId);
        saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
        sendWsMessage({type: 'checklist-delete', room: APP.state.room, checklistId, id: itemId});
        this.renderBoards();
    }

    _togglePin(checklistId) {
        const board = APP.state.checklists.find(b => b.id === checklistId);
        if (!board) { APP.showStatusMsg('❌ 找不到該檢查清單'); return; }
        board.pinned = !board.pinned;
        saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
        sendWsMessage({type: 'checklistboard-pin', room: APP.state.room, id: checklistId, pinned: board.pinned});
        this.renderBoards();
    }

    async _deleteBoard(checklistId) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        const b = APP.state.checklists.find(b => b.id === checklistId);
        if (!b) { APP.showStatusMsg('❌ 找不到該檢查清單'); return; }
        if (!await showConfirmDialog('確定刪除「' + b.title + '」？（所有項目也將刪除）')) return;
        APP.state.checklists = APP.state.checklists.filter(b => b.id !== checklistId);
        saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
        sendWsMessage({type: 'checklistboard-delete', room: APP.state.room, id: checklistId});
        this.renderBoards();
    }

    _resetBoard(checklistId) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        const board = APP.state.checklists.find(b => b.id === checklistId);
        if (!board) { APP.showStatusMsg('❌ 找不到該檢查清單'); return; }
        const checkedCount = board.items.filter(i => i.checked).length;
        if (checkedCount === 0) { APP.showStatusMsg('💡 沒有已勾選的項目需要重設'); return; }
        for (const item of board.items) {
            item.checked = false;
            item.checkedAt = null;
        }
        saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
        sendWsMessage({type: 'checklist-reset', room: APP.state.room, id: checklistId});
        this.renderBoards();
        APP.showStatusMsg('🔄 已重設所有勾選');
    }

    _showReminderForm(checklistId) {
        const board = APP.state.checklists.find(b => b.id === checklistId);
        if (!board) return;
        const existingOverlay = document.querySelector('.cl-reminder-form');
        if (existingOverlay) existingOverlay.remove();

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay cl-reminder-form';
        const currentVal = board.reminderAt ? new Date(board.reminderAt).toISOString().slice(0, 16) : '';
        overlay.innerHTML = '<div class="modal-dialog" style="max-width:360px;">'
            + '<h3 style="font-size:20px;font-weight:600;margin-bottom:12px;">🔔 排程提醒</h3>'
            + '<p style="font-size:16px;color:#94a3b8;margin-bottom:12px;">' + escapeHtml(board.title) + '</p>'
            + '<label style="font-size:16px;color:#94a3b8;display:block;margin-bottom:4px;">提醒時間</label>'
            + '<input type="datetime-local" class="notice-form-input" id="clRemindTime" value="' + currentVal + '">'
            + '<label style="font-size:16px;color:#94a3b8;display:block;margin:8px 0 4px;">提醒標題（選填）</label>'
            + '<input type="text" class="notice-form-input" id="clRemindTitle" placeholder="例如：請完成開發工作" value="' + (board.reminderTitle ? escapeHtml(board.reminderTitle) : '') + '">'
            + '<div class="notice-form-buttons" style="margin-top:16px;">'
            + '<button class="btn btn-secondary" id="clRemindCancel">取消</button>'
            + '<button class="btn btn-secondary" id="clRemindClear" style="color:#ef4444;border-color:#ef4444;">清除提醒</button>'
            + '<button class="btn btn-primary" id="clRemindSave">設定</button>'
            + '</div></div>';
        document.body.appendChild(overlay);

        const self = this;
        document.getElementById('clRemindCancel').addEventListener('click', () => overlay.remove());
        document.getElementById('clRemindClear').addEventListener('click', () => {
            self._setReminder(checklistId, null, '');
            overlay.remove();
            APP.showStatusMsg('✅ 提醒已清除');
        });
        document.getElementById('clRemindSave').addEventListener('click', () => {
            const dt = document.getElementById('clRemindTime').value;
            if (!dt) { APP.showStatusMsg('❌ 請選擇提醒時間'); return; }
            const ts = new Date(dt).getTime();
            const title = document.getElementById('clRemindTitle').value.trim();
            self._setReminder(checklistId, ts, title);
            overlay.remove();
            APP.showStatusMsg('✅ 提醒已設定於 ' + new Date(ts).toLocaleString('zh-TW'));
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    _setReminder(checklistId, reminderAt, reminderTitle) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        const board = APP.state.checklists.find(b => b.id === checklistId);
        if (!board) return;
        board.reminderAt = reminderAt;
        board.reminderTitle = reminderTitle || '';
        saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
        sendWsMessage({type: 'checklistboard-remind', room: APP.state.room, id: checklistId, reminderAt, reminderTitle: board.reminderTitle});
        this.renderBoards();
    }

    _checkReminders() {
        const now = Date.now();
        for (const board of APP.state.checklists) {
            if (board.reminderAt && board.reminderAt <= now) {
                window.showPopup('🔔', '檢查清單提醒', (board.reminderTitle || board.title) + ' ⏰');
                board.reminderAt = null;
                board.reminderTitle = '';
                saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
                if ((APP.state.ws && APP.state.ws.readyState === WebSocket.OPEN) && APP.state.room) {
                    sendWsMessage({type: 'checklistboard-remind', room: APP.state.room, id: board.id, reminderAt: null, reminderTitle: ''});
                }
                this.renderBoards();
            }
        }
    }

    // ==================== IMPORT / EXPORT ====================

    exportToMarkdown() {
        const boards = APP.state.checklists;
        if (boards.length === 0) {
            APP.showStatusMsg('💡 尚無檢查清單可匯出');
            return;
        }

        const today = new Date().toISOString().split('T')[0];
        let md = '# ✅ 檢查清單匯出 — ' + today + '\n\n';

        for (const board of boards) {
            const tagsStr = (board.tags && board.tags.length) ? '標籤：`' + board.tags.join('` `') + '`' : '';
            const metaParts = [];
            if (board.category) metaParts.push('分類：' + board.category);
            if (tagsStr) metaParts.push(tagsStr);
            md += '## ' + board.title + '\n';
            if (metaParts.length) md += '*' + metaParts.join(' | ') + '*\n\n';

            if (board.items && board.items.length) {
                for (const item of board.items) {
                    md += '- [' + (item.checked ? 'x' : ' ') + '] ' + item.text + '\n';
                }
            }
            md += '\n---\n\n';
        }

        // Download as .md file
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'checklist_export_' + today + '.md';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        APP.showStatusMsg('✅ Markdown 已匯出 (' + boards.length + ' 個檢查清單)');
    }

    _copyMarkdown() {
        const boards = APP.state.checklists;
        if (boards.length === 0) {
            APP.showStatusMsg('💡 尚無檢查清單可複製');
            return;
        }

        const today = new Date().toISOString().split('T')[0];
        let md = '# ✅ 檢查清單匯出 — ' + today + '\n\n';

        for (const board of boards) {
            const tagsStr = (board.tags && board.tags.length) ? '標籤：`' + board.tags.join('` `') + '`' : '';
            const metaParts = [];
            if (board.category) metaParts.push('分類：' + board.category);
            if (tagsStr) metaParts.push(tagsStr);
            md += '## ' + board.title + '\n';
            if (metaParts.length) md += '*' + metaParts.join(' | ') + '*\n\n';

            if (board.items && board.items.length) {
                for (const item of board.items) {
                    md += '- [' + (item.checked ? 'x' : ' ') + '] ' + item.text + '\n';
                }
            }
            md += '\n---\n\n';
        }

        navigator.clipboard.writeText(md).then(() => {
            APP.showStatusMsg('✅ Markdown 已複製到剪貼簿 (' + boards.length + ' 個檢查清單)');
        }).catch(() => {
            APP.showStatusMsg('❌ 複製失敗，請手動選取');
        });
    }

    exportToJSON() {
        const boards = APP.state.checklists;
        if (boards.length === 0) {
            APP.showStatusMsg('💡 尚無檢查清單可匯出');
            return;
        }

        const data = {
            version: 1,
            exportedAt: new Date().toISOString(),
            checklists: boards.map(board => ({
                id: board.id,
                title: board.title,
                category: board.category || '',
                tags: board.tags || [],
                color: board.color || '#38bdf8',
                pinned: !!board.pinned,
                items: (board.items || []).map(item => ({
                    id: item.id,
                    text: item.text,
                    checked: !!item.checked
                }))
            }))
        };

        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'checklist_export_' + new Date().toISOString().split('T')[0] + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        APP.showStatusMsg('✅ JSON 已匯出 (' + boards.length + ' 個檢查清單)');
    }

    importFromJSON(jsonStr) {
        let data;
        try {
            data = JSON.parse(jsonStr);
        } catch (e) {
            APP.showStatusMsg('❌ JSON 語法錯誤：' + e.message);
            return;
        }

        if (!data || data.version !== 1) {
            APP.showStatusMsg('❌ 不支援的 JSON 格式（預期 version: 1）');
            return;
        }
        if (!Array.isArray(data.checklists)) {
            APP.showStatusMsg('❌ JSON 缺少 checklists 陣列');
            return;
        }
        if (!APP.state.room) {
            APP.showStatusMsg('❌ 請先連線後再匯入');
            return;
        }

        let importedCount = 0;
        for (const cb of data.checklists) {
            if (!cb.title) continue;
            // If ID already exists, skip
            if (APP.state.checklists.some(b => b.id === cb.id)) continue;

            const newBoard = {
                id: cb.id || crypto.randomUUID(),
                title: cb.title,
                category: cb.category || '',
                tags: cb.tags || [],
                color: cb.color || '#38bdf8',
                pinned: !!cb.pinned,
                createdBy: APP.state.displayName,
                createdAt: Date.now(),
                items: (cb.items || []).map(item => ({
                    id: crypto.randomUUID(),
                    text: item.text || '',
                    checked: !!item.checked,
                    addedBy: APP.state.displayName,
                    timestamp: Date.now(),
                    checkedAt: null
                }))
            };
            APP.state.checklists.push(newBoard);
            sendWsMessage({type: 'checklistboard-create', room: APP.state.room, board: newBoard});
            importedCount++;
        }

        if (importedCount > 0) {
            saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
            this.renderBoards();
            APP.showStatusMsg('✅ 已匯入 ' + importedCount + ' 個檢查清單');
        } else {
            APP.showStatusMsg('💡 沒有新的檢查清單可匯入（可能已存在）');
        }
    }

    importFromMarkdown(mdStr) {
        if (!mdStr || !mdStr.trim()) {
            APP.showStatusMsg('❌ Markdown 內容為空');
            return;
        }
        if (!APP.state.room) {
            APP.showStatusMsg('❌ 請先連線後再匯入');
            return;
        }

        // Split by --- (board separator)
        const sections = mdStr.split(/\n---\s*\n/);
        let importedCount = 0;

        for (const section of sections) {
            const lines = section.split('\n').filter(l => l.trim());
            let title = '';
            let items = [];
            let parsingItems = false;

            for (const line of lines) {
                const h2Match = line.match(/^##\s+(.+)/);
                if (h2Match) {
                    title = h2Match[1].trim();
                    parsingItems = true;
                    continue;
                }
                if (parsingItems) {
                    const itemMatch = line.match(/^-\s+\[([ x])\]\s+(.+)/);
                    if (itemMatch) {
                        items.push({
                            text: itemMatch[2].trim(),
                            checked: itemMatch[1] === 'x'
                        });
                    }
                }
            }

            if (!title) continue;
            // Skip if board with same title exists
            if (APP.state.checklists.some(b => b.title === title)) continue;

            const newBoard = {
                id: crypto.randomUUID(),
                title: title,
                category: '',
                tags: [],
                color: '#38bdf8',
                pinned: false,
                createdBy: APP.state.displayName,
                createdAt: Date.now(),
                items: items.map(item => ({
                    id: crypto.randomUUID(),
                    text: item.text,
                    checked: false,
                    addedBy: APP.state.displayName,
                    timestamp: Date.now(),
                    checkedAt: null
                }))
            };
            APP.state.checklists.push(newBoard);
            sendWsMessage({type: 'checklistboard-create', room: APP.state.room, board: newBoard});
            importedCount++;
        }

        if (importedCount > 0) {
            saveToStorage(APP.roomKey('vcc_checklists'), APP.state.checklists);
            this.renderBoards();
            APP.showStatusMsg('✅ 已從 Markdown 匯入 ' + importedCount + ' 個檢查清單');
        } else {
            APP.showStatusMsg('💡 沒有新的檢查清單可匯入（可能已存在或格式不符）');
        }
    }

    _showExportMenu() {
        const existing = document.querySelector('.cl-export-menu');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay cl-export-menu';
        overlay.innerHTML = '<div class="modal-dialog" style="max-width:300px;">'
            + '<h3 style="font-size:20px;font-weight:600;margin-bottom:16px;">📤 匯出檢查清單</h3>'
            + '<div style="display:flex;flex-direction:column;gap:8px;">'
            + '<button class="btn btn-secondary" id="clExportMd" style="text-align:left;">📄 匯出 Markdown (.md)</button>'
            + '<button class="btn btn-secondary" id="clExportJson" style="text-align:left;">📦 匯出 JSON (.json)</button>'
            + '<button class="btn btn-secondary" id="clCopyMd" style="text-align:left;">📋 複製 Markdown</button>'
            + '</div>'
            + '<div class="notice-form-buttons" style="margin-top:16px;">'
            + '<button class="btn btn-secondary" id="clExportCancel">取消</button>'
            + '</div></div>';
        document.body.appendChild(overlay);

        const self = this;
        document.getElementById('clExportMd').addEventListener('click', () => {
            overlay.remove();
            self.exportToMarkdown();
        });
        document.getElementById('clExportJson').addEventListener('click', () => {
            overlay.remove();
            self.exportToJSON();
        });
        document.getElementById('clCopyMd').addEventListener('click', () => {
            overlay.remove();
            self._copyMarkdown();
        });
        document.getElementById('clExportCancel').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    _showImportPicker() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.md,.markdown';
        input.style.display = 'none';
        document.body.appendChild(input);

        const self = this;
        input.addEventListener('change', function() {
            const file = this.files[0];
            if (!file) { input.remove(); return; }
            const reader = new FileReader();
            reader.onload = function(e) {
                const content = e.target.result;
                if (file.name.endsWith('.json')) {
                    self.importFromJSON(content);
                } else {
                    self.importFromMarkdown(content);
                }
            };
            reader.readAsText(file);
            input.remove();
        });
        input.click();
    }

    // ==================== TEMPLATE EXPORT / IMPORT ====================

    exportTemplatesToJSON() {
        const templates = APP.state.checklistTemplates;
        if (!templates || templates.length === 0) {
            APP.showStatusMsg('💡 尚無範本可匯出');
            return;
        }

        const data = {
            version: 1,
            exportedAt: new Date().toISOString(),
            templates: templates.map(t => ({
                id: t.id,
                title: t.title,
                description: t.description || '',
                category: t.category || '',
                tags: t.tags || [],
                color: t.color || '#38bdf8',
                items: (t.items || []).map(item => ({
                    text: typeof item === 'string' ? item : (item.text || '')
                }))
            }))
        };

        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'checklist_templates_export_' + new Date().toISOString().split('T')[0] + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        APP.showStatusMsg('✅ 範本已匯出 (' + templates.length + ' 個)');
    }

    importTemplatesFromJSON(jsonStr) {
        let data;
        try {
            data = JSON.parse(jsonStr);
        } catch (e) {
            APP.showStatusMsg('❌ JSON 語法錯誤：' + e.message);
            return;
        }

        if (!data || !Array.isArray(data.templates)) {
            APP.showStatusMsg('❌ JSON 缺少 templates 陣列');
            return;
        }

        let importedCount = 0;
        for (const t of data.templates) {
            if (!t.title) continue;
            if (APP.state.checklistTemplates.some(ex => ex.title === t.title)) continue;

            APP.state.checklistTemplates.push({
                id: crypto.randomUUID(),
                title: t.title,
                description: t.description || '',
                category: t.category || '',
                tags: t.tags || [],
                color: t.color || '#38bdf8',
                items: (t.items || []).map(item => ({
                    text: typeof item === 'string' ? item : (item.text || '')
                })),
                createdBy: APP.state.displayName,
                createdAt: Date.now()
            });
            importedCount++;
        }

        if (importedCount > 0) {
            saveToStorage(APP.roomKey('vcc_checklist_templates'), APP.state.checklistTemplates);
            if (typeof window.renderTemplates === 'function') window.renderTemplates();
            APP.showStatusMsg('✅ 已匯入 ' + importedCount + ' 個範本');
        } else {
            APP.showStatusMsg('💡 沒有新的範本可匯入');
        }
    }
}
