"""Notice service for Clipper — owns all notice post CRUD and pin logic."""
import time


class NoticeService:
    def __init__(self, persistence):
        self.persistence = persistence

    def create_post(self, room_data, room_id, post, broadcast_fn, log_fn):
        """Create a notice post. Returns (success, error_msg)."""
        if not post.get("id"):
            return False, "post id required"
        if not post.get("title", "").strip():
            return False, "title required"
        room_data.setdefault("noticePosts", [])
        room_data["noticePosts"].append(post)
        broadcast_fn({"type": "notice-create", "post": post})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('NOTICE', f'created post in {room_id}')
        return True, None

    def edit_post(self, room_data, room_id, data, broadcast_fn):
        """Edit a notice post. Supports partial updates."""
        post_id = data.get("id")
        if not post_id:
            return False, "id required"
        for post in room_data.get("noticePosts", []):
            if post.get("id") == post_id:
                if "title" in data:
                    post["title"] = data["title"]
                if "content" in data:
                    post["content"] = data["content"]
                if "editedAt" in data:
                    post["editedAt"] = data["editedAt"]
                if "category" in data:
                    post["category"] = data["category"]
                if "tags" in data:
                    post["tags"] = data["tags"]
                if "color" in data:
                    post["color"] = data["color"]
                break
        broadcast_msg = {
            k: v for k, v in data.items()
            if k in ("title", "content", "editedAt", "category", "tags", "color")
        }
        broadcast_msg["type"] = "notice-edit"
        broadcast_msg["id"] = post_id
        broadcast_fn(broadcast_msg)
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        return True, None

    def delete_post(self, room_data, room_id, post_id, broadcast_fn, log_fn):
        """Delete a notice post and track its ID for ghost-prevention."""
        if not post_id:
            return False, "id required"
        room_data.setdefault("deletedPostIds", [])
        if post_id not in room_data["deletedPostIds"]:
            room_data["deletedPostIds"].append(post_id)
        room_data["noticePosts"] = [
            p for p in room_data.get("noticePosts", []) if p.get("id") != post_id
        ]
        broadcast_fn({"type": "notice-delete", "id": post_id})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        log_fn('NOTICE', f'deleted post {post_id} in {room_id}')
        return True, None

    def toggle_pin(self, room_data, room_id, post_id, pinned, broadcast_fn):
        """Toggle pin status on a notice post."""
        if not post_id:
            return False, "id required"
        for post in room_data.get("noticePosts", []):
            if post.get("id") == post_id:
                post["pinned"] = pinned
                break
        broadcast_fn({"type": "notice-pin", "id": post_id, "pinned": pinned})
        if self.persistence:
            self.persistence.save_room_data(room_id, room_data)
        return True, None
