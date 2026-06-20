#!/usr/bin/env python3
"""Clipper signaling server - N-peer WebSocket room for WebRTC Full Mesh."""

import asyncio
import hashlib
import json
import logging
import os
import random
import secrets
import signal
import socket
import sqlite3
import struct
import string
import time
from datetime import datetime, timezone, timedelta

import websockets
import mimetypes

from services.ws_router import ROUTES
from services.persistence import Persistence
from services.chat_service import ChatService
from services.room_service import RoomServicefrom services.keymgmt_service import KeyMgmtService

# ──── Config ────────────────────────────────────────────────────────────
MAX_PEERS_PER_ROOM = 50
CHAT_RETENTION_DAYS = 7
DB_PATH = "clipper_data.db"
LOG_DIR = "logs"
LOG_RETENTION_HOURS = 24
DEFAULT_ADMIN_PASSWORD = "12345"
DEBUG = True
SESSION_TIMEOUT = 1800
MAX_LOGIN_ATTEMPTS = 5
LOGIN_COOLDOWN = 30

_config = {"chatRetentionDays": CHAT_RETENTION_DAYS, "stunServer": "stun:stun.l.google.com:19302"}
_ntp_config = {"server": "stdtime.gov.hk", "offset": 0.0, "enabled": True}
_sessions = {}
_login_attempts = {}

# Global persistence instance
persistence = Persistence(DB_PATH)

# Global chat service instance
chat_service = ChatService(persistence, CHAT_RETENTION_DAYS)
# Global room service instance
room_service = RoomService(persistence, rooms, peer_ids, MAX_PEERS_PER_ROOM)

# room_id -> {peerId: {"ws": websocket, "joinedAt": "ISO timestamp"}}
rooms = {}
peer_ids = set()
# room_id -> {"noticePosts": [...], "checklists": [...], "chatMessages": [...]}
room_data = {}


def _setup_logging():
    global _log_file
    os.makedirs(LOG_DIR, exist_ok=True)
    log_path = os.path.join(LOG_DIR, f"clipper_{datetime.now().strftime('%Y%m%d')}.log")
    _log._file = open(log_path, 'a', encoding='utf-8')
    return log_path

def _rotate_logs():
    """Remove log files older than LOG_RETENTION_HOURS."""
    now = time.time()
    cutoff = now - LOG_RETENTION_HOURS * 3600
    if os.path.isdir(LOG_DIR):
        for fname in os.listdir(LOG_DIR):
            fpath = os.path.join(LOG_DIR, fname)
            if fname.endswith('.log') and os.path.getmtime(fpath) < cutoff:
                os.remove(fpath)
                print(f"[Log rotation] Removed old log: {fname}")

def _log(category, message):
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{ts}] [{category}] {message}"
    print(line)
    if hasattr(_log, '_file') and _log._file:
        try:
            _log._file.write(line + '\n')
            _log._file.flush()
        except:
            pass


_log._file = None

def _generate_session():
    """Generate a secure random session token."""
    token = secrets.token_hex(32)
    _sessions[token] = {"createdAt": time.time()}
    return token

def _verify_session(token):
    """Verify session token and check expiry."""
    if not token:
        return False
    entry = _sessions.get(token)
    if not entry:
        return False
    if time.time() - entry["createdAt"] > SESSION_TIMEOUT:
        _sessions.pop(token, None)
        return False
    return True

def _check_login_rate(ws_id):
    """Rate limit logins: max 5 attempts per 30 seconds per connection."""
    now = time.time()
    entry = _login_attempts.get(ws_id, {"count": 0, "first": now})
    if now - entry["first"] > LOGIN_COOLDOWN:
        entry["count"] = 0
        entry["first"] = now
    entry["count"] += 1
    _login_attempts[ws_id] = entry
    return entry["count"] <= MAX_LOGIN_ATTEMPTS

