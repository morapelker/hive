---
name: verify
description: Build, launch, and drive this worktree's Hive app over CDP to verify a change end-to-end with playwright-cli
---

# Verifying Hive changes end-to-end

## Build & launch (verified 2026-07-03)

```bash
pnpm exec electron-vite build && pnpm run build:server
env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH \
    -u CLAUDE_CODE_NEW_INIT -u CLAUDE_CODE_SESSION_ID -u CLAUDECODE \
    HIVE_SERVER_ENTRY_PATH=$PWD/out/main/server.js HIVE_DESKTOP_BACKEND_PORT=51000 \
    pnpm exec electron . --remote-debugging-port=9223   # background
playwright-cli -s=<unique-session> attach --cdp=http://127.0.0.1:9223
playwright-cli -s=<s> tab-select 1   # tab 0 is the pet overlay, tab 1 is the main window
```

- Port 9222 is usually the user's own Chrome — always use 9223.
- Without `HIVE_SERVER_ENTRY_PATH` the app dies ~30s in ("Fatal error during app startup").
- The `env -u CLAUDE_CODE_*` strip is required or spawned claude TUIs become child sessions.
- Confirm you're driving YOUR build: the page URL is `file://<this worktree>/out/renderer/index.html`.

## Data & test targets

- Dev shares the real `~/.hive/hive.db` with the installed app — only exercise the
  test projects below, OR set `HIVE_DESKTOP_BASE_DIR=<dir>` at launch to point the
  backend at an isolated data dir (`<dir>/hive.db`). Plain `HOME=` is NOT enough:
  `app.getPath('home')` ignores `$HOME` on macOS, so the backend would still open
  the real DB (verified 2026-07-08).
  **test-python** (GitHub remote) and **ct-test** (no remote) projects.
- Inspect state read-only: `sqlite3 -readonly ~/.hive/hive.db "..."` (projects, worktrees,
  connections, connection_members tables).
- Create worktrees via the sidebar "+" button on a project row; connections via
  right-click worktree → "Connect to..." → check other worktrees → Connect.

## Gotchas

- Snapshot refs vanish (all elements ref-less) while a context-menu/focus state is
  active — `playwright-cli press Escape`, then re-snapshot.
- Open React context menus by dispatching a `contextmenu` MouseEvent via `eval` on the row ref.
- In "Connect to..." connection mode, the Radix checkbox does NOT toggle on direct
  click — click the worktree ROW (the cursor-pointer wrapper) instead.
- Dispatching `contextmenu` on a row scrolled out of view opens the menu offscreen
  and menuitem clicks time out — `scrollIntoView` (or pick a visible row) first.
- Quit the dev app with `osascript -e 'tell application "Electron" to quit'`
  (production app is named "Hive", dev is "Electron").
- Clean up after PR tests: `gh pr close <n> --repo morapelker/test-python --delete-branch`,
  archive test worktrees via the sidebar context menu ("Archive Delete branch").
- App logs: `~/.hive/logs/hive-YYYY-MM-DD.log` (all Hive processes write there; filter by pid).

## Voice dictation with test clips (no microphone)

Launch with `HIVE_VOICE_TEST_CLIPS=1` and the dictation HUD records a WAV clip instead of
the mic: played in real time into the same capture worklet, so the level bars, chunking and
stop handling behave as with a real mic. After the clip ends, silence keeps flowing until the
dictation stops. The mic permission check is skipped. Unset (the default), nothing changes:
no test API, mic as usual. `1`/`true` plays the committed fixtures in `test/fixtures/voice/`;
any other value is a directory of your own `<name>.wav` (+ optional `<name>.txt`) clips.

```bash
HIVE_DESKTOP_BASE_DIR=/tmp/voice-verify \
HIVE_VOICE_TEST_CLIPS=1 \
  ... pnpm exec electron . --remote-debugging-port=9223   # same launch line as above
```

- Use an isolated base dir. Voice must be enabled with a downloaded speech model under
  `<base>/voice/models/<archive>` (copy or symlink it from `~/.hive/voice/models` to skip the
  630 MB download). Turn AI cleanup off in Settings › Voice to compare text exactly.
- Fixtures (16 kHz mono; the expected transcript is in `<name>.txt`):

  | clip | length | what it's for |
  | --- | --- | --- |
  | `short-command` | ~3 s | short command |
  | `sentence` | ~8 s | one sentence |
  | `paragraph` | ~27 s | paragraph |
  | `monologue` | ~60 s | long dictation |
  | `pause-mid` | ~11 s | 7 s of silence between two sentences |
  | `speech-at-start` | ~3 s | speech from the very first sample |
  | `silence` | 3 s | digital silence: expect "Nothing heard" |

  Regenerate them with `node scripts/generate-voice-fixtures.mjs` (macOS `say`).
- Drive it from the main window (tab 1) with `playwright-cli -s=<s> eval "..."`. Focus the
  target text field first (click it). Start and stop use the controller's toggle, the same
  path as the hotkey:

  ```js
  await window.desktopBridge.voiceTest.listClips()       // [{ name, durationMs, sampleRate, expectedText }]
  // Start; auto-stop 800 ms after the clip ends (omit autoStopAfterMs to stop manually):
  await window.desktopBridge.voiceTest.start({ clip: 'sentence', autoStopAfterMs: 800 })
  await window.desktopBridge.voiceTest.stop()            // manual stop (= pressing the hotkey)
  await window.desktopBridge.voiceTest.status()          // { selected, playing, autoStopAfterMs, … }
  // Or arm a clip and use the real hotkey / pill / Esc:
  await window.desktopBridge.voiceTest.selectClip('paragraph', { autoStopAfterMs: null })
  ```

  `start` rejects unless the dictation is idle. The clip stays selected for later dictations
  until you select another one (`selectClip(null)` disarms it, and a dictation started with
  nothing armed fails with "Could not start recording"). Toggles less than 250 ms apart are
  ignored, as with the hotkey.
- The text is only inserted while the Electron window has OS focus (`document.hasFocus()` is
  true). Otherwise it's left on the clipboard ("No editable target focused" in the log), which
  is normal app behaviour. Run `osascript -e 'tell application "Electron" to activate'` first,
  and don't `tab-select` the HUD mid-dictation, because that can take focus. `pbpaste` shows
  the text when it lands on the clipboard instead.
- Wait about the clip length plus the delay, then read the text field from a snapshot.
  The HUD is its own CDP target ("Voice dictation", `voice-hud.html`): `tab-list`, then
  `tab-select` it to screenshot the pill and its level bars.
- Logs: `VoiceTestClips` lines (`Test clip selected`, `Test clip ended`) and the controller's
  `Transcribed` line.
- With a streaming speech model (Nemotron) the HUD also streams each chunk to the engine while
  recording. After the dictation, `status().lastStream` shows what that session got:
  `{ chunks, streamedMs, topUpMs, clipMs, sessionAudioMs, finishMs, text }` (reset when the next
  capture starts). The log has the same numbers, without the text, as `Streamed dictation audio`.
