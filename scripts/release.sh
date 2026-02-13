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
REPO="morapelker/hive"
GHOSTTY_DEPS_TAG="ghostty-deps-v1"
HOMEBREW_REPO="/Users/mor/Documents/dev/hive-brew"
HOMEBREW_CASK="Casks/hive.rb"
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

# Check we're on main
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  warn "You are on branch '$CURRENT_BRANCH', not 'main'."
  read -rp "Continue anyway? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || exit 1
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

# Read current version and suggest next patch
CURRENT_VERSION=$(node -p "require('./package.json').version")
SUGGESTED_VERSION=$(node -p "
  const [major, minor, patch] = '${CURRENT_VERSION}'.split('.').map(Number);
  \`\${major}.\${minor}.\${patch + 1}\`
" 2>/dev/null || echo "")
info "Current version: ${YELLOW}v${CURRENT_VERSION}${NC}"

# Prompt for new version with suggested default
if [[ -n "$SUGGESTED_VERSION" ]]; then
  read -rp "Enter new version [${SUGGESTED_VERSION}]: " NEW_VERSION
  NEW_VERSION="${NEW_VERSION:-$SUGGESTED_VERSION}"
else
  read -rp "Enter new version (without 'v' prefix): " NEW_VERSION
fi
if [[ -z "$NEW_VERSION" ]]; then
  fatal "No version provided."
fi
if [[ "$NEW_VERSION" == "$CURRENT_VERSION" ]]; then
  fatal "New version is the same as current version."
fi

# Confirm
echo ""
info "Will release: ${YELLOW}v${CURRENT_VERSION}${NC} → ${GREEN}v${NEW_VERSION}${NC}"
info "This will:"
echo "  1. Bump package.json to ${NEW_VERSION}"
echo "  2. Commit, tag v${NEW_VERSION}, and push to origin"
echo "  3. Build for arm64 + x64 (sign + notarize)"
echo "  4. Publish DMGs/ZIPs to GitHub Release v${NEW_VERSION}"
echo "  5. Update Homebrew cask with new SHA256 checksums"
echo "  6. Push Homebrew repo"
echo ""
read -rp "Proceed? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }

# ── Phase 2: Version bump + git ──────────────────────────────────
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

# ── Phase 4: Package + Sign + Notarize + Publish ─────────────────
info "Packaging, signing, notarizing, and publishing..."
info "This will take several minutes (notarization is slow)."

export GH_TOKEN
GH_TOKEN=$(gh auth token)

pnpm exec electron-builder --mac --publish always

ok "Published to GitHub Releases"
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

# Wait for release assets to be available
info "Waiting for release assets to be available..."
DMG_ARM="Hive-${NEW_VERSION}-arm64.dmg"
DMG_X64="Hive-${NEW_VERSION}.dmg"

MAX_ATTEMPTS=30
ATTEMPT=0
while true; do
  ASSETS=$(gh release view "v${NEW_VERSION}" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null || true)
  if echo "$ASSETS" | grep -q "$DMG_ARM" && echo "$ASSETS" | grep -q "$DMG_X64"; then
    ok "Both DMGs are available"
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  if [[ $ATTEMPT -ge $MAX_ATTEMPTS ]]; then
    fatal "Timed out waiting for release assets after $((MAX_ATTEMPTS * 10))s"
  fi
  info "Assets not ready yet, waiting 10s... (attempt $ATTEMPT/$MAX_ATTEMPTS)"
  sleep 10
done

# Download DMGs to temp directory
TMPDIR_RELEASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_RELEASE"' EXIT

info "Downloading DMGs for checksum..."
gh release download "v${NEW_VERSION}" \
  --repo "$REPO" \
  --pattern "*.dmg" \
  --dir "$TMPDIR_RELEASE"

# Compute SHA256
SHA_ARM=$(shasum -a 256 "$TMPDIR_RELEASE/$DMG_ARM" | awk '{print $1}')
SHA_X64=$(shasum -a 256 "$TMPDIR_RELEASE/$DMG_X64" | awk '{print $1}')

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
echo "    • Hive-${NEW_VERSION}-arm64.dmg  (Apple Silicon)"
echo "    • Hive-${NEW_VERSION}.dmg        (Intel)"
echo "    • Hive-${NEW_VERSION}-arm64-mac.zip"
echo "    • Hive-${NEW_VERSION}-mac.zip"
echo "    • latest-mac.yml (auto-updater)"
echo ""
