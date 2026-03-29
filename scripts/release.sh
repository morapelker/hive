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

# ── Parse flags ──────────────────────────────────────────────────
SHUTDOWN_AFTER=false
SLEEP_AFTER=false
AUTO_YES=false
SUDO_KEEPALIVE_PID=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes) AUTO_YES=true ;;
    --shutdown) SHUTDOWN_AFTER=true ;;
    --sleep) SLEEP_AFTER=true ;;
    *) fatal "Unknown argument: $arg" ;;
  esac
done

if $SHUTDOWN_AFTER && $SLEEP_AFTER; then
  fatal "Cannot combine --shutdown and --sleep"
fi

if $AUTO_YES; then
  warn "Auto-accepting all prompts (-y)"
fi

if $SHUTDOWN_AFTER; then
  warn "Computer will shut down after release completes"
fi

if $SLEEP_AFTER; then
  warn "Computer will sleep after release completes"
fi

# ── Constants ─────────────────────────────────────────────────────
REPO="morapelker/hive"
GHOSTTY_DEPS_TAG="ghostty-deps-v1"
HOMEBREW_REPO="${HOMEBREW_REPO:-$HOME/Documents/dev/hive-brew}"
HOMEBREW_CASK="Casks/hive.rb"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Phase 1: Preflight ───────────────────────────────────────────
info "Running preflight checks..."

cd "$PROJECT_DIR"
DIST_DIR="$PROJECT_DIR/dist"

# Check gh CLI is authenticated
gh auth status &>/dev/null || fatal "gh CLI is not authenticated. Run 'gh auth login' first."
ok "gh CLI authenticated"

# Check clean working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
  fatal "Working tree has uncommitted changes. Commit or stash them first."
fi
ok "Clean working tree"

# Pull latest from remote
info "Pulling latest changes..."
git pull || fatal "git pull failed"
ok "Up to date with remote"

# Check we're on main
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  warn "You are on branch '$CURRENT_BRANCH', not 'main'."
  if ! $AUTO_YES; then
    read -rp "Continue anyway? [Y/n] " confirm
    [[ "$confirm" =~ ^[Nn]$ ]] && exit 1
  fi
fi

# Check .env.signing exists
ENV_SIGNING="$PROJECT_DIR/.env.signing"
if [[ ! -f "$ENV_SIGNING" ]]; then
  fatal ".env.signing not found. Copy .env.signing.example and fill in your credentials."
fi
source "$ENV_SIGNING"

