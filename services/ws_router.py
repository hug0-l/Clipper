"""WebSocket message routing table for Clipper."""
import json
import random
import time
from datetime import datetime, timezone

from services.checklist_service import ChecklistService
from services.persistence import Persistence


# Module-level service instances
checklist_service = ChecklistService(Persistence())

ROUTES = {}

def register(msg_type):
    """Decorator to register a WS message handler."""
    def decorator(fn):
        ROUTES[msg_type] = fn
        return fn
    return decorator


# ──────────────────────────────────────────────
# Handler functions
# ──────────────────────────────────────────────

    _ = ctx["room_service"].generate_room_code()


@register("join")
async def h_join(websocket, data, ctx):
    rs = ctx["room_service"]
    rid = data.get("room")
    if not rid:
        await websocket.send(json.dumps({"type": "error", "message": "room is required"}))
        return

    if rs.is_room_full(rid):
        await websocket.send(json.dumps({"type": "room_full", "room": rid}))
        return

    # Leave previous room if any
    old_room_id = ctx["_room_id"]
    old_my_peer_id = ctx["_my_peer_id"]
    was_left, room_now_empty = rs.leave_previous_room(old_room_id, old_my_peer_id)
    if was_left and not room_now_empty:
        ctx["broadcast"](
            ctx["rooms"][old_room_id],
            {"type": "peer_left", "peerId": old_my_peer_id},
            exclude=websocket,
        )

    # Join new room
    rid = data["room"]
    display_name = data.get("displayName")
    room_id, my_peer_id, peer_info = rs.add_peer(rid, websocket, display_name)

    # Send joined confirmation
    await websocket.send(json.dumps({
        "type": "joined",
        "room": room_id,
        "peerId": my_peer_id,
    }))
    ctx["debug"](f"\u2192 TX joined room={room_id} peerId={my_peer_id}")

    # If others are in the room, send room_peers to joiner and peer_joined to all existing members
    other_peers_list = rs.get_other_peers(room_id, my_peer_id)
    if other_peers_list:
        await websocket.send(json.dumps({
            "type": "room_peers",
            "peers": other_peers_list,
        }))
        ctx["debug"](f"\u2192 TX room_peers count={len(other_peers_list)} to={my_peer_id}")

        # Notify all existing peers
        joiner_name = peer_info.get("displayName", my_peer_id)
        ctx["broadcast"](
            ctx["rooms"][room_id],
            {"type": "peer_joined", "peerId": my_peer_id, "displayName": joiner_name},
            exclude=websocket,
        )

    # Broadcast updated peer list to all (including joiner)
    await ctx["broadcast_peer_list"](room_id)
    ctx["log"]('JOIN', f'{my_peer_id} joined room {room_id} ({len(ctx["rooms"][room_id])} peers)')

    ctx["_room_id"] = room_id
    ctx["_my_peer_id"] = my_peer_id


@register("offer")
@register("answer")
@register("ice-candidate")
async def h_webrtc_signal(websocket, data, ctx):
    rid = data.get("room")
    my_peer_id = ctx["_my_peer_id"]
    msg_type = data.get("type")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return

    target = data.get("to")
    if target and target in ctx["rooms"][rid]:
        out = {
            "type": msg_type,
            "from": my_peer_id,
            "data": data.get("data"),
        }
        ws = ctx["rooms"][rid][target]["ws"]
        try:
            await ws.send(json.dumps(out))
            ctx["debug"](f"→ TX {msg_type} to={target} from={my_peer_id}")
        except Exception:
            pass
    elif not target and len(ctx["rooms"][rid]) == 2:
        for pid, info in ctx["rooms"][rid].items():
            if pid != my_peer_id:
                out = {
                    "type": msg_type,
                    "from": my_peer_id,
                    "data": data.get("data"),
                }
                try:
                    await info["ws"].send(json.dumps(out))
                    ctx["debug"](f"→ TX {msg_type} to={pid} from={my_peer_id} (2-peer compat)")
                except Exception:
                    pass
                break
    else:
        await websocket.send(json.dumps({
            "type": "error",
            "message": f"target peer '{target}' not found in room",
        }))


