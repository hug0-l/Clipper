# AGENTS.md

This file provides guidance to AI agents when working with this repository.

## Development Commands

- **Run Server**: `python3 signal_server.py`
- **Dependencies**: `pip install websockets`
- **No build step required** — single-file SPA + Python server.

## Architecture

```
├── clipper.html              # 主用戶端 SPA（WebRTC + WS + 所有功能模組，~4,550 行）
├── signal_server.py          # 信令伺服器（WebSocket 配對 + 持久化儲存 + Relay，~1,400 行）
├── clipper.spec              # PyInstaller 打包設定
├── clipper-sdk.js            # 輕量 JS SDK (1,317 行)，0 外部依賴
├── protocol.md               # 完整 WS API 規範 (1,936 行，48 種訊息類型)
├── .github/workflows/        # GitHub Actions CI/CD
│   └── build.yml             # Windows + macOS 自動編譯 + Release
├── clipper_data.db           # SQLite 資料庫（啟動時自動建立）
├── logs/                     # 每日日誌檔案（自動輪替，24h 保留）
```
## Protocol

| Layer | Transport | Purpose |
|-------|-----------|---------|
| Signaling | WebSocket (WS) | Room pairing, WebRTC offer/answer/ICE, relay data, admin, persistence |
| Real-time | WebRTC DataChannel | Chat messages, file transfer (P2P) |
| Fallback | WS Relay | When DataChannel fails, messages/files relay through server |
| Static | HTTP (:8766) | Serves `clipper.html` and static files — open in browser directly |

## Key Patterns

- **`APP.state`** — global state object in `clipper.html`. All state lives here.
- **`handleWsMessage(data)`** — WS message router (switch on `data.type`). Unknown types fall through to `handleAdminMessage(data)`.
- **`handleAdminMessage(data)`** — admin panel message handler, defined later in the script.
- **`sendWsMessage(obj)`** — send JSON to server.
- **`sendToPeers(jsonStr, peerIds)`** — send via DC if open, else relay.
- **`_broadcast(room_peers, message, exclude)`** — server-side broadcast.

## Common Tasks

- **Add a new WS message type**: Add a `case 'your-type':` in `handleWsMessage()` (client) and a corresponding `elif msg_type == "your-type":` in `handler()` (server).
- **Change persistence**: Server uses SQLite (`clipper_data.db`). Legacy JSON migration (`vcc_server_state.json`) runs automatically on first startup.
- **Add admin feature**: Add a new `case` in `handleAdminMessage()`, a new `elif msg_type == "admin-*":` in server, and UI elements in the admin panel HTML.
- **File transfer**: Uses chunked transfer (16 KB chunks) over DC or WS relay. Each peer has an independent sending queue.

## Known Quirks

- `isPeerReachable(pid)` checks `dc.readyState`, `ps.relay`, and `ps.connected` — used for file transfer target selection.
- When a peer disconnects, `removePeer()` cleans `selectedTargetPeerIds` automatically.
- Admin session tokens expire after 30 minutes. `unauthorized` error auto-resets the admin panel.
- The server has no `make` commands — just run `python3 signal_server.py` directly.
- `_log._file` is assigned in `_setup_logging()`; the old JSON persistence file (`vcc_server_state.json`) gets renamed to `.bak` after migration.
- HTTP server: `_mini_http()` runs on port 8766 via `asyncio.start_server`. Independent from WebSocket server on 8765.
- NTP validation: `_ntp_query()` returns `(offset, is_valid)`. When `is_valid=False` the admin panel shows the offset in red with a tooltip. All NTP responses (`time-sync`, `ntp-config-result`, `admin-login`, `admin-config`) include `ntpValid`.
- **離線唯讀模式**: WS 斷線時自動呼叫 `setReadOnly(true)` 鎖定所有協作功能；重連成功後（`joined` 事件）自動解除。`setReadOnly()` 實作在獨立的 `Read-Only Mode` 區塊中。手動中斷（`disconnect()`）不觸發唯讀。
- **幽靈復活防護**: 伺服器記錄 `deletedPostIds`/`deletedChecklistIds`/`deletedKeyIds`，`room-state` 回應中攜帶這些 ID。前端合併時先過濾已被伺服器刪除的項目，再執行現有合併邏輯。向後相容：舊伺服器不發 `deleted*Ids` 則跳過過濾。
- **自動跳轉瀏覽器**: `signal_server.py` 啟動完成後自動呼叫 `webbrowser.open('http://localhost:8766')`，headless 環境優雅降級。
- **SDK WebRTC P2P**: `clipper-sdk.js` 有完整 P2P 支援（`RTCPeerConnection` + `DataChannel`）。低 peerId 者發起 `offer`，高者等待。自動降級 WS relay。原生 `clipper.html` 也有同樣實作。
- **SDK 檔案傳輸佇列**: `sendFile()` 放入 `_fileSendQueue`，依序傳送。`_fileSending` 旗標避免並行 flood。
- **REST API**: `signal_server.py` 在 port 8766 提供 `GET /api/health`、`GET /api/rooms/:room/state`、`POST|PUT|DELETE /api/rooms/:room/notice` 等端點。CORS `*`。
- **peerId 不顯示給用戶**: 三個 codebase（clipper.html / clipper-sdk.js / countdownctrl）的所有 UI 文字只顯示 `displayName`。`peerId` 只用於內部識別（Map key、`btn.title`）。

## 🤖 CI/CD — GitHub Actions

### Build Workflow (`.github/workflows/build.yml`)

| 觸發條件 | 動作 |
|---------|------|
| 推送 `v*` tag（如 `v2.1.0`） | 自動在 Windows + macOS 編譯 PyInstaller 執行檔 |
| 手動 `workflow_dispatch` | 可從 GitHub Actions tab 手動觸發 |

### 產出
| 平台 | 檔案 |
|------|------|
| 🪟 Windows | `clipper-server.exe` |
| 🍎 macOS | `clipper-server` (執行檔) + `Clipper.app.zip` (.app Bundle) |

### 觸發方式
```bash
git tag v2.1.0 && git push origin v2.1.0
# → GitHub Actions 自動建置 → Release 自動建立
```

### Release 流程
1. 打 tag → push → GitHub Actions 觸發
2. `build-windows` job: 編譯 `clipper-server.exe`
3. `build-macos` job: 編譯 `clipper-server` + 壓縮 `Clipper.app.zip`
4. `release` job: 自動建立 GitHub Release 並附上三個產出檔案

> **注意**：Release 由 `softprops/action-gh-release@v2` 自動建立，需確保 `GITHUB_TOKEN` 有 `contents: write` 權限（已在 workflow 中設定）。