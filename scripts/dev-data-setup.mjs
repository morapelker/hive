// First-run data setup for `pnpm dev` (isolated mode).
//
// The dev launcher (scripts/dev-desktop.mjs) keeps its data separate from the
// installed/official ("daily") Hive app by pinning HIVE_DATA_DIR /
// HIVE_WORKTREES_DIR to the fixed dev dirs below; getHiveDataDir() /
// getHiveWorktreesDir() in src/main/services/hive-paths.ts read those env vars
// and relocate the whole data tree accordingly. Without this, `pnpm dev` and
// /Applications/Hive.app both open ~/.hive/hive.db (and share logs, icons,
// attachments, worktrees) — running both at once races the same SQLite file.
//
// This module owns the *first run* in isolated mode (no ~/.hive-dev yet): we
// let the dev either CLONE everything from the official ~/.hive into the dev
// location, or start with an empty database. The official data is treated as
// strictly READ-only: we never move, modify, or delete it. Two explicit gates:
// choose clone-vs-fresh, then a hard confirm to quit the official app (required
// for a consistent SQLite + worktree snapshot; default = No = abort).
//
// It is kept out of dev-desktop.mjs so the launcher stays a small process
// supervisor; the launcher only imports ensureDevDataReady + the dev dirs.

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import * as readline from 'node:readline/promises'
import process from 'node:process'

export const LEGACY_DATA_DIR = join(homedir(), '.hive')
export const LEGACY_WORKTREES_DIR = join(homedir(), '.hive-worktrees')
export const DEV_DATA_DIR = join(homedir(), '.hive-dev')
export const DEV_WORKTREES_DIR = join(homedir(), '.hive-dev-worktrees')

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

const tildify = (p) => {
  const home = homedir()
  return p === home || p.startsWith(home + sep) ? '~' + p.slice(home.length) : p
}

// Pure: parse the clone-vs-fresh answer. Empty input = the default (clone).
export const parseSyncAnswer = (input) => {
  const value = String(input ?? '')
    .trim()
    .toLowerCase()
  if (value === '') return 'sync'
  if (['s', 'sync', 'y', 'yes'].includes(value)) return 'sync'
  if (['f', 'fresh', 'n', 'no', 'scratch'].includes(value)) return 'fresh'
  return 'sync' // unrecognized -> safe default (read-only clone, still gated below)
}

// Pure: parse the quit-official-app confirm. Default (empty / anything but an
// explicit yes) = No = abort, so a stray keypress never quits the daily app.
export const parseQuitAnswer = (input) => {
  const value = String(input ?? '')
    .trim()
    .toLowerCase()
  return value === 'y' || value === 'yes'
}

// Pure: sanitize a project name into a single safe path segment (no separators,
// no leading dots) so it can't escape ~/.hive-dev-worktrees.
const safePathSegment = (value) =>
  String(value ?? '')
    .trim()
    .replace(/[/\\]+/g, '-')
    .replace(/^[.\-]+/, '')

// Pure: map a prod worktree path to its dev twin under ~/.hive-dev-worktrees.
//   - Paths under ~/.hive-worktrees keep their full sub-path (the
//     <proj>/<leaf> convention):
//       ~/.hive-worktrees/<proj>/<leaf> -> ~/.hive-dev-worktrees/<proj>/<leaf>
//   - Foreign paths (worktrees the user created at a CUSTOM location, e.g.
//     a sibling of the repo) are consolidated under
//       ~/.hive-dev-worktrees/<projectName>/<basename>
//     so every dev worktree lives in one isolated, easy-to-reset tree instead
//     of being left pointing at the shared prod working dir.
export const mapWorktreeDevPath = (
  prodPath,
  {
    legacyWorktreesDir = LEGACY_WORKTREES_DIR,
    devWorktreesDir = DEV_WORKTREES_DIR,
    projectName = ''
  } = {}
) => {
  if (prodPath === legacyWorktreesDir || prodPath.startsWith(legacyWorktreesDir + sep)) {
    return devWorktreesDir + prodPath.slice(legacyWorktreesDir.length)
  }
  const project = safePathSegment(projectName)
  const leaf = basename(prodPath)
  return project ? join(devWorktreesDir, project, leaf) : join(devWorktreesDir, leaf)
}

// Pure: a git branch checks out in only ONE worktree, so each dev clone gets a
// fresh "hive-dev_"-prefixed branch off the same commit. Detached worktrees
// have no branch, so the DB branch_name is left unchanged.
export const devBranchName = (oldBranch, { detached = false } = {}) =>
  detached ? oldBranch : `hive-dev_${oldBranch}`

const describeError = (error) => (error instanceof Error ? error.message : String(error))

const sqlStr = (value) => `'${String(value).replace(/'/g, "''")}'`