def _get_logs(count=50):
    """Return the last N lines from today's log file."""
    today_log = os.path.join(LOG_DIR, f"clipper_{datetime.now().strftime('%Y%m%d')}.log")
    if not os.path.exists(today_log):
        return ["(no logs yet)"]
    with open(today_log, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    return [l.rstrip('\n') for l in lines[-count:]]


def _debug(message):
    if DEBUG:
        ts = datetime.now(timezone.utc).strftime('%H:%M:%S.%f')[:12]
        print(f"  └─ [{ts}] {message}")


def _init_db():
    """Create SQLite tables if they don't exist."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        notice_posts TEXT NOT NULL DEFAULT '[]',
        checklists TEXT NOT NULL DEFAULT '[]',
        chat_messages TEXT NOT NULL DEFAULT '[]',
        key_managements TEXT NOT NULL DEFAULT '[]'
    )""")
    conn.commit()
    conn.close()


def _load_state():
    """Load all rooms from persistence layer, with legacy SQLite fallback."""
    global room_data
    room_data = {}

    # Try new persistence layer first
    loaded = persistence.load_all_rooms()
    if loaded:
        room_data = loaded
    else:
        # Legacy: read from old rooms table
        conn = sqlite3.connect(DB_PATH)
        try:
            rows = conn.execute(
                "SELECT room_id, notice_posts, checklists, chat_messages, key_managements FROM rooms"
            ).fetchall()
            for rid, np, cl, cm, km in rows:
                room_data[rid] = {
                    "noticePosts": json.loads(np),
                    "checklists": json.loads(cl),
                    "chatMessages": json.loads(cm),
                    "keyManagements": json.loads(km),
                }
            # Migrate to new format
            for rid in list(room_data.keys()):
                persistence.save_room_data(rid, room_data[rid])
        except sqlite3.OperationalError:
            pass
        conn.close()

    # Ensure all rooms have deleted arrays
    for rid in room_data:
        if "deletedPostIds" not in room_data[rid]:
            room_data[rid]["deletedPostIds"] = []
        if "deletedChecklistIds" not in room_data[rid]:
            room_data[rid]["deletedChecklistIds"] = []
        if "deletedKeyIds" not in room_data[rid]:
            room_data[rid]["deletedKeyIds"] = []

    # Migrate old JSON if exists
    OLD_JSON = "vcc_server_state.json"
    if os.path.exists(OLD_JSON):
        try:
            with open(OLD_JSON, 'r') as f:
                legacy = json.load(f)
            for rid, data in legacy.items():
                if rid not in room_data:
                    room_data[rid] = data
            _save_state()
            os.rename(OLD_JSON, OLD_JSON + ".bak")
            _log('MIGRATE', f'Imported {len(legacy)} rooms from legacy JSON, backed up as {OLD_JSON}.bak')
        except Exception as e:
            _log('MIGRATE', f'Failed to migrate legacy JSON: {e}')


def _save_state():
    """Write all room data to persistence layer."""
    for rid, data in room_data.items():
        persistence.save_room_data(rid, data)


def _migrate_room_data():
    for rid in room_data:
        if "checklistItems" in room_data[rid]:
            old_items = room_data[rid].pop("checklistItems", [])
            if old_items and "checklists" not in room_data[rid]:
                room_data[rid]["checklists"] = [{
                    "id": "legacy-" + rid,
                    "title": "舊檢查清單",
                    "category": "",
                    "tags": [],
                    "color": "#38bdf8",
                    "pinned": False,
                    "createdBy": "系統",
                    "createdAt": int(time.time() * 1000),
                    "items": old_items
                }]
        if "checklists" not in room_data[rid]:
            room_data[rid]["checklists"] = []
        if "keyManagements" not in room_data[rid]:
            room_data[rid]["keyManagements"] = []

def _ntp_query(server=None):
    """Query NTP server and return (offset, is_valid). is_valid=False on failure."""
    if server is None:
        server = _ntp_config["server"]
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(5)
        t0 = time.time()
        sock.sendto(NTP_PACKET, (server, NTP_PORT))
        data, addr = sock.recvfrom(1024)
        t3 = time.time()
        sock.close()
        if len(data) < 48:
            return (0, False)
        # Extract transmit timestamp (bytes 40-47)
        tx_ts = struct.unpack('!I', data[40:44])[0]
        tx_frac = struct.unpack('!I', data[44:48])[0]
        tx_time = tx_ts + tx_frac / 2**32 - 2208988800  # NTP epoch to Unix
        # Calculate offset: ((t1 - t0) + (t2 - t3)) / 2  simplified
        rtt = t3 - t0
        offset = (tx_time - t0 - rtt / 2)
        return (offset, True)
    except socket.timeout:
        _debug(f"NTP query timeout for {server}")
        return (0, False)
    except Exception as e:
        _debug(f"NTP query failed: {e}")
        return (0, False)


