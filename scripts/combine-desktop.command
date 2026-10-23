#!/bin/bash
# Opens CombineWebUI in desktop mode. Double-click it in Finder, or run it in a
# terminal. Expects a virtual environment at .venv (see README, Desktop mode).
# Make it executable once with: chmod +x scripts/combine-desktop.command
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -x ".venv/bin/python" ]; then
    echo "No virtual environment at $(pwd)/.venv."
    echo "Create it with: python3 -m venv .venv && .venv/bin/pip install -r requirements-desktop.txt"
    exit 1
fi

exec ".venv/bin/python" main.py desktop "$@"
