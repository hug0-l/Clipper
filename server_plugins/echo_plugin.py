"""Echo plugin — responds to plugin-echo messages for testing."""

import json
import time
from services.ws_router import register


@register("plugin-echo")
async def h_plugin_echo(websocket, data, ctx):
    """Echo back the data with a server timestamp."""
    msg = data.get("msg", "")
    await websocket.send(json.dumps({
        "type": "plugin-echo-response",
        "original": msg,
        "serverTime": int(time.time() * 1000),
        "plugin": "echo_plugin",
    }))
