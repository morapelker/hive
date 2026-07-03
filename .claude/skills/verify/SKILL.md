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
  **test-python** (GitHub remote) and **ct-test** (no remote) projects.
- Inspect state read-only: `sqlite3 -readonly ~/.hive/hive.db "..."` (projects, worktrees,
  connections, connection_members tables).
- Create worktrees via the sidebar "+" button on a project row; connections via
  right-click worktree → "Connect to..." → check other worktrees → Connect.

## Gotchas

- Snapshot refs vanish (all elements ref-less) while a context-menu/focus state is
  active — `playwright-cli press Escape`, then re-snapshot.
- Open React context menus by dispatching a `contextmenu` MouseEvent via `eval` on the row ref.
- Quit the dev app with `osascript -e 'tell application "Electron" to quit'`
  (production app is named "Hive", dev is "Electron").
- Clean up after PR tests: `gh pr close <n> --repo morapelker/test-python --delete-branch`,
  archive test worktrees via the sidebar context menu ("Archive Delete branch").
- App logs: `~/.hive/logs/hive-YYYY-MM-DD.log` (all Hive processes write there; filter by pid).