def _ensure_room_data(rid):
    if rid not in room_data:
        room_data[rid] = {"noticePosts": [], "checklists": [], "chatMessages": [], "keyManagements": []}
    if "deletedPostIds" not in room_data[rid]:
        room_data[rid]["deletedPostIds"] = []
    if "deletedChecklistIds" not in room_data[rid]:
        room_data[rid]["deletedChecklistIds"] = []
    if "deletedKeyIds" not in room_data[rid]:
        room_data[rid]["deletedKeyIds"] = []


def _generate_peer_id():
    """Generate a unique 4-char uppercase alphanumeric peer ID."""
    chars = string.ascii_uppercase + string.digits
    while True:
        pid = "".join(random.choices(chars, k=4))
        if pid not in peer_ids:
            peer_ids.add(pid)
            return pid


# Mini HTTP server — serves static files + REST API on port 8766
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _api_error_response(status, message):
    return {"error": message}, status


def _api_health():
    """GET /api/health"""
    return {
        "status": "ok",
        "version": "1.1.0",
        "uptime": int(time.time() - _start_time),
        "activeRooms": len(rooms),
        "onlinePeers": sum(len(p) for p in rooms.values()),
    }, 200


def _api_room_state(room_id):
    """GET /api/rooms/:room/state"""
    _ensure_room_data(room_id)
    rd = room_data[room_id]
    return {
        "noticePosts": rd.get("noticePosts", []),
        "checklists": rd.get("checklists", []),
        "keyManagements": rd.get("keyManagements", []),
        "deletedNoticeIds": rd.get("deletedPostIds", []),
        "deletedChecklistIds": rd.get("deletedChecklistIds", []),
        "deletedKeyIds": rd.get("deletedKeyIds", []),
    }, 200


def _api_room_notice(room_id, method, query, body):
    """POST/PUT/DELETE /api/rooms/:room/notice"""
    _ensure_room_data(room_id)

    if method == "POST":
        data = json.loads(body) if body else {}
        now_ms = int(time.time() * 1000)
        post = {
            "id": data.get("id", str(now_ms)),
            "title": data.get("title", ""),
            "content": data.get("content", ""),
            "category": data.get("category", ""),
            "tags": data.get("tags", []),
            "author": data.get("author", ""),
            "createdAt": now_ms,
        }
        room_data[room_id]["noticePosts"].append(post)
        _save_state()
        return {"success": True, "post": post}, 200

    elif method == "PUT":
        data = json.loads(body) if body else {}
        post_id = query.get("id") or data.get("id")
        if not post_id:
            return _api_error_response(400, "id is required")
        found = None
        for post in room_data[room_id]["noticePosts"]:
            if post.get("id") == post_id:
                for key in ("title", "content", "category", "tags", "color"):
                    if key in data:
                        post[key] = data[key]
                post["editedAt"] = data.get("editedAt", int(time.time() * 1000))
                found = post
                break
        if not found:
            return _api_error_response(404, "notice not found")
        _save_state()
        return {"success": True, "post": found}, 200

    elif method == "DELETE":
        del_id = query.get("id")
        if not del_id:
            return _api_error_response(400, "id is required")
        room_data[room_id]["noticePosts"] = [
            p for p in room_data[room_id]["noticePosts"] if p.get("id") != del_id
        ]
        if del_id not in room_data[room_id].get("deletedPostIds", []):
            room_data[room_id].setdefault("deletedPostIds", []).append(del_id)
        _save_state()
        return {"success": True, "id": del_id}, 200

    return _api_error_response(405, "method not allowed")