const runGit = (args, { cwd } = {}) => spawnSync('git', args, { cwd, encoding: 'utf8' })

// Fresh setup guarantees ~/.hive-dev is absent, so any dir already sitting at a
// target dev worktree path is orphaned from a prior aborted/removed run. Clear
// the dir AND its git registration so `git worktree add` recovers it instead of
// failing on "<path> already exists" and archiving the row. Without this, a clone
// that dies between worktree creation and the atomic publish can never be retried
// — the leftover dev worktrees survive the data-dir cleanup and block the next run.
const clearStaleDevWorktree = (sourceRepoPath, devPath) => {
  if (existsSync(devPath)) {
    runGit(['worktree', 'remove', '--force', devPath], { cwd: sourceRepoPath })
    rmSync(devPath, { recursive: true, force: true })
  }
  runGit(['worktree', 'prune'], { cwd: sourceRepoPath })
}

// better-sqlite3 is built against Electron's ABI and unusable from plain node,
// so we shell out to /usr/bin/sqlite3 for the seeding queries. -readonly opens
// the DB read-only: every caller here only SELECTs, and the Prompt-1 preview
// touches the OFFICIAL ~/.hive/hive.db before the user has agreed to anything —
// a writable handle would create/modify -wal/-shm side files on official data.
const sqlite3Query = (dbPath, sql) => {
  const result = spawnSync('sqlite3', ['-readonly', '-json', dbPath, sql], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`sqlite3 query failed: ${result.stderr || result.stdout || result.status}`)
  }
  const out = (result.stdout || '').trim()
  return out ? JSON.parse(out) : []
}

const sqlite3Exec = (dbPath, sql) => {
  const result = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`sqlite3 exec failed: ${result.stderr || result.stdout || result.status}`)
  }
}

// The clone path shells out to the system `sqlite3` CLI (better-sqlite3 is built
// for Electron's ABI and unusable from plain node). macOS ships it at
// /usr/bin/sqlite3; elsewhere it may be absent. Probe once so we can fall back
// to a fresh dev DB instead of letting runClone throw mid-copy.
const sqlite3Available = ({ spawnSyncImpl = spawnSync } = {}) => {
  const result = spawnSyncImpl('sqlite3', ['-version'], { encoding: 'utf8' })
  return result.status === 0 && !result.error
}

const isOfficialAppRunning = ({ spawnSyncImpl = spawnSync } = {}) => {
  // pgrep exits 0 when at least one process matches, 1 when none do.
  const result = spawnSyncImpl('pgrep', ['-f', '/Hive.app/Contents/MacOS/Hive'])
  return result.status === 0
}

const quitOfficialApp = ({ spawnSyncImpl = spawnSync } = {}) => {
  if (!isOfficialAppRunning({ spawnSyncImpl })) return
  spawnSyncImpl('osascript', ['-e', 'tell application "Hive" to quit'], { stdio: 'ignore' })
}

const waitUntilOfficialAppGone = async ({
  timeoutMs = 15000,
  intervalMs = 500,
  log = console
} = {}) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isOfficialAppRunning()) return true
    await sleep(intervalMs)
  }
  log.warn?.('[dev] official Hive app still running after 15s; proceeding anyway.')
  return false
}

// Reads the (already-copied) dev DB or the prod DB to list every live,
// non-default worktree to clone — both Hive's own ~/.hive-worktrees ones and
// worktrees the user created at a custom location. project_name (via the
// projects join) gives foreign-path worktrees a stable parent segment.
const listActiveWorktrees = (dbPath) =>
  sqlite3Query(
    dbPath,
    'SELECT w.id AS id, w.name AS name, w.branch_name AS branch_name, w.path AS path, ' +
      'p.name AS project_name FROM worktrees w LEFT JOIN projects p ON p.id = w.project_id ' +
      "WHERE w.is_default = 0 AND w.status = 'active'"
  )

// Informational preview shown in Prompt 1, computed from the prod DB (the dev
// DB doesn't exist yet). Best-effort: any failure yields an empty preview.
const buildWorktreePreview = ({
  legacyDataDir = LEGACY_DATA_DIR,
  legacyWorktreesDir = LEGACY_WORKTREES_DIR,
  devWorktreesDir = DEV_WORKTREES_DIR
} = {}) => {
  try {
    return listActiveWorktrees(join(legacyDataDir, 'hive.db'))
      .filter(
        (row) =>
          row.path && row.path !== devWorktreesDir && !row.path.startsWith(devWorktreesDir + sep)
      )
      .map((row) => ({
        branch: devBranchName(row.branch_name),
        path: mapWorktreeDevPath(row.path, {
          legacyWorktreesDir,
          devWorktreesDir,
          projectName: row.project_name
        })
      }))
  } catch {
    return []
  }
}

