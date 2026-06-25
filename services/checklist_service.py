"""Checklist service for Clipper — owns all checklist board and item CRUD logic."""
import time


class ChecklistService:
    def __init__(self, persistence):
        self.persistence = persistence

    def create_board(self, room_data, room_id, board, broadcast_fn, log_fn):
        """Create a new checklist board."""
        room_data.setdefault("checklists", [])
        if any(b.get("id") == board.get("id") for b in room_data["checklists"]):
            return False, "board id already exists"
        room_data["checklists"].append(board)
        broadcast_fn({"type": "checklistboard-create", "board": board})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('CHECKLIST', f'created board in {room_id}')
        return True, None

    def edit_board(self, room_data, room_id, data, broadcast_fn):
        """Edit a checklist board's metadata."""
        board_id = data.get("id")
        if not board_id:
            return False, "board id required"
        for board in room_data.get("checklists", []):
            if board.get("id") == board_id:
                if "title" in data:
                    board["title"] = data["title"]
                if "category" in data:
                    board["category"] = data["category"]
                if "tags" in data:
                    board["tags"] = data["tags"]
                if "color" in data:
                    board["color"] = data["color"]
                break
        broadcast_fn({
            "type": "checklistboard-edit", "id": board_id,
            "title": data.get("title"), "category": data.get("category"),
            "tags": data.get("tags"), "color": data.get("color"),
        })
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        return True, None

    def delete_board(self, room_data, room_id, board_id, broadcast_fn):
        """Delete a checklist board and track its ID for ghost prevention."""
        if not board_id:
            return False, "board id required"
        room_data.setdefault("deletedChecklistIds", [])
        if board_id and board_id not in room_data["deletedChecklistIds"]:
            room_data["deletedChecklistIds"].append(board_id)
        room_data["checklists"] = [b for b in room_data.get("checklists", []) if b.get("id") != board_id]
        broadcast_fn({"type": "checklistboard-delete", "id": board_id})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        return True, None

    def pin_board(self, room_data, room_id, board_id, pinned, broadcast_fn):
        """Pin or unpin a checklist board."""
        if not board_id:
            return False, "board id required"
        for board in room_data.get("checklists", []):
            if board.get("id") == board_id:
                board["pinned"] = pinned
                break
        broadcast_fn({"type": "checklistboard-pin", "id": board_id, "pinned": pinned})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        return True, None

    def set_reminder(self, room_data, room_id, board_id, reminder_at, reminder_title, broadcast_fn, log_fn):
        """Set reminder on a checklist board."""
        if not board_id:
            return False, "board id required"
        for board in room_data.get("checklists", []):
            if board.get("id") == board_id:
                board["reminderAt"] = reminder_at
                board["reminderTitle"] = reminder_title or ""
                break
        broadcast_fn({
            "type": "checklistboard-remind", "id": board_id,
            "reminderAt": reminder_at, "reminderTitle": reminder_title or "",
        })
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('CHECKLIST', f'set reminder for board {board_id} in {room_id}')
        return True, None

    def add_item(self, room_data, room_id, checklist_id, item, broadcast_fn):
        """Add an item to a checklist board."""
        if not checklist_id:
            return False, "checklistId required"
        for board in room_data.get("checklists", []):
            if board.get("id") == checklist_id:
                board.setdefault("items", []).append(item)
                break
        broadcast_fn({"type": "checklist-add", "checklistId": checklist_id, "item": item})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        return True, None

    def toggle_item(self, room_data, room_id, checklist_id, item_id, checked, checked_at, broadcast_fn):
        """Toggle checked state of a checklist item."""
        if not checklist_id or not item_id:
            return False, "checklistId and item id required"
        for board in room_data.get("checklists", []):
            if board.get("id") == checklist_id:
                for item in board.get("items", []):
                    if item.get("id") == item_id:
                        item["checked"] = checked
                        item["checkedAt"] = checked_at
                        break
                break
        broadcast_fn({
            "type": "checklist-toggle", "checklistId": checklist_id,
            "id": item_id, "checked": checked, "checkedAt": checked_at,
        })
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        return True, None

    def delete_item(self, room_data, room_id, checklist_id, item_id, broadcast_fn):
        """Delete an item from a checklist board."""
        if not checklist_id or not item_id:
            return False, "checklistId and item id required"
        for board in room_data.get("checklists", []):
            if board.get("id") == checklist_id:
                board["items"] = [i for i in board.get("items", []) if i.get("id") != item_id]
                break
        broadcast_fn({"type": "checklist-delete", "checklistId": checklist_id, "id": item_id})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        return True, None

    def reorder_items(self, room_data, room_id, checklist_id, item_ids, broadcast_fn):
        """Reorder items in a checklist board."""
        if not checklist_id or not item_ids:
            return False, "checklistId and item_ids required"
        for board in room_data.get("checklists", []):
            if board.get("id") == checklist_id:
                item_map = {i.get("id"): i for i in board.get("items", [])}
                board["items"] = [item_map[iid] for iid in item_ids if iid in item_map]
                break
        broadcast_fn({"type": "checklist-reorder", "checklistId": checklist_id, "itemIds": item_ids})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        return True, None

    def reset_items(self, room_data, room_id, board_id, broadcast_fn, log_fn):
        """Uncheck all items in a checklist board."""
        if not board_id:
            return False, "board id required"
        for board in room_data.get("checklists", []):
            if board.get("id") == board_id:
                for item in board.get("items", []):
                    item["checked"] = False
                    item["checkedAt"] = None
                break
        broadcast_fn({"type": "checklist-reset", "id": board_id})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('CHECKLIST', f'reset all items in board {board_id} in {room_id}')
        return True, None