def _api_room_checklist(room_id, method, query, body):
    """POST/PUT/DELETE /api/rooms/:room/checklist"""
    _ensure_room_data(room_id)

    if method == "POST":
        board = json.loads(body) if body else {}
        room_data[room_id]["checklists"].append(board)
        _save_state()
        return {"success": True, "board": board}, 200

    elif method == "PUT":
        data = json.loads(body) if body else {}
        board_id = query.get("id") or data.get("id")
        if not board_id:
            return _api_error_response(400, "id is required")
        found = None
        for board in room_data[room_id]["checklists"]:
            if board.get("id") == board_id:
                for key in ("title", "category", "tags", "color"):
                    if key in data:
                        board[key] = data[key]
                found = board
                break
        if not found:
            return _api_error_response(404, "checklist not found")
        _save_state()
        return {"success": True, "board": found}, 200

    elif method == "DELETE":
        del_id = query.get("id")
        if not del_id:
            return _api_error_response(400, "id is required")
        room_data[room_id]["checklists"] = [
            b for b in room_data[room_id]["checklists"] if b.get("id") != del_id
        ]
        if del_id not in room_data[room_id].get("deletedChecklistIds", []):
            room_data[room_id].setdefault("deletedChecklistIds", []).append(del_id)
        _save_state()
        return {"success": True, "id": del_id}, 200

    return _api_error_response(405, "method not allowed")


def _api_room_keymgmt(room_id, method, query, body):
    """POST/PUT/DELETE /api/rooms/:room/keymgmt"""
    _ensure_room_data(room_id)

    if method == "POST":
        entry = json.loads(body) if body else {}
        room_data[room_id].setdefault("keyManagements", []).append(entry)
        _save_state()
        return {"success": True, "entry": entry}, 200

    elif method == "PUT":
        data = json.loads(body) if body else {}
        entry_id = query.get("id") or data.get("id")
        if not entry_id:
            return _api_error_response(400, "id is required")
        found = None
        for entry in room_data[room_id].get("keyManagements", []):
            if entry.get("id") == entry_id:
                for key in ("label", "streamKey", "streamUrl", "currentProgram"):
                    if key in data:
                        entry[key] = data[key]
                entry["updatedAt"] = data.get("updatedAt", int(time.time() * 1000))
                found = entry
                break
        if not found:
            return _api_error_response(404, "key management entry not found")
        _save_state()
        return {"success": True, "entry": found}, 200

    elif method == "DELETE":
        del_id = query.get("id")
        if not del_id:
            return _api_error_response(400, "id is required")
        room_data[room_id]["keyManagements"] = [
            e for e in room_data[room_id].get("keyManagements", []) if e.get("id") != del_id
        ]
        if del_id not in room_data[room_id].get("deletedKeyIds", []):
            room_data[room_id].setdefault("deletedKeyIds", []).append(del_id)
        _save_state()
        return {"success": True, "id": del_id}, 200

    return _api_error_response(405, "method not allowed")


def _api_room_chats(room_id):
    """GET /api/rooms/:room/chats"""
    _ensure_room_data(room_id)
    return {"messages": room_data[room_id].get("chatMessages", [])}, 200


async def _api_send_json(writer, data, status=200):
    """Send JSON response with CORS headers."""
    body = json.dumps(data)
    status_msg = {
        200: "OK", 201: "Created", 400: "Bad Request", 401: "Unauthorized",
        403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
        500: "Internal Server Error",
    }.get(status, "Internal Server Error")
    response = (
        f"HTTP/1.1 {status} {status_msg}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Access-Control-Allow-Origin: *\r\n"
        f"Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
        f"Access-Control-Allow-Headers: Authorization, Content-Type\r\n"
        f"Cache-Control: no-cache\r\n"
        f"\r\n"
        f"{body}"
    )
    writer.write(response.encode())
    await writer.drain()
    writer.close()


