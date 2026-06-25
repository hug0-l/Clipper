# Clipper Plugin System

Clipper 支援 client 端與 server 端的插件系統，允許開發者新增自訂分頁功能、註冊 WebSocket 訊息類型，以及儲存持久化資料。

---

## 目錄

- [架構概覽](#架構概覽)
- [Client 插件](#client-插件)
  - [註冊 API](#註冊-api)
  - [mount / unmount](#mount--unmount)
  - [WS Handlers](#ws-handlers)
  - [CSS 注入](#css-注入)
  - [完整範例](#完整範例)
- [Server 插件](#server-插件)
  - [註冊 WS Handler](#註冊-ws-handler)
  - [ctx 可用物件](#ctx-可用物件)
  - [持久化儲存](#持久化儲存)
  - [完整範例](#server-完整範例)
- [插件管理](#插件管理)
- [可用全域 API](#可用全域-api)
- [通訊模式](#通訊模式)
- [最佳實踐](#最佳實踐)

---

## 架構概覽

```
┌─────────────────────┐     ┌──────────────────────┐
│   Client (瀏覽器)    │     │   Server (Python)     │
│                     │     │                       │
│  ClipperPlugins     │ WS  │  @register("type")    │
│  .registerPlugin()  │────▶│  async def handler()  │
│                     │     │                       │
│  mount(container)   │     │  ctx["plugin_set"]()  │
│  unmount()          │     │  ctx["plugin_get"]()  │
│  wsHandlers{...}    │     │                       │
└─────────────────────┘     └──────────────────────┘
         │                           │
         │ DataChannel / WS Relay    │
         ▼                           ▼
    其他 Peers ════════════════════════
```

**Client 插件**: 在瀏覽器中執行，可以新增分頁、註冊 WS 訊息處理器、操縱 DOM。
**Server 插件**: 在 Python 伺服器中執行，可以註冊 WS 訊息類型、存取持久化資料庫。

插件透過 WebSocket (WS) 或 DataChannel (DC)/WS Relay 進行通訊。

---

## Client 插件

### 註冊 API

插件透過 `ClipperPlugins.register(descriptor)` 或 `ClipperPlugins.registerPlugin(descriptor)` 註冊。

**descriptor 欄位：**

| 欄位 | 型態 | 必填 | 說明 |
|------|------|------|------|
| `name` | `string` | ✅ | 唯一識別名稱，只能包含英文數字與連字號 |
| `version` | `string` | — | 語意化版本號 (如 `1.0.0`) |
| `displayName` | `string` | — | 顯示名稱，預設同 `name` |
| `description` | `string` | — | 簡短描述（顯示在佔位區與管理頁） |
| `icon` | `string` | — | Emoji 圖示，預設 `🔌` |
| `tab` | `object` | — | 分頁設定 |
| `mount` | `function` | — | 掛載函式，接收 container DOM 元素 |
| `unmount` | `function` | — | 卸載函式，清除 listener / timer |
| `wsHandlers` | `object` | — | WS 訊息類型 → 處理函式映射 |
| `css` | `string` | — | 插件專屬 CSS 字串（自動注入 `<style>`） |

**tab 欄位：**

| 欄位 | 型態 | 預設 | 說明 |
|------|------|------|------|
| `position` | `'nav'` | `'dropdown'` | `'nav'` = 導航欄常駐, `'dropdown'` = 在「更多」選單內 |
| `title` | `string` | `displayName` | 分頁按鈕文字 |
| `afterTarget` | `string` | — | 插入位置（如 `'filetransfer'`、`'about'`） |

### mount / unmount

**`mount(container)`**:
- `container` 是 `<section class="tab-pane">` DOM 元素
- 插件應在此方法中設定 container 的 `innerHTML` 並繫結事件
- 支援 `contenteditable`、`addEventListener` 等標準 DOM API
- 掛載錯誤會被自動捕捉並記錄

**`unmount()`**:
- 應清除所有自訂的 `setInterval`、`addEventListener`、DOM 變更
- WS handler 會由 PluginRegistry 自動清理（透過 `wsManager.unregisterModule()`）

### WS Handlers

```javascript
wsHandlers: {
    'relay-data': function(data) {
        // data.from = 發送者 peerId
        // data.data = { type, ... } 自訂 payload
        if (data.data && data.data.type === 'plugin-my-event') {
            // 處理訊息
        }
    },
    'some-ws-type': function(data) {
        // 處理伺服器廣播的特定 WS 訊息類型
    }
}
```

支援任何 WS 訊息類型，包含：
- `relay-data` — 接收來自其他 peer 的 relay 訊息（需檢查 `data.data.type`）
- 自訂 server 端 `@register("...")` 定義的類型
- 系統事件如 `room-state`、`peer-list` 等

**注意**: 
- DataChannel 訊息會透過 `wsManager.dispatchMessage()` 自動轉發給插件 handler
- 插件應使用 `data.data.type` 來過濾自己的訊息，避免干擾其他功能
- handler 內的 `this` 指向 descriptor 物件

### CSS 注入

提供 `css` 字串會自動建立 `<style id="plugin-css-{name}">` 並注入 `<head>`。
取消註冊時自動移除。

```javascript
css: '.plugin-myclass { color: red; }' +
     '.plugin-other { padding: 10px; }'
```

**命名建議**: 所有 class 加上 `plugin-{name}-` 前綴以避免衝突。

### 完整範例

`plugins/counter-plugin.js`:

```javascript
(function() {
    var _val = 0;

    ClipperPlugins.register({
        name: 'counter',
        version: '1.0.0',
        displayName: '計數器',
        description: '協作計數器 — 同房所有用戶同步',
        icon: '🔢',
        tab: { position: 'dropdown', title: '🔢 計數器', afterTarget: 'about' },
        css: '.plugin-counter-val{font-size:48px;font-weight:700;color:#38bdf8;text-align:center;padding:20px;}' +
              '.plugin-counter-btn{font-size:24px;padding:10px 20px;margin:0 8px;}',

        wsHandlers: {
            'relay-data': function(data) {
                if (data.data && data.data.type === 'plugin-counter-update') {
                    _val = data.data.value;
                    var el = document.getElementById('pluginCounterVal');
                    if (el) el.textContent = _val;
                }
            }
        },

        mount: function(container) {
            container.innerHTML = '<div class="plugin-counter-wrap">' +
                '<h2>🔢 協作計數器</h2>' +
                '<div class="plugin-counter-val" id="pluginCounterVal">0</div>' +
                '<button id="pluginCounterInc">+</button>' +
                '</div>';

            document.getElementById('pluginCounterInc').addEventListener('click', function() {
                _val++;
                broadcastToPeers(JSON.stringify({type: 'plugin-counter-update', value: _val}));
            });
        }
    });
})();
```

---

## Server 插件

### 目錄位置

```
server_plugins/
  ├── echo_plugin.py      # 範例插件
  └── your_plugin.py      # 你的插件
```

伺服器啟動時自動掃描 `server_plugins/` 目錄並載入所有 `.py` 檔案（不含 `_` 開頭的）。

### 註冊 WS Handler

使用 `@register("type")` 裝飾器註冊 WS 訊息處理器：

```python
from services.ws_router import register

@register("my-plugin-action")
async def h_my_action(websocket, data, ctx):
    """處理 my-plugin-action 類型的 WS 訊息。"""
    rid = data.get("room")
    payload = data.get("payload", {})
    # ... 處理邏輯 ...
    await websocket.send(json.dumps({
        "type": "my-plugin-response",
        "result": "ok"
    }))
```

### ctx 可用物件

server 插件 handler 可透過 `ctx` 存取以下物件：

| 名稱 | 說明 |
|------|------|
| `ctx["rooms"]` | `{room_id: {peer_id: {ws, displayName, ...}}}` — 目前線上房間 |
| `ctx["room_data"]` | `{room_id: {noticePosts, checklists, ...}}` — 持久資料 |
| `ctx["broadcast"](room_peers, msg, exclude)` | 廣播訊息給房間內所有 peer |
| `ctx["broadcast_peer_list"](room_id)` | 廣播更新後的 peer 清單 |
| `ctx["log"]("CATEGORY", "message")` | 寫入日誌 |
| `ctx["debug"]("message")` | DEBUG 模式才輸出的日誌 |
| `ctx["ensure_room_data"](room_id)` | 確保 room_data 存在 |
| `ctx["save_state"]()` | 儲存所有資料到 SQLite |
| `ctx["verify_session"](token)` | 驗證管理員 session token |
| `ctx["plugin_set"]` | 見下方持久化 |
| `ctx["plugin_get"]` | 見下方持久化 |
| `ctx["plugin_delete"]` | 見下方持久化 |
| `ctx["plugin_list"]` | 見下方持久化 |
| `ctx["plugin_clear"]` | 見下方持久化 |
| `ctx["_my_peer_id"]` | 當前連線的 peer ID |
| `ctx["_room_id"]` | 當前連線的房間 ID |
| `ctx["config"]` | `{chatRetentionDays, stunServer, turnServer, ...}` |
| `ctx["ntp_config"]` | `{server, offset, enabled, _ntp_valid}` |

### 持久化儲存

插件可使用 key-value 儲存在 SQLite 中保存資料（`plugin_data` 表）：

```python
# 儲存
ctx["plugin_set"]("my-plugin", "counter", 42)

# 讀取
value = ctx["plugin_get"]("my-plugin", "counter", default=0)

# 刪除
ctx["plugin_delete"]("my-plugin", "counter")

# 列出所有 key
keys = ctx["plugin_list"]("my-plugin")

# 清除所有
ctx["plugin_clear"]("my-plugin")
```

### Server 完整範例

```python
"""server_plugins/my_plugin.py"""

import json
import time
from services.ws_router import register


@register("my-plugin-save")
async def h_save(websocket, data, ctx):
    """Save data to plugin storage."""
    rid = data.get("room")
    key = data.get("key", "default")
    value = data.get("value")
    
    ctx["plugin_set"]("my-plugin", key, value)
    ctx["log"]("MY-PLUGIN", f"saved {key} in {rid}")
    
    await websocket.send(json.dumps({
        "type": "my-plugin-save-result",
        "success": True,
    }))


@register("my-plugin-load")
async def h_load(websocket, data, ctx):
    """Load data from plugin storage."""
    key = data.get("key", "default")
    value = ctx["plugin_get"]("my-plugin", key)
    
    await websocket.send(json.dumps({
        "type": "my-plugin-load-result",
        "key": key,
        "value": value,
    }))
```

---

## 插件管理

管理員登入後可在 **⚙️ 伺服器設定 → 🔌 插件** 頁面管理插件：

- **檢視** 已安裝插件清單（名稱、版本、描述、WS handlers）
- **啟用/停用** 插件分頁顯示（按鈕隱藏/顯示）
- **移除** 插件（呼叫 `unregisterPlugin()`）
- **載入** 插件（輸入 URL 或上傳 `.js` 檔案）

---

## 可用全域 API

Client 插件可在 `mount()`、`wsHandlers`、`unmount()` 中使用的全域 API：

| API | 說明 |
|-----|------|
| `APP.state` | 全域狀態（`room`, `peers`, `peerNames`, `displayName`, `checklists`, `noticePosts` 等） |
| `APP.state.room` | 目前房間代碼 |
| `APP.state.peers` | `Map<peerId, {dc, pc, relay}>` 其他 peer 連線 |
| `APP.state.peerNames` | `Map<peerId, displayName>` |
| `APP.state.displayName` | 自己的顯示名稱 |
| `APP.state.readOnly` | 唯讀模式 |
| `sendWsMessage(obj)` | 發送 JSON 到 WebSocket 伺服器 |
| `broadcastToPeers(jsonStr)` | 廣播 JSON 字串到所有 peer（自動選 DC 或 relay） |
| `showPopup(icon, title, body)` | 顯示彈出通知 |
| `showConfirmDialog(msg)` | 顯示確認對話框（回傳 Promise） |
| `APP.showStatusMsg(msg)` | 在底部狀態列顯示訊息 |
| `saveToStorage(key, data)` | 儲存到 localStorage |
| `loadFromStorage(key, default)` | 從 localStorage 讀取 |
| `escapeHtml(str)` | HTML 跳脫 |
| `wsBus.on(event, handler)` | 監聽 MessageBus 事件 |
| `wsManager.send(obj)` | 等同 `sendWsMessage` |
| `wsManager.onMessage(types, handler, moduleName)` | 註冊 WS handler |
| `wsManager.dispatchMessage(data)` | 手動分發訊息給已註冊 handler |

**MessageBus 事件** (`wsBus.on(...)`)：

| 事件 | payload | 時機 |
|------|---------|------|
| `connected` | `{}` | WS 連線成功 |
| `disconnected` | `{wasIntentional}` | WS 斷線 |
| `room-joined` | `{room, peerId}` | 成功加入房間 |
| `peer-joined` | `{peerId, displayName}` | 有 peer 加入 |
| `peer-left` | `{peerId}` | 有 peer 離開 |
| `state-synced` | `{}` | room-state 合併完成 |
| `readonly-change` | `{enabled}` | 唯讀模式切換 |
| `server-message` | `{msg, type}` | 收到原始 WS 訊息 |

---

## 通訊模式

### 1. Client → Client (DataChannel)

使用 `broadcastToPeers()`：

```javascript
// sender
broadcastToPeers(JSON.stringify({
    type: 'plugin-my-event',
    value: 42
}));

// receiver (in wsHandlers)
wsHandlers: {
    'relay-data': function(data) {
        if (data.data && data.data.type === 'plugin-my-event') {
            // data.data.value === 42
        }
    }
}
```

### 2. Client → Server → Client

使用 `sendWsMessage()` + server `@register()`：

```javascript
// client
sendWsMessage({
    type: 'my-plugin-action',
    room: APP.state.room,
    payload: { ... }
});

// server 收到後可廣播給所有人
ctx["broadcast"](ctx["rooms"][rid], {"type": "my-plugin-event", ...}, exclude=websocket)
```

### 3. Client → Server (persistence)

```javascript
// client 要求 server 儲存資料
sendWsMessage({
    type: 'my-plugin-save',
    room: APP.state.room,
    key: 'counter',
    value: 42
});
```

---

## 最佳實踐

### 命名規範

| 項目 | 規範 | 範例 |
|------|------|------|
| 插件 name | 英文小寫 + 連字號 | `my-awesome-plugin` |
| WS 訊息 type | `plugin-{name}-{action}` | `plugin-counter-update` |
| DOM element ID | `plugin{Name}{Desc}` | `pluginCounterVal` |
| CSS class | `plugin-{name}-{desc}` | `plugin-counter-val` |
| CSS prefix | 所有 class 加前綴 | `plugin-myname-*` |

### readOnly 支援

插件應檢查 `APP.state.readOnly` 並在唯讀模式時禁用寫入操作：

```javascript
if (APP.state.readOnly) {
    APP.showStatusMsg('🔒 唯讀模式不可操作');
    return;
}
```

### 清理程序

在 `unmount()` 中清理：
- `clearInterval()` / `clearTimeout()`
- 全域 `document.addEventListener` 監聽
- `document.body` 的直接修改

WS handler 和 CSS 會由 PluginRegistry 自動清理。

### 錯誤處理

- mount 錯誤會自動捕捉並記錄
- WS handler 錯誤會觸發 `module-error` 事件但不影響其他插件
- 使用 `try/catch` 包裹非同步操作

### 效能考量

- 避免在 `mount()` 中執行大量 DOM 操作
- WS handler 應盡量輕量，複雜計算應使用 `requestAnimationFrame` 或 `setTimeout`
- 使用 `localStorage` 謹慎，避免頻繁寫入

---

## i18n / Localization

Clipper 內建 i18n 系統，支援中英文切換。

### 對插件開發者的影響

插件可以使用 `_t('key')` 函數取得當前語言的翻譯字串：

```javascript
mount: function(container) {
    container.innerHTML = '<h2>' + _t('checklist.form_title') + '</h2>';
}
```

也可使用 `data-i18n` 屬性自動翻譯（元素載入時自動設定 `textContent`）：

```html
<button data-i18n="common.save"></button>
```

語系切換時會自動更新所有 `data-i18n` 元素。

### 新增語言

1. 在 `js/i18n/` 目錄下建立新的語言檔案，如 `ja.js`（日文）：

```javascript
_registerLocale('ja', {
  common: { save: '保存', cancel: 'キャンセル', ... },
  chat: { send_btn: '送信', ... },
  // ... 完整翻譯所有 key
});
```

2. 在 `clipper.html` 中加入 `<script src="js/i18n/ja.js"></script>`（放在 `i18n.js` 之前）

3. 在語系選擇器中加入選項：
```html
<option value="ja">日本語</option>
```

4. 翻譯 key 結構參考 `zh-TW.js` 或 `en.js`，所有 key 必須保持一致。

### 可用 i18n 全域函式

| 函式 | 說明 |
|------|------|
| `_t(key, ...args)` | 取得翻譯字串，支援 `{0}` `{1}` 佔位符 |
| `_langGet()` | 取得當前語系代碼（如 `'zh-TW'`、`'en'`） |
| `_langSet(lang)` | 切換語系（如 `_langSet('en')`） |
| `_i18nOnChange(fn)` | 註冊語系變更監聽器，回傳取消訂閱函式 |
