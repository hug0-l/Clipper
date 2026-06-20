/**
 * Clipper FilesModule — file transfer (drag-drop, send queue, chunk assembly, SHA-256)
 *
 * Depends on: ModuleBase (js/core/module-base.js), WSManager (js/core/ws-manager.js)
 *
 * Uses APP global for state (APP.state.fileQueue/fileSending/fileReceives/...).
 * Backward-compatible: same state keys as the monolithic clipper.html.
 */
class FilesModule extends ClipperModule {
    constructor(bus, wsManager) {
        super('files', bus, wsManager);

        // Register WS type-specific handlers (fire after wildcard legacy handler)
        wsManager.onMessage(['relay-chunk', 'file-cancel', 'relay-data'],
            (data) => this._handleWsMessage(data), 'files');
    }

    _mount() {
        // Wire up drag-drop + file picker DOM events
        const dropZone = document.getElementById('fileDropZone');
        const fileInput = document.getElementById('fileInput');
        const clearBtn = document.getElementById('btnClearDone');

        if (!dropZone) return;

        this._dropClickHandler = (e) => {
            if (e.target === dropZone || e.target.closest('.drop-zone-icon') || e.target.tagName === 'P') {
                fileInput.click();
            }
        };
        this._fileChangeHandler = () => {
            if (fileInput.files.length > 0) {
                this.handleFiles(fileInput.files);
                fileInput.value = '';
            }
        };
        this._dragOverHandler = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
        this._dragLeaveHandler = () => { dropZone.classList.remove('drag-over'); };
        this._dropHandler = (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) this.handleFiles(e.dataTransfer.files);
        };
        this._clearClickHandler = () => {
            APP.state.fileQueue = APP.state.fileQueue.filter(f => f.status !== 'done' && f.status !== 'error');
            this.updateFileUI();
        };

        dropZone.addEventListener('click', this._dropClickHandler);
        fileInput.addEventListener('change', this._fileChangeHandler);
        dropZone.addEventListener('dragover', this._dragOverHandler);
        dropZone.addEventListener('dragleave', this._dragLeaveHandler);
        dropZone.addEventListener('drop', this._dropHandler);
        if (clearBtn) clearBtn.addEventListener('click', this._clearClickHandler);