async def _mini_http(reader, writer):
    """Serve HTTP requests — REST API + static files."""
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=5)
        if not line:
            writer.close(); return
        parts = line.decode(errors="replace").strip().split(" ")
        if len(parts) < 2:
            writer.close(); return
        method = parts[0].upper()
        raw_path = parts[1]

        path = raw_path
        query_params = {}
        if "?" in raw_path:
            path, qs = raw_path.split("?", 1)
            for pair in qs.split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    query_params[k] = v

        headers = {}
        while True:
            hdr = await reader.readline()
            if hdr == b"\r\n" or not hdr:
                break
            hdr_str = hdr.decode(errors="replace").strip()
            if ":" in hdr_str:
                hk, hv = hdr_str.split(":", 1)
                headers[hk.strip().lower()] = hv.strip()

        body = b""
        cl = headers.get("content-length", "0")
        try:
            content_length = int(cl)
        except ValueError:
            content_length = 0
        if content_length > 0:
            body = await asyncio.wait_for(reader.readexactly(content_length), timeout=5)

        if method == "OPTIONS":
            resp = (
                b"HTTP/1.1 200 OK\r\n"
                b"Access-Control-Allow-Origin: *\r\n"
                b"Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
                b"Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
                b"Content-Length: 0\r\n"
                b"Connection: close\r\n\r\n"
            )
            writer.write(resp); await writer.drain()
            writer.close(); return

        if path.startswith("/api/"):
            status_code = 200
            response_data = None

            try:
                rest_path = path[len("/api/"):]

                if rest_path == "health":
                    response_data, status_code = _api_health()
                elif rest_path == "admin/login" and method == "POST":
                    try:
                        login_data = json.loads(body) if body else {}
                        pw = login_data.get("password", "")
                        if persistence.verify_admin_password(pw):
                            token = _generate_session()
                            response_data, status_code = {"token": token, "success": True}, 200
                        else:
                            response_data, status_code = {"error": "invalid password", "success": False}, 401
                    except json.JSONDecodeError:
                        response_data, status_code = {"error": "invalid JSON"}, 400
                elif rest_path == "client-log" and method == "POST":
                    entries = json.loads(body)
                    if isinstance(entries, dict) and 'entries' in entries:
                        entries = entries['entries']
                    if isinstance(entries, list):
                        for entry in entries:
                            ts = entry.get('ts', datetime.now(timezone.utc).isoformat())
                            level = entry.get('level', 'log')
                            msg = entry.get('msg', '')
                            _log(f'CLIENT-{level.upper()}', f'{msg}')
                        response_data, status_code = {"status": "ok", "count": len(entries)}, 200
                    else:
                        response_data, status_code = {"error": "expected list"}, 400
                elif rest_path.startswith("rooms/"):
                    sub = rest_path[len("rooms/"):]
                    slash_idx = sub.find("/")
                    if slash_idx == -1:
                        room_id = sub
                        sub_resource = None
                    else:
                        room_id = sub[:slash_idx]
                        sub_resource = sub[slash_idx+1:]

                    if sub_resource is None:
                        response_data, status_code = {"error": "missing resource"}, 404
                    elif sub_resource in ("notice", "checklist", "keymgmt") and method in ("POST", "PUT", "DELETE"):
                        auth_header = headers.get("authorization", "")
                        token = None
                        if auth_header.lower().startswith("bearer "):
                            token = auth_header[7:]
                        if not _verify_session(token):
                            response_data, status_code = {"error": "unauthorized", "message": "Authentication required"}, 401
                        elif sub_resource == "notice":
                            response_data, status_code = _api_room_notice(room_id, method, query_params, body)
                        elif sub_resource == "checklist":
                            response_data, status_code = _api_room_checklist(room_id, method, query_params, body)
                        elif sub_resource == "keymgmt":
                            response_data, status_code = _api_room_keymgmt(room_id, method, query_params, body)
                    elif sub_resource == "state" and method == "GET":
                        response_data, status_code = _api_room_state(room_id)
                    elif sub_resource == "chats" and method == "GET":
                        response_data, status_code = _api_room_chats(room_id)
                    else:
                        response_data, status_code = {"error": "not found"}, 404
                else:
                    response_data, status_code = {"error": "not found"}, 404
            except json.JSONDecodeError:
                response_data, status_code = {"error": "invalid JSON"}, 400
            except Exception as e:
                _log('REST-API', f'Error: {e}')
                response_data, status_code = {"error": "internal server error"}, 500

            body_out = json.dumps(response_data).encode()
            status_msg = {
                200: b"200 OK", 201: b"201 Created", 400: b"400 Bad Request",
                404: b"404 Not Found", 405: b"405 Method Not Allowed",
                500: b"500 Internal Server Error",
            }.get(status_code, b"500 Internal Server Error")
            resp = (
                b"HTTP/1.1 " + status_msg + b"\r\n"
                b"Access-Control-Allow-Origin: *\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: " + str(len(body_out)).encode() + b"\r\n"
                b"Connection: close\r\n\r\n"
            ) + body_out
            writer.write(resp); await writer.drain()
            writer.close(); return

        if path == "/":
            path = "/clipper.html"
        safe_path = os.path.normpath(os.path.join(_SCRIPT_DIR, path.lstrip("/")))
        if not safe_path.startswith(_SCRIPT_DIR) or not os.path.isfile(safe_path):
            body_out = b"Not Found"; status = b"404 Not Found"; ct = b"text/plain"
        else:
            ct_val, _ = mimetypes.guess_type(safe_path)
            ct = (ct_val or "text/html").encode()
            with open(safe_path, "rb") as f:
                body_out = f.read()
            status = b"200 OK"
        resp = (b"HTTP/1.1 " + status + b"\r\n"
                b"Content-Type: " + ct + b"\r\n"
                b"Content-Length: " + str(len(body_out)).encode() + b"\r\n"
                b"Cache-Control: no-store, no-cache, must-revalidate\r\n"
                b"Pragma: no-cache\r\n"
                b"Expires: 0\r\n"
                b"Access-Control-Allow-Origin: *\r\n"
                b"Connection: close\r\n\r\n") + body_out
        writer.write(resp); await writer.drain()
    except Exception:
        pass
    finally:
        try: writer.close()
        except: pass


