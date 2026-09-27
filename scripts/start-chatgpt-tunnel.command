#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
: "${CHATWORK_TUNNEL_ID:?Set CHATWORK_TUNNEL_ID to your own tunnel ID}"
STABLE_DIR="$HOME/Library/Application Support/ChatWorkBridge/current"
if [ -x "$STABLE_DIR/.chatwork-bridge/bin/tunnel-client" ]; then
  PROJECT_DIR="$STABLE_DIR"
else
  "$SOURCE_DIR/scripts/install-runtime.command"
  PROJECT_DIR="$STABLE_DIR"
fi
BIN="$PROJECT_DIR/.chatwork-bridge/bin/tunnel-client"
if [ ! -x "$BIN" ]; then
  echo "Install your own tunnel-client at $BIN before starting the tunnel." >&2
  exit 1
fi
LABEL="com.openai.chatwork-bridge"
DOMAIN="gui/$(id -u)"
RUNTIME_API_KEY="$HOME/Library/Application Support/ChatWorkBridge/secrets/control-plane.key"
MCP_COMMAND="$HOME/.chatwork-bridge-current/scripts/start-chatgpt-stdio.sh"
if [ ! -f "$RUNTIME_API_KEY" ]; then
  echo "Configure your own tunnel runtime key at $RUNTIME_API_KEY before starting the tunnel." >&2
  exit 1
fi

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "$DOMAIN/$LABEL"
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 60 ]; do
    HEALTH_FILE="$HOME/Library/Application Support/ChatWorkBridge/state/tunnel-health.url"
    if [ -s "$HEALTH_FILE" ]; then
      HEALTH_URL=$(tr -d '\r\n' < "$HEALTH_FILE")
      if curl -fsS "$HEALTH_URL/readyz" >/dev/null 2>&1; then
        if node "$PROJECT_DIR/scripts/check-tunnel-health.mjs"; then
          echo "ChatWork Bridge is ready at $HEALTH_URL"
          exit 0
        fi
      fi
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done
  echo "ChatWork Bridge did not become ready. Run scripts/doctor.command for details." >&2
  exit 1
fi

"$BIN" runtimes connect \
  --alias chatwork-local \
  --profile chatwork-local \
  --profile-dir "$PROJECT_DIR/.chatwork-bridge/tunnel-profiles" \
  --tunnel-id "$CHATWORK_TUNNEL_ID" \
  --runtime-api-key "file:$RUNTIME_API_KEY" \
  --mcp-command "$MCP_COMMAND"

"$BIN" runtimes status chatwork-local --json