const printSyncPrompt = (log = console) => {
  const preview = buildWorktreePreview()
  const worktreeLines = preview.length
    ? preview.map((w) => `                branch ${w.branch}  |  path ${tildify(w.path)}`)
    : ['                (no live worktrees to clone)']

  log.log?.(
    [
      '',
      '⚠  Hive dev — no ~/.hive-dev found (first isolated run)',
      '',
      '  ✅ Your official Hive data is NEVER changed, NEVER moved, NEVER deleted.',
      '     Sync only READS ~/.hive and writes a SEPARATE ~/.hive-dev copy.',
      '',
      '  Sync clones everything into the isolated dev location:',
      '      Data      ~/.hive  ──►  ~/.hive-dev',
      '                db · logs · attachments · project-icons · connections · custom-commands',
      '      Worktrees full clone — incl. uncommitted + gitignored files.',
      '                Git limit: a branch checks out in only ONE worktree, so each',
      '                clone gets a NEW branch (prefix "hive-dev_") off the same commit.',
      '                (Only change to your real repos: these hive-dev_* branches are',
      '                 added — remove anytime with `git branch -D` / `git worktree remove`.)',
      ...worktreeLines,
      '',
      '  Fresh starts dev with an empty database.',
      '',
      'Sync from official app, or start fresh?',
      '  [S] Sync (default)      [F] Start fresh'
    ].join('\n')
  )
}

const printQuitPrompt = (log = console) => {
  log.log?.(
    [
      '',
      '⚠  Must quit the official Hive app to continue',
      '',
      'A consistent clone of the DB & worktrees REQUIRES the official Hive app',
      'fully closed — an open SQLite database copies torn / half-written.',
      '',
      'Pressing Yes quits the official Hive app for you, then clones.',
      'Your data is STILL never modified — quitting just flushes it to disk.',
      '',
      'Quit the official Hive app now and continue?',
      '  [y] Yes — quit it & sync',
      '  [N] No  — cancel & exit          (default)'
    ].join('\n')
  )
}

const ask = async (query) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(query)
  } finally {
    rl.close()
  }
}

