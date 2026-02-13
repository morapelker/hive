# Local Release Script Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a single `scripts/release.sh` script that performs a full end-to-end GitHub release from a local Mac — version bump, git tag, build for both architectures, sign + notarize, publish to GitHub Releases, compute SHA256 checksums, update the Homebrew cask, and push the Homebrew repo.

**Architecture:** A single Bash script with clearly separated phases. It sources signing credentials from a `.env.signing` file (gitignored). Uses `gh` CLI for GitHub operations (already authenticated). Uses `electron-builder --mac --publish always` which creates the GitHub release and uploads artifacts in one shot. Then downloads the published DMGs, computes SHA256s, and updates the Homebrew cask via `sed` and `git`.

**Tech Stack:** Bash, `gh` CLI, `electron-builder`, `node-gyp`, `shasum`, `jq`, `sed`

---

## Overview of the Release Pipeline

```
┌──────────────────────────────────────────────────────────────────┐
│  scripts/release.sh                                              │
│                                                                  │
│  Phase 1: Preflight checks                                       │
│    ├─ Verify gh auth, clean working tree, .env.signing exists    │
│    ├─ Show current version, prompt for new version               │
│    └─ Confirm before proceeding                                  │
│                                                                  │
│  Phase 2: Version bump + git                                     │
│    ├─ Update package.json version                                │
│    ├─ git commit -am "release: vX.Y.Z"                           │
│    ├─ git tag vX.Y.Z                                             │
│    └─ git push origin main --tags                                │
│                                                                  │
│  Phase 3: Build                                                  │
│    ├─ Download libghostty.a from GH release (if not cached)      │
│    ├─ pnpm install --frozen-lockfile                             │
│    ├─ pnpm build:native (GHOSTTY_LIB_PATH=...)                  │
│    └─ pnpm build                                                 │
│                                                                  │
│  Phase 4: Package + Sign + Notarize + Publish                    │
│    └─ electron-builder --mac --publish always                    │
│        (signs with local keychain cert, notarizes with Apple ID, │
│         uploads DMGs/ZIPs/blockmap/latest-mac.yml to GH release) │
│                                                                  │
│  Phase 5: Update Homebrew cask                                   │
│    ├─ Download both DMGs from the GH release                     │
│    ├─ Compute SHA256 for arm64 + x64 DMGs                        │
│    ├─ Update version + SHA256s in Casks/hive.rb                  │
│    ├─ git commit + push in the homebrew-hive repo                │
│    └─ Clean up downloaded DMGs                                   │
│                                                                  │
│  Phase 6: Summary                                                │
│    └─ Print release URL, Homebrew install command                │
└──────────────────────────────────────────────────────────────────┘
```

---

## Pre-implementation: Things to Verify

Before writing the script, confirm these are correct (they are based on current analysis):

| Fact                     | Value                                              |
| ------------------------ | -------------------------------------------------- |
| GitHub repo              | `morapelker/hive`                                  |
| Signing identity         | `Developer ID Application: Your Name (XXXXXXXXXX)` |
| Ghostty deps release tag | `ghostty-deps-v1`                                  |
| DMG naming (arm64)       | `Hive-{version}-arm64.dmg`                         |
| DMG naming (x64)         | `Hive-{version}.dmg`                               |
| Homebrew repo local path | `~/Documents/dev/hive-brew`                        |
| Homebrew cask file       | `Casks/hive.rb`                                    |
| Default branch           | `main`                                             |

---

## Task 1: Create `.env.signing.example` and gitignore entry

**Files:**

- Create: `.env.signing.example`
- Modify: `.gitignore`

**Step 1: Add `.env.signing` to `.gitignore`**

Check if `.env.signing` is already in `.gitignore`. If not, append it.

```
# Signing credentials
.env.signing
```

**Step 2: Create the example file**

```bash
# .env.signing.example
# Copy this to .env.signing and fill in your values.
# This file is gitignored — never commit the real one.

# Apple notarization (required for signed releases)
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"

# Code signing (optional — electron-builder auto-discovers from keychain)
# Only set these if you need to override keychain auto-discovery:
# export CSC_LINK="/path/to/cert.p12"
# export CSC_KEY_PASSWORD="password"
```

**Step 3: Commit**

```bash
git add .env.signing.example .gitignore
git commit -m "chore: add .env.signing example for local release signing"
```

---

## Task 2: Create `scripts/release.sh` — Phase 1 (Preflight)

**Files:**

- Create: `scripts/release.sh`

