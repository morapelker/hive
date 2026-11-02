#!/usr/bin/env bash
set -euo pipefail

# ── Colors & helpers ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}▶${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1" >&2; }
fatal() { err "$1"; exit 1; }

# ── Constants ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="Hive"
INSTALL_DIR="/Applications"

# ── Detect architecture ──────────────────────────────────────────
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  BUILD_DIR="$PROJECT_DIR/dist/mac-arm64"
else
  BUILD_DIR="$PROJECT_DIR/dist/mac"
fi

info "Architecture: $ARCH"
info "Build output: $BUILD_DIR"

# ── Build ─────────────────────────────────────────────────────────
info "Building $APP_NAME (unsigned)..."
cd "$PROJECT_DIR"
pnpm run build:mac:unsigned
ok "Build complete"

# ── Verify build output ──────────────────────────────────────────
APP_PATH="$BUILD_DIR/$APP_NAME.app"
if [[ ! -d "$APP_PATH" ]]; then
  fatal "Build output not found at $APP_PATH"
fi

# ── Prompt before quitting Hive ──────────────────────────────────
if pgrep -x "$APP_NAME" > /dev/null 2>&1; then
  echo ""
  warn "$APP_NAME is running. Press Enter to quit, install and relaunch."
  CMUX_BIN="$(command -v cmux || true)"
  if [[ -z "$CMUX_BIN" && -x "/Applications/cmux.app/Contents/Resources/bin/cmux" ]]; then
    CMUX_BIN="/Applications/cmux.app/Contents/Resources/bin/cmux"
  fi
  if [[ -n "$CMUX_BIN" ]]; then
    "$CMUX_BIN" notify --title "$APP_NAME install" --body "Build finished — waiting for you to close $APP_NAME" 2>/dev/null || true
  fi
  read -r
  info "Quitting $APP_NAME..."
  osascript -e "quit app \"$APP_NAME\"" 2>/dev/null || true
  sleep 2
  if pgrep -x "$APP_NAME" > /dev/null 2>&1; then
    pkill -x "$APP_NAME" 2>/dev/null || true
    sleep 1
  fi
  ok "$APP_NAME quit"
fi

# ── Install ───────────────────────────────────────────────────────
info "Installing to $INSTALL_DIR/$APP_NAME.app..."
rm -rf "$INSTALL_DIR/$APP_NAME.app"
cp -R "$APP_PATH" "$INSTALL_DIR/$APP_NAME.app"
ok "Installed to $INSTALL_DIR/$APP_NAME.app"

# ── Launch ────────────────────────────────────────────────────────
info "Launching $APP_NAME..."
open "$INSTALL_DIR/$APP_NAME.app"
ok "Done!"