# Validate required env vars
[[ -n "${APPLE_ID:-}" ]]                     || fatal "APPLE_ID not set in .env.signing"
[[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]  || fatal "APPLE_APP_SPECIFIC_PASSWORD not set in .env.signing"
[[ -n "${APPLE_TEAM_ID:-}" ]]                || fatal "APPLE_TEAM_ID not set in .env.signing"
ok "Signing credentials loaded"

# Load .env for Telegram notifications (optional)
if [[ -f "$PROJECT_DIR/.env" ]]; then
  source "$PROJECT_DIR/.env"
fi

tg() {
  if [[ -n "${MORIKO_TELEGRAM_BOT_TOKEN:-}" && -n "${MORIKO_TELEGRAM_OPERATOR_CHAT_ID:-}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${MORIKO_TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${MORIKO_TELEGRAM_OPERATOR_CHAT_ID}" \
      -d text="$1" > /dev/null 2>&1 || true
  fi
}

# Acquire sudo + prevent macOS sleep when --shutdown or --sleep is used
if $SHUTDOWN_AFTER || $SLEEP_AFTER; then
  info "Acquiring sudo credentials (needed to prevent sleep)..."
  sudo -v || fatal "Failed to acquire sudo credentials"
  # Keep sudo credentials alive in background for the duration of the build
  (while true; do sudo -n true; sleep 50; kill -0 "$$" 2>/dev/null || exit; done) &
  SUDO_KEEPALIVE_PID=$!
  sudo pmset -a disablesleep 1
  ok "System sleep disabled (safe to close lid)"
  # Restore sleep on early exit (before on_exit trap is armed)
  trap 'sudo pmset -a disablesleep 0; kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true' EXIT
fi

# Read current version and suggest next patch
CURRENT_VERSION=$(node -p "require('./package.json').version")
SUGGESTED_VERSION=$(node -p "
  const [major, minor, patch] = '${CURRENT_VERSION}'.split('.').map(Number);
  \`\${major}.\${minor}.\${patch + 1}\`
" 2>/dev/null || echo "")
info "Current version: ${YELLOW}v${CURRENT_VERSION}${NC}"

# Prompt for new version with suggested default
if $AUTO_YES; then
  if [[ -n "$SUGGESTED_VERSION" ]]; then
    NEW_VERSION="$SUGGESTED_VERSION"
    ok "Auto-accepting version: ${NEW_VERSION}"
  else
    fatal "Cannot auto-accept version: no suggested version available"
  fi
elif [[ -n "$SUGGESTED_VERSION" ]]; then
  read -rp "Enter new version number (without 'v' prefix) [${SUGGESTED_VERSION}]: " NEW_VERSION
  NEW_VERSION="${NEW_VERSION:-$SUGGESTED_VERSION}"
else
  read -rp "Enter new version number (without 'v' prefix, e.g. 1.0.18): " NEW_VERSION
fi
if [[ -z "$NEW_VERSION" ]]; then
  fatal "No version provided."
fi
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fatal "Invalid version format: '${NEW_VERSION}'. Expected semver like 1.0.18"
fi
if [[ "$NEW_VERSION" == "$CURRENT_VERSION" ]]; then
  fatal "New version is the same as current version."
fi

# ── Generate release notes from merged PRs ───────────────────────
info "Generating release notes from merged PRs..."

LAST_TAG_DATE=$(TZ=UTC0 git log -1 --format='%ad' --date=format-local:'%Y-%m-%dT%H:%M:%SZ' "v${CURRENT_VERSION}" 2>/dev/null || echo "")

if [[ -z "$LAST_TAG_DATE" ]]; then
  warn "Could not find tag v${CURRENT_VERSION}. Skipping PR-based release notes."
  RELEASE_NOTES=""
else
  RELEASE_NOTES=$(gh pr list --repo "$REPO" --state merged --limit 50 \
    --json number,title,body,mergedAt,author \
    --jq "[.[] | select(.mergedAt > \"${LAST_TAG_DATE}\")]" | node -e "
const prs = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'))
if (!prs.length) {
  process.exit(0)
}

const lines = ['## What\\'s Changed', '']
for (const pr of prs) {
  lines.push('### ' + pr.title + ' (#' + pr.number + ')')
  const body = pr.body || ''
  // Extract the Summary section if present
  const summaryMatch = body.match(/## Summary\\s*\\n([\\s\\S]*?)(?=\\n## |$)/)
  if (summaryMatch) {
    lines.push(summaryMatch[1].trim())
  } else if (body.trim()) {
    // No Summary heading — use the full body, capped at 500 chars
    const trimmed = body.trim()
    lines.push(trimmed.length > 500 ? trimmed.slice(0, 500) + '...' : trimmed)
  }
  lines.push('')
}
console.log(lines.join('\\n'))
" 2>/dev/null || echo "")
fi

if [[ -n "$RELEASE_NOTES" ]]; then
  ok "Found release notes from PRs"
  echo ""
  echo -e "${CYAN}── Release notes preview ──────────────────────────${NC}"
  echo "$RELEASE_NOTES"
  echo -e "${CYAN}───────────────────────────────────────────────────${NC}"
  echo ""
  if ! $AUTO_YES; then
    read -rp "Edit release notes in \$EDITOR before publishing? [y/N] " edit_notes
    if [[ "$edit_notes" =~ ^[Yy]$ ]]; then
      NOTES_TMPFILE=$(mktemp "${TMPDIR:-/tmp}/hive-release-notes.XXXXXX")
      echo "$RELEASE_NOTES" > "$NOTES_TMPFILE"
      ${EDITOR:-vim} "$NOTES_TMPFILE"
      RELEASE_NOTES=$(cat "$NOTES_TMPFILE")
      rm -f "$NOTES_TMPFILE"
      ok "Release notes updated"
    fi
  fi
else
  warn "No merged PRs found since v${CURRENT_VERSION}. Release will have no notes."
fi

# Confirm
echo ""
info "Will release: ${YELLOW}v${CURRENT_VERSION}${NC} → ${GREEN}v${NEW_VERSION}${NC}"
info "This will:"
echo "  1. Bump package.json to ${NEW_VERSION}"
echo "  2. Commit, tag v${NEW_VERSION}, and push to origin"
echo "  3. Build macOS for arm64 + x64 (sign + notarize)"
echo "  4. Build Windows x64 (NSIS installer + ZIP)"
echo "  5. Publish all artifacts to GitHub Release v${NEW_VERSION}"
echo "  6. Update Homebrew cask with new SHA256 checksums"
echo "  7. Push Homebrew repo"
echo ""
if ! $AUTO_YES; then
  read -rp "Proceed? [Y/n] " confirm
  [[ "$confirm" =~ ^[Nn]$ ]] && { info "Aborted."; exit 0; }
fi

# Arm EXIT trap AFTER user confirmation (so aborting doesn't trigger shutdown/notification)
RELEASE_SUCCEEDED=false
PHASE2_STARTED=false

rollback() {
  warn "Rolling back failed release v${NEW_VERSION}..."

  # 1. Delete local tag
  if git tag -l "v${NEW_VERSION}" | grep -q .; then
    git tag -d "v${NEW_VERSION}" && ok "Deleted local tag v${NEW_VERSION}" || true
  fi

  # 2. Delete remote tag
  git push origin ":refs/tags/v${NEW_VERSION}" 2>/dev/null \
    && ok "Deleted remote tag v${NEW_VERSION}" || true

  # 3. Delete GitHub release if electron-builder created one
  gh release delete "v${NEW_VERSION}" --repo "$REPO" --yes 2>/dev/null \
    && ok "Deleted GitHub release v${NEW_VERSION}" || true

  # 4. Revert package.json version if it was bumped
  CURRENT_PKG_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
  if [[ "$CURRENT_PKG_VERSION" == "$NEW_VERSION" ]]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      pkg.version = '${CURRENT_VERSION}';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
    git add package.json
    git commit -m "rollback: revert version bump for failed v${NEW_VERSION} release"
    git push origin "$CURRENT_BRANCH" \
      && ok "Reverted package.json to ${CURRENT_VERSION} and pushed" \
      || warn "Failed to push rollback commit"
  else
    ok "package.json already at ${CURRENT_PKG_VERSION}, no revert needed"
  fi

  ok "Rollback complete"
  tg "🔄 Hive release v${NEW_VERSION} — rolled back"
}

on_exit() {
  # Re-enable system sleep if we disabled it
  if $SHUTDOWN_AFTER || $SLEEP_AFTER; then
    sudo pmset -a disablesleep 0 && ok "System sleep re-enabled" || true
    kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
  fi
  if ! $RELEASE_SUCCEEDED; then
    if $PHASE2_STARTED; then
      rollback
    else
      tg "❌ Hive release v${NEW_VERSION} — release failed (pre-phase-2, no rollback needed)"
    fi
  fi
  if $SHUTDOWN_AFTER; then
    warn "Shutting down in 10 seconds... (Ctrl+C to cancel)"
    sleep 10
    sudo shutdown -h now
  elif $SLEEP_AFTER; then
    warn "Sleeping in 10 seconds... (Ctrl+C to cancel)"
    sleep 10
    pmset sleepnow
  fi
}
trap on_exit EXIT

tg "🚀 Hive release v${NEW_VERSION} — starting release"

# ── Phase 2: Version bump + git ──────────────────────────────────
PHASE2_STARTED=true
info "Bumping version to ${NEW_VERSION}..."

node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '${NEW_VERSION}';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
ok "package.json updated"

git add package.json
git commit -m "release: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
ok "Tagged v${NEW_VERSION}"

info "Pushing to origin..."
git push origin "$CURRENT_BRANCH"
git push origin "v${NEW_VERSION}"
ok "Pushed commit and tag"

# ── Phase 3: Build ────────────────────────────────────────────────
tg "🔨 Hive release v${NEW_VERSION} — building"
# Resolve libghostty.a — check local paths first, download as last resort
LOCAL_GHOSTTY="$HOME/Documents/dev/ghostty/macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a"
VENDOR_GHOSTTY="$PROJECT_DIR/vendor/libghostty.a"

if [[ -n "${GHOSTTY_LIB_PATH:-}" && -f "$GHOSTTY_LIB_PATH" ]]; then
  ok "Using libghostty.a from GHOSTTY_LIB_PATH ($GHOSTTY_LIB_PATH)"
elif [[ -f "$LOCAL_GHOSTTY" ]]; then
  export GHOSTTY_LIB_PATH="$LOCAL_GHOSTTY"
  ok "Using local libghostty.a ($LOCAL_GHOSTTY)"
elif [[ -f "$VENDOR_GHOSTTY" ]]; then
  export GHOSTTY_LIB_PATH="$VENDOR_GHOSTTY"
  ok "Using cached libghostty.a (vendor/)"
else
  info "Downloading libghostty.a (not found locally)..."
  mkdir -p "$PROJECT_DIR/vendor"
  gh release download "$GHOSTTY_DEPS_TAG" -p "libghostty.a" -D "$PROJECT_DIR/vendor/" --repo "$REPO"
  export GHOSTTY_LIB_PATH="$VENDOR_GHOSTTY"
  ok "Downloaded libghostty.a ($(du -h "$VENDOR_GHOSTTY" | cut -f1))"
fi

info "Installing dependencies..."
pnpm install --frozen-lockfile
ok "Dependencies installed"

info "Building native addon..."
pnpm build:native
ok "ghostty.node built"

info "Building Electron app..."
pnpm build
ok "Electron build complete"

info "Building web UI for headless mode..."
pnpm build:web
cp -r dist/web out/web
ok "Web UI built and staged for packaging"

# ── Phase 4: Package + Sign + Notarize + Publish ─────────────────
tg "📦 Hive release v${NEW_VERSION} — build complete, packaging & notarizing"
info "Packaging, signing, notarizing, and publishing..."
info "This will take several minutes (notarization is slow)."

export GH_TOKEN
GH_TOKEN=$(gh auth token)

pnpm exec electron-builder --mac --publish always

ok "Assets uploaded to GitHub Releases"

# Also publish canary-mac.yml so canary-channel users see this stable release
cp "$DIST_DIR/latest-mac.yml" "$DIST_DIR/canary-mac.yml"
gh release upload "v${NEW_VERSION}" "$DIST_DIR/canary-mac.yml" --repo "$REPO" --clobber
ok "canary-mac.yml published (canary users will see this stable release)"

# ── Phase 4.5: Windows build ──────────────────────────────────────
# Windows build is non-fatal — macOS artifacts are already published.
# If this fails, we warn but continue with the release.
WIN_BUILD_OK=false
tg "🪟 Hive release v${NEW_VERSION} — building Windows"
if bash "$SCRIPT_DIR/prepare-win-deps.sh"; then
  info "Packaging Windows build..."
  info "This may take a few minutes."
  # --config.npmRebuild=false: skip native module rebuild (we prepared Windows binaries manually)
  if pnpm exec electron-builder --win --publish always --config.npmRebuild=false; then
    WIN_BUILD_OK=true
    ok "Windows assets uploaded to GitHub Releases"

    # Also publish canary.yml (Windows) so canary-channel users see this stable release
    if [[ -f "$DIST_DIR/latest.yml" ]]; then
      cp "$DIST_DIR/latest.yml" "$DIST_DIR/canary.yml"
      gh release upload "v${NEW_VERSION}" "$DIST_DIR/canary.yml" --repo "$REPO" --clobber
      ok "canary.yml (Windows) published"
    fi
  else
    warn "Windows build failed — macOS release will continue without Windows artifacts"
    tg "⚠️ Hive release v${NEW_VERSION} — Windows build failed"
  fi
else
  warn "Windows dependency preparation failed — skipping Windows build"
  tg "⚠️ Hive release v${NEW_VERSION} — Windows deps preparation failed"
fi

# Always restore macOS native binaries so the working tree stays usable for development
bash "$SCRIPT_DIR/prepare-win-deps.sh" --restore 2>/dev/null || true

# ── Phase 4.6: Linux build ───────────────────────────────────────
# Linux build is non-fatal — macOS artifacts are already published.
# If this fails, we warn but continue with the release.
LINUX_BUILD_OK=false
tg "🐧 Hive release v${NEW_VERSION} — building Linux"
if bash "$SCRIPT_DIR/prepare-linux-deps.sh"; then
  info "Packaging Linux build..."
  info "This may take a few minutes."
  # --config.npmRebuild=false: skip native module rebuild (we prepared Linux binaries manually)
  if pnpm exec electron-builder --linux --publish always --config.npmRebuild=false; then
    LINUX_BUILD_OK=true
    ok "Linux assets uploaded to GitHub Releases"

    # Also publish canary-linux.yml so canary-channel users see this stable release
    if [[ -f "$DIST_DIR/latest-linux.yml" ]]; then
      cp "$DIST_DIR/latest-linux.yml" "$DIST_DIR/canary-linux.yml"
      gh release upload "v${NEW_VERSION}" "$DIST_DIR/canary-linux.yml" --repo "$REPO" --clobber
      ok "canary-linux.yml published"
    fi
  else
    warn "Linux build failed — release will continue without Linux artifacts"
    tg "⚠️ Hive release v${NEW_VERSION} — Linux build failed"
  fi
else
  warn "Linux dependency preparation failed — skipping Linux build"
  tg "⚠️ Hive release v${NEW_VERSION} — Linux deps preparation failed"
fi

# Always restore macOS native binaries after Linux build
bash "$SCRIPT_DIR/prepare-linux-deps.sh" --restore 2>/dev/null || true

# Un-draft the release and attach release notes
info "Publishing release (removing draft status)..."
if [[ -n "$RELEASE_NOTES" ]]; then
  gh release edit "v${NEW_VERSION}" --repo "$REPO" --draft=false --notes "$RELEASE_NOTES"
  ok "Release published with PR-based release notes"
else
  gh release edit "v${NEW_VERSION}" --repo "$REPO" --draft=false
  ok "Release published (no release notes)"
fi
info "Release URL: https://github.com/${REPO}/releases/tag/v${NEW_VERSION}"

# ── Phase 5: Update Homebrew cask ─────────────────────────────────
info "Updating Homebrew cask..."

if [[ ! -d "$HOMEBREW_REPO/.git" ]]; then
  fatal "Homebrew repo not found at $HOMEBREW_REPO"
fi

CASK_FILE="$HOMEBREW_REPO/$HOMEBREW_CASK"
if [[ ! -f "$CASK_FILE" ]]; then
  fatal "Cask file not found: $CASK_FILE"
fi

# Compute SHA256 from local build artifacts
DMG_ARM="Hive-${NEW_VERSION}-arm64.dmg"
DMG_X64="Hive-${NEW_VERSION}.dmg"

[[ -f "$DIST_DIR/$DMG_ARM" ]] || fatal "Build artifact not found: $DIST_DIR/$DMG_ARM"
[[ -f "$DIST_DIR/$DMG_X64" ]] || fatal "Build artifact not found: $DIST_DIR/$DMG_X64"

SHA_ARM=$(shasum -a 256 "$DIST_DIR/$DMG_ARM" | awk '{print $1}')
SHA_X64=$(shasum -a 256 "$DIST_DIR/$DMG_X64" | awk '{print $1}')

ok "SHA256 (arm64): $SHA_ARM"
ok "SHA256 (x64):   $SHA_X64"

# Update the cask file using node for reliable multi-replacement
node -e "
  const fs = require('fs');
  let cask = fs.readFileSync('$CASK_FILE', 'utf8');

  // Update version
  cask = cask.replace(/version \"[^\"]+\"/, 'version \"${NEW_VERSION}\"');

  // Update sha256 values — arm64 comes first in the file
  let shaIndex = 0;
  cask = cask.replace(/sha256 \"[a-f0-9]+\"/g, (match) => {
    shaIndex++;
    if (shaIndex === 1) return 'sha256 \"${SHA_ARM}\"';
    if (shaIndex === 2) return 'sha256 \"${SHA_X64}\"';
    return match;
  });

  fs.writeFileSync('$CASK_FILE', cask);
"

ok "Cask file updated"

# Commit and push homebrew repo
cd "$HOMEBREW_REPO"
git add "$HOMEBREW_CASK"
git commit -m "Update Hive to v${NEW_VERSION}"
git push origin main
cd "$PROJECT_DIR"

ok "Homebrew repo pushed"

# ── Phase 6: Summary ─────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Release v${NEW_VERSION} complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo "  GitHub Release: https://github.com/${REPO}/releases/tag/v${NEW_VERSION}"
echo "  Homebrew:       brew install --cask morapelker/hive/hive"
echo ""
echo "  Assets published:"
echo "    macOS:"
echo "      • Hive-${NEW_VERSION}-arm64.dmg  (Apple Silicon)"
echo "      • Hive-${NEW_VERSION}.dmg        (Intel)"
echo "      • Hive-${NEW_VERSION}-arm64-mac.zip"
echo "      • Hive-${NEW_VERSION}-mac.zip"
echo "      • latest-mac.yml (auto-updater)"
if $WIN_BUILD_OK; then
  echo "    Windows:"
  echo "      • Hive-Setup-${NEW_VERSION}.exe  (NSIS installer)"
  echo "      • Hive-${NEW_VERSION}-win.zip    (portable)"
  echo "      • latest.yml (auto-updater)"
else
  echo "    Windows: ⚠ build failed (macOS release published without Windows artifacts)"
fi
if $LINUX_BUILD_OK; then
  echo "    Linux:"
  echo "      • Hive-${NEW_VERSION}.AppImage   (AppImage)"
  echo "      • hive_${NEW_VERSION}_amd64.deb  (Debian package)"
  echo "      • hive-${NEW_VERSION}.tar.gz     (portable)"
  echo "      • latest-linux.yml (auto-updater)"
else
  echo "    Linux: ⚠ build failed (release published without Linux artifacts)"
fi
echo ""

RELEASE_SUCCEEDED=true
PLATFORMS="macOS"
if $WIN_BUILD_OK; then PLATFORMS="$PLATFORMS + Windows"; fi
if $LINUX_BUILD_OK; then PLATFORMS="$PLATFORMS + Linux"; fi
tg "✅ Hive release v${NEW_VERSION} — released successfully ($PLATFORMS)"
