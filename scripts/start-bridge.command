#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR/.."
export NODE_COMPILE_CACHE="$PWD/.chatwork-bridge/node-compile-cache"

if [[ ! -d node_modules ]]; then
  npm install
fi

echo "Chatwork Bridge will only expose: ${CHATWORK_ROOTS:-$PWD}"
echo "Endpoint: http://${CHATWORK_HOST:-127.0.0.1}:${CHATWORK_PORT:-7337}/mcp"
npm start
