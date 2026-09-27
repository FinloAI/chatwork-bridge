#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STABLE_MODULES="$HOME/Library/Application Support/ChatWorkBridge/current/node_modules"

if [ ! -d "$STABLE_MODULES" ]; then
  echo "Stable runtime dependencies are unavailable. Run npm install or install-runtime.command first." >&2
  exit 1
fi

TEMP_ROOT=$(mktemp -d /private/tmp/chatwork-bridge-test.XXXXXX)
STAGED_PROJECT="$TEMP_ROOT/chatwork-bridge"
cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

mkdir "$STAGED_PROJECT"
/usr/bin/rsync -a \
  --exclude '.chatwork-bridge' \
  --exclude 'node_modules' \
  --exclude '*.zip' \
  "$SOURCE_DIR/" "$STAGED_PROJECT/"
ln -s "$STABLE_MODULES" "$STAGED_PROJECT/node_modules"
cd "$STAGED_PROJECT"
npm test
