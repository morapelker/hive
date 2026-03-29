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

# ── Parse flags ───────────────────────────────────────────────────
DRY_RUN=false
SHUTDOWN_AFTER=false
SLEEP_AFTER=false
AUTO_YES=false
SUDO_KEEPALIVE_PID=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes) AUTO_YES=true ;;
    --dry-run) DRY_RUN=true ;;
    --shutdown) SHUTDOWN_AFTER=true ;;
    --sleep) SLEEP_AFTER=true ;;
    *) fatal "Unknown argument: $arg" ;;
  esac
done

if $SHUTDOWN_AFTER && $SLEEP_AFTER; then
  fatal "Cannot combine --shutdown and --sleep"
fi

if $DRY_RUN && $SHUTDOWN_AFTER; then
  fatal "Cannot combine --dry-run and --shutdown"
fi

if $DRY_RUN && $SLEEP_AFTER; then
  fatal "Cannot combine --dry-run and --sleep"
fi

if $AUTO_YES; then
  warn "Auto-accepting all prompts (-y)"
fi

if $DRY_RUN; then
  warn "DRY RUN — no git push, no publish, no homebrew update"
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
HOMEBREW_CASK="Casks/hive-canary.rb"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Phase 1: Preflight ───────────────────────────────────────────
info "Running preflight checks..."

cd "$PROJECT_DIR"

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

# NO branch restriction — canary can be released from any branch
CURRENT_BRANCH=$(git branch --show-current)
info "Current branch: ${YELLOW}${CURRENT_BRANCH}${NC}"

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

# Compute next canary version
# Strip any existing prerelease suffix to get base version
BASE_VERSION=$(node -p "require('./package.json').version.replace(/-.*/, '')")

# Find the highest canary number for this base version
LATEST_CANARY=$(git tag -l "v${BASE_VERSION}-canary.*" | \
  sed "s/v${BASE_VERSION}-canary\.//" | \
  sort -n | tail -1)
CANARY_NUM=$(( ${LATEST_CANARY:-0} + 1 ))
NEW_VERSION="${BASE_VERSION}-canary.${CANARY_NUM}"
SHORT_SHA=$(git rev-parse --short HEAD)

# Validate computed versions
if ! [[ "$BASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fatal "Invalid base version: '${BASE_VERSION}'. Expected semver like 1.0.18"
fi
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-canary\.[0-9]+$ ]]; then
  fatal "Invalid canary version: '${NEW_VERSION}'. Expected format like 1.0.18-canary.1"
fi

info "Base version: ${YELLOW}v${BASE_VERSION}${NC}"
info "Next canary:  ${GREEN}v${NEW_VERSION}${NC}"
info "Branch:       ${CYAN}${CURRENT_BRANCH}${NC} (${SHORT_SHA})"

# ── Generate release notes from merged PRs ───────────────────────
info "Generating release notes from merged PRs..."

# Use the most recent canary tag if one exists, otherwise fall back to the stable tag
PREV_CANARY_TAG=$(git tag -l "v${BASE_VERSION}-canary.*" | sort -t. -k4 -n | tail -1)
if [[ -n "$PREV_CANARY_TAG" ]]; then
  REFERENCE_TAG="$PREV_CANARY_TAG"
  info "Using previous canary tag as reference: ${YELLOW}${REFERENCE_TAG}${NC}"
else
  REFERENCE_TAG="v${BASE_VERSION}"
  info "No previous canary tags found, using stable tag: ${YELLOW}${REFERENCE_TAG}${NC}"
fi

LAST_TAG_DATE=$(TZ=UTC0 git log -1 --format='%ad' --date=format-local:'%Y-%m-%dT%H:%M:%SZ' "$REFERENCE_TAG" 2>/dev/null || echo "")

if [[ -z "$LAST_TAG_DATE" ]]; then
  warn "Could not find tag ${REFERENCE_TAG}. Skipping PR-based release notes."
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
  # Prepend canary header
  RELEASE_NOTES="**Canary build** from branch \`${CURRENT_BRANCH}\` (${SHORT_SHA})

${RELEASE_NOTES}"
  ok "Found release notes from PRs"
  echo ""
  echo -e "${CYAN}── Release notes preview ──────────────────────────${NC}"
  echo "$RELEASE_NOTES"
  echo -e "${CYAN}───────────────────────────────────────────────────${NC}"
  echo ""
  if ! $AUTO_YES; then
    read -rp "Edit release notes in \$EDITOR before publishing? [y/N] " edit_notes
    if [[ "$edit_notes" =~ ^[Yy]$ ]]; then
      NOTES_TMPFILE=$(mktemp "${TMPDIR:-/tmp}/hive-canary-release-notes.XXXXXX")
      echo "$RELEASE_NOTES" > "$NOTES_TMPFILE"
      ${EDITOR:-vim} "$NOTES_TMPFILE"
      RELEASE_NOTES=$(cat "$NOTES_TMPFILE")
      rm -f "$NOTES_TMPFILE"
      ok "Release notes updated"
    fi
  fi
