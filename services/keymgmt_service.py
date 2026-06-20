"""Key management service for Clipper — owns all key/stream CRUD logic."""
import time


class KeyMgmtService:
    def __init__(self, persistence):
        self.persistence = persistence

    def create_entry(self, room_data, room_id, entry, broadcast_fn, log_fn):
        room_data.setdefault("keyManagements", [])
        room_data["keyManagements"].append(entry)
        broadcast_fn({"type": "keymgmt-create", "entry": entry})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('KEYMGMT', f'created key entry in {room_id}')
        return True, None

    def edit_entry(self, room_data, room_id, data, broadcast_fn, log_fn):
        edit_id = data.get("id")
        for entry in room_data.get("keyManagements", []):
            if entry.get("id") == edit_id:
                if "label" in data:
                    entry["label"] = data["label"]
                if "streamKey" in data:
                    entry["streamKey"] = data["streamKey"]
                if "streamUrl" in data:
                    entry["streamUrl"] = data["streamUrl"]
                if "currentProgram" in data:
                    entry["currentProgram"] = data["currentProgram"]
                entry["updatedAt"] = data.get("updatedAt", time.time() * 1000)
                break
        broadcast_fn({"type": "keymgmt-edit", "id": edit_id,
                      "label": data.get("label"), "streamKey": data.get("streamKey"),
                      "streamUrl": data.get("streamUrl"), "currentProgram": data.get("currentProgram")})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('KEYMGMT', f'edited key entry {edit_id} in {room_id}')
        return True, None

    def toggle_active(self, room_data, room_id, entry_id, broadcast_fn, log_fn):
        new_active = False
        for entry in room_data.get("keyManagements", []):
            if entry.get("id") == entry_id:
                entry["isActive"] = not entry.get("isActive", False)
                new_active = entry["isActive"]
                break
        broadcast_fn({"type": "keymgmt-toggle-active", "id": entry_id, "isActive": new_active})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('KEYMGMT', f'toggled key entry {entry_id} in {room_id}')
        return True, None

    def set_program(self, room_data, room_id, entry_id, program, broadcast_fn, log_fn):
        for entry in room_data.get("keyManagements", []):
            if entry.get("id") == entry_id:
                entry["currentProgram"] = program
                entry["updatedAt"] = time.time() * 1000
                break
        broadcast_fn({"type": "keymgmt-set-program", "id": entry_id, "currentProgram": program})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('KEYMGMT', f'set program for key entry {entry_id} in {room_id}')
        return True, None

    def delete_entry(self, room_data, room_id, entry_id, broadcast_fn, log_fn):
        room_data.setdefault("deletedKeyIds", [])
        if entry_id and entry_id not in room_data["deletedKeyIds"]:
            room_data["deletedKeyIds"].append(entry_id)
        room_data["keyManagements"] = [
            e for e in room_data.get("keyManagements", []) if e.get("id") != entry_id
        ]
        broadcast_fn({"type": "keymgmt-delete", "id": entry_id})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('KEYMGMT', f'deleted key entry {entry_id} in {room_id}')
        return True, None
