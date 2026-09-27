#!/bin/sh
set -eu

# Set CHATWORK_ROOTS to the projects you want the bridge to access before launch.
# Read access defaults to the same roots; widen it explicitly only if needed.
: "${CHATWORK_ROOTS:?Set CHATWORK_ROOTS to an absolute project directory}"
export CHATWORK_ROOTS
export CHATWORK_READ_ROOTS="${CHATWORK_READ_ROOTS:-$CHATWORK_ROOTS}"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export PYTHONUNBUFFERED="1"
export CHATWORK_REQUIRE_PROCESS_SANDBOX="1"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_STATE="$HOME/Library/Application Support/ChatWorkBridge"
mkdir -p "$RUNTIME_STATE/state" "$RUNTIME_STATE/cache/node"
chmod 700 "$RUNTIME_STATE" "$RUNTIME_STATE/state" "$RUNTIME_STATE/cache" "$RUNTIME_STATE/cache/node"
export CHATWORK_STATE_DIR="$RUNTIME_STATE/state"
export NODE_COMPILE_CACHE="$RUNTIME_STATE/cache/node"
cd "$SCRIPT_DIR/.."
exec node src/server.js --stdio
