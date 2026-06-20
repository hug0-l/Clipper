/**
 * DiagnosticModule — error capture + health monitoring + dashboard UI.
 *
 * Extends ClipperModule. Captures window.onerror, unhandledrejection, and
 * module-error bus events into a circular buffer. Monitors WS connection
 * quality via ping/pong latency and reconnect count. Periodically polls
 * backend diagnostic data. Renders dashboard with sparklines, timeline,
 * module health, and export.
 *
 * Depends on: ClipperModule (js/core/module-base.js), MessageBus, WSManager
 */
class DiagnosticModule extends ClipperModule {
    constructor(bus, wsManager) {
        super('diagnostic', bus, wsManager);

        // Error ring buffer
        this._errors = [];
        this._MAX_ERRORS = 50;

        // Health metrics
        this._metrics = {
            wsLatency: 0,
            wsReconnects: 0,
            moduleHealth: {},   // moduleName → {lastHeartbeat, errors, status}
            lastServerSnapshot: null,
        };

        // Sparkline rolling buffers (last 60 values)
        this._sparklineLoop = [];
        this._sparklineLatency = [];
        this._MAX_SPARKLINE = 60;

        // Timeline events
        this._timeline = [];
        this._MAX_TIMELINE = 50;

        // Dashboard auto-refresh timer
        this._dashboardTimer = null;

        // Track reconnect count by listening to bus
        this._unsubReconnect = bus.on('reconnecting', () => {
            this._metrics.wsReconnects++;
        });

        // Track module errors
        this._unsubModuleError = bus.on('module-error', (detail) => {
            this._recordError('module', `${detail.module}: ${detail.error?.message || detail.error}`, detail.error?.stack);
        });

        // Timers
        this._pollTimer = null;
        this._latencyTimer = null;

        // Saved global handlers for restore on unmount
        this._origOnError = null;
        this._origOnRejection = null;
    }

    _mount() {
        // Install global error handlers
        this._origOnError = window.onerror;
        window.onerror = (msg, url, line, col, err) => {
            this._recordError('uncaught', `${msg} (${url}:${line}:${col})`, err?.stack);
            if (this._origOnError) return this._origOnError(msg, url, line, col, err);
        };

        this._origOnRejection = window.onunhandledrejection;
        window.onunhandledrejection = (event) => {
            this._recordError('unhandled', event.reason?.message || String(event.reason), event.reason?.stack);
            if (this._origOnRejection) return this._origOnRejection(event);
        };

        // Wire WS lifecycle timeline events
        this._unsubConnected = this.bus.on('connected', () => {
            this._pushTimeline('ok', 'WS 連線成功');
        });
        this._unsubDisconnected = this.bus.on('disconnected', ({wasIntentional}) => {
            if (!wasIntentional) this._pushTimeline('warn', 'WS 連線中斷');
        });
        this._unsubReconnected = this.bus.on('reconnected', () => {
            this._pushTimeline('ok', 'WS 自動重連成功');
        });

        // Wire dashboard buttons
        this._listenOne('btnDiagnosticRefresh', 'click', () => {
            this.renderDashboard();
            this.wsManager.send({type: 'diagnostic'});
        });
        this._listenOne('btnDiagnosticFull', 'click', () => {
            this.requestFullDiagnostic();
            APP.showStatusMsg('📋 完整診斷請求已送出');
        });
        this._listenOne('btnDiagnosticClearErrors', 'click', () => {
            this.clearErrors();
            this._timeline = [];
            this.renderDashboard();
            this.renderTimeline();
        });
        this._listenOne('btnDiagnosticExport', 'click', () => {
            this._exportDiagnosticReport();
            APP.showStatusMsg('✅ 診斷報告已下載');
        });

        // Start dashboard auto-refresh when tab visible
        this._dashboardTimer = setInterval(() => {
            const diagPane = document.getElementById('adminPaneDiagnostic');
            if (diagPane && diagPane.style.display !== 'none') {
                this.renderDashboard();
            }
        }, 3000);

        // Start periodic tasks
        this._startPolling();
        this._startLatencyCheck();

        // Register WS diagnostic handler
        this.wsManager.onMessage('diagnostic-result', (data) => {
            this._metrics.lastServerSnapshot = data.server;
            const loopDelay = data.server.loopDelayMs;
            if (loopDelay !== undefined) {
                this._sparklineLoop.push(loopDelay);
                if (this._sparklineLoop.length > this._MAX_SPARKLINE) {
                    this._sparklineLoop.shift();
                }
            }
            this._recordModuleHealth('server', loopDelay < 100 ? 'green' : 'red');
        }, 'diagnostic');

        // Listen to pong for latency
        this.wsManager.onMessage('pong', (data) => {
            if (data.clientTs) {
                this._metrics.wsLatency = Date.now() - data.clientTs;
                this._sparklineLatency.push(this._metrics.wsLatency);
                if (this._sparklineLatency.length > this._MAX_SPARKLINE) {
                    this._sparklineLatency.shift();
                }
            }
        }, 'diagnostic');
    }