def _generate_peer_id():
    """Generate a unique 4-char uppercase alphanumeric peer ID."""
    chars = string.ascii_uppercase + string.digits
    while True:
        pid = "".join(random.choices(chars, k=4))
        if pid not in peer_ids:
            peer_ids.add(pid)
            return pid




async def handler(websocket):
    """Handle a WebSocket connection."""
    room_id = None
    my_peer_id = None

    # Build mutable context for handler functions
    ctx = {
        "_room_id": None,
        "_my_peer_id": None,
        "rooms": rooms,
        "peer_ids": peer_ids,
        "room_data": room_data,
        "config": _config,
        "ntp_config": _ntp_config,
        "sessions": _sessions,
        "login_attempts": _login_attempts,
        "broadcast": _broadcast,
        "broadcast_peer_list": _broadcast_peer_list,
        "log": _log,
        "debug": _debug,
        "ensure_room_data": _ensure_room_data,
        "save_state": _save_state,
        "verify_session": _verify_session,
        "generate_peer_id": _generate_peer_id,"room_service": room_service,"room_service": room_service,
        "generate_session": _generate_session,
        "persistence": persistence,"persistence": persistence,
        "chat_service": chat_service,
        "verify_admin_password": persistence.verify_admin_password,
        "set_admin_password": persistence.set_admin_password,
        "check_login_rate": _check_login_rate,
        "get_logs": _get_logs,
        "ntp_query": _ntp_query,
        "_start_time": _start_time,
        "CHAT_RETENTION_DAYS": CHAT_RETENTION_DAYS,
        "MAX_PEERS_PER_ROOM": MAX_PEERS_PER_ROOM,
        "DEBUG": DEBUG,
        "LOG_DIR": LOG_DIR,
        "DB_PATH": DB_PATH,
        "LOG_RETENTION_HOURS": LOG_RETENTION_HOURS,
    }

    try:
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get("type")
            _debug(f"← RX type={msg_type} room={data.get('room','?')} from={my_peer_id}")

            ctx["_room_id"] = room_id
            ctx["_my_peer_id"] = my_peer_id

            handler_fn = ROUTES.get(msg_type)
            if handler_fn:
                await handler_fn(websocket, data, ctx)
                room_id = ctx.get("_room_id", room_id)
                my_peer_id = ctx.get("_my_peer_id", my_peer_id)

    except websockets.exceptions.ConnectionClosed:
        _debug(f"WebSocket connection closed for {my_peer_id}")
        pass
    finally:
        if room_id and room_id in rooms and my_peer_id:
            rooms[room_id].pop(my_peer_id, None)
            peer_ids.discard(my_peer_id)
            if rooms[room_id]:
                remaining = len(rooms[room_id])
                _debug(f"peer_left broadcast: {my_peer_id} left, {remaining} remaining in {room_id}")
                _broadcast(
                    rooms[room_id],
                    {"type": "peer_left", "peerId": my_peer_id},
                )
            else:
                _debug(f"Room {room_id} now empty, deleting")
                del rooms[room_id]

        if room_id and room_id in rooms and len(rooms[room_id]) > 0:    finally:
        was_removed, room_now_empty = room_service.remove_peer(room_id, my_peer_id)
        if was_removed and not room_now_empty:
            remaining = len(rooms[room_id])
            _debug(f"peer_left broadcast: {my_peer_id} left, {remaining} remaining in {room_id}")
            _broadcast(
                rooms[room_id],
                {"type": "peer_left", "peerId": my_peer_id},
            )

        if room_id and room_id in rooms and len(rooms[room_id]) > 0:        _log('DISCONNECT', f'{my_peer_id} disconnected (room: {room_id})')