else
  RELEASE_NOTES="Canary build from branch ${CURRENT_BRANCH} (${SHORT_SHA})"
  warn "No merged PRs found since ${REFERENCE_TAG}. Using default canary notes."
fi

# Confirm
echo ""
info "This will:"
echo "  1. Bump package.json to ${NEW_VERSION}"
echo "  2. Commit, tag v${NEW_VERSION}, and push to origin"
echo "  3. Build macOS for arm64 + x64 (sign + notarize)"
echo "  4. Build Windows x64 (NSIS installer + ZIP)"
echo "  5. Publish all artifacts to GitHub Release v${NEW_VERSION} (prerelease)"
echo "  6. Update Homebrew canary cask with new SHA256 checksums"
echo ""
if ! $AUTO_YES; then
  read -rp "Proceed? [Y/n] " confirm
  [[ "$confirm" =~ ^[Nn]$ ]] && { info "Aborted."; exit 0; }
fi

# Arm EXIT trap AFTER user confirmation (so aborting doesn't trigger shutdown/notification)
RELEASE_SUCCEEDED=false
PHASE2_STARTED=false

rollback() {
  warn "Rolling back failed canary release v${NEW_VERSION}..."

  # 0. If in detached HEAD (building from tag), return to the working branch
  CURRENT_HEAD=$(git branch --show-current)
  if [[ -z "$CURRENT_HEAD" ]]; then
    git checkout "$CURRENT_BRANCH" \
      && ok "Returned to branch ${CURRENT_BRANCH} from detached HEAD" \
      || warn "Failed to checkout ${CURRENT_BRANCH}"
  fi

  # 1. Delete local tag
  if git tag -l "v${NEW_VERSION}" | grep -q .; then
    git tag -d "v${NEW_VERSION}" && ok "Deleted local tag v${NEW_VERSION}" || true
  fi

  # 2. Delete remote tag
  if ! $DRY_RUN; then
    git push origin ":refs/tags/v${NEW_VERSION}" 2>/dev/null \
      && ok "Deleted remote tag v${NEW_VERSION}" || true
  fi

  # 3. Delete GitHub release if electron-builder created one
  if ! $DRY_RUN; then
    gh release delete "v${NEW_VERSION}" --repo "$REPO" --yes 2>/dev/null \
      && ok "Deleted GitHub release v${NEW_VERSION}" || true
  fi

  # 4. Revert package.json version if needed
  CURRENT_PKG_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
  if [[ "$CURRENT_PKG_VERSION" == "$NEW_VERSION" ]]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      pkg.version = '${BASE_VERSION}';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
    git add package.json
    git commit -m "rollback: revert version bump for failed canary v${NEW_VERSION} release"
    if ! $DRY_RUN; then
      git push origin "$CURRENT_BRANCH" \
        && ok "Reverted package.json to ${BASE_VERSION} and pushed" \
        || warn "Failed to push rollback commit"
    else
      ok "Reverted package.json to ${BASE_VERSION} (dry run, not pushed)"
    fi
  else
    ok "package.json already at ${CURRENT_PKG_VERSION}, no revert needed"
  fi

  ok "Rollback complete"
  tg "🔄 Hive canary v${NEW_VERSION} — rolled back"
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
      tg "❌ Hive canary v${NEW_VERSION} — release failed (pre-phase-2, no rollback needed)"
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

tg "🚀 Hive canary v${NEW_VERSION} — starting release"

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
git commit -m "canary: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
ok "Tagged v${NEW_VERSION}"

if $DRY_RUN; then
  warn "[DRY RUN] Skipping git push"
else
  info "Pushing to origin..."
  git push origin "$CURRENT_BRANCH"
  git push origin "v${NEW_VERSION}"
  ok "Pushed commit and tag"
fi

# Restore base version in package.json for continued development
info "Restoring base version for development..."
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '${BASE_VERSION}';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
git add package.json
git commit -m "chore: restore version to ${BASE_VERSION} after canary release"

if $DRY_RUN; then
  warn "[DRY RUN] Skipping restore commit push"
else
  git push origin "$CURRENT_BRANCH"
  ok "Restored package.json to ${BASE_VERSION}"
fi

# ── Phase 3: Build ────────────────────────────────────────────────
tg "🔨 Hive canary v${NEW_VERSION} — building"
# Build from the tagged commit
info "Checking out tagged commit for build..."
git checkout "v${NEW_VERSION}"

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
tg "📦 Hive canary v${NEW_VERSION} — build complete, packaging & notarizing"
info "Packaging, signing, notarizing, and publishing..."
info "This will take several minutes (notarization is slow)."

export GH_TOKEN
GH_TOKEN=$(gh auth token)

WIN_BUILD_OK=false
if $DRY_RUN; then
  warn "[DRY RUN] Skipping electron-builder publish"
  warn "[DRY RUN] Would run: pnpm exec electron-builder --mac --publish always -c.publish.channel=canary"
  warn "[DRY RUN] Would run: pnpm exec electron-builder --win --publish always -c.publish.channel=canary"
else
  pnpm exec electron-builder --mac --publish always -c.publish.channel=canary
  ok "macOS assets uploaded to GitHub Releases"

  # ── Phase 4.5: Windows build ──────────────────────────────────────
  # Windows build is non-fatal — macOS artifacts are already published.
  tg "🪟 Hive canary v${NEW_VERSION} — building Windows"
  if bash "$SCRIPT_DIR/prepare-win-deps.sh"; then
    info "Packaging Windows canary build..."
    info "This may take a few minutes."
    # --config.npmRebuild=false: skip native module rebuild (we prepared Windows binaries manually)
    if pnpm exec electron-builder --win --publish always -c.publish.channel=canary --config.npmRebuild=false; then
      WIN_BUILD_OK=true
      ok "Windows assets uploaded to GitHub Releases"
    else
      warn "Windows build failed — macOS canary release will continue without Windows artifacts"
      tg "⚠️ Hive canary v${NEW_VERSION} — Windows build failed"
    fi
  else
    warn "Windows dependency preparation failed — skipping Windows build"
    tg "⚠️ Hive canary v${NEW_VERSION} — Windows deps preparation failed"
  fi

  # Always restore macOS native binaries so the working tree stays usable for development
  bash "$SCRIPT_DIR/prepare-win-deps.sh" --restore 2>/dev/null || true

  # Mark as prerelease and attach notes
  info "Publishing release as prerelease..."
  gh release edit "v${NEW_VERSION}" --repo "$REPO" --prerelease --draft=false --notes "$RELEASE_NOTES"
  ok "Release published as prerelease"
fi

info "Release URL: https://github.com/${REPO}/releases/tag/v${NEW_VERSION}"

# Return to the working branch
info "Returning to branch ${CURRENT_BRANCH}..."
git checkout "$CURRENT_BRANCH"

# ── Phase 5: Update Homebrew canary cask ──────────────────────────
if $DRY_RUN; then
  warn "[DRY RUN] Skipping Homebrew cask update"
else
  info "Updating Homebrew canary cask..."

  if [[ ! -d "$HOMEBREW_REPO/.git" ]]; then
    fatal "Homebrew repo not found at $HOMEBREW_REPO"
  fi

  CASK_FILE="$HOMEBREW_REPO/$HOMEBREW_CASK"
  if [[ ! -f "$CASK_FILE" ]]; then
    fatal "Cask file not found: $CASK_FILE. Create it first (see CANARY_SUPPORT.md)."
  fi

  # Compute SHA256 from local build artifacts
  DIST_DIR="$PROJECT_DIR/dist"
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
  git commit -m "Update Hive Canary to v${NEW_VERSION}"
  git push origin main
  cd "$PROJECT_DIR"

  ok "Homebrew repo pushed"
fi

# ── Phase 6: Summary ─────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Canary release v${NEW_VERSION} complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo "  GitHub Release: https://github.com/${REPO}/releases/tag/v${NEW_VERSION}"
echo "  Homebrew:       brew install --cask morapelker/hive/hive-canary"
echo ""
echo "  Assets published:"
echo "    macOS:"
echo "      - Hive-${NEW_VERSION}-arm64.dmg  (Apple Silicon)"
echo "      - Hive-${NEW_VERSION}.dmg        (Intel)"
echo "      - Hive-${NEW_VERSION}-arm64-mac.zip"
echo "      - Hive-${NEW_VERSION}-mac.zip"
echo "      - canary-mac.yml (auto-updater)"
if $WIN_BUILD_OK; then
  echo "    Windows:"
  echo "      - Hive-Setup-${NEW_VERSION}.exe  (NSIS installer)"
  echo "      - Hive-${NEW_VERSION}-win.zip    (portable)"
  echo "      - canary.yml (auto-updater)"
else
  echo "    Windows: ⚠ build failed (macOS release published without Windows artifacts)"
fi
echo ""
if $DRY_RUN; then
  warn "This was a DRY RUN — nothing was actually published."
fi

RELEASE_SUCCEEDED=true
if $WIN_BUILD_OK; then
  tg "✅ Hive canary v${NEW_VERSION} — released successfully (macOS + Windows)"
else
  tg "✅ Hive canary v${NEW_VERSION} — released (macOS only, Windows build failed)"
fi
