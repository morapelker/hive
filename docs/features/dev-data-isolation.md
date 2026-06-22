# Dev Data Isolation

`pnpm dev` keeps its data fully separate from an installed (official/daily) Hive app, so you
can develop against Hive while still using Hive day-to-day without the two racing the same
SQLite database or sharing logs, attachments, and worktrees.

| Data                 | Installed app       | `pnpm dev`              |
| -------------------- | ------------------- | ----------------------- |
| Database & resources | `~/.hive`           | `~/.hive-dev`           |
| Git worktrees        | `~/.hive-worktrees` | `~/.hive-dev-worktrees` |

The official data (`~/.hive` / `~/.hive-worktrees`) is treated as strictly **read-only** —
never modified, moved, or deleted. The dev launcher only ever reads it and writes a separate
copy.

## How it works

`src/main/services/hive-paths.ts` is the single source of truth for every on-disk Hive path.
Each helper (`getHiveDataDir`, `getHiveDbPath`, `getHiveLogsDir`, `getHiveWorktreesDir`, …)
resolves an environment override first, falling back to the historical `~/.hive` /
`~/.hive-worktrees` layout:

- `HIVE_DATA_DIR` → root for the data tree (db, logs, attachments, project-icons,
  connections, custom-commands).
- `HIVE_WORKTREES_DIR` → root for git worktrees.

`scripts/dev-desktop.mjs` (the `pnpm dev` launcher) pins those two vars to the fixed dev dirs
(`~/.hive-dev` / `~/.hive-dev-worktrees`) for the dev process and the server child it spawns.
With no overrides set, the installed app resolves to the default `~/.hive` layout unchanged —
so this feature has no effect on the daily app.

## First-run experience

The first time dev runs in isolated mode (no `~/.hive-dev` yet), the launcher prompts on a
TTY. There are two gates:

1. **Clone vs fresh** (default **clone**). Clone copies everything from the official app into
   the dev location; fresh starts with an empty database.
2. **Quit the official app** (default **No** → cancel). A consistent DB + worktree snapshot
   requires the official app closed (an open SQLite database copies torn). Choosing yes quits
   the app for you, waits until it exits, then clones. The official data is still only read.

Non-interactive runs (CI / piped, no TTY) skip both prompts and start fresh — they never
prompt or quit the app.

## What gets cloned

Sync copies the full data tree (`~/.hive` → `~/.hive-dev`: db incl. `-wal`/`-shm`, logs,
attachments, project-icons, connections, custom-commands) **and every live worktree**,
including uncommitted, gitignored, and untracked files.

A git branch can be checked out in only one worktree at a time, so each cloned worktree gets
a new branch off the same commit, prefixed `hive-dev_` (e.g. `golden-retriever` →
`hive-dev_golden-retriever`). These branches are registered in your **real project repos** —
that is the only change made to them. A detached-HEAD worktree is cloned detached at the same
commit, with no branch.

| Source worktree location                      | Cloned into                                                 |
| --------------------------------------------- | ----------------------------------------------------------- |
| under `~/.hive-worktrees/<project>/<leaf>`    | `~/.hive-dev-worktrees/<project>/<leaf>` (same sub-path)    |
| a custom location outside `~/.hive-worktrees` | `~/.hive-dev-worktrees/<project>/<dir-name>` (consolidated) |

> Because the `hive-dev_*` branches are added to whichever real repo each worktree belongs
> to, a clone can touch **multiple repos** — one per project that has live worktrees. The
> entire dev worktree tree still resets with a single `rm -rf ~/.hive-dev-worktrees`.

Each worktree is cloned independently and wrapped in error handling — a single failure logs a
skip and never aborts the dev launch.

## Resetting

To wipe the dev data and be prompted again on the next run (spans every repo a clone touched):

```bash
rm -rf ~/.hive-dev ~/.hive-dev-worktrees
# optionally drop the hive-dev_* branches/worktrees registered in your real repos:
for repo in /path/to/hive /path/to/other-project; do
  git -C "$repo" worktree prune
  for b in $(git -C "$repo" branch --list 'hive-dev_*' | tr -d ' '); do
    git -C "$repo" branch -D "$b"
  done
done
```

## Manual verification

### Setup

Be on the feature branch and set a var for the repo you launch from, plus one per other
project repo that has worktrees:

```bash
cd /path/to/hive
git branch --show-current      # → feat/dev-data-isolation

HIVE=/path/to/hive             # the Hive repo you run pnpm dev from
REPO_2=/path/to/other-project  # any other project repo that has live worktrees
```

List which repos will receive `hive-dev_*` branches before testing:

```bash
sqlite3 ~/.hive/hive.db \
  "SELECT DISTINCT p.name, p.path
     FROM worktrees w JOIN projects p ON p.id = w.project_id
    WHERE w.is_default = 0 AND w.status = 'active';"
```

### Step 0 — Snapshot official data (read-only proof)

Run before testing; compare after. Record the printed values.

```bash
shasum ~/.hive/hive.db
stat -f '%z bytes  mtime=%Sm' ~/.hive/hive.db
git -C "$HIVE" worktree list
git -C "$REPO_2" worktree list
```

### Path 1 — Clone (default; the main feature)

```bash
rm -rf ~/.hive-dev ~/.hive-dev-worktrees     # clean first-run state
cd "$HIVE"
pnpm dev
```

At the prompts:

1. **Prompt 1** (clone vs fresh) → press **Enter** (= clone). The preview lists every
   worktree with its `hive-dev_` branch and dev path.
