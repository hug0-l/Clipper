"""Chat service for Clipper — owns all chat backup, edit, delete, and history logic."""
import time
from datetime import datetime


class ChatService:
    def __init__(self, persistence, retention_days=7):
        self.persistence = persistence
        self.retention_days = retention_days

    def set_retention_days(self, days):
        self.retention_days = days

    def backup_message(self, room_data, room_id, msg_data, log_fn):
        """Append a chat message and enforce retention cutoff."""
        room_data.setdefault("chatMessages", [])
        backup_msg = {
            "msgId": msg_data.get("msgId", ""),
            "text": msg_data.get("text", ""),
            "from": msg_data.get("from", ""),
            "timestamp": msg_data.get("timestamp", time.time() * 1000),
            "serverReceivedAt": time.time() * 1000,
        }
        room_data["chatMessages"].append(backup_msg)
        # Enforce retention
        cutoff = (time.time() - self.retention_days * 86400) * 1000
        room_data["chatMessages"] = [
            m for m in room_data["chatMessages"]
            if self._ts_val(m["timestamp"]) > cutoff
        ]
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('CHAT-BACKUP', f'backed up chat msg in {room_id} ({len(room_data["chatMessages"])} stored)')

    def edit_message(self, room_data, room_id, msg_id, new_text, broadcast_fn, log_fn):
        """Edit a chat message (soft-edit). Returns (success, error_msg)."""
        found = False
        for msg in room_data.get("chatMessages", []):
            if msg.get("msgId") == msg_id:
                msg["text"] = new_text
                msg["edited"] = True
                found = True
                break
        if not found:
            return False, "message not found"
        broadcast_fn({"type": "chat-edit", "msgId": msg_id, "newText": new_text, "edited": True})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('CHAT-EDIT', f'edited msg {msg_id} in {room_id}')
        return True, None

    def delete_message(self, room_data, room_id, msg_id, broadcast_fn, log_fn):
        """Delete a chat message (soft-delete). Returns (success, error_msg)."""
        found = False
        for msg in room_data.get("chatMessages", []):
            if msg.get("msgId") == msg_id:
                msg["deleted"] = True
                found = True
                break
        if not found:
            return False, "message not found"
        broadcast_fn({"type": "chat-delete", "msgId": msg_id, "deleted": True})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('CHAT-DELETE', f'deleted msg {msg_id} in {room_id}')
        return True, None

    def get_history(self, room_data, room_id, since=None):
        """Return filtered chat messages (not deleted, within retention window)."""
        if since is None:
            cutoff = (time.time() - self.retention_days * 86400) * 1000
            filtered = [
                m for m in room_data.get("chatMessages", [])
                if self._ts_val(m["timestamp"]) > cutoff and not m.get("deleted", False)
            ]
        else:
            since_f = self._ts_val(since)
            filtered = [
                m for m in room_data.get("chatMessages", [])
                if self._ts_val(m["timestamp"]) > since_f and not m.get("deleted", False)
            ]
        return filtered

    @staticmethod
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
