# AGENTS.md

This file provides guidance to AI agents when working with this repository.

## Development Commands

- **Run Server**: `python3 signal_server.py`
- **Dependencies**: `pip install websockets`
- **No build step required** — single-file SPA + Python server.

## Architecture

```
clipper.html          # Single-page application (SPA), ~4,550 lines
                      # HTML + CSS + JS in one file. No bundler/framework.
signal_server.py      # WebSocket signaling server, ~1,250 lines
                      # Handles: room mgmt, WebRTC signaling, WS relay,
                      # admin panel, NTP sync, SQLite persistence.
                      # Built-in HTTP server on port 8766.
clipper_data.db       # SQLite database (auto-created at startup)
logs/                 # Daily log files (auto-rotated, 24h retention)
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