        // Initial UI
        this.updateFileUI();
    }

    _unmount() {
        const dropZone = document.getElementById('fileDropZone');
        const fileInput = document.getElementById('fileInput');
        const clearBtn = document.getElementById('btnClearDone');

        if (dropZone && this._dropClickHandler) {
            dropZone.removeEventListener('click', this._dropClickHandler);
            fileInput.removeEventListener('change', this._fileChangeHandler);
            dropZone.removeEventListener('dragover', this._dragOverHandler);
            dropZone.removeEventListener('dragleave', this._dragLeaveHandler);
            dropZone.removeEventListener('drop', this._dropHandler);
        }
        if (clearBtn && this._clearClickHandler) {
            clearBtn.removeEventListener('click', this._clearClickHandler);
        }
    }

    // ===== DC message handlers (called from clipper.html DC data channel handler) =====

    handleDCMessage(msg, peerId) {
        switch (msg.type) {
            case 'file-meta':
                this.handleFileMeta(msg, peerId);
                break;
            case 'file-done':
                this.handleFileDone(msg, peerId);
                break;
        }
    }

    handleDCFileChunk(data, peerId) {
        this.handleFileChunk(data, peerId);
    }

    // ===== WS message handler =====

    _handleWsMessage(data) {
        switch (data.type) {
            case 'file-cancel':
                this._handleFileCancel(data);
                break;
            case 'relay-data':
                this._handleRelayDataFile(data);
                break;
            case 'relay-chunk':
                this._handleRelayChunk(data);
                break;
        }
    }

    _handleFileCancel(data) {
        if (data.fileId) {
            for (const [pid, entry] of APP.state.fileSending) {
                if (entry.fileId === data.fileId) {
                    entry.status = 'cancelled';
                    APP.state.fileSending.delete(pid);
                    break;
                }
            }
            APP.state.fileQueue = APP.state.fileQueue.filter(f => f.fileId !== data.fileId);
            this.updateFileUI();
            APP.showStatusMsg('❌ 傳送已取消：' + (data.fileId || ''));
        }
    }

    _handleRelayDataFile(data) {
        if (data.data) {
            if (data.data.type === 'file-meta') {
                this.handleFileMeta(data.data, data.from);
            } else if (data.data.type === 'file-done') {
                this.handleFileDone(data.data, data.from);
            }
        }
        // relay-peer marking still handled by legacy wildcard handler
    }

    _handleRelayChunk(data) {
        const fromPid = data.from;
        const fileId = data.fileId;
        const chunkBase64 = data.chunk;
        const binaryStr = atob(chunkBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }
        this.handleFileChunk(bytes.buffer, fromPid);
        const relayPeer2 = APP.state.peers.get(fromPid);
        if (relayPeer2) relayPeer2.relay = true;
        window.updateTransportUI();
    }

    // ===== Utility =====

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    }

    // ===== UI Rendering =====

    updateFileUI() {
        const queue = document.getElementById('fileQueue');
        const overall = document.getElementById('fileOverall');
        const clearBtn = document.getElementById('btnClearDone');
        if (!queue) return;

        const items = [];
        for (const entry of APP.state.fileSending.values()) {
            items.push({...entry, direction: 'up'});
        }
        for (const f of APP.state.fileQueue) {
            if (!items.find(i => i.fileId === f.fileId)) items.push({...f, direction: 'up'});
        }
        for (const entry of APP.state.fileReceives.values()) {
            if (!items.find(i => i.fileId === entry.fileId)) {
                items.push({...entry, direction: 'down'});
            }
        }

        const doneCount = [...APP.state.fileSending.values()].filter(e => e.status === 'done').length;
        if (overall) overall.textContent = `${doneCount} / ${items.length} 個檔案完成`;

        if (items.length === 0) {
            queue.innerHTML = '<div style="color:#64748b;text-align:center;padding:20px;font-size:16px">尚未選擇檔案</div>';
            if (clearBtn) clearBtn.style.display = 'none';
            return;
        }

        const hasDoneOrError = items.some(i => i.status === 'done' || i.status === 'error');
        if (clearBtn) clearBtn.style.display = hasDoneOrError ? '' : 'none';

        queue.innerHTML = items.map(f => {
            const pct = f.progress || 0;
            const isReceiving = f.direction === 'down';
            const label = isReceiving ? '接收中' : '傳送中';
            const statusMap = {pending: '等待中', sending: `${label} ${pct}%`, receiving: `接收中 ${pct}%`, done: '已完成', error: '失敗', cancelled: '已取消'};
            const statusText = statusMap[f.status] || f.status;
            const fillClass = f.status === 'done' ? 'done' : (f.status === 'error' ? 'error' : (f.status === 'cancelled' ? 'error' : ''));
            const prefix = isReceiving ? '📥 ' : '📤 ';
            const safeName = f.name.replace(/"/g, '&quot;');
            const canCancel = f.status === 'pending' || f.status === 'sending' || f.status === 'receiving';
            const cancelBtn = canCancel ? `<button class="file-cancel-btn" data-file-id="${f.fileId}" data-direction="${f.direction}" title="取消" style="font-size:11px;padding:1px 6px;border:1px solid #ef4444;background:transparent;color:#ef4444;border-radius:4px;cursor:pointer;">✕ 取消</button>` : '';
            const retryBtn = f.status === 'error' ? `<button class="file-retry-btn" data-file-id="${f.fileId}">重試</button>` : '';
            return `<div class="file-item">
                <div class="file-item-header">
                    <span class="file-name" title="${safeName}">${prefix}${safeName}</span>
                    <span class="file-size">${this.formatFileSize(f.size)}</span>
                </div>
                <div class="file-progress-bar"><div class="file-progress-fill ${fillClass}" style="width:${pct}%"></div></div>
                <div class="file-status"><span class="${f.status}">${statusText}</span>${cancelBtn}${retryBtn}</div>
            </div>`;
        }).join('');

        // Cancel buttons
        queue.querySelectorAll('.file-cancel-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (APP.state.readOnly) {
                    APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
                    return;
                }
                const fileId = btn.dataset.fileId;
                const dir = btn.dataset.direction;
                if (dir === 'up') {
                    APP.state.fileQueue = APP.state.fileQueue.filter(f => f.fileId !== fileId);
                    for (const [pid, entry] of APP.state.fileSending) {
                        if (entry.fileId === fileId || entry.fileId.startsWith(fileId + '-')) {
                            APP.state.fileSending.delete(pid);
                        }
                    }
                    this.updateFileUI();
                } else {
                    const entry = APP.state.fileReceives.get(fileId);
                    if (entry) {
                        entry.status = 'cancelled';
                        if ((APP.state.ws && APP.state.ws.readyState === WebSocket.OPEN) && APP.state.room) {
                            window.sendWsMessage({type: 'file-cancel', room: APP.state.room, to: entry.fromPeer || '', fileId});
                        }
                    }
                    this.updateFileUI();
                }
            });
        });
        // Retry buttons
        queue.querySelectorAll('.file-retry-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const fileId = btn.dataset.fileId;
                APP.state.fileQueue = APP.state.fileQueue.filter(f => f.fileId !== fileId);
                for (const [pid, entry] of APP.state.fileSending) {
                    if (entry.fileId === fileId) { APP.state.fileSending.delete(pid); break; }
                }
                this.updateFileUI();
            });
        });
    }

    // ===== File Operations =====

    handleFiles(fileList) {
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        if ((!APP.state.ws || APP.state.ws.readyState !== WebSocket.OPEN)) {
            APP.showStatusMsg('❌ 請先建立連線');
            return;
        }
        if (APP.state.selectedTargetPeerIds.size === 0) {
            APP.showStatusMsg('💡 請先在檔案傳送區域選取傳送對象');
            return;
        }
        for (const file of fileList) {
            APP.state.fileQueue.push({
                file,
                fileId: crypto.randomUUID(),
                name: file.name,
                size: file.size,
                progress: 0,
                status: 'pending'
            });
        }
        this.updateFileUI();
        if (APP.state.fileSending.size === 0) {
            this.sendNextFile();
        }
    }

    markAllFailed() {
        for (const [pid, entry] of APP.state.fileSending) {
            entry.status = 'error';
        }
        APP.state.fileSending.clear();
        for (const entry of APP.state.fileReceives.values()) {
            if (entry.status === 'receiving') entry.status = 'error';
        }
        for (const f of APP.state.fileQueue) {
            if (f.status === 'pending' || f.status === 'sending') {
                f.status = 'error';
            }
        }
        this.updateFileUI();
    }

    async sendFileToPeer(entry, pid) {
        APP.state.fileSending.set(pid, {fileId: entry.fileId, name: entry.name, size: entry.size, progress: 0, status: 'sending'});
        this.updateFileUI();
        try {
            const buffer = await entry.file.arrayBuffer();
            const CHUNK_SIZE = 16384;
            const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
            const relayFileId = entry.fileId + '-' + pid;
            let checksum = null;
            if (crypto.subtle) {
                try {
                    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                    checksum = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
                } catch (_) {}
            }
            const peerState = APP.state.peers.get(pid);
            const useRelay = !(peerState && peerState.dc && peerState.dc.readyState === 'open');
            const effectiveChunkSize = useRelay ? 65536 : CHUNK_SIZE;
            const effectiveTotalChunks = Math.ceil(buffer.byteLength / effectiveChunkSize);

            const metaObj = {type: 'file-meta', fileId: relayFileId, name: entry.name, size: entry.size, chunks: effectiveTotalChunks};
            if (checksum) metaObj.sha256 = checksum;
            const metaMsg = JSON.stringify(metaObj);
            window.sendToPeers(metaMsg, new Set([pid]));

            for (let i = 0; i < effectiveTotalChunks; i++) {
                const start = i * effectiveChunkSize;
                const end = Math.min(start + effectiveChunkSize, buffer.byteLength);
                const chunk = buffer.slice(start, end);

                if (useRelay) {
                    const chunkBase64 = await new Promise(resolve => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result.split(',')[1]);
                        reader.readAsDataURL(new Blob([chunk]));
                    });
                    window.sendWsMessage({
                        type: 'relay-chunk', room: APP.state.room, to: pid,
                        fileId: relayFileId, chunk: chunkBase64, index: i, total: effectiveTotalChunks
                    });
                    await new Promise(r => setTimeout(r, 10));
                } else {
                    while (peerState.dc.bufferedAmount > 65536) {
                        await new Promise(resolve => {
                            peerState.dc.addEventListener('bufferedamountlow', resolve, { once: true });
                        });
                    }
                    try { peerState.dc.send(chunk); } catch (e) { console.error('[FT] send chunk error', e); }
                }
                const sendingEntry = APP.state.fileSending.get(pid);
                if (sendingEntry) {
                    sendingEntry.progress = Math.round(((i + 1) / effectiveTotalChunks) * 100);
                }
                if (i % 8 === 0) this.updateFileUI();
            }
            const doneMsg = JSON.stringify({type: 'file-done', fileId: relayFileId});
            window.sendToPeers(doneMsg, new Set([pid]));
            APP.state.fileSending.set(pid, {fileId: relayFileId, name: entry.name, size: entry.size, progress: 100, status: 'done'});
            this.updateFileUI();
        } catch (err) {
            console.error('[FT] Send to', pid, 'failed', err);
            APP.state.fileSending.set(pid, {fileId: entry.fileId + '-' + pid, name: entry.name, size: entry.size, progress: 0, status: 'error'});
            this.updateFileUI();
        }
    }

    async sendNextFile() {
        if (APP.state.fileQueue.length === 0) return;
        if (APP.state.readOnly) {
            APP.showStatusMsg('🔒 伺服器中斷，唯讀模式不可操作');
            return;
        }
        const entry = APP.state.fileQueue.find(f => f.status === 'pending');
        if (!entry) return;
        entry.status = 'sending';
        this.updateFileUI();
        const targets = new Set(APP.state.selectedTargetPeerIds);
        if (targets.size === 0) {
            entry.status = 'error';
            this.updateFileUI();
            return;
        }
        for (const [pid, e] of APP.state.fileSending) {
            if (e.status === 'done' || e.status === 'error' || e.status === 'cancelled') {
                APP.state.fileSending.delete(pid);
            }
        }
        const promises = [];
        for (const pid of targets) {
            promises.push(this.sendFileToPeer(entry, pid));
        }
        await Promise.all(promises);
        entry.status = 'done';
        APP.state.fileQueue = APP.state.fileQueue.filter(f => f.fileId !== entry.fileId);
        this.updateFileUI();
        this.sendNextFile();
    }

    // ===== File Receive =====

    handleFileMeta(msg, fromPeerId) {
        console.log('[FT] File meta:', msg.name, msg.size, msg.chunks, 'chunks', 'from', fromPeerId);
        APP.state.fileReceives.set(msg.fileId, {
            fileId: msg.fileId,
            name: msg.name, size: msg.size, received: 0, blobs: [], status: 'receiving',
            sha256: msg.sha256 || null, progress: 0,
            fromPeer: fromPeerId, chunks: msg.chunks || 0, chunkCount: 0
        });
        APP.state.peerCurrentFile.set(fromPeerId, msg.fileId);
        const displayName = APP.state.peerNames.get(fromPeerId) || fromPeerId;
        window.showPopup('📁', '接收檔案中', displayName + ' 傳送：' + msg.name);
        this.updateFileUI();
    }

    handleFileChunk(data, fromPeerId) {
        const fileId = APP.state.peerCurrentFile.get(fromPeerId);
        if (!fileId) return;
        const entry = APP.state.fileReceives.get(fileId);
        if (!entry || entry.status !== 'receiving') return;
        entry.blobs.push(data);
        entry.received += data.byteLength;
        entry.chunkCount = (entry.chunkCount || 0) + 1;
        if (entry.chunkCount % 64 === 0) {
            entry.progress = entry.chunks > 0 ? Math.round((entry.chunkCount / entry.chunks) * 100) : Math.round((entry.received / entry.size) * 100);
            this.updateFileUI();
        }
    }

    handleFileDone(msg, fromPeerId) {
        const entry = APP.state.fileReceives.get(msg.fileId);
        if (!entry || entry.status === 'cancelled') return;
        entry.status = 'done';
        entry.progress = 100;
        this.updateFileUI();

        const blob = new Blob(entry.blobs, {type: 'application/octet-stream'});
        const url = URL.createObjectURL(blob);

        if (entry.sha256 && crypto.subtle) {
            const reader = new FileReader();
            reader.onload = async function() {
                const buf = reader.result;
                const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
                const receivedHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
                if (receivedHash === entry.sha256) {
                    APP.showStatusMsg('✅ ' + entry.name + ' — 完整性驗證通過 (SHA-256)');
                } else {
                    APP.showStatusMsg('⚠️ ' + entry.name + ' — 完整性驗證失敗，檔案可能已損壞');
                }
            };
            reader.readAsArrayBuffer(blob);
        } else {
            APP.showStatusMsg('已接收: ' + entry.name);
        }

        const a = document.createElement('a');
        a.href = url;
        a.download = entry.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);

        APP.state.fileReceives.delete(msg.fileId);
        if (APP.state.peerCurrentFile.get(fromPeerId) === msg.fileId) {
            APP.state.peerCurrentFile.delete(fromPeerId);
        }
    }
}
