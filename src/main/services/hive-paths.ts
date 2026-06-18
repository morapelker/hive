import { homedir } from 'os'
import { join, resolve } from 'path'

// Single source of truth for where Hive keeps its user data on disk.
//
// Historically every call site hardcoded `~/.hive` (and `~/.hive-worktrees`),
// which meant `pnpm dev` and the installed desktop app shared one database and
// one set of resource folders — running both at once raced the same SQLite
// file. Routing every path through these helpers lets a single env var
// (HIVE_DATA_DIR) relocate the whole tree, so dev can run against ~/.hive-dev
// in complete isolation from the daily app.
//
// IMPORTANT: keep this module dependency-free (only `os` + `path`). It is
// imported by logger.ts, which nearly everything else imports — pulling in any
// other internal module here risks an import cycle.

const DEFAULT_DATA_DIR_NAME = '.hive'
const DEFAULT_WORKTREES_DIR_NAME = '.hive-worktrees'

// Root for the Hive data tree (DB, logs, attachments, icons, connections, ...).
// Resolution order, first match wins:
//   1. HIVE_DATA_DIR — explicit override (set by `pnpm dev` -> ~/.hive-dev). The
//                      desktop main process and its spawned server child both
//                      inherit it, so they agree without any other coupling.
//   2. ~/.hive       — default for the installed/daily app.
//
// We deliberately do NOT key off HIVE_SERVER_BASE_DIR here: that var is also set
// in standalone server/browser mode, and following it would silently relocate
// these resource folders away from the historical ~/.hive. Desktop already pins
// the database via HIVE_SERVER_DB_PATH, so it needs no help from this function.
export function getHiveDataDir(): string {
  const explicit = process.env.HIVE_DATA_DIR?.trim()
  if (explicit) return resolve(explicit)

  return join(homedir(), DEFAULT_DATA_DIR_NAME)
}

export function getHiveDbPath(): string {
  return join(getHiveDataDir(), 'hive.db')
}

export function getHiveLogsDir(): string {
  return join(getHiveDataDir(), 'logs')
}

export function getHiveAttachmentsDir(): string {
  return join(getHiveDataDir(), 'attachments')
}

export function getHiveProjectIconsDir(): string {
  return join(getHiveDataDir(), 'project-icons')
}

export function getHiveConnectionsDir(): string {
  return join(getHiveDataDir(), 'connections')
}

export function getHiveCustomCommandsFile(): string {
  return join(getHiveDataDir(), 'custom-commands.json')
}

// Git worktrees live in a sibling of the data dir (~/.hive-worktrees by
// default) rather than inside it. HIVE_WORKTREES_DIR relocates them so dev runs
// don't drop worktrees next to the daily app's.
export function getHiveWorktreesDir(): string {
  const explicit = process.env.HIVE_WORKTREES_DIR?.trim()
  if (explicit) return resolve(explicit)

  return join(homedir(), DEFAULT_WORKTREES_DIR_NAME)
}