    _unmount() {
        // Restore global handlers
        window.onerror = this._origOnError;
        window.onunhandledrejection = this._origOnRejection;
        if (this._pollTimer) clearInterval(this._pollTimer);
        if (this._latencyTimer) clearInterval(this._latencyTimer);
        if (this._dashboardTimer) clearInterval(this._dashboardTimer);
        if (this._unsubReconnect) this._unsubReconnect();
        if (this._unsubModuleError) this._unsubModuleError();
        if (this._unsubConnected) this._unsubConnected();
        if (this._unsubDisconnected) this._unsubDisconnected();
        if (this._unsubReconnected) this._unsubReconnected();
        if (this._boundListeners) {
            for (const {el, type, handler} of this._boundListeners) {
                el?.removeEventListener(type, handler);
            }
            this._boundListeners = [];
        }
        this.wsManager.unregisterModule('diagnostic');
    }

    // ─── Helper: track listeners for cleanup ───

    _listenOne(id, type, handler) {
        const el = document.getElementById(id);
        if (!el) return;
        const bound = handler.bind(this);
        el.addEventListener(type, bound);
        if (!this._boundListeners) this._boundListeners = [];
        this._boundListeners.push({el, type, handler: bound});
    }

    // ─── Error recording ───

    _recordError(source, message, stack) {
        this._errors.unshift({
            ts: new Date().toISOString(),
            source,
            message,
            stack: stack || '',
            category: source,
        });
        if (this._errors.length > this._MAX_ERRORS) {
            this._errors.pop();
        }
        this._pushTimeline('error', `[${source}] ${message}`);
        this.bus.emit('diagnostic-error', { source, message });
    }

    // ─── Timeline ───

    _pushTimeline(type, text) {
        this._timeline.unshift({ts: new Date(), type, text});
        if (this._timeline.length > this._MAX_TIMELINE) {
            this._timeline.pop();
        }
    }

    // ─── Module health tracking ───

    _recordModuleHealth(moduleName, status) {
        this._metrics.moduleHealth[moduleName] = {
            status,  // 'green' | 'yellow' | 'red'
            lastUpdate: Date.now(),
        };
    }

    // ─── Periodic polling ───

    _startPolling() {
        this._pollTimer = setInterval(() => {
            if (this.wsManager.connected) {
                this.wsManager.send({type: 'diagnostic'});
                this.wsManager.send({type: 'time-request'});
            }
        }, 5000);  // every 5 seconds
    }

    _startLatencyCheck() {
        this._latencyTimer = setInterval(() => {
            if (this.wsManager.connected) {
                this.wsManager.send({type: 'ping', clientTs: Date.now()});
            }
        }, 10000);  // every 10 seconds
    }

    // ─── Dashboard rendering ───

    renderDashboard() {
        const snap = this._metrics.lastServerSnapshot;
        const serverCard = document.getElementById('diagCardServer');
        const clientCard = document.getElementById('diagCardClient');

        // Server metrics
        if (snap) {
            this._setText('diagVersion', snap.version || '---');
            this._setText('diagUptime', snap.uptime ? Math.floor(snap.uptime / 3600) + 'h ' + Math.floor((snap.uptime % 3600) / 60) + 'm' : '---');
            this._setText('diagRooms', snap.activeRooms ?? '---');
            this._setText('diagPeers', snap.activePeers ?? '---');
            this._setText('diagLoop', snap.loopDelayMs !== undefined ? snap.loopDelayMs + 'ms' : '---');
            this._setText('diagMem', snap.memoryUsageMb !== undefined ? snap.memoryUsageMb.toFixed(1) + 'MB' : '---');
            this._setText('diagDb', snap.dbOk ? '🟢 OK' : '🔴 ERR');
            this._setText('diagNtp', snap.ntpOffset !== undefined ? snap.ntpOffset + 's' : '---');

            // Server card severity color
            const loopGreen = snap.loopDelayMs !== undefined && snap.loopDelayMs < 50;
            const loopYellow = snap.loopDelayMs !== undefined && snap.loopDelayMs < 100;
            const memOk = snap.memoryUsageMb === undefined || snap.memoryUsageMb < 500;
            const dbOk = snap.dbOk !== false;
            const serverHealthy = loopGreen && memOk && dbOk;
            const serverWarn = loopYellow && memOk && dbOk;
            if (serverCard) {
                serverCard.className = 'diag-card';
                if (serverHealthy) serverCard.classList.add('diag-card-green');
                else if (serverWarn) serverCard.classList.add('diag-card-yellow');
                else serverCard.classList.add('diag-card-red');
            }
        }

        // Client metrics
        this._setText('diagWsStatus', this.wsManager.connected ? '🟢 已連線' : '🔴 離線');
        this._setText('diagWsLatency', this._metrics.wsLatency ? this._metrics.wsLatency + 'ms' : '---');
        this._setText('diagReconnects', String(this._metrics.wsReconnects));
        this._setText('diagHeap', performance?.memory?.usedJSHeapSize ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + 'MB' : '---');

        // Client card severity
        const clientHealthy = this.wsManager.connected && this._metrics.wsLatency < 100;
        const clientWarn = this.wsManager.connected && this._metrics.wsLatency < 300;
        if (clientCard) {
            clientCard.className = 'diag-card';
            if (clientHealthy) clientCard.classList.add('diag-card-green');
            else if (clientWarn) clientCard.classList.add('diag-card-yellow');
            else clientCard.classList.add('diag-card-red');
        }

        // Sparklines
        this._drawSparkline('diagSparklineLoop', this._sparklineLoop, '#38bdf8');
        this._drawSparkline('diagSparklineLatency', this._sparklineLatency, '#22c55e');

        // Module health
        this._renderModuleHealth();

        // Error log
        this._renderErrorLog();

        // Timeline
        this.renderTimeline();
    }

