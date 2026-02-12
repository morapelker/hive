# Hive — macOS Code Signing & Notarization Implementation Plan

## Current State

- `electron-builder.yml` has a minimal config — no signing, no entitlements, no notarization
- No `.plist` entitlements files exist
- No environment variable references for Apple credentials anywhere
- No `asarUnpack` config despite three native modules (better-sqlite3, node-pty, ghostty addon)
- electron-builder version is 25.1.8+ which has built-in notarization support (no afterSign hook needed)

---

## Step 1: Apple Developer Account Setup (manual, outside project)

**What:** Ensure you have an active Apple Developer Program membership and gather credentials.

**Sub-steps:**

1. **Verify membership** at https://developer.apple.com/account — you need the paid program ($99/year), not the free tier. The free tier cannot create Developer ID certificates, which are required for distributing apps outside the App Store.

2. **Note your Team ID** — found on the Membership Details page. It's a 10-character alphanumeric string (e.g. `A1B2C3D4E5`). This goes into the `APPLE_TEAM_ID` env var later.

3. **Create a Developer ID Application certificate** — this is the certificate used to sign `.app` bundles for distribution outside the Mac App Store. Do this via:

   ```
   Xcode → Settings → Accounts → select your team → Manage Certificates → + → Developer ID Application
   ```

   This installs the certificate + private key directly into your login Keychain. Verify it worked:

   ```bash
   security find-identity -v -p codesigning
   ```

   You should see output containing: `"Developer ID Application: Your Name (TEAMID)"`

4. **Create an App-Specific Password** — Apple's notary service needs this for authentication. Go to https://appleid.apple.com → Sign-In and Security → App-Specific Passwords → Generate. Label it something like "Hive Notarization". Save the generated `xxxx-xxxx-xxxx-xxxx` password securely.

**Why:** electron-builder automatically finds signing certificates from the macOS Keychain by identity name. Without a Developer ID Application certificate, macOS Gatekeeper will block your app entirely on other people's machines. Without notarization, users get a scary "unidentified developer" warning even if the app is signed.

**Verification:**

```bash
# Should list your Developer ID Application certificate
security find-identity -v -p codesigning
```

---

## Step 2: Create Entitlements Files

**What:** Create two `.plist` files that declare which hardened runtime exceptions the app needs.

### File: `resources/entitlements.mac.plist`

Applied to the main app bundle.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
</dict>
</plist>
```

### File: `resources/entitlements.mac.inherit.plist`

Applied to child/helper processes (Electron spawns several: GPU, renderer, utility).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
</dict>
</plist>
```

**Why each entitlement is needed:**

| Entitlement                        | Reason                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow-jit`                        | Chromium's V8 engine uses JIT compilation. Without this, the renderer process crashes.                                                                                          |
| `allow-unsigned-executable-memory` | V8 maps memory pages as writable then executable. Hardened runtime blocks this by default.                                                                                      |
| `disable-library-validation`       | Native `.node` modules (better-sqlite3, node-pty, ghostty addon) are not signed with your team identity. Without this, they fail to load at runtime with code signature errors. |
| `allow-dyld-environment-variables` | Some native module loading paths rely on `DYLD_*` environment variables. Required for node-pty and the ghostty addon which link against system frameworks.                      |

**Why two files:** macOS code signing applies entitlements hierarchically. The main binary gets `entitlements.mac.plist`. All nested helper binaries (inside `Hive.app/Contents/Frameworks/`) get `entitlementsInherit`. Having a separate inherit file lets you give child processes fewer privileges if needed in the future (e.g. you might later remove an entitlement from helpers that only the main process needs).

**Verification:**

```bash
# After a signed build, confirm entitlements are embedded
codesign -d --entitlements - "dist/mac-arm64/Hive.app"
```

---

## Step 3: Update `electron-builder.yml`

**What:** Replace the current minimal config with a complete config that enables signing, hardened runtime, notarization, and proper native module handling.

**Full replacement for `electron-builder.yml`:**

```yaml
appId: com.hive.app
productName: Hive
directories:
  buildResources: resources
  output: dist