2. **Prompt 2** (quit official app) → type **`y`** + Enter. It quits Hive.app, waits until
   gone, then clones.

The dev app launches on `~/.hive-dev`. Leave it running; in another terminal, verify:

```bash
# (a) data tree cloned
ls ~/.hive-dev                  # hive.db, logs, attachments, project-icons, connections, custom-commands.json
ls ~/.hive-dev-worktrees/       # one dir per project that had worktrees

# (b) new hive-dev_ branches in each real repo
git -C "$HIVE"   branch --list 'hive-dev_*'
git -C "$REPO_2" branch --list 'hive-dev_*'

# (c) dev worktrees registered on those branches
git -C "$HIVE"   worktree list | grep hive-dev
git -C "$REPO_2" worktree list | grep hive-dev

# (d) uncommitted / gitignored / untracked files copied (pick any cloned worktree dir)
ls -la ~/.hive-dev-worktrees/<project>/<dir-name>/

# (e) dev DB points at the dev paths (never prod paths)
sqlite3 ~/.hive-dev/hive.db \
  "SELECT branch_name, path FROM worktrees WHERE is_default = 0 AND status = 'active';"
#   every path under ~/.hive-dev-worktrees; branches prefixed hive-dev_
```

**Read-only proof — official data unchanged** (must match Step 0 exactly):

```bash
shasum ~/.hive/hive.db                          # identical hash
stat -f '%z bytes  mtime=%Sm' ~/.hive/hive.db   # identical size + mtime
git -C "$HIVE"   worktree list                  # original entries intact; hive-dev_ ones ADDED
git -C "$REPO_2" worktree list                  # original entries intact; hive-dev_ ones ADDED
```

In the running dev app: confirm your projects and sessions are present and clickable.

Quit the dev app, then reset before trying another path.

### Path 2 — Start fresh

```bash
rm -rf ~/.hive-dev ~/.hive-dev-worktrees
cd "$HIVE"
pnpm dev
# Prompt 1 → type  f  + Enter
```

- No Prompt 2; official app never touched.
- Dev opens with an empty database.

```bash
ls ~/.hive-dev                                  # created (empty db + dirs)
ls ~/.hive-dev-worktrees 2>/dev/null            # empty or absent — nothing cloned
sqlite3 ~/.hive-dev/hive.db "SELECT count(*) FROM projects;"   # 0
```

### Path 3 — Abort (default No on the quit gate)

```bash
rm -rf ~/.hive-dev ~/.hive-dev-worktrees
cd "$HIVE"
pnpm dev
# Prompt 1 → Enter (clone)
# Prompt 2 → Enter (= No, default)
```

- Prints `Cancelled — official app left running, nothing copied. Exiting.` and exits.
- Confirm nothing was created and the official app still runs:

```bash
ls -d ~/.hive-dev ~/.hive-dev-worktrees 2>&1    # both: No such file or directory
pgrep -fl '/Hive.app/Contents/MacOS/Hive'       # still running (if it was)
```

### Path 4 (optional) — Non-TTY = silent fresh

Confirms CI / piped runs never prompt or quit the app:

```bash
rm -rf ~/.hive-dev ~/.hive-dev-worktrees
echo "" | node scripts/dev-desktop.mjs &        # stdin not a TTY
sleep 3; kill %1 2>/dev/null
ls -d ~/.hive-dev                               # created fresh, no prompt shown
rm -rf ~/.hive-dev ~/.hive-dev-worktrees
```

### Pass criteria

- **Path 1** — dev opens on `~/.hive-dev` with all projects/sessions; every worktree cloned
  under `~/.hive-dev-worktrees`; `hive-dev_*` branches present in each real repo; dev DB
  paths all under `~/.hive-dev-worktrees`; official `~/.hive/hive.db` byte-identical to
  Step 0 and every repo's original worktrees intact.
- **Path 2** — empty dev DB, no Prompt 2, app untouched.
- **Path 3** — clean exit, nothing created, app left running.

## Known limitation

Dev and the official app share the underlying project repos, so `git worktree list` shows
both installs' worktrees, and a later project refresh in dev may import the official app's
worktree rows (and vice-versa). The clone gives dev its own copy of every worktree
(`hive-dev_*`, fully independent) — avoid operating from dev on any worktree whose path is
not under `~/.hive-dev-worktrees`. In particular, a project's default `(no-worktree)` row
points at the repo checkout itself (its path is your real repo, not a `~/.hive-dev-worktrees`
copy), so a dev session opened on that default entry runs agents in — and can modify — your
actual repository; for isolated dev work, add a worktree (which lands under
`~/.hive-dev-worktrees`) rather than using the default `(no-worktree)` entry. True
per-worktree isolation isn't possible without cloning the repos themselves; separating the
databases is strictly better than the previous shared-everything state.

## Implementation

- `src/main/services/hive-paths.ts` — path resolver honoring `HIVE_DATA_DIR` /
  `HIVE_WORKTREES_DIR`; every former `~/.hive` call site routes through it.
- `scripts/dev-desktop.mjs` — pins the dev env vars and runs the first-run clone flow
  (`ensureDevDataReady` → prompts → quit official app → copy data tree → clone worktrees).
- `src/server/config.ts` — server base-dir precedence: `HIVE_DATA_DIR` >
  `HIVE_SERVER_BASE_DIR` > `~/.hive`.
- `test/dev-desktop-script.test.ts` — unit tests for env pinning, prompt parsing, the
  worktree dev-path mapping, and branch prefixing.