// Clone every live, non-default worktree into the dev worktrees dir on a fresh
// hive-dev_* branch, then rewrite the dev DB rows to point at the new
// path/branch. Mirrors Hive's own "duplicate" worktree flow (git worktree add
// -b + copy of the working tree). All git ops target the prod worktree dir
// (`git -C row.path`), which auto-resolves the shared real repo; prod worktrees
// and the prod DB are never written. A failed worktree is logged and skipped —
// it never aborts the whole launch.
const cloneWorktrees = ({
  log = console,
  devDataDir = DEV_DATA_DIR,
  legacyWorktreesDir = LEGACY_WORKTREES_DIR,
  devWorktreesDir = DEV_WORKTREES_DIR
} = {}) => {
  const dbPath = join(devDataDir, 'hive.db')
  const cloned = []
  const skipped = []
  // Two active worktrees can map to the SAME dev leaf — same project with an
  // identical leaf dir, or distinct foreign paths consolidated by basename
  // (mapWorktreeDevPath is intentionally pure, so it can't see siblings). Left
  // unresolved, the second clone's clearStaleDevWorktree wipes the first's
  // checkout and both DB rows end up pointing at one shared dir. Track every
  // assigned dev path and suffix any collision with the unique worktree id.
  const usedDevPaths = new Set()

  let rows
  try {
    rows = listActiveWorktrees(dbPath)
  } catch (error) {
    // Fatal: the copied DB still has every active worktree row pointing at the
    // OFFICIAL ~/.hive-worktrees paths. If we can't read them we can't rewrite or
    // archive them, so publishing the clone now would let dev list and operate on
    // the user's real worktrees, breaking the read-only isolation guarantee.
    // Throw so runClone rolls back the staging + dev dirs and the next run
    // re-prompts, rather than silently shipping a leaky DB.
    throw new Error(
      `could not read worktrees from ${dbPath} to isolate them: ${describeError(error)}`
    )
  }

  for (const row of rows) {
    try {
      if (!row.path) continue
      // A row already under ~/.hive-dev-worktrees can only have reached this DB
      // via cross-visibility import: the staged DB is a fresh copy of OFFICIAL,
      // and a prior dev refresh's worktree shows up in the shared repo, then gets
      // imported onto an official project refresh. It is NOT output of this clone
      // run, and a fresh sync rebuilds the dev tree from scratch — so preserving
      // it active would (a) leave a row whose dir we may be about to recreate,
      // escaping the missing-dir archive, and (b) skip collision tracking, so a
      // real worktree mapping to the same dev path could leave two active rows on
      // one checkout. Archive it (via skipped) so dev neither lists it nor races
      // a real clone for its path; the authoritative copy is re-cloned below.
      if (row.path === devWorktreesDir || row.path.startsWith(devWorktreesDir + sep)) {
        skipped.push({
          id: row.id,
          branch: row.branch_name,
          path: row.path,
          reason: 'imported dev-path row (cross-visibility); rebuilt from official'
        })
        continue
      }
      // Archived worktree whose dir is gone — nothing to copy.
      if (!existsSync(row.path)) {
        skipped.push({
          id: row.id,
          branch: row.branch_name,
          path: row.path,
          reason: 'directory missing'
        })
        continue
      }

      const headRef = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: row.path })
      if (headRef.status !== 0) {
        skipped.push({
          id: row.id,
          branch: row.branch_name,
          path: row.path,
          reason: `not a git worktree (${(headRef.stderr || '').trim()})`
        })
        continue
      }

      const headBranch = headRef.stdout.trim()
      const detached = headBranch === 'HEAD'
      let devPath = mapWorktreeDevPath(row.path, {
        legacyWorktreesDir,
        devWorktreesDir,
        projectName: row.project_name
      })
      if (usedDevPaths.has(devPath)) {
        const unique = `${devPath}--${row.id}`
        log.warn?.(
          `[dev] dev worktree path collision at ${tildify(devPath)}; ` +
            `cloning to ${tildify(unique)} instead`
        )
        devPath = unique
      }
      usedDevPaths.add(devPath)
      mkdirSync(dirname(devPath), { recursive: true })
      // Reclaim any leftover dev worktree dir/registration from a prior aborted run
      // so the add below recovers instead of failing on a pre-existing directory.
      clearStaleDevWorktree(row.path, devPath)

      let newBranch
      if (detached) {
        // No branch to fork — check out the same commit detached.
        const commit = runGit(['rev-parse', 'HEAD'], { cwd: row.path }).stdout.trim()
        const add = runGit(['worktree', 'add', '--detach', devPath, commit], { cwd: row.path })
        if (add.status !== 0) {
          skipped.push({
            id: row.id,
            branch: row.branch_name,
            path: row.path,
            reason: (add.stderr || '').trim()
          })
          continue
        }
        newBranch = row.branch_name // unchanged in DB
      } else {
        newBranch = devBranchName(headBranch)
        // -B creates-or-RESETS the hive-dev_ branch to the source commit. On a
        // re-seed (dev dir removed but the branch lingers in the real repo) this
        // produces a branch off the SAME commit instead of reattaching a stale
        // one — otherwise the rsync overlay below would surface as uncommitted
        // diff against an old HEAD rather than the clean clone the prompt promises.
        let add = runGit(['worktree', 'add', '-B', newBranch, devPath, headBranch], {
          cwd: row.path
        })
        if (add.status !== 0 && /already (used by|checked out)/i.test(add.stderr || '')) {
          // Stale registration from a prior dev worktree dir that was rm -rf'd.
          runGit(['worktree', 'prune'], { cwd: row.path })
          add = runGit(['worktree', 'add', '-B', newBranch, devPath, headBranch], { cwd: row.path })
        }
        if (add.status !== 0) {
          skipped.push({
            id: row.id,
            branch: row.branch_name,
            path: row.path,
            reason: (add.stderr || '').trim()
          })
          continue
        }
      }

      // Overlay the prod working tree (uncommitted + gitignored + untracked) onto
      // the freshly checked-out worktree. --delete mirrors uncommitted deletions
      // (so files deleted in the source aren't resurrected from the checkout);
      // --exclude=/.git is anchored to the transfer root so the worktree's own
      // .git file (created by `worktree add`, linking it to the SHARED repo) is
      // left intact while the rest of the tree — including submodule working
      // content — is copied.
      const rs = spawnSync(
        'rsync',
        ['-a', '--delete', '--exclude=/.git', `${row.path}/`, `${devPath}/`],
        { encoding: 'utf8' }
      )
      if (rs.status !== 0) {
        // The git checkout itself succeeded, so the worktree is on the right
        // branch/commit and fully isolated; only the working-tree overlay may be
        // incomplete. Keep it (it never points at prod), but say so loudly.
        log.warn?.(
          `[dev] rsync overlay incomplete for ${tildify(devPath)} (exit ${rs.status}); ` +
            `uncommitted/gitignored state may be partial: ${(rs.stderr || '').trim()}`
        )
      }

      // The copied submodule .git files still carry a `gitdir:` pointing at the
      // SOURCE worktree's module store (under official ~/.hive-worktrees or the
      // user's repo). Left in place, any git command run inside a dev submodule
      // would read/write the OFFICIAL metadata — breaking the read-only guarantee.
      // Drop those nested link files (the depth-1 root .git is kept) so dev
      // submodules are inert until re-inited dev-locally; the submodule working
      // content copied above is preserved.
      const neutralize = spawnSync(
        'find',
        [devPath, '-mindepth', '2', '-name', '.git', '-type', 'f', '-delete'],
        { encoding: 'utf8' }
      )
      if (neutralize.status !== 0) {
        log.warn?.(
          `[dev] could not neutralize submodule git links under ${tildify(devPath)}: ` +
            `${(neutralize.stderr || '').trim()}`
        )
      }

      sqlite3Exec(
        dbPath,
        `UPDATE worktrees SET path = ${sqlStr(devPath)}, branch_name = ${sqlStr(
          newBranch
        )}, branch_renamed = 1 WHERE id = ${sqlStr(row.id)};`
      )
      cloned.push({ id: row.id, branch: newBranch, path: devPath })
    } catch (error) {
      skipped.push({
        id: row.id,
        branch: row.branch_name,
        path: row.path,
        reason: describeError(error)
      })
    }
  }

  // A skipped row still points at its ORIGINAL (official/foreign) path in the
  // copied dev DB. Archiving it keeps dev from LISTING it, but that alone is not
  // enough: getWorktree()/db.worktree.get resolve a row by id WITHOUT filtering
  // status (src/main/db/database.ts getWorktree), so anything still holding this
  // worktree's id can fetch the archived row and read its still-official `path`.
  // Every surface that launches an agent from a worktree id is a leak vector:
  //   - Kanban jump-to-session reads kanban_tickets.worktree_id / current_session_id
  //   - SessionView resume reads sessions.worktree_id
  //   - a Discord message resolves discord_resources.worktree_id (discord-service.ts)
  // each then runs the agent against that path — i.e. the user's REAL checkout,
  // breaking read-only isolation. The schema declares these FKs ON DELETE SET
  // NULL (and ON DELETE CASCADE for discord), but we archive (not delete) the
  // row, so none of that fires. Null them ourselves: orphan every ticket / card
  // / session / Discord reference to a skipped worktree, then archive the row.
  // (Files on disk are left untouched.)
  for (const s of skipped) {
    if (s.id == null) continue
    const id = sqlStr(s.id)
    // Order matters: clear links that select this worktree via its sessions
    // BEFORE nulling sessions.worktree_id (those subqueries read it).
    const statements = [
      `UPDATE kanban_tickets SET current_session_id = NULL ` +
        `WHERE current_session_id IN (SELECT id FROM sessions WHERE worktree_id = ${id});`,
      `UPDATE markdown_kanban_card_state SET current_session_id = NULL ` +
        `WHERE current_session_id IN (SELECT id FROM sessions WHERE worktree_id = ${id});`,
      // Clear the Discord resource's managed-session link before its worktree_id
      // (both filter on worktree_id, so the worktree_id null must come last).
      `UPDATE discord_resources SET managed_session_id = NULL WHERE worktree_id = ${id};`,
      `UPDATE kanban_tickets SET worktree_id = NULL WHERE worktree_id = ${id};`,
      `UPDATE markdown_kanban_card_state SET worktree_id = NULL WHERE worktree_id = ${id};`,
      // Unlinking worktree_id makes discord-service.ts:handleUserMessage early-return
      // (`if (!provisionedChannel.worktree_id) return`) instead of resolving a path.
      `UPDATE discord_resources SET worktree_id = NULL WHERE worktree_id = ${id};`,
      `UPDATE sessions SET worktree_id = NULL WHERE worktree_id = ${id};`,
      `UPDATE worktrees SET status = 'archived' WHERE id = ${id};`
    ]
    for (const sql of statements) {
      try {
        sqlite3Exec(dbPath, sql)
      } catch (error) {
        log.warn?.(`[dev] could not isolate skipped worktree ${s.id}: ${describeError(error)}`)
      }
    }
  }

  return { cloned, skipped }
}