def _broadcast(room_peers, message, exclude=None):
    """Send a message to all peers in a room, optionally excluding one."""
    payload = json.dumps(message)
    target_ids = []
    for info in room_peers.values():
        if exclude and info["ws"] == exclude:
            continue
        target_ids.append('?')
        try:
            asyncio.create_task(info["ws"].send(payload))
        except websockets.exceptions.ConnectionClosed:
            pass
    if DEBUG:
        mtype = message.get("type", "?")
        _debug(f"→ TX broadcast type={mtype} to={len(target_ids)} peers")


async def _broadcast_peer_list(rid):
    """Broadcast the current online peer list for a room."""
    if rid not in rooms:
        return
    peer_list = []
    for pid, info in rooms[rid].items():
        peer_list.append({
            "peerId": pid,
            "displayName": info.get("displayName", pid),
            "joinedAt": info.get("joinedAt", ""),
            "alive": True,
        })
    _broadcast(rooms[rid], {"type": "peer-list", "peers": peer_list})


HEARTBEAT_TIMEOUT = 20  # seconds without heartbeat = stale

async def _heartbeat_check():
    """Periodic heartbeat check. Remove stale peers and broadcast lists."""
    while True:
        await asyncio.sleep(10)
        now = time.time()
        for rid in list(rooms.keys()):
            stale = []
            for pid, info in list(rooms[rid].items()):
                if now - info.get("lastHeartbeat", 0) > HEARTBEAT_TIMEOUT:
                    stale.append(pid)
            for pid in stale:
                _log('HEARTBEAT', f'{pid} timed out in room {rid}')
                try:
                    await rooms[rid][pid]["ws"].close()
                except:
                    pass
                rooms[rid].pop(pid, None)
                peer_ids.discard(pid)
            if stale:
                if rooms[rid]:
                    await _broadcast_peer_list(rid)
                else:
                    del rooms[rid]


async def _periodic_log_rotation():
    """Rotate logs every hour."""
    while True:
        await asyncio.sleep(3600)
        _rotate_logs()


async def _session_cleanup():
    """Clean up expired sessions every 5 minutes."""
    while True:
        await asyncio.sleep(300)
        now = time.time()
        expired = [t for t, e in _sessions.items() if now - e["createdAt"] > SESSION_TIMEOUT]
        for t in expired:
            _sessions.pop(t, None)
        if expired and DEBUG:
            _debug(f"Cleaned up {len(expired)} expired sessions")

