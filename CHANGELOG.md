# Changelog

All notable changes to Clipper are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.1.0] — 2026-06-20

### 🚀 新增功能
- **📦 PyInstaller 打包** — 12MB 單一執行檔，Windows + macOS 雙平台 GitHub Actions 自動編譯
- **🤖 CI/CD 自動化** — `.github/workflows/build.yml` 完整 pipeline：推送 `v*` tag 自動建置 + Release
- **💬 聊天室現代化氣泡 UI** — 改善聊天版面、氣泡樣式、搜尋列固定只讓訊息區滾動
- **🌐 WS Server URL 自動持久化** — 瀏覽器 hostname 自動偵測 + URL/Room ID 儲存

### 🐛 修復
- **所有用戶卡在 relay 模式** — 3 個 root cause 一次修復，P2P 連線恢復正常
- **聊天訊息看不見** — 孤立的 `dc.onmessage` + `handleWsMessage` 呼叫修復
- **ChatModule 未實例化** — 導致發送按鈕無反應
- **聊天佈局損壞** — `.main-content` 非 flex 容器
- **雙重滾動條問題** — 聊天頁排除 `tab-pane` 的 `overflow-y:auto`
- **Tab 溢出問題** — 限制 `tab-pane` 高度防止內容溢出
- **聊天輸入框消失** — load-more 後 preserve scroll position
- **傳送訊息未持久化** — `_sendChatMessage` 未寫入 `APP.state.persistedChatMessages`

### 🔧 改善
- 搜尋列與輸入框固定，只讓訊息區滾動
- 多項 chat scrolling / layout 問題修復

### 🚀 新增功能

- **📡 密鑰管理分頁** — 專用管理直播推流 Stream Key 和 URL，支援標記「正在直播的節目名稱」、使用中/未使用狀態切換、部分遮蔽顯示、一鍵複製
- **🆔 頁首 Peer ID 顯示** — header 時鐘旁顯示當前用戶 Peer ID，連線後自動更新、斷線後清除

## [1.1.0] — 2026-06-19

### 🚀 新增功能

- **📋 公告欄分頁** — 完整 CRUD 公告貼文，支援釘選置頂
- **🏷️ 公告欄分類** — 4 級分類（重要🔴/日常🔵/交接事項🟡/其他事項⚪），自動色碼、標籤 badges
- **✅ 檢查清單 Boards** — 階層式結構，每個 Board 可獨立命名、設色、加標籤、釘選、可收合
- **🔄 Tick Reset** — 一鍵重設 Board 內所有勾選
- **🔔 排程提醒** — 設定日期時間，到期自動彈窗通知
- **💬 實時短信持久化** — 聊天訊息自動儲存至 localStorage，重整不消失（最多 200 則）
- **🎨 用戶顏色區分** — 根據顯示名稱自動分配 HSL 色相，一眼辨識發話者
- **🗑️ 清除本機聊天紀錄** — 確認對話框防誤刪
- **🖥️ 伺服器持久化** — 公告欄、檢查清單、聊天備份全部儲存至伺服器 SQLite 資料庫
- **🔧 聊天備份留存** — 可設定 `CHAT_RETENTION_DAYS`（預設 7 天）
- **🔄 WS Relay 後備** — WebRTC DataChannel 失敗時自動降級為 WebSocket 中繼傳輸
- **⚙️ 設定分頁** — 檢視傳輸模式（P2P/Relay）、各用戶連線狀態、STUN 伺服器設定
- **🌐 STUN 支援** — 預設 Google STUN 伺服器，設定頁可自訂位址
- **📤 並行檔案傳輸** — 各對象獨立傳送不阻塞，A 傳 B 同時 C 可傳 D
- **🔍 Debug Dump** — 一鍵輸出伺服器完整診斷資訊
- **🕐 頁頂時鐘** — 即時顯示 hh:mm:ss 及當日日期
- **🔗 預設配對碼** — 自動填入 1234 並在頁面載入後快速建立配對
- **✏️ 顯示名稱跨 F5 保留** — 使用 localStorage 儲存，重整不重置
- **🔔 Popup 通知** — 新公告/新檢查清單/新待辦項目時右下角彈窗
- **🟢 同步狀態指示器** — footer 顯示最後同步時間 + 手動同步按鈕

### 🔧 改善

- **📱 自適應佈局** — 視窗縮小時排版自動折疊、不隱藏任何文字
- **🔤 字體放大 25%** — 全介面字體等比放大，提升可讀性
- **🛡️ Room-State Merge** — 同步時合併而非覆寫，保留本機資料
- **🚨 連線守衛** — 公告編輯等操作補上連線檢查
- **🗑️ 防誤刪確認** — 公告欄及檢查清單所有刪除動作皆有確認對話框
- **📂 檔案傳輸改為需選對象** — 不再預設傳送給所有人
- **📤 檔案傳輸並行化** — `fileSending` 改為 `Map<peerId, entry>`，各對象不互相阻塞
- **🔊 伺服器 Verbose DEBUG** — `_debug()` 微秒精度日誌，所有 WS 收發可追蹤
- **🔄 自動重新同步** — 斷線重連後自動發送 state-get
- **🌐 已知限制更新** — 4 項限制各有解決方案或已實作

### 🐛 修復

- **資料覆蓋問題** — room-state 改為合併而非覆寫 local-only 資料

### 🏗️ 架構

- **C/S 分離** — WebSocket 負責持久資料 CRUD + Relay，DataChannel 負責即時通訊
- **localStorage + 伺服器 JSON 雙重持久化**
- **聊天備份** — 7 日留存可調，不影響 P2P 即時通訊
- **WebRTC 優先，WS Relay 後備** — 自適應傳輸模式
- **FileSending per-peer** — 各對象獨立傳送佇列

### 檔案統計 (vs v1.0)

| 檔案 | v1.0 | 1.1.0 | 變更 |
|------|------|-------|------|
| clipper.html | 1,497 行 | ~4,550 行 | +3,053 |
| signal_server.py | 190 行 | ~1,200 行 | +1,010 |
| CHANGELOG.md | — | 新增 | +85 |
| README.md | 99 行 | 170 行 | +71 |

### 完整 Commit History

```
b183e3a docs: update about page, README and CHANGELOG for v1.1.0
1f334a4 feat(relay): add WebSocket relay fallback + settings tab
c7d406d feat(server): add verbose DEBUG logging
...共 30+ 個 commits
```

## [1.0.0] — 初始版本

- 內網跨子網 P2P 多人協作工具
- WebRTC Full Mesh 連線
- 聊天室即時訊息廣播
- 檔案傳輸（拖放上傳、大檔案區塊傳輸、指定對象）
- 隨機中文顯示名稱系統
- WebSocket 信令伺服器