// Connection working dirs live under <dataDir>/connections, and connections.path
// stores that absolute location. cpSync copies the dir, but the copied DB rows
// still point at the OFFICIAL ~/.hive/connections; add/delete-member then create
// or remove symlinks (and rewrite AGENTS.md) there, mutating the official tree.
// Rewrite the column prefix to the dev copy so those ops stay isolated.
const rewriteConnectionPaths = (dbPath, { sourceDataDir, devDataDir }) => {
  const legacy = join(sourceDataDir, 'connections')
  const dev = join(devDataDir, 'connections')
  // substr-prefix compare (not LIKE) so a '_'/'%' in the home path can't mis-match.
  sqlite3Exec(
    dbPath,
    `UPDATE connections SET path = ${sqlStr(dev)} || substr(path, ${legacy.length + 1}) ` +
      `WHERE substr(path, 1, ${legacy.length}) = ${sqlStr(legacy)};`
  )
}

// Image ticket attachments are saved by saveAttachment() as ABSOLUTE paths under
// <dataDir>/attachments and stored verbatim in the attachments JSON of
// kanban_tickets / markdown_kanban_card_state (worktrees.attachments only holds
// external jira/figma URLs). cpSync copies the files into the dev tree, but the
// copied DB still points each image url at ~/.hive/attachments/… — so dev
// thumbnails read the OFFICIAL file and break if it is later removed or changed.
// Rewrite that prefix to the dev copy. Paths are embedded inside a JSON string so
// we replace() on the column text; the prefix includes a trailing '/attachments/'
// so it only matches real attachment paths (jira/figma URLs and the '.hive-dev'
// dir never contain it) and is a no-op on rows without it. Best-effort per table
// — an older DB missing a table/column must not abort the clone (unlike worktree
// isolation, a stale thumbnail path is a degraded read, not a read-only breach).
const rewriteAttachmentPaths = (dbPath, { sourceDataDir, devDataDir, log = console }) => {
  const legacy = join(sourceDataDir, 'attachments') + sep
  const dev = join(devDataDir, 'attachments') + sep
  for (const table of ['kanban_tickets', 'markdown_kanban_card_state', 'worktrees']) {
    try {
      sqlite3Exec(
        dbPath,
        `UPDATE ${table} SET attachments = replace(attachments, ${sqlStr(legacy)}, ${sqlStr(dev)});`
      )
    } catch (error) {
      log.warn?.(`[dev] could not rewrite attachment paths in ${table}: ${describeError(error)}`)
    }
  }
}