files:
  - out/**/*
  - resources/**/*

# Native .node binaries cannot be loaded from inside an ASAR archive.
# This extracts them to app.asar.unpacked/ at build time.
asarUnpack:
  - '**/*.node'
  - '**/better-sqlite3/**'
  - '**/node-pty/**'

# ── macOS ──────────────────────────────────────────────
mac:
  icon: resources/icon.icns
  category: public.app-category.developer-tools
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: resources/entitlements.mac.plist
  entitlementsInherit: resources/entitlements.mac.inherit.plist
  target:
    - target: dmg
      arch:
        - arm64
        - x64
    - target: zip
      arch:
        - arm64
        - x64
  notarize: true

dmg:
  sign: false

# ── Windows ────────────────────────────────────────────
win:
  icon: resources/icon.ico

# ── Linux ──────────────────────────────────────────────
linux:
  icon: resources/icon.png
  category: Development
```

**What changed and why:**

| Addition                               | Explanation                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asarUnpack`                           | better-sqlite3, node-pty, and the ghostty `.node` addon are native compiled binaries. Node.js cannot `dlopen()` files inside an ASAR archive. Without this, the app builds fine but crashes at runtime when trying to load any native module. The `**/*.node` glob catches all native addons; the explicit package entries ensure supporting files (like `.dylib` siblings) are also unpacked. |
| `hardenedRuntime: true`                | Apple requires hardened runtime for all notarized apps since macOS 10.14.5. This restricts the app from doing things like injecting code into other processes, unless entitlements explicitly allow exceptions. Without this, notarization submission is rejected immediately.                                                                                                                 |
| `gatekeeperAssess: false`              | Tells electron-builder to skip running `spctl --assess` locally during the build. This check is slow, unreliable on CI, and redundant when notarization is enabled (Apple's notary service is the real gatekeeper check).                                                                                                                                                                      |
| `entitlements` / `entitlementsInherit` | Points to the plist files from Step 2. electron-builder passes these to `codesign` during signing. Without them, the hardened runtime blocks V8 JIT and native module loading.                                                                                                                                                                                                                 |
| `target` with `arch`                   | Explicitly builds both Apple Silicon (arm64) and Intel (x64) variants. Without specifying arch, electron-builder only builds for the host machine's architecture. Users on the other architecture would get a Rosetta-translated or non-functional build.                                                                                                                                      |
| `notarize: true`                       | electron-builder 25+ has built-in notarization. When this is `true` and the `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` env vars are set, it automatically submits the signed app to Apple's notary service and staples the ticket. No afterSign hook script needed.                                                                                                            |
| `dmg.sign: false`                      | The `.app` inside the DMG is already signed and notarized. Signing the DMG container itself is unnecessary and can actually cause issues on some macOS versions.                                                                                                                                                                                                                               |

---

## Step 4: Update `.gitignore`

**What:** Add an entry for the signing environment file so credentials never get committed.

**Add this line** to `.gitignore`:

```
.env.signing
```

**Why:** Step 5 creates a `.env.signing` file containing your Apple ID and app-specific password. These are secrets that must never enter version control. The existing `.env` and `.env.local` patterns are already ignored, but `.env.signing` doesn't match the `.env.*.local` glob pattern, so it needs an explicit entry.

---

## Step 5: Create `.env.signing` Template

**What:** Create a local-only environment file for signing credentials.

**File: `.env.signing`** (gitignored, never committed):

```bash
# Apple Developer credentials for code signing and notarization
# Get your Team ID from: https://developer.apple.com/account → Membership Details
# Create an app-specific password at: https://appleid.apple.com → Sign-In and Security

export APPLE_ID="your-apple-id@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

**Why:** Centralizes credentials in one source-able file. Before a signed build you run `source .env.signing` to load them into your shell. electron-builder reads these three env vars automatically when `notarize: true` is set. Keeping them in a dedicated file (rather than your shell profile) makes it explicit and portable.

---

## Step 6: Update `package.json` Build Scripts

**What:** Add a convenience script for unsigned local builds.

**Change in `package.json` scripts:**

```jsonc
// existing — no change needed, signing happens automatically when cert is in Keychain
"build:mac": "pnpm run build && electron-builder --mac",

// add — skips signing for fast local testing
"build:mac:unsigned": "CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run build && electron-builder --mac"
```

**Why:** electron-builder automatically discovers signing certificates from the Keychain. Once you install your Developer ID cert (Step 1), every `build:mac` will attempt signing. The `build:mac:unsigned` script sets `CSC_IDENTITY_AUTO_DISCOVERY=false` which tells electron-builder to skip certificate discovery entirely — useful when you want a fast local build for testing without waiting for signing + notarization (which adds 2-15 minutes).

No separate `build:mac:sign` script is needed because signing is the default behavior when a certificate exists in the Keychain.

---

## Step 7: First Signed Build & Verification

**What:** Run the build and verify everything works end to end.

**Commands:**

```bash
# 1. Load credentials
source .env.signing

# 2. Build (signing + notarization happen automatically)
pnpm build:mac

# 3. Verify code signature is valid
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Hive.app"
# Expected: "valid on disk" and "satisfies its Designated Requirement"

# 4. Verify signing identity
codesign -dv "dist/mac-arm64/Hive.app" 2>&1 | grep Authority
# Expected: "Authority=Developer ID Application: Your Name (TEAMID)"

# 5. Verify notarization
spctl -a -vvv "dist/mac-arm64/Hive.app"
# Expected: "source=Notarized Developer ID"

# 6. Verify entitlements are embedded
codesign -d --entitlements - "dist/mac-arm64/Hive.app"
# Expected: shows the entitlements from your plist

# 7. Test the DMG
open "dist/Hive-1.0.0-arm64.dmg"
# Drag to Applications, launch — should not show any Gatekeeper warnings
```

**Why:** Each verification step confirms a different layer of the signing chain. A common failure mode is "signed but not notarized" (step 5 fails) or "signed but entitlements missing" (step 6 shows empty dict, app crashes on launch). Running all checks after the first build catches configuration issues before you distribute to users.

**Troubleshooting common failures:**

| Symptom                                                                  | Likely Cause                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `codesign --verify` fails with "code object is not signed at all"        | Certificate not in Keychain, or `CSC_IDENTITY_AUTO_DISCOVERY=false` was set  |
| Notarization fails with "The signature of the binary is invalid"         | `hardenedRuntime` not set to `true`                                          |
| Notarization fails with "The binary uses an SDK older than the 10.9 SDK" | Electron version too old (not an issue with Electron 33)                     |
| App crashes on launch after signing                                      | Missing entitlements — V8 JIT or native modules are blocked                  |
| `spctl` says "rejected" after successful notarization                    | The notarization ticket wasn't stapled. Check build logs for stapling errors |
| Build errors about native modules                                        | `asarUnpack` patterns don't cover all native module files                    |

---

## Summary of All File Changes

| #   | File                                       | Action                                       |
| --- | ------------------------------------------ | -------------------------------------------- |
| 1   | `resources/entitlements.mac.plist`         | Create new                                   |
| 2   | `resources/entitlements.mac.inherit.plist` | Create new                                   |
| 3   | `electron-builder.yml`                     | Replace contents                             |
| 4   | `.gitignore`                               | Add `.env.signing` line                      |
| 5   | `.env.signing`                             | Create new (gitignored, fill in real values) |
| 6   | `package.json`                             | Add `build:mac:unsigned` script              |

Total: 4 new files, 2 modified files. No dependencies to install (electron-builder 25+ includes `@electron/notarize` transitively).
