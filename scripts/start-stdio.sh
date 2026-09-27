#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_STATE=${CHATWORK_RUNTIME_STATE:-"$HOME/Library/Application Support/ChatWorkBridge"}
mkdir -p "$RUNTIME_STATE/state" "$RUNTIME_STATE/cache/node"
chmod 700 "$RUNTIME_STATE" "$RUNTIME_STATE/state" "$RUNTIME_STATE/cache" "$RUNTIME_STATE/cache/node"
export CHATWORK_STATE_DIR=${CHATWORK_STATE_DIR:-"$RUNTIME_STATE/state"}
export NODE_COMPILE_CACHE=${NODE_COMPILE_CACHE:-"$RUNTIME_STATE/cache/node"}
cd "$SCRIPT_DIR/.."
exec node src/server.js --stdio
