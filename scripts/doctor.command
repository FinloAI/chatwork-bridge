#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STABLE_DIR="$HOME/Library/Application Support/ChatWorkBridge/current"
if [ -x "$STABLE_DIR/.chatwork-bridge/bin/tunnel-client" ]; then
  PROJECT_DIR="$STABLE_DIR"
else
  PROJECT_DIR="$SOURCE_DIR"
fi
LABEL="com.openai.chatwork-bridge"
DOMAIN="gui/$(id -u)"
HEALTH_FILE="$HOME/Library/Application Support/ChatWorkBridge/state/tunnel-health.url"

echo "LaunchAgent:"
launchctl print "$DOMAIN/$LABEL" 2>&1 | sed -n '1,80p'

HEALTH_URL=""
HEALTH=""
READY=""
ATTEMPT=0
while [ "$ATTEMPT" -lt 60 ]; do
  if [ -s "$HEALTH_FILE" ]; then
    HEALTH_URL=$(tr -d '\r\n' < "$HEALTH_FILE")
    if HEALTH=$(curl --max-time 2 -fsS "$HEALTH_URL/healthz" 2>/dev/null) && READY=$(curl --max-time 2 -fsS "$HEALTH_URL/readyz" 2>/dev/null); then
      break
    fi
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

if [ -z "$HEALTH" ] || [ -z "$READY" ]; then
  echo "ERROR: tunnel health endpoint is stale or not ready: $HEALTH_URL" >&2
  echo "Run scripts/start-chatgpt-tunnel.command to restart it." >&2
  exit 1
fi

echo "Health: $HEALTH"
echo "Ready:  $READY"
echo "Effective tunnel health:"
if ! node "$PROJECT_DIR/scripts/check-tunnel-health.mjs"; then
  echo "ERROR: the outer tunnel is responding, but its MCP channel is not healthy." >&2
  echo "Run scripts/start-chatgpt-tunnel.command to replace the poisoned tunnel instance." >&2
  exit 1
fi