// Mirror of generateConnectionInstructions() in
// src/main/services/connection-service.ts. Each connection dir holds an AGENTS.md
// and a CLAUDE.md, generated from the connection's absolute path and each member's
// absolute worktree path. cpSync copies them verbatim, so the dev copies still
// embed the OFFICIAL connection path and official worktree paths — telling a dev
// agent to "ONLY work inside ~/.hive/connections/…" and listing real-repo paths,
// which would steer work straight back at the official checkout. We rebuild them
// from the staged (rewritten) DB below. Keep this template in sync with the source.
export const buildConnectionInstructions = (connectionPath, members) => {
  const sections = members.map(
    (m) => `### ${m.symlinkName}/
- **Project:** ${m.projectName}
- **Branch:** ${m.branchName}
- **Real path:** ${m.worktreePath}`
  )

  return `# Connected Worktrees

This workspace contains **symlinked** worktrees from multiple projects.
Each subdirectory is a symlink pointing to a real git repository on disk.

## IMPORTANT — Symlink Safety

- **Every subdirectory here is a symlink** to a real project. Edits you make here directly modify the original project files.
- **ONLY work on files inside this directory (\`${connectionPath}\`).** Do not navigate to or edit files using the real paths listed below.
- **Do NOT create commits, run git operations, or push changes** unless the user explicitly asks you to.
- Treat this workspace as a read/write view into the linked projects — not as your own repo to manage.

## Projects

${sections.join('\n\n')}
`
}

// A connection is a working dir full of symlinks (one per member worktree) that
// the cpSync copied verbatim — so every member symlink still points at the
// ORIGINAL worktree location, and connection_members is not filtered by worktree
// status. Left alone, opening a dev connection follows those links straight back
// to the official/foreign repo. Reconcile both cases against the staged DB+dir:
//   - cloned worktree  -> repoint its member symlinks at the new dev worktree;
//   - skipped worktree -> drop its member rows + stale symlinks so dev neither
//     lists it (archived above) nor can reach it through a connection.
// Best-effort per member: a failure is logged and never aborts the clone.
const reconcileConnections = ({ dbPath, stagingDir, devDataDir, cloned, skipped, log }) => {
  // connections.path was rewritten to the FINAL dev location, but the files still
  // live in the staging dir until the atomic rename — map the prefix back.
  const toStagingDir = (storedPath) =>
    storedPath === devDataDir || storedPath.startsWith(devDataDir + sep)
      ? stagingDir + storedPath.slice(devDataDir.length)
      : null
  const membersFor = (worktreeId) => {
    try {
      return sqlite3Query(
        dbPath,
        'SELECT cm.symlink_name AS symlink_name, c.path AS conn_path FROM connection_members cm ' +
          `JOIN connections c ON c.id = cm.connection_id WHERE cm.worktree_id = ${sqlStr(worktreeId)}`
      )
    } catch (error) {
      log.warn?.(
        `[dev] could not read connection members for ${worktreeId}: ${describeError(error)}`
      )
      return []
    }
  }

  for (const w of cloned) {
    if (w.id == null) continue
    for (const m of membersFor(w.id)) {
      const base = toStagingDir(m.conn_path)
      if (!base || !m.symlink_name) continue
      const link = join(base, m.symlink_name)
      try {
        rmSync(link, { force: true })
        symlinkSync(w.path, link, 'dir')
      } catch (error) {
        log.warn?.(
          `[dev] could not repoint connection link ${tildify(link)}: ${describeError(error)}`
        )
      }
    }
  }

  for (const s of skipped) {
    if (s.id == null) continue
    for (const m of membersFor(s.id)) {
      const base = toStagingDir(m.conn_path)
      if (!base || !m.symlink_name) continue
      try {
        rmSync(join(base, m.symlink_name), { force: true })
      } catch (error) {
        log.warn?.(
          `[dev] could not remove stale connection link for ${s.id}: ${describeError(error)}`
        )
      }
    }
    try {
      sqlite3Exec(dbPath, `DELETE FROM connection_members WHERE worktree_id = ${sqlStr(s.id)};`)
    } catch (error) {
      log.warn?.(`[dev] could not drop connection members for ${s.id}: ${describeError(error)}`)
    }
  }
}