    renderTimeline() {
        const container = document.getElementById('diagTimelineContent');
        if (!container) return;
        if (this._timeline.length === 0) {
            container.innerHTML = '<div style="color:#475569;">尚無事件</div>';
            return;
        }
        container.innerHTML = this._timeline.slice(0, 30).map(e => {
            const dotClass = e.type === 'error' ? 'error' : e.type === 'warn' ? 'warn' : 'ok';
            const timeStr = e.ts.toISOString().slice(11, 19);
            return `<div><span class="diag-timeline-dot ${dotClass}"></span><span style="color:#64748b;">${timeStr}</span> ${e.text}</div>`;
        }).join('');
    }

    _renderModuleHealth() {
        const container = document.getElementById('diagModuleContent');
        if (!container) return;
        const health = this._metrics.moduleHealth;
        const names = Object.keys(health);
        if (names.length === 0) {
            container.innerHTML = '<span style="color:#475569;">尚無模組資料</span>';
            return;
        }
        container.innerHTML = names.map(name => {
            const info = health[name];
            const statusIcon = info.status === 'green' ? '🟢' : info.status === 'yellow' ? '🟡' : '🔴';
            return `<span style="background:#0f172a;border-radius:6px;padding:4px 10px;">${statusIcon} ${name}</span>`;
        }).join('');
    }

    _renderErrorLog() {
        const container = document.getElementById('diagErrorContent');
        if (!container) return;
        if (this._errors.length === 0) {
            container.innerHTML = '<div style="color:#475569;">無錯誤記錄</div>';
            return;
        }
        container.innerHTML = this._errors.slice(0, 30).map(e => {
            const timeStr = e.ts.slice(11, 19);
            return `<div><span style="color:#ef4444;">[${timeStr}]</span> <span style="color:#94a3b8;">${e.message}</span></div>`;
        }).join('');
    }

    // ─── Sparkline canvas drawing ───

    _drawSparkline(canvasId, data, color) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !data || data.length < 2) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        const max = Math.max(...data, 1);
        const min = Math.min(...data, 0);
        const range = max - min || 1;
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        data.forEach((v, i) => {
            const x = (i / (data.length - 1)) * w;
            const y = h - ((v - min) / range) * (h - 4) - 2;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
    }

    // ─── Export diagnostic report ───

    _exportDiagnosticReport() {
        const data = {
            exportedAt: new Date().toISOString(),
            server: this._metrics.lastServerSnapshot,
            client: {
                wsStatus: this.wsManager.connected ? 'connected' : 'disconnected',
                wsLatency: this._metrics.wsLatency,
                reconnectCount: this._metrics.wsReconnects,
            },
            modules: this._metrics.moduleHealth,
            errors: this._errors.slice(0, 50),
            timeline: this._timeline.slice(0, 50),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json;charset=utf-8'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `diagnostic-report-${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    // ─── Internal helpers ───

    _setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    // ─── Public API for dashboard ───

    getErrors(count = 20) {
        return this._errors.slice(0, count);
    }

    getMetrics() {
        return { ...this._metrics };
    }

    requestFullDiagnostic() {
        this.wsManager.send({type: 'diagnostic'});
    }

    clearErrors() {
        this._errors = [];
    }
}
