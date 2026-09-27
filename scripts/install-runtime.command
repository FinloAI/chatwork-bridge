#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_ROOT="$HOME/Library/Application Support/ChatWorkBridge"
HELPER_SOURCE="$SOURCE_DIR/native/chatwork-ax-helper.m"
HELPER_DIR="$INSTALL_ROOT/bin"
HELPER_TARGET="$HELPER_DIR/chatwork-ax-helper"
SECRETS_DIR="$INSTALL_ROOT/secrets"
SOURCE_CONTROL_KEY="$SOURCE_DIR/.chatwork-bridge/control-plane.key"
INSTALLED_CONTROL_KEY="$SECRETS_DIR/control-plane.key"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)-$$"
VERSION=$(cd "$SOURCE_DIR" && node -p 'require("./package.json").version')
TARGET="$INSTALL_ROOT/runtime-$VERSION-$TIMESTAMP"
STAGING="$INSTALL_ROOT/.runtime-$VERSION-$TIMESTAMP.tmp"
CURRENT="$INSTALL_ROOT/current"
NO_SPACE_CURRENT="$HOME/.chatwork-bridge-current"
DEPENDENCY_SOURCE="$SOURCE_DIR/node_modules"

if [ -d "$CURRENT/node_modules" ] && [ -f "$CURRENT/package.json" ]; then
  SOURCE_DEPENDENCIES=$(cd "$SOURCE_DIR" && node -p 'JSON.stringify(require("./package.json").dependencies || {})')
  CURRENT_DEPENDENCIES=$(cd "$CURRENT" && node -p 'JSON.stringify(require("./package.json").dependencies || {})')
  if [ "$SOURCE_DEPENDENCIES" = "$CURRENT_DEPENDENCIES" ]; then
    DEPENDENCY_SOURCE="$CURRENT/node_modules"
  fi
fi

if [ ! -d "$DEPENDENCY_SOURCE" ]; then
  echo "Installed Node dependencies are missing. Run npm install or npm ci, then retry." >&2
  exit 1
fi
DATALLESS_DEPENDENCY=$(/usr/bin/find "$DEPENDENCY_SOURCE" -type f -flags +dataless -print -quit)
if [ -n "$DATALLESS_DEPENDENCY" ]; then
  echo "Node dependencies contain iCloud dataless files: $DEPENDENCY_SOURCE" >&2
  echo "Download them locally or run npm ci outside iCloud, then retry." >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT" "$INSTALL_ROOT/state" "$INSTALL_ROOT/cache" "$INSTALL_ROOT/logs" "$HELPER_DIR" "$SECRETS_DIR"
chmod 700 "$INSTALL_ROOT" "$INSTALL_ROOT/state" "$INSTALL_ROOT/cache" "$INSTALL_ROOT/logs" "$HELPER_DIR" "$SECRETS_DIR"

if [ -f "$SOURCE_CONTROL_KEY" ]; then
  CONTROL_KEY_STAGING="$SECRETS_DIR/.control-plane.key-$TIMESTAMP.tmp"
  cp "$SOURCE_CONTROL_KEY" "$CONTROL_KEY_STAGING"
  chmod 600 "$CONTROL_KEY_STAGING"
  mv "$CONTROL_KEY_STAGING" "$INSTALLED_CONTROL_KEY"
fi

if [ ! -f "$HELPER_SOURCE" ]; then
  echo "Native accessibility helper source is missing: $HELPER_SOURCE" >&2
  exit 1
fi

HELPER_HASH_FILE="$HELPER_DIR/chatwork-ax-helper.source.sha256"
HELPER_SOURCE_HASH=$(/usr/bin/shasum -a 256 "$HELPER_SOURCE" | /usr/bin/awk '{print $1}')
HELPER_BUILD_KEY="objc-ax-v1-$HELPER_SOURCE_HASH"
HELPER_INSTALLED_KEY=""
if [ -f "$HELPER_HASH_FILE" ]; then
  HELPER_INSTALLED_KEY=$(/usr/bin/sed -n '1p' "$HELPER_HASH_FILE")
fi

if [ -x "$HELPER_TARGET" ] && [ "$HELPER_BUILD_KEY" = "$HELPER_INSTALLED_KEY" ]; then
  echo "Reusing unchanged native accessibility helper: $HELPER_TARGET"
else
  HELPER_STAGING="$HELPER_DIR/.chatwork-ax-helper-$TIMESTAMP.tmp"
  HELPER_HASH_STAGING="$HELPER_DIR/.chatwork-ax-helper-$TIMESTAMP.sha256.tmp"
  echo "Compiling native macOS accessibility helper..."
  if ! /usr/bin/xcrun --sdk macosx clang \
    -fobjc-arc \
    -O2 \
    -Wall \
    -Wextra \
    -Werror \
    -framework Foundation \
    -framework AppKit \
    -framework ApplicationServices \
    "$HELPER_SOURCE" \
    -o "$HELPER_STAGING"; then
    echo "Failed to compile the native accessibility helper. Install or repair Xcode Command Line Tools, then retry." >&2
    exit 1
  fi
  /usr/bin/codesign --force --sign - --identifier com.openai.chatworkbridge.axhelper "$HELPER_STAGING"
  chmod 700 "$HELPER_STAGING"
  /usr/bin/printf '%s\n' "$HELPER_BUILD_KEY" > "$HELPER_HASH_STAGING"
  chmod 600 "$HELPER_HASH_STAGING"
  mv "$HELPER_STAGING" "$HELPER_TARGET"
  mv "$HELPER_HASH_STAGING" "$HELPER_HASH_FILE"
  echo "Native accessibility helper updated: $HELPER_TARGET"
  echo "Because the helper binary changed, macOS may ask you to grant Accessibility access to this stable path again."
fi

mkdir -p "$STAGING"

/usr/bin/rsync -a \
  --exclude '.DS_Store' \
  --exclude '.chatwork-bridge/audit.jsonl' \
  --exclude '.chatwork-bridge/jobs' \
  --exclude '.chatwork-bridge/screenshots' \
  --exclude '.chatwork-bridge/node-compile-cache' \
  --exclude '.chatwork-bridge/launchd.out.log' \
  --exclude '.chatwork-bridge/launchd.err.log' \
  --exclude '.chatwork-bridge/control-plane.key' \
  --exclude 'node_modules' \
  "$SOURCE_DIR/" "$STAGING/"
mkdir -p "$STAGING/node_modules"
/usr/bin/rsync -a "$DEPENDENCY_SOURCE/" "$STAGING/node_modules/"
echo "Runtime dependencies copied from: $DEPENDENCY_SOURCE"
PROFILE="$STAGING/.chatwork-bridge/tunnel-profiles/chatwork-local.yaml"
if [ -f "$PROFILE" ] && [ -f "$INSTALLED_CONTROL_KEY" ]; then
  node "$SOURCE_DIR/scripts/configure-tunnel-profile.mjs" \
    "$PROFILE" \
    "$INSTALLED_CONTROL_KEY" \
    "$INSTALL_ROOT/state/tunnel-health.url" \
    "$INSTALL_ROOT/logs/tunnel-client.log" \
    "$NO_SPACE_CURRENT/scripts/start-chatgpt-stdio.sh"
fi
mv "$STAGING" "$TARGET"
ln -sfn "$TARGET" "$CURRENT"
ln -sfn "$CURRENT" "$NO_SPACE_CURRENT"

echo "Installed immutable runtime: $TARGET"
echo "Current runtime: $CURRENT"
echo "No-space tunnel launcher: $NO_SPACE_CURRENT"
