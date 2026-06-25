"""Unified persistence layer for Clipper server data."""
import json
import sqlite3
import hashlib
import hmac
import threading
from datetime import datetime, timezone


DB_PATH = "clipper_data.db"


class Persistence:
    def __init__(self, db_path=DB_PATH):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA cache_size=-8000")
        self._init_db()

    def _init_db(self):
        """Create tables if they don't exist."""
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS room_data ("
            "room_id TEXT PRIMARY KEY, data TEXT)"
        )
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS device_peers ("
            "device_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, "
            "room_id TEXT DEFAULT '', display_name TEXT DEFAULT '', "
            "last_seen TEXT NOT NULL)"
        )
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS plugin_data ("
            "plugin TEXT, key TEXT, value TEXT, PRIMARY KEY(plugin, key))"
        )
        self._conn.commit()

    # --- Room data ---

    def save_room_data(self, room_id, room_data):
        """Persist a room's full data (notices, checklists, keys, chat)."""
        with self._lock:
            blob = json.dumps(room_data, ensure_ascii=False)
            self._conn.execute(
                "INSERT OR REPLACE INTO room_data VALUES (?, ?)", (room_id, blob)
            )
            self._conn.commit()

    def save_many_rooms(self, room_dict):
        """Persist multiple rooms in a single transaction."""
        with self._lock:
            with self._conn:
                for rid, data in room_dict.items():
                    blob = json.dumps(data, ensure_ascii=False)
                    self._conn.execute(
                        "INSERT OR REPLACE INTO room_data VALUES (?, ?)", (rid, blob)
                    )

    def load_all_rooms(self):
        """Load all room data from DB. Returns {room_id: {data...}}."""
        rows = self._conn.execute(
            "SELECT room_id, data FROM room_data"
        ).fetchall()
        result = {}
        for rid, blob in rows:
            try:
                result[rid] = json.loads(blob)
            except json.JSONDecodeError:
                continue
        return result

    # --- Plugin key-value storage ---

    def plugin_set(self, plugin_name, key, value):
        """Store a plugin's key-value pair. Thread-safe."""
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO plugin_data VALUES (?,?,?)",
                (plugin_name, key, json.dumps(value))
            )
            self._conn.commit()

    def plugin_get(self, plugin_name, key, default=None):
        """Retrieve a plugin's value by key."""
        row = self._conn.execute(
            "SELECT value FROM plugin_data WHERE plugin=? AND key=?",
            (plugin_name, key)
        ).fetchone()
        if row:
            return json.loads(row[0])
        return default

    def plugin_delete(self, plugin_name, key):
        """Delete a plugin's key-value pair."""
        with self._lock:
            self._conn.execute(
                "DELETE FROM plugin_data WHERE plugin=? AND key=?",
                (plugin_name, key)
            )
            self._conn.commit()

    def plugin_list(self, plugin_name):
        """List all keys for a plugin."""
        rows = self._conn.execute(
            "SELECT key FROM plugin_data WHERE plugin=?", (plugin_name,)
        ).fetchall()
        return [r[0] for r in rows]

    def plugin_clear(self, plugin_name):
        """Clear all data for a plugin."""
        with self._lock:
            self._conn.execute("DELETE FROM plugin_data WHERE plugin=?", (plugin_name,))
            self._conn.commit()

    # --- Device-Peer mapping (thread-safe) ---

    def get_peer_for_device(self, device_id):
        """Look up a peer_id previously assigned to this device.
        Returns (peer_id, room_id, display_name) tuple, or None.
        """
        row = self._conn.execute(
            "SELECT peer_id, room_id, display_name FROM device_peers WHERE device_id=?",
            (device_id,)
        ).fetchone()
        return row if row else None

    def save_device_peer(self, device_id, peer_id, room_id='', display_name=''):
        """Save or update a device→peer mapping."""
        self._conn.execute(
            "INSERT OR REPLACE INTO device_peers "
            "(device_id, peer_id, room_id, display_name, last_seen) "
            "VALUES (?,?,?,?,?)",
            (device_id, peer_id, room_id, display_name,
             datetime.now(timezone.utc).isoformat())
        )
        self._conn.commit()
