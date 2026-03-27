#!/usr/bin/env bash
set -euo pipefail

# ── prepare-win-deps.sh ─────────────────────────────────────────
# Downloads prebuilt Windows native .node binaries from GitHub
# and swaps them into node_modules/ so electron-builder can
# package a Windows build from macOS.
#
# Usage:
#   bash scripts/prepare-win-deps.sh           # download + swap
#   bash scripts/prepare-win-deps.sh --restore  # restore macOS binaries
# ─────────────────────────────────────────────────────────────────

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

REPO="morapelker/hive"
WIN_NATIVES_TAG="win-natives-v1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CACHE_DIR="$PROJECT_DIR/.win-natives"
BACKUP_DIR="$PROJECT_DIR/.mac-natives-backup"

# ── Restore mode ────────────────────────────────────────────────
if [[ "${1:-}" == "--restore" ]]; then
  info "Restoring macOS native binaries..."

  if [[ ! -d "$BACKUP_DIR" ]]; then
    warn "No backup found at $BACKUP_DIR — nothing to restore"
    exit 0
  fi

  # Restore each backed-up file
  while IFS= read -r -d '' backup_file; do
    relative="${backup_file#$BACKUP_DIR/}"
    target="$PROJECT_DIR/$relative"
    target_dir=$(dirname "$target")
    mkdir -p "$target_dir"
    cp "$backup_file" "$target"
    ok "Restored $relative"
  done < <(find "$BACKUP_DIR" -type f -print0)

  rm -rf "$BACKUP_DIR"
  ok "macOS native binaries restored"
  exit 0
fi

# ── Download mode ───────────────────────────────────────────────
info "Preparing Windows native binaries for cross-build..."

# Download prebuilt binaries (cached)
EXTRACT_DIR="$CACHE_DIR/extracted"

if [[ -d "$EXTRACT_DIR" && -n "$(ls -A "$EXTRACT_DIR" 2>/dev/null)" ]]; then
  ok "Using cached Windows natives ($EXTRACT_DIR)"
else
  info "Downloading Windows native binaries from GitHub..."
  mkdir -p "$CACHE_DIR"
  rm -rf "$EXTRACT_DIR"

  # Download the Actions artifact from the latest successful workflow run
  gh run download \
    --name win-natives \
    --dir "$EXTRACT_DIR" \
    --repo "$REPO" \
    || fatal "Failed to download win-natives artifact. Run the build-win-natives workflow first."
  ok "Downloaded Windows natives"
fi

ls -la "$EXTRACT_DIR"

# ── Swap native binaries ───────────────────────────────────────
info "Swapping macOS → Windows native binaries..."
mkdir -p "$BACKUP_DIR"

swap_native() {
  local win_file="$1"
  local find_pattern="$2"
  local search_dir="$3"

  if [[ ! -f "$EXTRACT_DIR/$win_file" ]]; then
    warn "Windows binary not found: $win_file — skipping"
    return 0
  fi

  # Find the macOS .node file
  local mac_file
  mac_file=$(find "$search_dir" -name "$find_pattern" -type f | head -1)

  if [[ -z "$mac_file" ]]; then
    warn "macOS binary not found: $find_pattern in $search_dir — skipping"
    return 0
  fi

  # Backup macOS binary
  local relative="${mac_file#$PROJECT_DIR/}"
  local backup_path="$BACKUP_DIR/$relative"
  mkdir -p "$(dirname "$backup_path")"
  cp "$mac_file" "$backup_path"

  # Replace with Windows binary
  cp "$EXTRACT_DIR/$win_file" "$mac_file"
  ok "Swapped $relative ($(du -h "$mac_file" | cut -f1))"
}

# better-sqlite3
swap_native "better_sqlite3.node" "better_sqlite3.node" "$PROJECT_DIR/node_modules/better-sqlite3"

# node-pty (could be pty.node or conpty.node on Windows)
if [[ -f "$EXTRACT_DIR/conpty.node" ]]; then
  swap_native "conpty.node" "*.node" "$PROJECT_DIR/node_modules/node-pty"
elif [[ -f "$EXTRACT_DIR/pty.node" ]]; then
  swap_native "pty.node" "*.node" "$PROJECT_DIR/node_modules/node-pty"
fi

# Copy any extra Windows DLLs/EXEs that node-pty might need
for extra in "$EXTRACT_DIR"/*.exe "$EXTRACT_DIR"/*.dll; do
  if [[ -f "$extra" ]]; then
    PTY_BUILD_DIR=$(find "$PROJECT_DIR/node_modules/node-pty" -name "Release" -type d | head -1)
    if [[ -n "$PTY_BUILD_DIR" ]]; then
      cp "$extra" "$PTY_BUILD_DIR/"
      ok "Copied $(basename "$extra") → node-pty build dir"
    fi
  fi
done

echo ""
ok "Windows native binaries are in place"
info "You can now run: pnpm exec electron-builder --win --config.npmRebuild=false"
info "After building, run: bash scripts/prepare-win-deps.sh --restore"
