/**
 * AdminModule — admin panel and settings management
 *
 * Extends ClipperModule. Handles admin login, config editor, log viewer,
 * NTP/STUN settings, data export/import, password change.
 *
 * Depends on: ClipperModule (js/core/module-base.js), MessageBus, WSManager
 * Global deps: window.APP, window.sendWsMessage, window.escapeHtml,
 *   window._getClientLogs, window._downloadClientLogs, window.showPopup
 */

class AdminModule extends ClipperModule {
    constructor(bus, wsManager) {
        super('admin', bus, wsManager);
        this._adminPassword = '';
        this._adminToken = '';
        this._adminLoggedIn = false;
        this._adminLogoutTimer = null;
        this._settingsInterval = null;
        this._boundListeners = [];
    }

    _mount() {
        this._bindAdminUI();
        // Expose handleAdminMessage globally for legacy WS handler default case
        window.handleAdminMessage = (data) => this._handleAdminMessage(data);
        // Start periodic settings view update
        this._settingsInterval = setInterval(() => {
            this._updateSettingsView();
            if (typeof updateTransportUI === 'function') updateTransportUI();
        }, 2000);
    }

    _unmount() {
        for (const {el, type, handler} of this._boundListeners) {
            el?.removeEventListener(type, handler);
        }
        this._boundListeners = [];
        if (this._settingsInterval) {
            clearInterval(this._settingsInterval);
            this._settingsInterval = null;
        }
        if (this._adminLogoutTimer) {
            clearTimeout(this._adminLogoutTimer);
            this._adminLogoutTimer = null;
        }
        window.handleAdminMessage = undefined;
    }

    // ─── Admin state accessors ───

    get isLoggedIn() { return this._adminLoggedIn; }
    get token() { return this._adminToken; }
    get password() { return this._adminPassword; }

    // ─── UI binding ───