@register("chat-backup")
async def h_chat_backup(websocket, data, ctx):
    rid = data.get("room")
    my_peer_id = ctx["_my_peer_id"]
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    backup_msg = {
        "msgId": data.get("msgId", ""),
        "text": data.get("text", ""),
        "from": data.get("from", ""),
        "timestamp": data.get("timestamp", time.time() * 1000),
        "serverReceivedAt": time.time() * 1000,
    }
    ctx["room_data"][rid]["chatMessages"].append(backup_msg)
    retention = ctx["config"].get("chatRetentionDays", 7)
    cutoff = (time.time() - retention * 86400) * 1000
    ctx["room_data"][rid]["chatMessages"] = [
        m for m in ctx["room_data"][rid]["chatMessages"]
        if _ts_val(m["timestamp"]) > cutoff
    ]
    ctx["save_state"]()
    ctx["log"]('CHAT-BACKUP', f'{my_peer_id} backed up chat msg in {rid} ({len(ctx["room_data"][rid]["chatMessages"])} stored)')


@register("chat-edit")
async def h_chat_edit(websocket, data, ctx):
    rid = data.get("room")
    my_peer_id = ctx["_my_peer_id"]
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    target_msg_id = data.get("msgId")
    new_text = data.get("text", "")
    found = False
    for msg in ctx["room_data"][rid].get("chatMessages", []):
        if msg.get("msgId") == target_msg_id:
            msg["text"] = new_text
            msg["edited"] = True
            found = True
            break
    if not found:
        await websocket.send(json.dumps({"type": "error", "message": "message not found"}))
        return
    ctx["broadcast"](
        ctx["rooms"][rid],
        {"type": "chat-edit", "msgId": target_msg_id, "newText": new_text, "edited": True},
        exclude=websocket,
    )
    ctx["save_state"]()
    ctx["log"]('CHAT-EDIT', f'{my_peer_id} edited msg {target_msg_id} in {rid}')


@register("chat-delete")
async def h_chat_delete(websocket, data, ctx):
    rid = data.get("room")
    my_peer_id = ctx["_my_peer_id"]
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    target_msg_id = data.get("msgId")
    found = False
    for msg in ctx["room_data"][rid].get("chatMessages", []):
        if msg.get("msgId") == target_msg_id:
            msg["deleted"] = True
            found = True
            break
    if not found:
        await websocket.send(json.dumps({"type": "error", "message": "message not found"}))
        return
    ctx["broadcast"](
        ctx["rooms"][rid],
        {"type": "chat-delete", "msgId": target_msg_id, "deleted": True},
        exclude=websocket,
    )
    ctx["save_state"]()
    ctx["log"]('CHAT-DELETE', f'{my_peer_id} deleted msg {target_msg_id} in {rid}')


@register("notice-create")
async def h_notice_create(websocket, data, ctx):
    rid = data.get("room")
    my_peer_id = ctx["_my_peer_id"]
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    post = data.get("post", {})
    ctx["room_data"][rid]["noticePosts"].append(post)
    ctx["broadcast"](
        ctx["rooms"][rid],
        {"type": "notice-create", "post": post},
        exclude=websocket,
    )
    ctx["log"]('NOTICE', f'{my_peer_id} created post in {rid}')
    ctx["save_state"]()