// After symlinks + DB rows are reconciled, the copied AGENTS.md/CLAUDE.md in each
// connection dir still embed the official connection + worktree paths. Rebuild
// them from the staged DB (whose connection.path + member worktree.path columns
// now point at the dev tree) so a dev agent reading them is never directed back
// at the real checkout. Best-effort per connection — a failure is logged, never
// fatal. Connections with no surviving members regenerate with an empty Projects
// list, dropping any stale official paths the old file listed.
const regenerateConnectionInstructions = ({ dbPath, stagingDir, devDataDir, log }) => {
  const toStagingDir = (storedPath) =>
    storedPath === devDataDir || storedPath.startsWith(devDataDir + sep)
      ? stagingDir + storedPath.slice(devDataDir.length)
      : null

  let rows
  try {
    rows = sqlite3Query(
      dbPath,
      'SELECT c.id AS conn_id, c.path AS conn_path, cm.symlink_name AS symlink_name, ' +
        'w.path AS worktree_path, w.branch_name AS branch_name, p.name AS project_name ' +
        'FROM connections c ' +
        'LEFT JOIN connection_members cm ON cm.connection_id = c.id ' +
        'LEFT JOIN worktrees w ON w.id = cm.worktree_id ' +
        'LEFT JOIN projects p ON p.id = cm.project_id ' +
        "WHERE c.status = 'active' ORDER BY c.id, cm.added_at"
    )
  } catch (error) {
    log.warn?.(
      `[dev] could not read connections to regenerate instructions: ${describeError(error)}`
    )
    return
  }

  const byConn = new Map()
  for (const r of rows) {
    if (!byConn.has(r.conn_id)) byConn.set(r.conn_id, { path: r.conn_path, members: [] })
    if (r.symlink_name) {
      byConn.get(r.conn_id).members.push({
        symlinkName: r.symlink_name,
        projectName: r.project_name,
        branchName: r.branch_name,
        worktreePath: r.worktree_path
      })
    }
  }

  for (const { path: connPath, members } of byConn.values()) {
    const base = toStagingDir(connPath)
    if (!base || !existsSync(base)) continue
    const content = buildConnectionInstructions(connPath, members)
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        writeFileSync(join(base, file), content, 'utf8')
      } catch (error) {
        log.warn?.(
          `[dev] could not regenerate ${file} for ${tildify(connPath)}: ${describeError(error)}`
        )
      }
    }
  }
}

const runClone = ({
  log = console,
  sourceDataDir = LEGACY_DATA_DIR,
  devDataDir = DEV_DATA_DIR,
  legacyWorktreesDir = LEGACY_WORKTREES_DIR,
  devWorktreesDir = DEV_WORKTREES_DIR
} = {}) => {
  log.log?.(`[dev] cloning ${tildify(sourceDataDir)} → ${tildify(devDataDir)} …`)

  // Stage the copy in a sibling .partial dir and only publish it with an atomic
  // rename once everything succeeds. A mid-clone failure (disk full, permission,
  // interruption) therefore never leaves a half-populated ~/.hive-dev that the
  // existsSync gate would mistake for a finished setup — the next run re-prompts.
  const stagingDir = devDataDir + '.partial'
  rmSync(stagingDir, { recursive: true, force: true })

  try {
    // Full copy: db (incl. -wal/-shm), logs, attachments, project-icons,
    // connections, custom-commands. The source is only read.
    cpSync(sourceDataDir, stagingDir, { recursive: true })

    // Rewrite copied rows to the FINAL dev paths (staging is renamed to devDataDir
    // below, so connections + worktrees end up consistent once published).
    rewriteConnectionPaths(join(stagingDir, 'hive.db'), { sourceDataDir, devDataDir })
    rewriteAttachmentPaths(join(stagingDir, 'hive.db'), { sourceDataDir, devDataDir, log })

    const { cloned, skipped } = cloneWorktrees({
      log,
      devDataDir: stagingDir,
      legacyWorktreesDir,
      devWorktreesDir
    })

    if (cloned.length) {
      log.log?.(`[dev] cloned ${cloned.length} worktree(s):`)
      for (const w of cloned) log.log?.(`        ${w.branch}  →  ${tildify(w.path)}`)
    } else {
      log.log?.('[dev] no worktrees cloned.')
    }
    if (skipped.length) {
      log.warn?.(`[dev] skipped ${skipped.length} worktree(s) (archived in dev DB):`)
      for (const w of skipped) log.warn?.(`        ${w.branch ?? '?'} — ${w.reason}`)
    }

    // Repoint/clean connection member symlinks against the staged copy so dev
    // connections never follow a link back to the official or foreign repo.
    reconcileConnections({
      dbPath: join(stagingDir, 'hive.db'),
      stagingDir,
      devDataDir,
      cloned,
      skipped,
      log
    })

    // The connection dirs' AGENTS.md/CLAUDE.md were copied verbatim and still
    // embed the official connection + worktree paths; regenerate them from the
    // staged DB so a dev agent is never told to work in the real checkout.
    regenerateConnectionInstructions({
      dbPath: join(stagingDir, 'hive.db'),
      stagingDir,
      devDataDir,
      log
    })

    renameSync(stagingDir, devDataDir)
    log.log?.(`[dev] done. Official ${tildify(sourceDataDir)} left untouched.`)
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true })
    rmSync(devDataDir, { recursive: true, force: true })
    throw error
  }
}