async def _login_attempt_cleanup():
    """Clean up old login attempt records every 60 seconds."""
    while True:
        await asyncio.sleep(60)
        now = time.time()
        stale = [k for k, v in _login_attempts.items() if now - v["first"] > LOGIN_COOLDOWN]
        for k in stale:
            _login_attempts.pop(k, None)


async def _ntp_sync_loop():
    """Periodically sync NTP every 60 seconds."""
    while True:
        await asyncio.sleep(60)
        if _ntp_config["enabled"]:
            offset, valid = _ntp_query()
            _ntp_config["offset"] = offset
            _ntp_config["_ntp_valid"] = valid
            if valid:
                _debug('NTP re-sync: offset=%.3fs' % _ntp_config['offset'])

async def main():
    global _start_time
    _start_time = time.time()
    # TLS/SSL support (optional, env var CLIPPER_TLS=1 to enable WSS/HTTPS)
    use_tls = os.environ.get("CLIPPER_TLS", "").lower() in ("1", "true", "yes")
    tls_cert = os.environ.get("CLIPPER_TLS_CERT", "cert.pem")
    tls_key = os.environ.get("CLIPPER_TLS_KEY", "key.pem")
    ssl_context = None
    if use_tls:
        import ssl
        if not os.path.exists(tls_cert) or not os.path.exists(tls_key):
            _log('TLS', f'Certificate not found: {tls_cert} / {tls_key}')
            _log('TLS', 'Generate with: openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes')
            _log('TLS', 'or set CLIPPER_TLS=0 to run without encryption')
            return
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.load_cert_chain(tls_cert, tls_key)
        _log('TLS', f'Loaded certificate: {tls_cert} / {tls_key}')

    log_path = _setup_logging()
    _rotate_logs()
    _init_db()
    # Add key_managements column for existing databases
    _migrate_conn = sqlite3.connect(DB_PATH)
    try:
        _migrate_conn.execute("ALTER TABLE rooms ADD COLUMN key_managements TEXT NOT NULL DEFAULT '[]'")
        _migrate_conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists
    finally:
        _migrate_conn.close()
    persistence.init_admin_password()
    _load_state()
    _migrate_room_data()
    asyncio.create_task(_heartbeat_check())
    asyncio.create_task(_periodic_log_rotation())
    asyncio.create_task(_session_cleanup())
    asyncio.create_task(_login_attempt_cleanup())
    asyncio.create_task(_ntp_sync_loop())
    # Initial NTP sync
    if _ntp_config["enabled"]:
        offset, valid = _ntp_query()
        _ntp_config["offset"] = offset
        _ntp_config["_ntp_valid"] = valid
        if valid:
            _log('NTP', 'Initial NTP sync from ' + _ntp_config["server"] + ': offset=' + str(_ntp_config["offset"]))
        else:
            _log('NTP', 'Initial NTP sync FAILED from ' + _ntp_config["server"])
    total_notices = sum(len(r.get("noticePosts", [])) for r in room_data.values())
    total_boards = sum(len(r.get("checklists", [])) for r in room_data.values())
    total_chats = sum(len(r.get("chatMessages", [])) for r in room_data.values())
    _log('STARTUP', f'Loaded {len(room_data)} rooms from SQLite ({DB_PATH})')
    _log('STARTUP', f'Data: {total_notices} notices, {total_boards} boards, {total_chats} chat backups')
    _log('STARTUP', f'Chat retention: {CHAT_RETENTION_DAYS} days')
    _log('STARTUP', f'DEBUG mode: {"ON" if DEBUG else "OFF"}')
    ws_scheme = "wss" if ssl_context else "ws"
    http_scheme = "https" if ssl_context else "http"
    _log('STARTUP', f'listening on {ws_scheme}://localhost:8765  |  {http_scheme}://localhost:8766')

    loop = asyncio.get_running_loop()
    stop = loop.create_future()

    # Start HTTP server on port 8766
    http_server = await asyncio.start_server(_mini_http, "0.0.0.0", 8766, ssl=ssl_context)

    async with websockets.serve(handler, "0.0.0.0", 8765, ssl=ssl_context):
        await stop


if __name__ == "__main__":
    asyncio.run(main())