The script header, utility functions, and preflight checks.

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Colors & helpers ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}▶${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1" >&2; }
fatal() { err "$1"; exit 1; }

# ── Constants ─────────────────────────────────────────────────────
REPO="morapelker/hive"
GHOSTTY_DEPS_TAG="ghostty-deps-v1"
HOMEBREW_REPO="$HOME/Documents/dev/hive-brew"
HOMEBREW_CASK="Casks/hive.rb"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Phase 1: Preflight ───────────────────────────────────────────
info "Running preflight checks..."

# Must be in the project root
cd "$PROJECT_DIR"

# Check gh CLI is authenticated
gh auth status &>/dev/null || fatal "gh CLI is not authenticated. Run 'gh auth login' first."
ok "gh CLI authenticated"

# Check clean working tree (allow untracked files)
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
# shellcheck source=/dev/null
source "$ENV_SIGNING"

# Validate required env vars
[[ -n "${APPLE_ID:-}" ]]                     || fatal "APPLE_ID not set in .env.signing"
[[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]  || fatal "APPLE_APP_SPECIFIC_PASSWORD not set in .env.signing"
[[ -n "${APPLE_TEAM_ID:-}" ]]                || fatal "APPLE_TEAM_ID not set in .env.signing"
ok "Signing credentials loaded"

# Read current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
info "Current version: ${YELLOW}v${CURRENT_VERSION}${NC}"

# Prompt for new version
read -rp "Enter new version (without 'v' prefix): " NEW_VERSION
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
```

**Step 2: Make executable and verify syntax**

```bash
chmod +x scripts/release.sh
bash -n scripts/release.sh  # syntax check only
```

**Step 3: Commit**

```bash
git add scripts/release.sh
git commit -m "feat(release): add release script — phase 1 preflight checks"
```

---

## Task 3: Add Phase 2 — Version Bump + Git

Append to `scripts/release.sh`:

```bash
# ── Phase 2: Version bump + git ──────────────────────────────────
info "Bumping version to ${NEW_VERSION}..."

# Use node to update package.json (preserves formatting better than sed)
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
```

**Commit:**

```bash
git add scripts/release.sh
git commit -m "feat(release): add phase 2 — version bump and git tag"
```

---

## Task 4: Add Phase 3 — Build

Append to `scripts/release.sh`:

```bash
# ── Phase 3: Build ────────────────────────────────────────────────
VENDOR_DIR="$PROJECT_DIR/vendor"
GHOSTTY_LIB="$VENDOR_DIR/libghostty.a"

# Download libghostty.a if not already present
if [[ ! -f "$GHOSTTY_LIB" ]]; then
  info "Downloading libghostty.a..."
  mkdir -p "$VENDOR_DIR"
  gh release download "$GHOSTTY_DEPS_TAG" -p "libghostty.a" -D "$VENDOR_DIR/" --repo "$REPO"
  ok "Downloaded libghostty.a ($(du -h "$GHOSTTY_LIB" | cut -f1))"
else
  ok "libghostty.a already present (cached)"
fi

export GHOSTTY_LIB_PATH="$GHOSTTY_LIB"

info "Installing dependencies..."
pnpm install --frozen-lockfile
ok "Dependencies installed"

info "Building native addon..."
pnpm build:native
ok "ghostty.node built"

info "Building Electron app..."
pnpm build
ok "Electron build complete"
```

**Commit:**

```bash
git add scripts/release.sh
git commit -m "feat(release): add phase 3 — build pipeline"
```

---

## Task 5: Add Phase 4 — Package, Sign, Notarize, Publish

Append to `scripts/release.sh`:

```bash
# ── Phase 4: Package + Sign + Notarize + Publish ─────────────────
info "Packaging, signing, notarizing, and publishing..."
info "This will take several minutes (notarization is slow)."

export GH_TOKEN
GH_TOKEN=$(gh auth token)

# electron-builder --publish always:
#   - Creates the GH release if it doesn't exist (from the tag)
#   - Builds DMG + ZIP for each arch
#   - Signs with the keychain cert (auto-discovered)
#   - Notarizes with Apple (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID)
#   - Uploads all artifacts + latest-mac.yml to the GH release
pnpm exec electron-builder --mac --publish always

ok "Published to GitHub Releases"
info "Release URL: https://github.com/${REPO}/releases/tag/v${NEW_VERSION}"
```

**Key design notes:**

- `GH_TOKEN` is obtained from `gh auth token` — no manual token management.
- `electron-builder` auto-discovers the signing cert from the keychain (matching the `mac.identity` or the first `Developer ID Application` cert). No need for `CSC_LINK` locally.
- The `APPLE_*` env vars come from `.env.signing` (already sourced in Phase 1).
- `--publish always` handles creating the release and uploading all artifacts.

**Commit:**

```bash
git add scripts/release.sh
git commit -m "feat(release): add phase 4 — package, sign, notarize, publish"
```

---

## Task 6: Add Phase 5 — Update Homebrew Cask

Append to `scripts/release.sh`:

```bash
# ── Phase 5: Update Homebrew cask ─────────────────────────────────
info "Updating Homebrew cask..."

# Verify homebrew repo exists
if [[ ! -d "$HOMEBREW_REPO/.git" ]]; then
  fatal "Homebrew repo not found at $HOMEBREW_REPO"
fi

CASK_FILE="$HOMEBREW_REPO/$HOMEBREW_CASK"
if [[ ! -f "$CASK_FILE" ]]; then
  fatal "Cask file not found: $CASK_FILE"
fi

# Wait for release assets to be available (notarization can cause delays)
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

# Download DMGs to a temp directory
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

# Update the cask file
# The cask has this structure:
#   version "1.0.4"
#   on_arm do
#     sha256 "..."
#     url "https://github.com/morapelker/hive/releases/download/v#{version}/Hive-#{version}-arm64.dmg"
#   end
#   on_intel do
#     sha256 "..."
#     url "https://github.com/morapelker/hive/releases/download/v#{version}/Hive-#{version}.dmg"
#   end

# We need to:
# 1. Update the version line
# 2. Update the arm64 sha256 (first sha256 in the file)
# 3. Update the x64 sha256 (second sha256 in the file)

# Use a node script for reliable multi-line editing
node -e "
  const fs = require('fs');
  let cask = fs.readFileSync('$CASK_FILE', 'utf8');

  // Update version
  cask = cask.replace(/version \"[^\"]+\"/, 'version \"${NEW_VERSION}\"');

  // Update sha256 values — the arm64 one comes first in the file
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
```

**Commit:**

```bash
git add scripts/release.sh
git commit -m "feat(release): add phase 5 — homebrew cask update"
```

---

## Task 7: Add Phase 6 — Summary + Final Polish

Append the summary to `scripts/release.sh`:

```bash
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
```

Also add `vendor/` to `.gitignore` if not already there (the downloaded `libghostty.a` should not be committed).

**Commit:**

```bash
git add scripts/release.sh .gitignore
git commit -m "feat(release): add summary phase and finalize release script"
```

---

## Task 8: End-to-End Dry Run Verification

**Do NOT actually run a release.** Instead verify:

**Step 1:** Run syntax check

```bash
bash -n scripts/release.sh
```

**Step 2:** Verify the script is executable

```bash
ls -la scripts/release.sh  # should show -rwxr-xr-x
```

**Step 3:** Verify `.env.signing` is gitignored

```bash
echo "test" > .env.signing
git status  # should NOT show .env.signing as untracked
rm .env.signing
```

**Step 4:** Read through the final script end-to-end and confirm it matches the CI workflow:

| CI Step                                                | Local Script Equivalent                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| `gh release download ghostty-deps-v1`                  | Phase 3: same command, with caching                              |
| `pnpm install --frozen-lockfile`                       | Phase 3: same                                                    |
| `pnpm build:native` with `GHOSTTY_LIB_PATH`            | Phase 3: same, env var set                                       |
| `pnpm build`                                           | Phase 3: same                                                    |
| `electron-builder --mac --publish always` with secrets | Phase 4: same, credentials from `.env.signing` + `gh auth token` |
| _(not in CI)_ Homebrew update                          | Phase 5: download DMGs, compute SHA256, update cask, push        |

**Commit:** No commit needed for this task.

---

## Design Decisions & Notes

### Why `--publish always` instead of `gh release create` + `gh release upload`?

`electron-builder --publish always` does three things at once:

1. Creates the GitHub release from the tag (if it doesn't exist)
2. Builds the DMGs, ZIPs, and blockmaps
3. Uploads them all including `latest-mac.yml` (needed for auto-updater)

Using `gh release create` separately would mean duplicating the upload logic and manually generating `latest-mac.yml`. Not worth it.

### Why download DMGs back for SHA256 instead of computing locally?

The DMGs in `dist/` are the pre-upload versions. In theory they're identical to what gets uploaded, but downloading guarantees the SHA256 matches exactly what users will download. It also serves as a verification that the upload succeeded and the assets are accessible.

### Why `node -e` for file edits instead of `sed`?

The cask file has two `sha256` lines that need different values. Doing this with `sed` requires tracking line numbers or using GNU sed features that differ on macOS. A 10-line Node script is more readable and reliable.

### What about `CSC_LINK` / `CSC_KEY_PASSWORD`?

Not needed locally. `electron-builder` auto-discovers the signing identity from the macOS keychain. The CI needs `CSC_LINK` because it doesn't have a persistent keychain — it imports a `.p12` cert at runtime. Locally, you already have `Developer ID Application: Your Name (XXXXXXXXXX)` installed.

### Error recovery

If the script fails mid-way:

- **Phase 2 (git) succeeded but Phase 3/4 failed:** The tag exists on GitHub. Delete it with `gh release delete vX.Y.Z --repo morapelker/hive -y && git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`, then re-run.
- **Phase 4 succeeded but Phase 5 (homebrew) failed:** Re-run just the homebrew portion manually, or re-run the script (it will fail at Phase 2 since the tag exists — we could add a `--homebrew-only` flag later if needed).

### Future improvements (out of scope)

- `--homebrew-only` flag for re-running just the cask update
- Changelog generation from git commits
- Slack/Discord notification on release
- `--dry-run` flag that prints what would happen without executing