// Called before build:server so the dev answers the prompt up front instead of
// waiting behind a build. No-op once ~/.hive-dev exists.
export const ensureDevDataReady = async ({ log = console } = {}) => {
  if (existsSync(DEV_DATA_DIR)) return

  if (!process.stdin.isTTY) {
    mkdirSync(DEV_DATA_DIR, { recursive: true })
    log.log?.('[dev] non-interactive shell (no TTY) → starting fresh with an empty dev database.')
    return
  }

  // The clone flow is macOS-only: it quits the official app via `osascript` and
  // detects it via `pgrep` against the .app bundle path, and the seeded paths it
  // rewrites are POSIX. On Windows/Linux those primitives don't exist (and
  // isOfficialAppRunning would falsely report "not running", risking a torn copy
  // of a live SQLite tree), so we skip cloning and start fresh. Isolation still
  // holds everywhere — HIVE_DATA_DIR/HIVE_WORKTREES_DIR are pinned to the dev
  // dirs regardless of platform; only the convenience one-time clone is skipped.
  if (process.platform !== 'darwin') {
    mkdirSync(DEV_DATA_DIR, { recursive: true })
    log.log?.(
      `[dev] cloning the official app is macOS-only (current platform: ${process.platform}) → ` +
        'starting fresh with an empty, isolated dev database.'
    )
    return
  }

  // Defensive: the clone reads/writes the DB through the system `sqlite3` CLI.
  // If it's missing, fall back to fresh rather than throwing mid-clone (which
  // would roll back and exit). Recovery: install sqlite3, then `rm -rf
  // ~/.hive-dev` and re-run `pnpm dev` to get the clone prompt again.
  if (!sqlite3Available()) {
    mkdirSync(DEV_DATA_DIR, { recursive: true })
    log.log?.(
      '[dev] `sqlite3` CLI not found on PATH → starting fresh with an empty, isolated dev ' +
        'database. To clone official data instead, install sqlite3, then `rm -rf ~/.hive-dev` ' +
        'and re-run `pnpm dev`.'
    )
    return
  }

  if (!existsSync(join(LEGACY_DATA_DIR, 'hive.db'))) {
    mkdirSync(DEV_DATA_DIR, { recursive: true })
    log.log?.(
      `[dev] no official data found at ${tildify(LEGACY_DATA_DIR)} → starting fresh with an empty dev database.`
    )
    return
  }

  printSyncPrompt(log)
  const choice = parseSyncAnswer(await ask('> '))
  if (choice === 'fresh') {
    mkdirSync(DEV_DATA_DIR, { recursive: true })
    log.log?.('[dev] starting fresh with an empty dev database.')
    return
  }

  printQuitPrompt(log)
  if (!parseQuitAnswer(await ask('> '))) {
    log.log?.('[dev] Cancelled — official app left running, nothing copied. Exiting.')
    process.exit(0)
  }

  log.log?.('[dev] Quitting official Hive…')
  quitOfficialApp()
  if (!(await waitUntilOfficialAppGone({ log }))) {
    // The whole point of the gate is a quiescent SQLite + worktree snapshot.
    // If the app won't quit, refuse rather than silently clone a torn DB.
    log.log?.(
      '[dev] Official Hive app is still running — aborting to avoid a torn snapshot. ' +
        'Quit it manually, then run `pnpm dev` again. Nothing copied.'
    )
    process.exit(0)
  }
  runClone({ log })
}
