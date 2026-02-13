# Distribution Audit — Machine-Specific Dependencies

> Audit date: 2026-02-12
> Audited for hardcoded references to user home directories and other machine-specific paths.

---

## Issue 1: Hardcoded Language Icon Paths (P0 — Runtime)

**File:** `src/main/ipc/project-handlers.ts` lines 207–217

**Description:**
When the app first launches and the `language_icons` setting doesn't exist in the DB, it seeds 11 default language icon paths that all point to files on a specific developer's Desktop:

```ts
python: '~/Desktop/python.svg',
rust: '~/Desktop/rustacean-orig-noshadow.svg',
go: '~/Desktop/golang.png',
typescript: '~/Desktop/typescript.svg',
swift: '~/Desktop/swift.svg',
kotlin: '~/Desktop/kotlin.svg',
csharp: '~/Desktop/csharp.svg',
cpp: '~/Desktop/c-plusplus.svg',
c: '~/Desktop/c.svg',
javascript: '~/Desktop/javascript.svg',
java: '~/Desktop/java.svg'
```

**Impact:**
Every new user on first launch gets broken language icon paths persisted to their database. The icons will fail to load silently or show broken images. Since the seed only runs when the setting is absent, fixing the code later won't help users who already ran the app once — their DB already has the bad paths.

**Suggested fixes (pick one):**

1. **Bundle icons as app resources.** Place the SVG/PNG files in `resources/language-icons/`. At runtime, resolve via `path.join(process.resourcesPath, 'language-icons', 'python.svg')`. This works in both dev (`resources/` relative to project root) and packaged builds (Electron sets `process.resourcesPath`).

2. **Use inline SVGs or a built-in icon library.** Instead of file paths, store SVG markup strings or use icons from `lucide-react` / a similar icon set. This eliminates filesystem dependencies entirely.

3. **Don't seed file paths at all.** Seed an empty object or a map of language → icon-name, and resolve the actual rendering at the component level using bundled assets. This keeps the DB schema clean and decouples storage from filesystem layout.

**Migration concern:** Users who already have the broken paths in their DB will need a one-time migration or a "reset icons to defaults" option.

---

## Issue 2: Hardcoded Ghostty Library Path in Native Build (P0 — Build)

**File:** `src/native/binding.gyp` line 15

**Description:**
The native Node addon build configuration references a static library via an absolute path:

```json
"libraries": [
  "~/Documents/dev/ghostty/macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a"
]
```

**Impact:**

- Any contributor cloning the repo and running `node-gyp rebuild` will get a build failure because the library doesn't exist at that path on their machine.
- The packaged Electron app ships the pre-built `.node` binary, so end users are unaffected — but the build pipeline is broken for anyone other than the original developer.
- CI/CD builds will also fail unless they happen to replicate this exact path.

**Suggested fixes (pick one):**

1. **Environment variable with fallback.**

   ```json
   "libraries": [
     "<!(echo ${GHOSTTY_LIB_PATH:-<(module_root_dir)/../vendor/libghostty.a})"
   ]
   ```

   Document in README/CONTRIBUTING that contributors must set `GHOSTTY_LIB_PATH` or place the library in `vendor/`.

2. **Relative vendor directory.** Commit or `.gitignore` a `src/native/vendor/` directory and reference it relatively. Add a setup script (`scripts/setup-ghostty.sh`) that downloads or symlinks the library into place.

3. **pkg-config or cmake integration.** If Ghostty provides a `.pc` file or cmake config, use that for automatic discovery.

4. **Conditional compilation.** Make the Ghostty native addon optional — if the library isn't found, skip building it and fall back to a non-native terminal implementation. This is the most distribution-friendly approach.

---

## Issue 3: Hardcoded Test Fixture Path (P1 — Tests)

**File:** `test/phase-5/session-8/app-icon.test.ts` line 86

**Description:**
A test references an app icon PNG via an absolute path:

```ts
const sourcePath = '~/Desktop/appicon.png'
```

The test does guard itself:

```ts
if (!existsSync(sourcePath)) {
  return // silently skips
}
```

**Impact:**
The test silently passes on every machine except the original developer's. It provides zero coverage in CI or for any contributor. The guard hides the problem — the test appears green but isn't actually running.

**Suggested fix:**

Move `appicon.png` into the repository as a test fixture:

```
test/fixtures/appicon.png
```

Then reference it relatively:

```ts
const sourcePath = path.join(__dirname, '../../fixtures/appicon.png')
```

Remove the `existsSync` guard so the test actually fails if the fixture is missing — that's the correct behavior.

---

## Issue 4: Hardcoded Paths in Documentation (P2 — Docs)

**Files:**
| File | Lines |
|------|-------|
| `docs/prd/phase-16.md` | 43, 81, 261 |
| `docs/prd/phase-10.md` | 57 |
| `docs/prd/phase-05.md` | 375 |
| `docs/implementation/phase-16.md` | 102, 111, 138 |
| `docs/implementation/phase-10.md` | 413, 1735 |
| `docs/implementation/phase-05.md` | 948, 1019 |
| `IMPLEMENTATION_TERMINAL.md` | 438 |

**Description:**
Multiple planning and implementation docs reference absolute paths on the developer's machine:

- `~/Documents/dev/opencode` — reference OpenCode CLI client
- `~/Desktop/appicon.png` — source app icon
- `~/Documents/dev/ghostty` — Ghostty source directory

**Impact:**
No runtime impact. These are internal planning documents. However, if the repo is open-sourced or shared with contributors, the paths are confusing and useless.

**Suggested fix:**

Replace all absolute paths with generic placeholders:

- `~/Documents/dev/opencode` → `<opencode-repo>` or a GitHub URL if the repo is public
- `~/Desktop/appicon.png` → `resources/appicon.png` (after bundling it)
- `~/Documents/dev/ghostty` → `<ghostty-source>` or a reference to the Ghostty build docs

This is low priority — do it as part of a general docs cleanup pass before open-sourcing.

---

## Summary

| #   | Issue               | Severity | Affects                      | Fix effort                         |
| --- | ------------------- | -------- | ---------------------------- | ---------------------------------- |
| 1   | Language icon paths | P0       | All new users at runtime     | Medium — bundle assets + migration |
| 2   | Ghostty lib path    | P0       | All contributors + CI builds | Small — env var or vendor dir      |
| 3   | Test fixture path   | P1       | Test coverage (silent skip)  | Small — move file into repo        |
| 4   | Doc paths           | P2       | Readability only             | Small — find-and-replace           |