    _bindAdminUI() {
        // Admin tab switching
        this._listen(document.querySelectorAll('.admin-tab-btn'), (btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                document.querySelectorAll('.admin-pane').forEach(p => p.style.display = 'none');
                const target = document.getElementById('adminPane' + btn.dataset.admintab.charAt(0).toUpperCase() + btn.dataset.admintab.slice(1));
                if (target) target.style.display = 'block';
                const tab = btn.dataset.admintab;
                if (tab === 'logs' && this._adminToken) {
                    this._refreshLogViewer();
                } else if (tab === 'config' && this._adminToken) {
                    sendWsMessage({type: 'admin-get-config', token: this._adminToken});
                } else if (tab === 'diagnostic') {
                    if (window.diagnosticModule) {
                        window.diagnosticModule.requestFullDiagnostic();
                    }
                } else if (tab === 'plugins') {
                    this._renderPluginList();
                }
            });
        });

        // Admin login
        this._listenOne('btnAdminLogin', 'click', () => {
            const pw = document.getElementById('adminPw').value.trim();
            if (!pw) {
                document.getElementById('adminLoginError').textContent = '❌ 請輸入密碼';
                document.getElementById('adminLoginError').style.display = 'block';
                return;
            }
            sendWsMessage({type: 'admin-login', password: pw});
        });
        this._listenOne('adminPw', 'keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('btnAdminLogin')?.click();
        });

        // Refresh logs
        this._listenOne('btnRefreshLogs', 'click', () => {
            if (this._adminPassword) sendWsMessage({type: 'admin-logs', token: this._adminToken, count: 50});
        });

        // Log source tabs
        this._listen(document.querySelectorAll('[data-srctab]'), (btn) => {
            btn.addEventListener('click', function() {
                document.querySelectorAll('[data-srctab]').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                APP.state._logSource = this.dataset.srctab;
                _refreshLogViewer();
            });
        });
        if (!APP.state._logSource) APP.state._logSource = 'server';

        // Download logs
        this._listenOne('btnDownloadLog', 'click', () => {
            if (this._adminPassword) sendWsMessage({type: 'admin-log-download', token: this._adminToken});
        });
        this._listenOne('btnDownloadClientLog', 'click', () => {
            if (typeof _downloadClientLogs === 'function') _downloadClientLogs();
            APP.showStatusMsg('✅ 本地端日誌已下載');
        });

        // Save config
        this._listenOne('btnSaveConfig', 'click', () => {
            if (!this._adminPassword) return;
            const retention = parseInt(document.getElementById('adminConfigRetention').value);
            if (isNaN(retention) || retention < 1) { APP.showStatusMsg('❌ 請輸入有效的天數'); return; }
            const stunVal = document.getElementById('adminStunServer')?.value?.trim();
            const cfg = {chatRetentionDays: retention};
            if (stunVal) cfg.stunServer = stunVal;
            sendWsMessage({type: 'admin-set-config', token: this._adminToken, config: cfg});
        });

        // NTP toggle
        this._listenOne('adminNtpToggle', 'change', function() {
            if (!this._adminPassword) return;
            const enabled = this.checked;
            document.getElementById('adminNtpSlider').style.background = enabled ? '#38bdf8' : '#475569';
            sendWsMessage({type: 'ntp-config', token: this._adminToken, ntpEnabled: enabled});
        });

        // NTP save
        this._listenOne('btnSaveNtp', 'click', () => {
            if (!this._adminPassword) return;
            const server = document.getElementById('adminNtpServer').value.trim();
            if (!server) { APP.showStatusMsg('❌ 請輸入 NTP 伺服器位址'); return; }
            sendWsMessage({type: 'ntp-config', token: this._adminToken, ntpServer: server, ntpEnabled: true});
        });

        // STUN save
        this._listenOne('btnSaveAdminStun', 'click', () => {
            if (!this._adminToken) return;
            const server = document.getElementById('adminStunServer').value.trim();
            if (!server) { APP.showStatusMsg('❌ STUN 伺服器位址不能為空'); return; }
            sendWsMessage({type: 'admin-set-config', token: this._adminToken, config: {stunServer: server}});
        });

        // TURN save
        this._listenOne('btnSaveAdminTurn', 'click', () => {
            if (!this._adminToken) return;
            const server = document.getElementById('adminTurnServer').value.trim();
            const username = document.getElementById('adminTurnUsername').value.trim();
            const credential = document.getElementById('adminTurnCredential').value.trim();
            const config = {};
            if (server) config.turnServer = server;
            if (username) config.turnUsername = username;
            if (credential) config.turnCredential = credential;
            sendWsMessage({type: 'admin-set-config', token: this._adminToken, config});
            APP.showStatusMsg('✅ TURN 設定已更新');
        });

        // Export/Import
        this._listenOne('btnExportDump', 'click', () => {
            if (!this._adminPassword) return;
            sendWsMessage({type: 'admin-export', token: this._adminToken});
        });
        this._listenOne('fileImportDump', 'change', function() {
            if (!this._adminPassword) return;
            const file = this.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                sendWsMessage({type: 'admin-import', token: this._adminToken, dump: e.target.result});
            };
            reader.readAsText(file);
            this.value = '';
        });

        // Change password
        this._listenOne('btnChangePw', 'click', () => {
            const oldPw = document.getElementById('adminOldPw').value;
            const newPw = document.getElementById('adminNewPw').value;
            const newPw2 = document.getElementById('adminNewPw2').value;
            const el = document.getElementById('adminPwResult');
            if (!oldPw || !newPw) { el.innerHTML = '<span style="color:#ef4444;">❌ 請填寫所有欄位</span>'; return; }
            if (newPw !== newPw2) { el.innerHTML = '<span style="color:#ef4444;">❌ 兩次密碼輸入不一致</span>'; return; }
            if (newPw.length < 4) { el.innerHTML = '<span style="color:#ef4444;">❌ 新密碼至少需要 4 個字元</span>'; return; }
            sendWsMessage({type: 'admin-change-password', password: this._adminPassword, oldPassword: oldPw, newPassword: newPw});
        });

        // Debug Dump
        this._listenOne('btnDump', 'click', () => {
            sendWsMessage({type: 'dump'});
            APP.showStatusMsg('正在請求伺服器資料...');
        });

        // Plugin Management
        this._listenOne('btnPluginRefresh', 'click', () => this._renderPluginList());
        this._listenOne('btnPluginLoadUrl', 'click', () => {
            document.getElementById('pluginLoadUrlDialog').style.display = 'block';
            document.getElementById('pluginUrlInput').focus();
        });
        this._listenOne('btnPluginUrlCancel', 'click', () => {
            document.getElementById('pluginLoadUrlDialog').style.display = 'none';
        });
        this._listenOne('btnPluginUrlLoad', 'click', () => {
            const url = document.getElementById('pluginUrlInput').value.trim();
            if (!url) { APP.showStatusMsg('❌ 請輸入插件網址'); return; }
            document.getElementById('pluginLoadUrlDialog').style.display = 'none';
            document.getElementById('pluginUrlInput').value = '';
            if (window.pluginLoader) {
                window.pluginLoader.loadFromUrl(url).then(() => {
                    this._renderPluginList();
                    APP.showStatusMsg('✅ 插件已載入');
                }).catch((err) => {
                    APP.showStatusMsg('❌ 載入失敗: ' + (err.message || err));
                });
            }
        });
        this._listenOne('filePluginLoad', 'change', function() {
            const file = this.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                const script = document.createElement('script');
                script.textContent = e.target.result;
                document.body.appendChild(script);
                document.getElementById('filePluginLoad').value = '';
                if (window.pluginRegistry) {
                    setTimeout(() => {
                        if (window.adminModule) window.adminModule._renderPluginList();
                    }, 100);
                }
                APP.showStatusMsg('✅ 插件已從檔案載入');
            };
            reader.readAsText(file);
        });
    }

    _renderPluginList() {
        const container = document.getElementById('pluginListContainer');
        const countEl = document.getElementById('pluginCount');
        if (!container) return;
        const plugins = window.ClipperPlugins ? window.ClipperPlugins.getPlugins() : [];
        if (countEl) countEl.textContent = plugins.length;
        if (plugins.length === 0) {
            container.innerHTML = '<div style="color:#64748b;text-align:center;padding:20px;">暫無插件</div>';
            return;
        }
        const self = this;
        container.innerHTML = plugins.map(function(p) {
            const enabled = window.ClipperPlugins ? window.ClipperPlugins.isPluginEnabled(p.name) : true;
            const handlerTypes = (p._handlerTypes && p._handlerTypes.length) ? p._handlerTypes.join(', ') : '無';
            return '<div class="keymgmt-card" style="border-left-color:' + (enabled ? '#22c55e' : '#64748b') + '">'
                + '<div class="keymgmt-card-header">'
                + '<span class="keymgmt-active-badge ' + (enabled ? 'on' : 'off') + '">' + (enabled ? '🟢 啟用' : '⚫ 停用') + '</span>'
                + '<span class="keymgmt-card-label">' + (p.icon || '🔌') + ' ' + escapeHtml(p.displayName || p.name) + '</span>'
                + '<span style="font-size:12px;color:#64748b;">v' + (p.version || '0.0.0') + '</span>'
                + '<span style="flex:1;"></span>'
                + '<button class="btn-icon" data-action="toggle-plugin" data-name="' + p.name + '" title="' + (enabled ? '停用' : '啟用') + '">' + (enabled ? '⏸' : '▶️') + '</button>'
                + '<button class="btn-icon" data-action="remove-plugin" data-name="' + p.name + '" title="移除" style="color:#ef4444;">🗑</button>'
                + '</div>'
                + '<div style="font-size:13px;color:#94a3b8;margin-top:4px;">' + escapeHtml(p.description || '') + '</div>'
                + '<div style="font-size:12px;color:#64748b;margin-top:4px;">WS handlers: ' + handlerTypes + ' | Tab: ' + (p.tab ? (p.tab.position || 'dropdown') : '無') + '</div>'
                + '</div>';
        }).join('');

        container.querySelectorAll('[data-action="toggle-plugin"]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                const name = this.dataset.name;
                if (window.ClipperPlugins) {
                    const enabled = window.ClipperPlugins.isPluginEnabled(name);
                    window.ClipperPlugins.setPluginEnabled(name, !enabled);
                    self._renderPluginList();
                    APP.showStatusMsg((enabled ? '⏸ 已停用' : '▶️ 已啟用') + ' 插件: ' + name);
                }
            });
        });
        container.querySelectorAll('[data-action="remove-plugin"]').forEach(function(btn) {
            btn.addEventListener('click', async function() {
                const name = this.dataset.name;
                if (!await showConfirmDialog('確定移除插件「' + name + '」？')) return;
                if (window.ClipperPlugins) {
                    window.ClipperPlugins.unregisterPlugin(name);
                    self._renderPluginList();
                    APP.showStatusMsg('🗑 插件已移除: ' + name);
                }
            });
        });
    }

    // ─── Helper: track listeners for cleanup ───

    _listenOne(id, type, handler) {
        const el = document.getElementById(id);
        if (!el) return;
        const bound = handler.bind(this);
        el.addEventListener(type, bound);
        this._boundListeners.push({el, type, handler: bound});
    }

    _listen(nodelist, fn) {
        if (!nodelist) return;
        nodelist.forEach(fn);
    }

    // ─── Log viewer helper ───

    _refreshLogViewer() {
        const viewer = document.getElementById('logViewer');
        if (!viewer) return;
        if (APP.state._logSource === 'client') {
            if (typeof _getClientLogs === 'function') {
                const logs = _getClientLogs(50);
                viewer.innerHTML = logs.map(l => typeof escapeHtml === 'function' ? escapeHtml(l) : l).join('<br>');
                viewer.scrollTop = viewer.scrollHeight;
            }
        } else if (APP.state._logSource === 'server') {
            if (this._adminToken) {
                sendWsMessage({type: 'admin-logs', token: this._adminToken, count: 50});
            }
        }
    }

    // ─── Settings view updater ───

    _updateSettingsView() {
        const syncEl = document.getElementById('settingsLastSync');
        const roomEl = document.getElementById('settingsRoomCode');
        if (syncEl) {
            if (APP.state.lastSyncTime) {
                const ago = Math.floor((Date.now() - APP.state.lastSyncTime) / 1000);
                if (ago < 60) syncEl.textContent = '剛剛同步';
                else if (ago < 3600) syncEl.textContent = Math.floor(ago / 60) + ' 分鐘前';
                else syncEl.textContent = Math.floor(ago / 3600) + ' 小時前';
            } else {
                syncEl.textContent = (APP.state.ws && APP.state.ws.readyState === WebSocket.OPEN) ? '未同步' : '---';
            }
        }
        if (roomEl) roomEl.textContent = APP.state.room || '---';

        const tsEl = document.getElementById('adminTimeSource');
        if (tsEl) {
            tsEl.textContent = APP.state.timeSource === 'server' ? '🛰️ 伺服器 (NTP)' : '💻 本機時間';
            tsEl.style.color = APP.state.timeSource === 'server' ? '#22c55e' : '#94a3b8';
        }
        const offsetEl = document.getElementById('adminNtpOffset');
        if (offsetEl) {
            if (APP.state.serverTimeOffset !== 0) {
                offsetEl.textContent = (APP.state.serverTimeOffset / 1000).toFixed(3) + 's';
            }
            if (APP.state.ntpValid) {
                offsetEl.style.color = '#22c55e';
                offsetEl.title = '✅ NTP 伺服器連線正常';
            } else if (APP.state.ntpEnabled) {
                offsetEl.style.color = '#ef4444';
                offsetEl.title = '❌ NTP 伺服器無回應';
            } else {
                offsetEl.style.color = '#94a3b8';
                offsetEl.title = 'NTP 已停用';
            }
        }
        const userList = document.getElementById('onlineUserList');
        if (userList) {
            const peers = [...APP.state.peerNames.entries()];
            if (peers.length === 0) {
                userList.innerHTML = '<div style="color:#475569;">僅你一人</div>';
            } else {
                userList.innerHTML = peers.map(([pid, name]) => {
                    const isSelf = pid === APP.state.myPeerId;
                    return '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;">'
                        + '<span style="color:#22c55e;">🟢</span>'
                        + '<span>' + (typeof escapeHtml === 'function' ? escapeHtml(name || pid) : (name || pid) + ' (' + pid + ')') + '</span>'
                        + (isSelf ? ' <span style="color:#64748b;font-size:12px;">(你)</span>' : '')
                        + '</div>';
                }).join('');
            }
        }
    }

    // ─── Admin WS message handler (called from legacy handleWsMessage default case) ───

    _handleAdminMessage(data) {
        if (data.type === 'admin-login-result') {
            if (data.success) {
                this._adminPassword = document.getElementById('adminPw').value;
                this._adminToken = data.token || '';
                this._adminLoggedIn = true;
                if (this._adminLogoutTimer) clearTimeout(this._adminLogoutTimer);
                this._adminLogoutTimer = setTimeout(() => {
                    this._adminLoggedIn = false;
                    this._adminToken = '';
                    document.getElementById('adminLogin').style.display = '';
                    document.getElementById('adminPanel').style.display = 'none';
                    APP.showStatusMsg('🔐 管理員會話已過期，請重新登入');
                }, 1800000);
                document.getElementById('adminLogin').style.display = 'none';
                document.getElementById('adminPanel').style.display = 'block';
                document.getElementById('adminLoginError').style.display = 'none';
                if (data.serverInfo) {
                    document.getElementById('adminVersion').textContent = data.serverInfo.version || '---';
                    const ntpSrv = document.getElementById('adminNtpServer');
                    if (ntpSrv && data.serverInfo.ntpServer) ntpSrv.value = data.serverInfo.ntpServer;
                    const ntpToggle = document.getElementById('adminNtpToggle');
                    if (ntpToggle) {
                        ntpToggle.checked = data.serverInfo.ntpEnabled !== false;
                        const slider = document.getElementById('adminNtpSlider');
                        if (slider) slider.style.background = data.serverInfo.ntpEnabled !== false ? '#38bdf8' : '#475569';
                    }
                    const offsetEl = document.getElementById('adminNtpOffset');
                    if (offsetEl && data.serverInfo.ntpOffset !== undefined) {
                        offsetEl.textContent = data.serverInfo.ntpOffset + 's';
                        if (data.serverInfo.ntpValid !== undefined) {
                            const isValid = data.serverInfo.ntpValid;
                            if (data.serverInfo.ntpEnabled) {
                                offsetEl.style.color = isValid ? '#22c55e' : '#ef4444';
                                offsetEl.title = isValid ? '✅ NTP 伺服器連線正常' : '❌ NTP 伺服器無回應';
                            } else {
                                offsetEl.style.color = '#94a3b8';
                                offsetEl.title = 'NTP 已停用';
                            }
                        }
                    }
                    document.getElementById('adminUptime').textContent = data.serverInfo.uptime ? Math.floor(data.serverInfo.uptime / 3600) + ' 小時 ' + Math.floor((data.serverInfo.uptime % 3600) / 60) + ' 分' : '---';
                    if (data.serverInfo.stunServer) APP.state.stunServer = data.serverInfo.stunServer;
                    document.getElementById('adminActiveRooms').textContent = data.serverInfo.activeRooms || 0;
                    document.getElementById('adminActivePeers').textContent = data.serverInfo.activePeers || 0;
                    document.getElementById('adminDataRooms').textContent = data.serverInfo.dataRooms || 0;
                    document.getElementById('adminRetention').textContent = data.serverInfo.chatRetentionDays + ' 天' || '---';
                    document.getElementById('adminDebug').textContent = data.serverInfo.debugMode ? '🟢 ON' : '🔴 OFF';
                }
                if (data.config) {
                    document.getElementById('adminConfigRetention').value = data.config.chatRetentionDays || 7;
                    document.getElementById('adminLogPath').textContent = (data.config.logDir || 'logs') + '/' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '.log';
                    const adminStunEl = document.getElementById('adminStunServer');
                    if (adminStunEl && data.config.stunServer) adminStunEl.value = data.config.stunServer;
                }
                sendWsMessage({type: 'admin-logs', token: this._adminToken, count: 50});
                sendWsMessage({type: 'admin-get-config', token: this._adminToken});
            } else {
                document.getElementById('adminLoginError').textContent = data.message || '❌ 登入失敗';
                document.getElementById('adminLoginError').style.display = 'block';
            }
        } else if (data.type === 'admin-logs-result') {
            if (APP.state._logSource !== 'client') {
                const viewer = document.getElementById('logViewer');
                if (viewer && data.logs) {
                    viewer.innerHTML = data.logs.map(l => typeof escapeHtml === 'function' ? escapeHtml(l) : l).join('<br>');
                    viewer.scrollTop = viewer.scrollHeight;
                }
            }
        } else if (data.type === 'admin-log-download-result') {
            if (data.logText) {
                const blob = new Blob([data.logText], {type: 'text/plain;charset=utf-8'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = data.logName || 'clipper.log';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 10000);
                APP.showStatusMsg('✅ 日誌已下載');
            }
        } else if (data.type === 'admin-config') {
            if (data.config) {
                document.getElementById('adminConfigRetention').value = data.config.chatRetentionDays || 7;
                document.getElementById('adminLogPath').textContent = (data.config.logDir || 'logs') + '/' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '.log';
                const adminStunEl = document.getElementById('adminStunServer');
                if (adminStunEl && data.config.stunServer) {
                    adminStunEl.value = data.config.stunServer;
                    APP.state.stunServer = data.config.stunServer;
                }
                const ntpToggle = document.getElementById('adminNtpToggle');
                if (ntpToggle) {
                    ntpToggle.checked = data.config.ntpEnabled !== false;
                    const slider = document.getElementById('adminNtpSlider');
                    if (slider) slider.style.background = data.config.ntpEnabled !== false ? '#38bdf8' : '#475569';
                }
                const ntpSrv = document.getElementById('adminNtpServer');
                if (ntpSrv) ntpSrv.value = data.config.ntpServer || 'stdtime.gov.hk';
                const offsetEl = document.getElementById('adminNtpOffset');
                if (offsetEl) {
                    offsetEl.textContent = data.config.ntpOffset ? data.config.ntpOffset + 's' : '0s';
                    if (data.config.ntpValid !== undefined) {
                        offsetEl.style.color = data.config.ntpValid ? '#22c55e' : '#ef4444';
                        offsetEl.title = data.config.ntpValid ? '✅ NTP 伺服器連線正常' : '❌ NTP 伺服器無回應';
                    }
                }
            }
        } else if (data.type === 'ntp-config-result') {
            if (data.ntpServer !== undefined) {
                document.getElementById('adminNtpServer').value = data.ntpServer;
            }
            const offsetEl = document.getElementById('adminNtpOffset');
            if (offsetEl && data.ntpOffset !== undefined) {
                offsetEl.textContent = data.ntpOffset + 's';
                if (data.ntpValid !== undefined) {
                    offsetEl.style.color = data.ntpValid ? '#22c55e' : '#ef4444';
                    offsetEl.title = data.ntpValid ? '✅ NTP 伺服器連線正常' : '❌ NTP 伺服器無回應';
                }
            }
            if (data.ntpEnabled === false) {
                APP.showStatusMsg('⏸️ NTP 時間同步已停用');
            } else if (data.ntpValid) {
                APP.showStatusMsg('✅ NTP 伺服器連線成功 (偏移 ' + data.ntpOffset + 's)');
            } else {
                APP.showStatusMsg('❌ NTP 伺服器無回應 — 請檢查位址是否正確');
            }
        } else if (data.type === 'admin-change-password-result') {
            const el = document.getElementById('adminPwResult');
            if (el) {
                el.innerHTML = data.success
                    ? '<span style="color:#22c55e;">✅ ' + data.message + '</span>'
                    : '<span style="color:#ef4444;">❌ ' + data.message + '</span>';
                if (data.success) {
                    this._adminPassword = document.getElementById('adminNewPw').value;
                    document.getElementById('adminOldPw').value = '';
                    document.getElementById('adminNewPw').value = '';
                    document.getElementById('adminNewPw2').value = '';
                }
            }
        } else if (data.type === 'admin-set-config-result') {
            APP.showStatusMsg(data.success ? '✅ ' + data.message : '❌ ' + data.message);
            if (data.success && data.config && data.config.stunServer) {
                APP.state.stunServer = data.config.stunServer;
            }
        } else if (data.type === 'admin-export-result') {
            if (data.dump) {
                const blob = new Blob([data.dump], {type: 'application/json;charset=utf-8'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'clipper-backup-' + new Date().toISOString().slice(0, 10) + '.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 10000);
                APP.showStatusMsg('✅ 設定備份已下載');
            }
        } else if (data.type === 'error' && data.message === 'unauthorized') {
            this._adminLoggedIn = false;
            this._adminToken = '';
            document.getElementById('adminLogin').style.display = '';
            document.getElementById('adminPanel').style.display = 'none';
            APP.showStatusMsg('🔐 管理員會話已過期，請重新登入');
        } else if (data.type === 'admin-import-result') {
            const el = document.getElementById('importResult');
            if (el) {
                if (data.success) {
                    el.innerHTML = '<span style="color:#22c55e;">✅ ' + (typeof escapeHtml === 'function' ? escapeHtml(data.message) : data.message) + '</span>';
                    APP.showStatusMsg('✅ ' + data.message);
                } else {
                    el.innerHTML = '<span style="color:#ef4444;">❌ ' + (typeof escapeHtml === 'function' ? escapeHtml(data.message) : data.message) + '</span>';
                }
            }
        }
    }
}
