#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$SOURCE_DIR/scripts/install-runtime.command"
PROJECT_DIR="$HOME/Library/Application Support/ChatWorkBridge/current"
LABEL="com.openai.chatwork-bridge"
SOURCE="$PROJECT_DIR/launchd/$LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ ! -x "$PROJECT_DIR/.chatwork-bridge/bin/tunnel-client" ] || [ ! -d "$PROJECT_DIR/.chatwork-bridge/tunnel-profiles" ]; then
  echo "Configure your own tunnel-client and profile in .chatwork-bridge before installing the LaunchAgent." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SOURCE" "$TARGET"
chmod 600 "$TARGET"
RUNTIME_PATH="/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/Library/Frameworks/Python.framework/Versions/Current/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.pyenv/shims:$HOME/.uv/bin:$HOME/miniforge3/bin:$HOME/mambaforge/bin:$HOME/anaconda3/bin:/usr/bin:/bin:/usr/sbin:/sbin"
plutil -replace ProgramArguments -json "[\"$PROJECT_DIR/.chatwork-bridge/bin/tunnel-client\",\"run\",\"--profile-dir\",\"$PROJECT_DIR/.chatwork-bridge/tunnel-profiles\",\"--profile\",\"chatwork-local\"]" "$TARGET"
plutil -replace WorkingDirectory -string "$PROJECT_DIR" "$TARGET"
plutil -replace EnvironmentVariables.PATH -string "$RUNTIME_PATH" "$TARGET"
plutil -replace EnvironmentVariables.NODE_COMPILE_CACHE -string "$HOME/Library/Application Support/ChatWorkBridge/cache/node" "$TARGET"
plutil -replace StandardOutPath -string "$HOME/Library/Application Support/ChatWorkBridge/logs/launchd.out.log" "$TARGET"
plutil -replace StandardErrorPath -string "$HOME/Library/Application Support/ChatWorkBridge/logs/launchd.err.log" "$TARGET"
plutil -lint "$TARGET"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
ATTEMPT=0
while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ "$ATTEMPT" -lt 50 ]; do
  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.1
done
if ! launchctl bootstrap "$DOMAIN" "$TARGET"; then
  # launchd can briefly return EIO while completing a prior bootout. If the
  # service was not loaded despite that error, wait once and retry.
  sleep 1
  if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootstrap "$DOMAIN" "$TARGET"
  fi
fi
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"
launchctl print "$DOMAIN/$LABEL"
"$PROJECT_DIR/scripts/doctor.command"
