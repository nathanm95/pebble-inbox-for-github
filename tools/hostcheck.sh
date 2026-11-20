#!/bin/sh
# Runs tools/hostcheck.py under pebble-tool's Python, which is where pypkjs lives.
exec "$HOME/.local/share/uv/tools/pebble-tool/bin/python" "$(dirname "$0")/hostcheck.py" "$@"
