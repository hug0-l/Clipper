"""Server-side plugin loader for Clipper.

Scans the server_plugins/ directory for Python plugin modules.
Each plugin module should import @register from services.ws_router
and decorate handler functions to register WS message types.

Plugins can also access ctx services for persistence, broadcast, etc.
"""

import importlib
import importlib.util
import os
import sys
import json

PLUGIN_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server_plugins")


def _log(msg):
    ts = __import__('datetime', fromlist=['datetime']).datetime.now().strftime('%H:%M:%S')
    print(f"[{ts}] [PLUGIN-LOADER] {msg}")


def load_plugins():
    """Scan server_plugins/ and import all .py files (not starting with _)."""
    if not os.path.isdir(PLUGIN_DIR):
        os.makedirs(PLUGIN_DIR, exist_ok=True)
        _log(f"Created plugin directory: {PLUGIN_DIR}")
        return []

    loaded = []
    for fname in sorted(os.listdir(PLUGIN_DIR)):
        if fname.startswith('_') or not fname.endswith('.py'):
            continue
        mod_name = fname[:-3]
        mod_path = os.path.join(PLUGIN_DIR, fname)

        try:
            spec = importlib.util.spec_from_file_location(mod_name, mod_path)
            if spec and spec.loader:
                mod = importlib.util.module_from_spec(spec)
                # Add plugin dir to sys.path for relative imports
                if PLUGIN_DIR not in sys.path:
                    sys.path.insert(0, PLUGIN_DIR)
                spec.loader.exec_module(mod)
                loaded.append(mod_name)
                _log(f"Loaded plugin: {mod_name}")
        except Exception as e:
            _log(f"FAILED to load plugin {mod_name}: {e}")
            import traceback
            _log(traceback.format_exc())

    return loaded