@register("notice-edit")
async def h_notice_edit(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    post_id = data.get("id")
    for post in ctx["room_data"][rid]["noticePosts"]:
        if post.get("id") == post_id:
            post["title"] = data.get("title", post.get("title", ""))
            post["content"] = data.get("content", post.get("content", ""))
            post["editedAt"] = data.get("editedAt", time.time() * 1000)
            if "category" in data:
                post["category"] = data["category"]
            if "tags" in data:
                post["tags"] = data["tags"]
            if "color" in data:
                post["color"] = data["color"]
            break
    broadcast_msg = {
        "type": "notice-edit",
        "id": post_id,
        "title": data.get("title"),
        "content": data.get("content"),
        "editedAt": data.get("editedAt"),
    }
    if "category" in data:
        broadcast_msg["category"] = data["category"]
    if "tags" in data:
        broadcast_msg["tags"] = data["tags"]
    if "color" in data:
        broadcast_msg["color"] = data["color"]
    ctx["broadcast"](
        ctx["rooms"][rid],
        broadcast_msg,
        exclude=websocket,
    )
    ctx["save_state"]()


@register("notice-delete")
async def h_notice_delete(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    del_id = data.get("id")
    ctx["room_data"][rid]["noticePosts"] = [
        p for p in ctx["room_data"][rid]["noticePosts"] if p.get("id") != del_id
    ]
    if del_id and del_id not in ctx["room_data"][rid]["deletedPostIds"]:
        ctx["room_data"][rid]["deletedPostIds"].append(del_id)
    ctx["broadcast"](
        ctx["rooms"][rid],
        {"type": "notice-delete", "id": del_id},
        exclude=websocket,
    )
    ctx["save_state"]()


@register("notice-pin")
async def h_notice_pin(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    pin_id = data.get("id")
    pin_val = data.get("pinned", False)
    for post in ctx["room_data"][rid]["noticePosts"]:
        if post.get("id") == pin_id:
            post["pinned"] = pin_val
            break
    ctx["broadcast"](
        ctx["rooms"][rid],
        {"type": "notice-pin", "id": pin_id, "pinned": pin_val},
        exclude=websocket,
    )
    ctx["save_state"]()


@register("checklistboard-create")
async def h_checklistboard_create(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    board = data.get("board", {})
    broadcast_fn = lambda msg: ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    success, err = checklist_service.create_board(ctx["room_data"][rid], rid, board, broadcast_fn, ctx["log"])
    if not success:
        await websocket.send(json.dumps({"type": "error", "message": err}))
        return


@register("checklistboard-edit")
async def h_checklistboard_edit(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    broadcast_fn = lambda msg: ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    success, err = checklist_service.edit_board(ctx["room_data"][rid], rid, data, broadcast_fn)
    if not success:
        await websocket.send(json.dumps({"type": "error", "message": err}))
        return


@register("checklistboard-delete")
async def h_checklistboard_delete(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    board_id = data.get("id")
    broadcast_fn = lambda msg: ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    success, err = checklist_service.delete_board(ctx["room_data"][rid], rid, board_id, broadcast_fn)
    if not success:
        await websocket.send(json.dumps({"type": "error", "message": err}))
        return


@register("checklistboard-pin")
async def h_checklistboard_pin(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    pin_id = data.get("id")
    pin_val = data.get("pinned", False)
    broadcast_fn = lambda msg: ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    success, err = checklist_service.pin_board(ctx["room_data"][rid], rid, pin_id, pin_val, broadcast_fn)
    if not success:
        await websocket.send(json.dumps({"type": "error", "message": err}))
        return


@register("checklistboard-remind")
async def h_checklistboard_remind(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    remind_id = data.get("id")
    remind_at = data.get("reminderAt")
    remind_title = data.get("reminderTitle", "")
    broadcast_fn = lambda msg: ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    success, err = checklist_service.set_reminder(ctx["room_data"][rid], rid, remind_id, remind_at, remind_title, broadcast_fn, ctx["log"])
    if not success:
        await websocket.send(json.dumps({"type": "error", "message": err}))
        return


@register("checklist-add")
async def h_checklist_add(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    checklist_id = data.get("checklistId")
    item = data.get("item", {})
    broadcast_fn = lambda msg: ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    success, err = checklist_service.add_item(ctx["room_data"][rid], rid, checklist_id, item, broadcast_fn)
    if not success:
        await websocket.send(json.dumps({"type": "error", "message": err}))
        return


@register("checklist-toggle")
async def h_checklist_toggle(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    checklist_id = data.get("checklistId")
    toggle_id = data.get("id")
    checked = data.get("checked", False)
    checked_at = data.get("checkedAt", time.time() * 1000)
    broadcast_fn = lambda msg: ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    success, err = checklist_service.toggle_item(ctx["room_data"][rid], rid, checklist_id, toggle_id, checked, checked_at, broadcast_fn)
    if not success:
        await websocket.send(json.dumps({"type": "error", "message": err}))
        return


@register("checklist-delete")
async def h_checklist_delete(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    checklist_id = data.get("checklistId")
    del_id = data.get("id")
    broadcast_fn = lambda msg: ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    success, err = checklist_service.delete_item(ctx["room_data"][rid], rid, checklist_id, del_id, broadcast_fn)
    if not success:
        await websocket.send(json.dumps({"type": "error", "message": err}))
        return


@register("checklist-reset")
async def h_checklist_reset(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    board_id = data.get("id") or data.get("checklistId")
    broadcast_fn = lambda msg: ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    success, err = checklist_service.reset_items(ctx["room_data"][rid], rid, board_id, broadcast_fn, ctx["log"])
    if not success:
        await websocket.send(json.dumps({"type": "error", "message": err}))
        return


@register("state-get")
async def h_state_get(websocket, data, ctx):
    rid = data.get("room")
    my_peer_id = ctx["_my_peer_id"]
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    posts_count = len(ctx["room_data"][rid].get("noticePosts", []))
    boards_count = len(ctx["room_data"][rid].get("checklists", []))
    await websocket.send(json.dumps({
        "type": "room-state",
        "noticePosts": ctx["room_data"][rid].get("noticePosts", []),
        "checklists": ctx["room_data"][rid].get("checklists", []),
        "keyManagements": ctx["room_data"][rid].get("keyManagements", []),
        "deletedNoticeIds": ctx["room_data"][rid].get("deletedPostIds", []),
        "deletedChecklistIds": ctx["room_data"][rid].get("deletedChecklistIds", []),
        "deletedKeyIds": ctx["room_data"][rid].get("deletedKeyIds", []),
    }))
    ctx["log"]('STATE', f'{my_peer_id} requested state in {rid}')
    ctx["debug"](f"→ TX room-state: {posts_count} posts, {boards_count} boards to {my_peer_id}")


@register("chat-history")
async def h_chat_history(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    since = data.get("since")
    if since is None:
        retention = ctx["config"].get("chatRetentionDays", 7)
        cutoff = (time.time() - retention * 86400) * 1000
        filtered = [
            m for m in ctx["room_data"][rid].get("chatMessages", [])
            if _ts_val(m["timestamp"]) > cutoff and not m.get("deleted", False)
        ]
    else:
        since_f = _ts_val(since) if since is not None else 0
        filtered = [
            m for m in ctx["room_data"][rid].get("chatMessages", [])
            if _ts_val(m["timestamp"]) > since_f and not m.get("deleted", False)
        ]
    await websocket.send(json.dumps({
        "type": "chat-history-result",
        "messages": filtered,
        "room": rid,
    }))


@register("ping")
async def h_ping(websocket, data, ctx):
    my_peer_id = ctx["_my_peer_id"]
    room_id = ctx["_room_id"]
    if ctx["room_service"].update_heartbeat(room_id, my_peer_id):
        try:
            await websocket.send(json.dumps({"type": "pong"}))
        except Exception:
            pass


@register("time-request")
async def h_time_request(websocket, data, ctx):
    ntp_on = ctx["ntp_config"]["enabled"]
    if ntp_on:
        server_ts = (time.time() + ctx["ntp_config"]["offset"]) * 1000
    else:
        server_ts = time.time() * 1000
    try:
        await websocket.send(json.dumps({
            "type": "time-sync",
            "serverTime": server_ts,
            "ntpEnabled": ntp_on,
            "ntpServer": ctx["ntp_config"]["server"],
            "ntpValid": ctx["ntp_config"].get("_ntp_valid", False),
        }))
    except Exception:
        pass


@register("ntp-config")
async def h_ntp_config(websocket, data, ctx):
    if not ctx["verify_session"](data.get("token", "")):
        await websocket.send(json.dumps({"type": "error", "message": "unauthorized"}))
        return
    if "ntpServer" in data:
        ctx["ntp_config"]["server"] = data["ntpServer"]
    if "ntpEnabled" in data:
        ctx["ntp_config"]["enabled"] = bool(data["ntpEnabled"])
    ntp_valid = False
    if ctx["ntp_config"]["enabled"]:
        offset, ntp_valid = ctx["ntp_query"]()
        ctx["ntp_config"]["offset"] = offset
        if ntp_valid:
            ctx["log"]('NTP', 'NTP sync from ' + ctx["ntp_config"]["server"] + ': offset=' + str(ctx["ntp_config"]["offset"]))
        else:
            ctx["log"]('NTP', 'NTP sync FAILED from ' + ctx["ntp_config"]["server"])
    else:
        ctx["ntp_config"]["offset"] = 0
    await websocket.send(json.dumps({
        "type": "ntp-config-result",
        "ntpServer": ctx["ntp_config"]["server"],
        "ntpEnabled": ctx["ntp_config"]["enabled"],
        "ntpOffset": round(ctx["ntp_config"]["offset"], 3),
        "ntpValid": ntp_valid,
    }))
    my_peer_id = ctx["_my_peer_id"]
    rid = data.get("room")
    name = data.get("displayName", "").strip()
    if not rid or rid not in ctx["rooms"] or not name or not my_peer_id:
        await websocket.send(json.dumps({"type": "error", "message": "invalid register-name"}))
        return
    rs = ctx["room_service"]
    final_name, was_conflict = rs.resolve_display_name(rid, my_peer_id, name)
    await websocket.send(json.dumps({"type": "name-resolved", "displayName": final_name, "wasConflict": was_conflict}))
    ctx["log"]('NAME', f'{my_peer_id} registered as "{final_name}"{" (was conflict: " + name + ")" if was_conflict else ""} in {rid}')
    await ctx["broadcast_peer_list"](rid)


@register("relay-data")
async def h_relay_data(websocket, data, ctx):
    rid = data.get("room")
    target = data.get("to")
    payload = data.get("data", {})
    my_peer_id = ctx["_my_peer_id"]
    if not rid or rid not in ctx["rooms"] or not target or target not in ctx["rooms"][rid]:
        await websocket.send(json.dumps({"type": "error", "message": "relay target not found"}))
        return
    out = {"type": "relay-data", "from": my_peer_id, "data": payload}
    try:
        await ctx["rooms"][rid][target]["ws"].send(json.dumps(out))
        ctx["debug"](f"→ TX relay-data to={target} from={my_peer_id} ({payload.get('type','?')})")
        ctx["log"]('RELAY', f'{my_peer_id} → {target} ({payload.get("type","?")})')
    except Exception:
        pass


@register("relay-chunk")
async def h_relay_chunk(websocket, data, ctx):
    rid = data.get("room")
    target = data.get("to")
    my_peer_id = ctx["_my_peer_id"]
    chunk_data = {
        "type": "relay-chunk",
        "from": my_peer_id,
        "fileId": data.get("fileId"),
        "chunk": data.get("chunk"),
        "index": data.get("index"),
        "total": data.get("total"),
    }
    if not rid or rid not in ctx["rooms"] or not target or target not in ctx["rooms"][rid]:
        return
    try:
        await ctx["rooms"][rid][target]["ws"].send(json.dumps(chunk_data))
    except Exception:
        pass


@register("file-cancel")
async def h_file_cancel(websocket, data, ctx):
    rid = data.get("room")
    target = data.get("to") or data.get("sender")
    my_peer_id = ctx["_my_peer_id"]
    if rid and target and target in ctx["rooms"].get(rid, {}):
        try:
            await ctx["rooms"][rid][target]["ws"].send(json.dumps({
                "type": "file-cancel",
                "from": my_peer_id,
                "fileId": data.get("fileId"),
            }))
            ctx["debug"](f"→ TX file-cancel to={target} from={my_peer_id} fileId={data.get('fileId')}")
        except Exception:
            pass


@register("admin-login")
async def h_admin_login(websocket, data, ctx):
    ws_id = str(websocket.remote_address) if hasattr(websocket, "remote_address") else str(id(websocket))
    my_peer_id = ctx["_my_peer_id"]
    if not ctx["check_login_rate"](ws_id):
        await websocket.send(json.dumps({"type": "admin-login-result", "success": False, "message": "登入嘗試過於頻繁，請 30 秒後再試"}))
        ctx["log"]("ADMIN", f"Rate limit hit for {ws_id}")
        return
    pw = data.get("password", "")
    if ctx["verify_admin_password"](pw):
        token = ctx["generate_session"]()
        await websocket.send(json.dumps({
            "type": "admin-login-result",
            "success": True,
            "message": "Authenticated",
            "token": token,
            "serverInfo": {
                "version": "1.1.0",
                "uptime": int(time.time() - ctx.get("_start_time", time.time())),
                "activeRooms": len(ctx["rooms"]),
                "activePeers": sum(len(p) for p in ctx["rooms"].values()),
                "dataRooms": len(ctx["room_data"]),
                "chatRetentionDays": ctx.get("CHAT_RETENTION_DAYS", 7),
                "debugMode": ctx.get("DEBUG", False),
                "ntpServer": ctx["ntp_config"]["server"],
                "ntpEnabled": ctx["ntp_config"]["enabled"],
                "ntpOffset": round(ctx["ntp_config"]["offset"], 3),
                "ntpValid": ctx["ntp_config"].get("_ntp_valid", False),
                "stunServer": ctx["config"]["stunServer"],
            },
            "config": {
                "chatRetentionDays": ctx.get("CHAT_RETENTION_DAYS", 7),
                "stunServer": ctx["config"]["stunServer"],
                "logDir": ctx.get("LOG_DIR", "logs"),
                "dataFile": ctx.get("DB_PATH", "clipper_data.db"),
            }
        }))
        ctx["log"]('ADMIN', f'{my_peer_id} logged in successfully')
    else:
        await websocket.send(json.dumps({"type": "admin-login-result", "success": False, "message": "密碼錯誤"}))
        ctx["log"]('ADMIN', f'{my_peer_id} login FAILED')


@register("admin-logs")
async def h_admin_logs(websocket, data, ctx):
    if not ctx["verify_session"](data.get("token", "")):
        await websocket.send(json.dumps({"type": "error", "message": "unauthorized"}))
        return
    count = data.get("count", 50)
    logs = ctx["get_logs"](count)
    await websocket.send(json.dumps({"type": "admin-logs-result", "logs": logs}))


@register("admin-log-download")
async def h_admin_log_download(websocket, data, ctx):
    if not ctx["verify_session"](data.get("token", "")):
        await websocket.send(json.dumps({"type": "error", "message": "unauthorized"}))
        return
    import os
    log_dir = ctx.get("LOG_DIR", "logs")
    today_log = os.path.join(log_dir, f"clipper_{datetime.now().strftime('%Y%m%d')}.log")
    if os.path.exists(today_log):
        with open(today_log, 'r', encoding='utf-8') as f:
            log_text = f.read()
    else:
        log_text = "(no logs yet)"
    await websocket.send(json.dumps({
        "type": "admin-log-download-result",
        "logText": log_text,
        "logName": f"clipper_{datetime.now().strftime('%Y%m%d')}.log",
    }))


@register("admin-change-password")
async def h_admin_change_password(websocket, data, ctx):
    my_peer_id = ctx["_my_peer_id"]
    old_pw = data.get("oldPassword", "")
    new_pw = data.get("newPassword", "")
    if not new_pw or len(new_pw) < 4:
        await websocket.send(json.dumps({"type": "admin-change-password-result", "success": False, "message": "新密碼至少需要 4 個字元"}))
        return
    if not ctx["verify_admin_password"](old_pw):
        await websocket.send(json.dumps({"type": "admin-change-password-result", "success": False, "message": "舊密碼錯誤"}))
        return
    ctx["set_admin_password"](new_pw)
    await websocket.send(json.dumps({"type": "admin-change-password-result", "success": True, "message": "密碼已更改"}))
    ctx["log"]('ADMIN', f'{my_peer_id} changed password')


@register("admin-get-config")
async def h_admin_get_config(websocket, data, ctx):
    if not ctx["verify_session"](data.get("token", "")):
        await websocket.send(json.dumps({"type": "error", "message": "unauthorized"}))
        return
    await websocket.send(json.dumps({
        "type": "admin-config",
        "config": {
            "chatRetentionDays": ctx["config"]["chatRetentionDays"],
            "maxPeersPerRoom": ctx.get("MAX_PEERS_PER_ROOM", 50),
            "debug": ctx.get("DEBUG", False),
            "logRetentionHours": ctx.get("LOG_RETENTION_HOURS", 24),
            "dataFile": ctx.get("DB_PATH", "clipper_data.db"),
            "logDir": ctx.get("LOG_DIR", "logs"),
            "ntpServer": ctx["ntp_config"]["server"],
            "ntpEnabled": ctx["ntp_config"]["enabled"],
            "ntpOffset": round(ctx["ntp_config"]["offset"], 3),
            "ntpValid": ctx["ntp_config"].get("_ntp_valid", False),
            "stunServer": ctx["config"]["stunServer"],
        }
    }))


@register("admin-set-config")
async def h_admin_set_config(websocket, data, ctx):
    my_peer_id = ctx["_my_peer_id"]
    if not ctx["verify_session"](data.get("token", "")):
        await websocket.send(json.dumps({"type": "error", "message": "unauthorized"}))
        return
    cfg = data.get("config", {})
    if "chatRetentionDays" in cfg:
        ctx["config"]["chatRetentionDays"] = int(cfg["chatRetentionDays"])
    if "stunServer" in cfg:
        ctx["config"]["stunServer"] = str(cfg["stunServer"])
    response = {"type": "admin-set-config-result", "success": True, "message": "設定已更新", "config": ctx["config"]}
    await websocket.send(json.dumps(response))
    ctx["log"]('ADMIN', f'{my_peer_id} updated server config')


@register("admin-export")
async def h_admin_export(websocket, data, ctx):
    my_peer_id = ctx["_my_peer_id"]
    if not ctx["verify_session"](data.get("token", "")):
        await websocket.send(json.dumps({"type": "error", "message": "unauthorized"}))
        return
    dump_data = {
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "version": "1.1.0",
        "config": {
            "chatRetentionDays": ctx["config"]["chatRetentionDays"],
            "ntpServer": ctx["ntp_config"]["server"],
            "ntpEnabled": ctx["ntp_config"]["enabled"],
        },
        "rooms": ctx["room_data"],
    }
    await websocket.send(json.dumps({"type": "admin-export-result", "dump": json.dumps(dump_data)}))
    ctx["log"]('ADMIN', f'{my_peer_id} exported config dump ({len(ctx["room_data"])} rooms)')


@register("admin-import")
async def h_admin_import(websocket, data, ctx):
    if not ctx["verify_session"](data.get("token", "")):
        await websocket.send(json.dumps({"type": "error", "message": "unauthorized"}))
        return
    dump_raw = data.get("dump", "")
    try:
        dump_data = json.loads(dump_raw)
        if "rooms" in dump_data:
            imported = 0
            for rid, rdata in dump_data["rooms"].items():
                if isinstance(rdata, dict):
                    ctx["room_data"][rid] = rdata
                    imported += 1
            ctx["save_state"]()
            ctx["log"]('ADMIN', f'imported {imported} rooms from config dump')
            await websocket.send(json.dumps({"type": "admin-import-result", "success": True, "message": f"成功匯入 {imported} 個房間的資料", "count": imported}))
        else:
            await websocket.send(json.dumps({"type": "admin-import-result", "success": False, "message": "無效的備份檔案：缺少 rooms 資料"}))
    except json.JSONDecodeError as e:
        await websocket.send(json.dumps({"type": "admin-import-result", "success": False, "message": f"無效的 JSON 格式：{e}"}))


@register("keymgmt-create")
async def h_keymgmt_create(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    entry = data.get("entry", {})
    def broadcast_fn(msg):
        ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    ctx["keymgmt_service"].create_entry(ctx["room_data"][rid], rid, entry, broadcast_fn, ctx["log"])


@register("keymgmt-edit")
async def h_keymgmt_edit(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    def broadcast_fn(msg):
        ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    ctx["keymgmt_service"].edit_entry(ctx["room_data"][rid], rid, data, broadcast_fn, ctx["log"])


@register("keymgmt-toggle-active")
async def h_keymgmt_toggle_active(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    toggle_id = data.get("id")
    def broadcast_fn(msg):
        ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    ctx["keymgmt_service"].toggle_active(ctx["room_data"][rid], rid, toggle_id, broadcast_fn, ctx["log"])


@register("keymgmt-set-program")
async def h_keymgmt_set_program(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    prog_id = data.get("id")
    current_program = data.get("currentProgram", "")
    def broadcast_fn(msg):
        ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    ctx["keymgmt_service"].set_program(ctx["room_data"][rid], rid, prog_id, current_program, broadcast_fn, ctx["log"])


@register("keymgmt-delete")
async def h_keymgmt_delete(websocket, data, ctx):
    rid = data.get("room")
    if not rid or rid not in ctx["rooms"]:
        await websocket.send(json.dumps({"type": "error", "message": "room not found"}))
        return
    ctx["ensure_room_data"](rid)
    del_id = data.get("id")
    def broadcast_fn(msg):
        ctx["broadcast"](ctx["rooms"][rid], msg, exclude=websocket)
    ctx["keymgmt_service"].delete_entry(ctx["room_data"][rid], rid, del_id, broadcast_fn, ctx["log"])



async def h_dump(websocket, data, ctx):
    my_peer_id = ctx["_my_peer_id"]
    iso_ts = datetime.now(timezone.utc).isoformat()
    rooms_diag = {}
    total_notices = 0
    total_boards = 0
    for rid_key, rdata in ctx["room_data"].items():
        n = len(rdata.get("noticePosts", []))
        b = len(rdata.get("checklists", []))
        total_notices += n
        total_boards += b
        rooms_diag[rid_key] = {
            "peerCount": len(ctx["rooms"].get(rid_key, {})),
            "noticePosts": rdata.get("noticePosts", []),
            "checklists": rdata.get("checklists", []),
            "chatMessageCount": len(rdata.get("chatMessages", [])),
        }
    await websocket.send(json.dumps({
        "type": "dump-result",
        "timestamp": iso_ts,
        "retention_days": ctx.get("CHAT_RETENTION_DAYS", 7),
        "room_count": len(ctx["room_data"]),
        "rooms": rooms_diag,
    }))
    ctx["log"]('DUMP', f'Dump requested by {my_peer_id}')
    ctx["debug"](f"→ TX dump: {len(ctx['room_data'])} rooms, {total_notices} notices, {total_boards} boards")


# ──────────────────────────────────────────────
# Utility helper used by handlers
# ──────────────────────────────────────────────
def _ts_val(v):
    """Convert timestamp (epoch ms number or ISO string) to float (epoch ms)."""
    if v is None:
        return 0.0
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp() * 1000
    return float(v)
