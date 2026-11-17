// Repointing the database at a project folder that moved ("Move projects" under Settings ›
// General › Dev folder). `DatabaseService.relocateProject` runs `relocateProjectRows` inside
// one immediate transaction; this module works on the raw better-sqlite3 handle.
//
// Order matters. Every row is read and every new value computed BEFORE the folders are put in
// place (`input.place()`), and only then written: a database that cannot be locked or read
// fails while the disk is untouched, and a failure after `place()` rolls the transaction back
// and rethrows, so the caller puts the folders back.
//
// The writes are raw UPDATEs on purpose. They publish no `db:changed` event (the caller
// publishes once git is repaired and the folder is usable again) and they leave every
// `updated_at` alone: a path that followed its folder is not an edit.
//
// Three kinds of value, each rewritten its own way:
// - a whole path (a worktree path, an attachment that is a file path): the old folder is
//   swapped for the new one as a prefix that ends at a segment boundary, so `/x/app` never
//   touches `/x/app2`, `/x/app 2` or `/x/app.old`;
// - free text (scripts, prompts, descriptions): `rewritePaths`, which finds whole paths inside
//   text, also given the `~/…`, `$HOME/…` and `${HOME}/…` spellings of a folder under home and
//   the backslash-escaped spelling of each (`~/My\ Projects/app`);
// - a JSON column: parsed, the named fields rewritten, stringified again. A column that does
//   not parse is left exactly as it is: a text replace over raw JSON breaks it as soon as a
//   path holds a quote or a backslash.
//
// Deliberately left alone, because they are prose or belong to someone else:
// `projects.description`, `worktrees.context`, a ticket's `note` and `goal_success_criteria`,
// follow-up messages, `document_runs.config`, run events, session transcripts, markdown card
// files and anything inside the checkout.
import { posix } from 'node:path'

import type Database from 'better-sqlite3'

import { rewritePaths } from '@shared/lib/path-rewrite'
import {
  SHELL_COMMAND_RUN_STATES,
  isShellCommandRunActive,
  parseSessionShellCommand,
  validateShellCommand,
  type ShellCommandRunState
} from '@shared/lib/shell-commands'
import { isAbsoluteFolderPath } from '@shared/types/dev-folder'
import { validateMarkdownConfigShape } from '../services/kanban-markdown-paths'
import {
  DEV_FOLDER_PENDING_MOVE_KEY,
  type PendingDevFolderMove,
  type RelocateProjectInput,
  type RelocateProjectResult,
  type RelocationMove
} from '../services/dev-folder/types'
import type { KanbanMarkdownConfig } from './types'

/** What `relocateProjectRows` reports; the caller adds the project row, read back. */
export type RelocatedRows = Omit<RelocateProjectResult, 'project'>

// ── Paths ───────────────────────────────────────────────────────────────────────────────

/**
 * A drive-letter or UNC spelling. There a backslash separates segments as well as a slash
 * (git prints `C:/dev/app/x` for a folder stored as `C:\dev\app`); in a POSIX path a
 * backslash is an ordinary character of a name.
 */
const isWindowsSpelling = (path: string): boolean => !path.startsWith('/')

const stripTrailingSeparators = (path: string): string =>
  path.replace(isWindowsSpelling(path) ? /[\\/]+$/ : /\/+$/, '')

/**
 * What follows `folder` in `value`: '' when `value` is the folder itself, the rest (starting
 * at its separator) when it is a path below it, null when it is neither. Never a pattern
 * match: `_` and `%` in a folder name are just characters.
 */
const restBelow = (value: string, folder: string): string | null => {
  if (!value.startsWith(folder)) return null
  if (value.length === folder.length) return ''
  const next = value[folder.length]
  if (next === '/' || (next === '\\' && isWindowsSpelling(folder))) {
    return value.slice(folder.length)
  }
  return null
}

/** One spelling of a folder that moved, and where that folder is now. */
interface MovedSpelling {
  readonly from: string
  readonly to: string
  /** Position among the spellings of its folder: 0 is the one the database stores. */
  readonly rank: number
}

interface MovedFolders {
  /** Every old spelling of every folder that moved, longest first. */
  readonly spellings: readonly MovedSpelling[]
  /** `projects.path` after the move. */
  readonly projectPath: string
}

interface PathRewriter extends MovedFolders {
  /** Where a whole-path value is now, when it is a moved folder or a path below one. */
  readonly locate: (value: string) => { readonly path: string; readonly rank: number } | null
  /** A whole-path value, repointed when it is a moved folder or below one; else as given. */
  readonly swapPrefix: (value: string) => string
  /** The same for a path that may be spelled `~/…`: it keeps that spelling when it can. */
  readonly swapHomePath: (value: string) => string
  /** Free text with every whole path of a moved folder replaced. */
  readonly rewriteText: (text: string) => string
  /** Every string `rewriteText` looks for. */
  readonly needles: readonly string[]
}

/** The folders that move, each under every spelling it is known by. */
const movedFoldersOf = (input: RelocateProjectInput): MovedFolders => {
  const checkout: RelocationMove | undefined = input.relocations[0]
  if (!checkout) throw new Error('There is no folder to move the project to.')

  const spellings: MovedSpelling[] = []
  const seen = new Set<string>()
  input.relocations.forEach((relocation, index) => {
    const to = stripTrailingSeparators(relocation.to)
    if (to === '') throw new Error('A folder cannot be moved to an empty path.')
    // The checkout is known by the path the project row holds, whatever else it is called.
    const olds = index === 0 ? [input.expectedPath, ...relocation.from] : relocation.from
    olds.forEach((old, rank) => {
      const from = stripTrailingSeparators(old)
      if (from === '' || from === to || seen.has(from)) return
      seen.add(from)
      spellings.push({ from, to, rank })
    })
  })
  // The most specific folder wins when one spelling is the start of another.
  spellings.sort((a, b) => b.from.length - a.from.length)
  return { spellings, projectPath: stripTrailingSeparators(checkout.to) }
}

/** How a script spells the home directory in front of a path. */
const HOME_SPELLINGS = ['~', '$HOME', '${HOME}'] as const

const safeEncodeUri = (value: string): string | null => {
  try {
    return encodeURI(value)
  } catch {
    return null
  }
}

/** A path as an unquoted shell word: a backslash before every character a shell reads. */
const shellEscaped = (value: string): string => value.replace(/[^A-Za-z0-9_./~+:@%,=${}-]/g, '\\$&')

/** Characters no path or script holds; one that is absent marks the text set aside below. */
const SENTINELS = [0xe000, 0xe001, 0xe002, 0xe003].map((code) => String.fromCharCode(code))

/**
 * `text` with every occurrence of `forms` set aside behind a marker, and the way back.
 * Null when no marker is free (the text holds every sentinel): then nothing is safe to do.
 * A marker ends in `_`, a character that continues a name, so what directly follows a
 * folder set aside (`/x/app 2` + `/x/app`, a folder inside it) is not read as a path either.
 */
const setAside = (
  text: string,
  forms: readonly string[],
  avoid: string
): { readonly text: string; readonly restore: (rewritten: string) => string } | null => {
  const present = forms.filter((form) => text.includes(form))
  if (present.length === 0) return { text, restore: (rewritten) => rewritten }
  const sentinel = SENTINELS.find((mark) => !text.includes(mark) && !avoid.includes(mark))
  if (sentinel === undefined) return null
  let masked = text
  const markers = present.map((form, index) => {
    const marker = `${sentinel}${index}_`
    masked = masked.split(form).join(marker)
    return { form, marker }
  })
  return {
    text: masked,
    restore: (rewritten) =>
      markers.reduce((restored, { form, marker }) => restored.split(marker).join(form), rewritten)
  }
}

/**
 * The rewriter for one move. `neighbours` are the registered folders whose path merely
 * starts with a moved one (`/x/app 2` next to `/x/app`): whole-path values never confuse the
 * two, but in free text a space, a bracket or an accented letter ends a path, so there they
 * are set aside before `rewritePaths` runs and put back after.
 */
const createPathRewriter = (
  moved: MovedFolders,
  homeDir: string,
  neighbours: readonly string[]
): PathRewriter => {
  const { spellings } = moved
  const locate: PathRewriter['locate'] = (value) => {
    for (const { from, to, rank } of spellings) {
      const rest = restBelow(value, from)
      if (rest !== null) return { path: to + rest, rank }
    }
    return null
  }
  const swapPrefix = (value: string): string => locate(value)?.path ?? value

  // A script reaches a folder under home as `~/dev/app` or `"$HOME/dev/app"` as often as by
  // its absolute path. Those spellings go to the same spelling of the new folder when that is
  // under home too, and to its absolute path otherwise.
  const home = stripTrailingSeparators(homeDir)
  const homeSpellingsOf = (path: string): string[] => {
    const rest = home === '' ? null : restBelow(path, home)
    return rest ? HOME_SPELLINGS.map((spelling) => spelling + rest) : []
  }
  const textMap: Record<string, string> = {}
  for (const { from, to } of spellings) textMap[from] = to
  for (const { from, to } of spellings) {
    const targets = homeSpellingsOf(to)
    homeSpellingsOf(from).forEach((key, index) => {
      if (!(key in textMap)) textMap[key] = targets[index] ?? to
    })
  }
  // An unquoted shell word spells a folder with a backslash before a space or a bracket
  // (`cd ~/My\ Projects/app`). That spelling goes to the same spelling of the new folder.
  for (const [key, value] of Object.entries(textMap)) {
    const escaped = shellEscaped(key)
    if (escaped !== key && !(escaped in textMap)) textMap[escaped] = shellEscaped(value)
  }

  // `rewritePaths` also tries the percent-encoded form of each key (`file://` urls).
  const needles = [
    ...new Set(
      Object.keys(textMap).flatMap((key) => {
        const encoded = safeEncodeUri(key)
        return encoded !== null && encoded !== key ? [key, encoded] : [key]
      })
    )
  ]
  // How text can spell a neighbour: under each spelling of the folder it sits next to (it is
  // registered under one, a script may use another), from home, percent-encoded, shell-escaped.
  const neighbourForms = [
    ...new Set(
      neighbours
        .flatMap((neighbour) => {
          const beside = spellings.find((spelling) => neighbour.startsWith(spelling.from))
          if (!beside) return [neighbour]
          const tail = neighbour.slice(beside.from.length)
          return spellings
            .filter((spelling) => spelling.to === beside.to)
            .map((spelling) => spelling.from + tail)
        })
        .flatMap((neighbour) => [neighbour, ...homeSpellingsOf(neighbour)])
        .flatMap((form) => {
          const encoded = safeEncodeUri(form)
          return [form, shellEscaped(form), ...(encoded === null ? [] : [encoded])]
        })
    )
  ].sort((a, b) => b.length - a.length)
  const replacements = Object.values(textMap).join('\n')

  const rewriteText = (text: string): string => {
    // The cheap test first: most text names no moved folder, and some of it is long (a pasted
    // image kept as a data url), which `rewritePaths` would walk one character at a time.
    if (!needles.some((needle) => text.includes(needle))) return text
    const aside = setAside(text, neighbourForms, replacements)
    return aside === null ? text : aside.restore(rewritePaths(aside.text, textMap))
  }

  const swapHomePath = (value: string): string => {
    const swapped = swapPrefix(value)
    if (swapped !== value || home === '' || !value.startsWith('~/')) return swapped
    const expanded = home + value.slice(1)
    const relocated = swapPrefix(expanded)
    if (relocated === expanded) return value
    const rest = restBelow(relocated, home)
    return rest ? `~${rest}` : relocated
  }

  return { ...moved, locate, swapPrefix, swapHomePath, rewriteText, needles }
}

// ── JSON columns ────────────────────────────────────────────────────────────────────────
// Every helper returns the value it was given (the same reference) when nothing changed, so
// "did this column change" is one identity check and an untouched column is never rewritten.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** JSON never parses to `undefined`, so that is what a column that does not parse reads as. */
const parseJson = (raw: unknown): unknown => {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** The column with `change` applied to its parsed value; the stored text when nothing changed. */
const rewriteJsonColumn = (
  raw: string | null,
  change: (value: unknown) => unknown
): string | null => {
  const parsed = parseJson(raw)
  if (parsed === undefined) return raw
  const next = change(parsed)
  return next === parsed ? raw : JSON.stringify(next)
}

/** `record` with the string under `key` changed; other value types are not paths. */
const withString = (
  record: Record<string, unknown>,
  key: string,
  change: (value: string) => string
): Record<string, unknown> => {
  const current = record[key]
  if (typeof current !== 'string') return record
  const next = change(current)
  return next === current ? record : { ...record, [key]: next }
}

/** `record` with the object under `key` changed. */
const withRecord = (
  record: Record<string, unknown>,
  key: string,
  change: (value: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> => {
  const current = record[key]
  if (!isRecord(current)) return record
  const next = change(current)
  return next === current ? record : { ...record, [key]: next }
}

/** An array with `change` applied to each of its object entries. */
const mapRecords = (
  value: unknown,
  change: (entry: Record<string, unknown>) => Record<string, unknown>
): unknown => {
  if (!Array.isArray(value)) return value
  let changed = false
  const next = value.map((entry: unknown) => {
    if (!isRecord(entry)) return entry
    const rewritten = change(entry)
    if (rewritten !== entry) changed = true
    return rewritten
  })
  return changed ? next : value
}

/** An array with `change` applied to each of its strings. */
const mapStrings = (value: unknown, change: (entry: string) => string): unknown => {
  if (!Array.isArray(value)) return value
  let changed = false
  const next = value.map((entry: unknown) => {
    if (typeof entry !== 'string') return entry
    const rewritten = change(entry)
    if (rewritten !== entry) changed = true
    return rewritten
  })
  return changed ? next : value
}

/** `projects.custom_commands`: [{ id, name, prompt }]. Only the prompt is text about paths. */
const rewriteCustomCommands = (value: unknown, rewriter: PathRewriter): unknown =>
  mapRecords(value, (command) => withString(command, 'prompt', rewriter.rewriteText))

/**
 * `projects.shell_commands`: [{ id, name, commands, keepRunningOnQuit? }]. Only `commands`: a
 * name that happens to hold a path stays as typed. A definition the rewrite would make
 * invalid (a longer path can push the script over its size limit) is dropped when the row is
 * read, so it is kept as it was instead.
 */
const rewriteShellCommands = (value: unknown, rewriter: PathRewriter): unknown =>
  mapRecords(value, (command) => {
    const rewritten = withString(command, 'commands', rewriter.rewriteText)
    return rewritten === command || validateShellCommand(rewritten).valid ? rewritten : command
  })

/** Where a project is before and after the move: the same place for a project that stays. */
interface ProjectPlace {
  readonly before: string
  readonly after: string
}

/** Whether a board folder given relative to its project leads out of the project (`../boards`). */
const leavesProject = (folder: string): boolean => {
  const normalized = posix.normalize(folder)
  return normalized === '..' || normalized.startsWith('../')
}

/**
 * `projects.kanban_markdown_config`: the folders a board reads its cards from, absolute or
 * relative to the project. The stored text is kept whenever it still leads to the card files
 * after the move, which is every folder inside the project that moves, however that project's
 * path is spelled. It stops doing so in three cases, and the folder is then stored as the
 * absolute path of where the card files are now: an absolute folder inside what moved; a
 * relative one that leads out of the project that moved (`../boards/app`, a folder that stayed
 * behind); a relative one of another project that leads into what moved (`../app/docs/kanban`,
 * or `app/docs/kanban` when the project that moved sat inside that other project). A board
 * that cannot find its folder lists no cards, and the app then forgets what it keeps about
 * every one of them.
 *
 * A config that would not validate afterwards reads as the default folders, which orphans
 * every card too, so such a column is left as it is.
 */
const rewriteMarkdownConfig = (
  value: unknown,
  rewriter: PathRewriter,
  place: ProjectPlace
): unknown => {
  if (!isRecord(value)) return value
  // Joining is done the POSIX way: below a drive-letter path a relative folder stays as typed.
  const joinable = !isWindowsSpelling(place.before) && !isWindowsSpelling(place.after)
  // A folder inside a project that moves goes with it. That is settled without joining: a
  // join tidies the project's path, which is then no longer found among the folders that moved.
  const movesAlong = (stored: string): boolean =>
    place.before !== place.after && !leavesProject(stored)
  const folder = (stored: string): string => {
    if (isAbsoluteFolderPath(stored)) return rewriter.swapPrefix(stored)
    if (!joinable || movesAlong(stored)) return stored
    // Where the card files are now, against where the stored text would look for them.
    const now = rewriter.swapPrefix(posix.join(place.before, stored))
    return now === posix.join(place.after, stored) ? stored : now
  }
  const next = withRecord(withString(value, 'singleFolder', folder), 'statusFolders', (folders) =>
    Object.keys(folders).reduce((acc, key) => withString(acc, key, folder), folders)
  )
  if (next === value) return value
  try {
    validateMarkdownConfigShape(next as KanbanMarkdownConfig)
  } catch {
    return value
  }
  return next
}

/**
 * Ticket and card attachments: [{ type, url, label }]. A dropped file is a plain absolute
 * path (a whole-path value); anything else (`file://` urls, links) is searched as text.
 */
const rewriteAttachments = (value: unknown, rewriter: PathRewriter): unknown =>
  mapRecords(value, (attachment) =>
    withString(attachment, 'url', (url) =>
      isAbsoluteFolderPath(url) ? rewriter.swapPrefix(url) : rewriter.rewriteText(url)
    )
  )

/** A queued launch (`pending_launch_config`): its prompt is sent as written when it starts. */
const rewritePendingLaunch = (value: unknown, rewriter: PathRewriter): unknown =>
  isRecord(value) ? withString(value, 'prompt', rewriter.rewriteText) : value

/** `document_runs.members`: the member checkouts of a run on a connection project. */
const rewriteRunMembers = (value: unknown, rewriter: PathRewriter): unknown =>
  mapRecords(value, (member) =>
    withString(
      withString(member, 'project_path', rewriter.swapPrefix),
      'integration_worktree_path',
      rewriter.swapPrefix
    )
  )

/**
 * `sessions.shell_command`: the script "Run again" executes. A run that has not finished is
 * skipped: the main process owns its snapshot and writes it back whole. A missing or unknown
 * state reads as pending, as the app reads it.
 */
const rewriteSessionShellCommand = (value: unknown, rewriter: PathRewriter): unknown => {
  if (!isRecord(value)) return value
  const state: ShellCommandRunState = (SHELL_COMMAND_RUN_STATES as readonly unknown[]).includes(
    value.state
  )
    ? (value.state as ShellCommandRunState)
    : 'pending'
  if (isShellCommandRunActive(state)) return value
  const rewritten = withString(value, 'script', rewriter.rewriteText)
  // A snapshot the app can no longer read (a script past its size limit) is worse than a
  // stale path.
  return rewritten === value || parseSessionShellCommand(rewritten) !== null ? rewritten : value
}

/**
 * `data_projects.config`: the SQLite file and the certificate / key files a connection reads.
 * They are expanded from `~/…` when used, so that spelling is recognised and kept.
 */
const rewriteDataProjectConfig = (value: unknown, rewriter: PathRewriter): unknown => {
  if (!isRecord(value)) return value
  const withPaths = (
    record: Record<string, unknown>,
    keys: readonly string[]
  ): Record<string, unknown> =>
    keys.reduce((acc, key) => withString(acc, key, rewriter.swapHomePath), record)
  const withFile = withPaths(value, ['filePath'])
  const withSsl = withRecord(withFile, 'ssl', (ssl) =>
    withPaths(ssl, ['caPath', 'certPath', 'keyPath'])
  )
  return withRecord(withSsl, 'ssh', (ssh) => withPaths(ssh, ['privateKeyPath']))
}

// ── What else is registered in a folder ─────────────────────────────────────────────────

interface RegisteredEntry {
  /** The project's name: for a worktree, the project it belongs to. */
  readonly name: string
  readonly path: string
}

/**
 * Other projects, and active worktrees of other projects, registered in one of `folders`:
 * below it, and with `orAt` also at the folder itself. An archived worktree row is history,
 * not a folder on disk, and does not count. SQL narrows by prefix, the segment boundary is
 * checked here.
 */
const registeredIn = (
  db: Database.Database,
  folders: readonly string[],
  exceptProjectId: string,
  orAt: boolean
): RegisteredEntry[] => {
  const spellings = [...new Set(folders.map(stripTrailingSeparators))].filter(
    (folder) => folder !== ''
  )
  if (spellings.length === 0) return []
  const inside = (path: string): boolean =>
    spellings.some((folder) => {
      const rest = restBelow(stripTrailingSeparators(path), folder)
      return rest !== null && (orAt || rest !== '')
    })
  const folderList = JSON.stringify(spellings)
  const projects = db
    .prepare(
      `SELECT p.name AS name, p.path AS path FROM projects p
        WHERE p.id <> ?
          AND EXISTS (SELECT 1 FROM json_each(?) AS folder WHERE instr(p.path, folder.value) = 1)
        ORDER BY p.sort_order ASC, p.name ASC`
    )
    .all(exceptProjectId, folderList) as RegisteredEntry[]
  const worktrees = db
    .prepare(
      `SELECT p.name AS name, w.path AS path FROM worktrees w
         JOIN projects p ON p.id = w.project_id
        WHERE w.project_id <> ? AND w.status = 'active'
          AND EXISTS (SELECT 1 FROM json_each(?) AS folder WHERE instr(w.path, folder.value) = 1)
        ORDER BY p.sort_order ASC, p.name ASC`
    )
    .all(exceptProjectId, folderList) as RegisteredEntry[]
  return [...projects, ...worktrees].filter((entry) => inside(entry.path))
}

/**
 * Names of the other projects registered strictly below `folderSpellings` (any spelling of
 * one folder), themselves or through one of their active worktrees. Each name once.
 */
export const namesRegisteredInside = (
  db: Database.Database,
  folderSpellings: readonly string[],
  exceptProjectId: string
): string[] => [
  ...new Set(registeredIn(db, folderSpellings, exceptProjectId, false).map((entry) => entry.name))
]

/**
 * Registered folders (of any project, archived worktrees included) whose path starts with the
 * spelling of a moved folder without being that folder or inside it: `/x/app 2` and
 * `/x/app-old` next to `/x/app`. Free text must not mistake them for the folder that moved.
 */
const neighboursOf = (db: Database.Database, moved: MovedFolders): string[] => {
  const folders = JSON.stringify(moved.spellings.map((spelling) => spelling.from))
  const startsWithMovedFolder = (column: string): string =>
    `EXISTS (SELECT 1 FROM json_each(@folders) AS folder WHERE instr(${column}, folder.value) = 1)`
  const rows = db
    .prepare(
      `SELECT p.path AS path FROM projects p WHERE ${startsWithMovedFolder('p.path')}
        UNION
       SELECT w.path AS path FROM worktrees w WHERE ${startsWithMovedFolder('w.path')}`
    )
    .all({ folders }) as { path: string }[]
  return rows
    .map((row) => stripTrailingSeparators(row.path))
    .filter((path) => moved.spellings.every((spelling) => restBelow(path, spelling.from) === null))
}

// ── The pending-move row ────────────────────────────────────────────────────────────────

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== ''

/** The stored value, or null when it is not one this code wrote. Never throws. */
const parsePendingDevFolderMove = (raw: string): PendingDevFolderMove | null => {
  const value = parseJson(raw)
  if (!isRecord(value)) return null
  const { projectId, fromPath, fromRealPath, toPath, relocations, copiedFrom } = value
  if (!isNonEmptyString(projectId) || !isNonEmptyString(fromPath) || !isNonEmptyString(toPath)) {
    return null
  }
  if (fromRealPath !== null && fromRealPath !== undefined && !isNonEmptyString(fromRealPath)) {
    return null
  }
  if (!Array.isArray(relocations)) return null
  const moves: RelocationMove[] = []
  for (const relocation of relocations as unknown[]) {
    if (!isRecord(relocation) || !isNonEmptyString(relocation.to)) return null
    const from: unknown = relocation.from
    if (!Array.isArray(from) || from.length === 0 || !from.every(isNonEmptyString)) return null
    moves.push({ from: [...from], to: relocation.to })
  }
  // Only a move to another volume writes the old folders it copied. A value that is not a
  // list of paths is dropped and the rest of the row still read: the steps owed matter more.
  const copied =
    Array.isArray(copiedFrom) && copiedFrom.every((entry) => typeof entry === 'string')
      ? { copiedFrom: [...(copiedFrom as string[])] }
      : {}
  return {
    projectId,
    fromPath,
    fromRealPath: fromRealPath ?? null,
    toPath,
    relocations: moves,
    ...copied
  }
}

/** The move whose follow-up steps are still owed, when there is one. */
export const readPendingDevFolderMove = (db: Database.Database): PendingDevFolderMove | null => {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(DEV_FOLDER_PENDING_MOVE_KEY) as { value: string } | undefined
  return row ? parsePendingDevFolderMove(row.value) : null
}

/** A raw DELETE: the row is bookkeeping of the move, no window keeps it. */
export const clearPendingDevFolderMove = (db: Database.Database): void => {
  db.prepare('DELETE FROM settings WHERE key = ?').run(DEV_FOLDER_PENDING_MOVE_KEY)
}

// ── The relocation ──────────────────────────────────────────────────────────────────────

/** A write, prepared and bound before the folders move, run after. */
type Write = () => void

const PROJECT_TEXT_COLUMNS = [
  'setup_script',
  'run_script',
  'archive_script',
  'worktree_create_script',
  'custom_commands',
  'shell_commands',
  'kanban_markdown_config'
] as const

/** The columns of a project that can name a folder in text. Raw: JSON columns as stored. */
type ProjectText = Record<(typeof PROJECT_TEXT_COLUMNS)[number], string | null>

interface ProjectRow extends ProjectText {
  id: string
  name: string
  path: string
  kind: string | null
  detected_icon: string | null
}

/** A free-text column, rewritten; NULL stays NULL. */
const rewrittenText = (value: string | null, rewriter: PathRewriter): string | null =>
  typeof value === 'string' ? rewriter.rewriteText(value) : value

/** A whole-path column, repointed; NULL stays NULL. */
const swappedPath = (value: string | null, rewriter: PathRewriter): string | null =>
  typeof value === 'string' ? rewriter.swapPrefix(value) : value

const rewriteProjectText = (
  row: ProjectText,
  rewriter: PathRewriter,
  place: ProjectPlace
): { readonly next: ProjectText; readonly changed: boolean; readonly scripts: boolean } => {
  const next: ProjectText = {
    setup_script: rewrittenText(row.setup_script, rewriter),
    run_script: rewrittenText(row.run_script, rewriter),
    archive_script: rewrittenText(row.archive_script, rewriter),
    worktree_create_script: rewrittenText(row.worktree_create_script, rewriter),
    custom_commands: rewriteJsonColumn(row.custom_commands, (value) =>
      rewriteCustomCommands(value, rewriter)
    ),
    shell_commands: rewriteJsonColumn(row.shell_commands, (value) =>
      rewriteShellCommands(value, rewriter)
    ),
    kanban_markdown_config: rewriteJsonColumn(row.kanban_markdown_config, (value) =>
      rewriteMarkdownConfig(value, rewriter, place)
    )
  }
  const changed = PROJECT_TEXT_COLUMNS.filter((column) => next[column] !== row[column])
  return {
    next,
    changed: changed.length > 0,
    scripts: changed.some((column) => column !== 'kanban_markdown_config')
  }
}

/** The guards: each throws before anything is read for writing, so nothing has changed. */
const readProjectToMove = (
  db: Database.Database,
  input: RelocateProjectInput,
  moved: MovedFolders
): ProjectRow => {
  const project = db
    .prepare(
      `SELECT id, name, path, kind, detected_icon, ${PROJECT_TEXT_COLUMNS.join(', ')}
         FROM projects WHERE id = ?`
    )
    .get(input.projectId) as ProjectRow | undefined
  if (!project) throw new Error('The project no longer exists.')
  if (project.kind === 'connection') {
    throw new Error(`${project.name} is a connection project: it has no folder of its own.`)
  }
  if (project.path !== input.expectedPath) {
    throw new Error(`${project.name} is no longer at ${input.expectedPath}.`)
  }
  if (moved.projectPath === project.path) {
    throw new Error(`${project.name} is already at ${project.path}.`)
  }
  const taken = db
    .prepare('SELECT name FROM projects WHERE path = ? AND id <> ?')
    .get(moved.projectPath, project.id) as { name: string } | undefined
  if (taken) {
    throw new Error(`${moved.projectPath} already belongs to the project ${taken.name}.`)
  }
  // Whatever else is registered in a folder that moves would be left pointing at nothing:
  // below it, or at the very same folder (under another spelling, or a worktree next to the
  // checkout that was also added as a project).
  const [other] = registeredIn(
    db,
    moved.spellings.map((spelling) => spelling.from),
    project.id,
    true
  )
  if (other) {
    throw new Error(
      `The project ${other.name} is registered at ${other.path}, ` +
        `which would move with ${project.name}.`
    )
  }
  return project
}

/** Connection projects that have the project as a member: its tickets and runs can live there. */
const connectionProjectsContaining = (db: Database.Database, projectId: string): string[] => {
  const rows = db
    .prepare(`SELECT id, member_project_ids FROM projects WHERE kind = 'connection'`)
    .all() as { id: string; member_project_ids: string | null }[]
  return rows
    .filter((row) => {
      const members = parseJson(row.member_project_ids)
      return Array.isArray(members) && members.includes(projectId)
    })
    .map((row) => row.id)
}

/**
 * What a content test looks for, as the JSON array bound to `@needles`: every string
 * `rewriteText` looks for and, because a JSON column escapes a quote or a backslash of a path,
 * that form of each as well.
 */
const contentNeedles = (rewriter: PathRewriter): string =>
  JSON.stringify([
    ...new Set(rewriter.needles.flatMap((needle) => [needle, JSON.stringify(needle).slice(1, -1)]))
  ])

/** SQL: whether one of the columns (NULL reads as empty) holds one of `@needles`. */
const holdsNeedle = (columns: readonly string[]): string => {
  const haystack = columns.map((column) => `coalesce(${column}, '')`).join(' || char(10) || ')
  return `EXISTS (SELECT 1 FROM json_each(@needles) AS needle WHERE instr(${haystack}, needle.value) > 0)`
}

const planProjectRow = (
  db: Database.Database,
  project: ProjectRow,
  rewriter: PathRewriter,
  writes: Write[]
): { readonly scripts: boolean } => {
  const { next, scripts } = rewriteProjectText(project, rewriter, {
    before: project.path,
    after: rewriter.projectPath
  })
  // 'none' is the marker for "looked, found no icon", not a path.
  const icon =
    project.detected_icon === 'none' ? 'none' : swappedPath(project.detected_icon, rewriter)
  // Trust is per folder: Claude is asked about the new one on the next launch.
  const update = db.prepare(
    `UPDATE projects
        SET path = @path, trust_check_done = 0, detected_icon = @detected_icon,
            setup_script = @setup_script, run_script = @run_script,
            archive_script = @archive_script, worktree_create_script = @worktree_create_script,
            custom_commands = @custom_commands, shell_commands = @shell_commands,
            kanban_markdown_config = @kanban_markdown_config
      WHERE id = @id AND path = @expected`
  )
  writes.push(() => {
    const { changes } = update.run({
      ...next,
      path: rewriter.projectPath,
      detected_icon: icon,
      id: project.id,
      expected: project.path
    })
    if (changes !== 1) throw new Error(`${project.name} changed while it was being moved.`)
  })
  return { scripts }
}

/**
 * Scripts, commands and board folders of OTHER projects that name a moved folder: a
 * connection project whose board lives in this checkout, a sibling whose setup script copies
 * a file out of it. Every project with board folders of its own is read as well: a folder
 * given relative to that project (`../app/docs/kanban`) names the moved one without spelling
 * its path.
 */
const planOtherProjects = (
  db: Database.Database,
  projectId: string,
  rewriter: PathRewriter,
  writes: Write[]
): { readonly ids: string[]; readonly scripts: boolean } => {
  const rows = db
    .prepare(
      `SELECT id, path, ${PROJECT_TEXT_COLUMNS.join(', ')} FROM projects
        WHERE id <> @project
          AND (kanban_markdown_config IS NOT NULL OR ${holdsNeedle(PROJECT_TEXT_COLUMNS)})`
    )
    .all({ project: projectId, needles: contentNeedles(rewriter) }) as (ProjectText & {
    id: string
    path: string
  })[]
  const update = db.prepare(
    `UPDATE projects
        SET setup_script = @setup_script, run_script = @run_script,
            archive_script = @archive_script, worktree_create_script = @worktree_create_script,
            custom_commands = @custom_commands, shell_commands = @shell_commands,
            kanban_markdown_config = @kanban_markdown_config
      WHERE id = @id`
  )
  const ids: string[] = []
  let anyScripts = false
  for (const row of rows) {
    const { next, changed, scripts } = rewriteProjectText(row, rewriter, {
      before: row.path,
      after: row.path
    })
    if (!changed) continue
    ids.push(row.id)
    anyScripts = anyScripts || scripts
    writes.push(() => update.run({ ...next, id: row.id }))
  }
  return { ids, scripts: anyScripts }
}

/** Every worktree row of the project, archived ones too: the default one, nested and moved ones. */
const planWorktrees = (
  db: Database.Database,
  projectId: string,
  rewriter: PathRewriter,
  writes: Write[]
): RelocateProjectResult['worktrees'] => {
  const rows = db.prepare('SELECT id, path FROM worktrees WHERE project_id = ?').all(projectId) as {
    id: string
    path: string
  }[]
  const update = db.prepare('UPDATE worktrees SET path = ? WHERE id = ?')
  const moved: { id: string; from: string; to: string }[] = []
  for (const row of rows) {
    const to = rewriter.swapPrefix(row.path)
    if (to === row.path) continue
    moved.push({ id: row.id, from: row.path, to })
    writes.push(() => update.run(to, row.id))
  }
  return moved
}

const SLASH_COMMANDS_KEY = 'slash_commands:'

/**
 * The slash commands Claude reported are kept per working directory, in the settings KEY.
 * When both spellings of a folder have a row, the one under the stored spelling is written
 * last and stays: that is the one the app keeps current.
 */
const planSlashCommandKeys = (
  db: Database.Database,
  rewriter: PathRewriter,
  writes: Write[]
): void => {
  const rows = db
    .prepare('SELECT key FROM settings WHERE instr(key, ?) = 1')
    .all(SLASH_COMMANDS_KEY) as { key: string }[]
  const rekey = db.prepare('UPDATE OR REPLACE settings SET key = ? WHERE key = ?')
  const moves = rows
    .map((row) => ({
      key: row.key,
      moved: rewriter.locate(row.key.slice(SLASH_COMMANDS_KEY.length))
    }))
    .flatMap(({ key, moved }) => (moved ? [{ key, to: moved.path, rank: moved.rank }] : []))
    .sort((a, b) => b.rank - a.rank)
  for (const move of moves) {
    writes.push(() => rekey.run(SLASH_COMMANDS_KEY + move.to, move.key))
  }
}

/**
 * Runs that can name a moved folder: those of the project and of the connection projects it
 * is a member of, those whose source document sits in a moved folder (the document is
 * whatever file was picked, for any project), and those that list the project as a member.
 * Returns the runs that changed, in their own row or in one of their items.
 */
const planDocumentRuns = (
  db: Database.Database,
  projectId: string,
  boardProjectIds: readonly string[],
  rewriter: PathRewriter,
  writes: Write[]
): string[] => {
  const candidates = db
    .prepare(
      `SELECT r.id AS id, r.project_id AS project_id, r.source_path AS source_path,
              r.integration_worktree_path AS integration_worktree_path,
              r.document_path AS document_path, r.members AS members
         FROM document_runs r
        WHERE r.project_id IN (SELECT value FROM json_each(@projects))
           OR (r.members IS NOT NULL AND instr(r.members, @project) > 0)
           OR EXISTS (
                SELECT 1 FROM json_each(@folders) AS folder
                 WHERE instr(r.source_path, folder.value) = 1
              )`
    )
    .all({
      projects: JSON.stringify(boardProjectIds),
      project: projectId,
      folders: JSON.stringify(rewriter.spellings.map((spelling) => spelling.from))
    }) as {
    id: string
    project_id: string
    source_path: string
    integration_worktree_path: string | null
    document_path: string | null
    members: string | null
  }[]

  const changed = new Set<string>()
  const runIds: string[] = []
  const updateRun = db.prepare(
    `UPDATE document_runs
        SET source_path = ?, integration_worktree_path = ?, document_path = ?, members = ?
      WHERE id = ?`
  )
  for (const run of candidates) {
    const sourcePath = swappedPath(run.source_path, rewriter) ?? run.source_path
    const members = parseJson(run.members)
    const namesProject =
      Array.isArray(members) &&
      members.some((member: unknown) => isRecord(member) && member.project_id === projectId)
    // The SQL test is a prefix and a substring: decide here whether the run is really one of these.
    if (
      !boardProjectIds.includes(run.project_id) &&
      !namesProject &&
      sourcePath === run.source_path
    ) {
      continue
    }
    runIds.push(run.id)
    const nextMembers = rewriteJsonColumn(run.members, (value) =>
      rewriteRunMembers(value, rewriter)
    )
    // The app makes a run's worktree and its copy of the document outside any folder that can
    // move. The worktree is where the run works, so should one ever sit in such a folder, it
    // follows it.
    const worktreePath = swappedPath(run.integration_worktree_path, rewriter)
    const documentPath = swappedPath(run.document_path, rewriter)
    if (
      sourcePath === run.source_path &&
      worktreePath === run.integration_worktree_path &&
      documentPath === run.document_path &&
      nextMembers === run.members
    ) {
      continue
    }
    changed.add(run.id)
    writes.push(() => updateRun.run(sourcePath, worktreePath, documentPath, nextMembers, run.id))
  }

  // The items quote the source document and the checkout in their text.
  const items = db
    .prepare(
      `SELECT id, run_id, title, summary, description, open_questions FROM document_run_items
        WHERE run_id IN (SELECT value FROM json_each(?))`
    )
    .all(JSON.stringify(runIds)) as {
    id: string
    run_id: string
    title: string
    summary: string
    description: string
    open_questions: string | null
  }[]
  const updateItem = db.prepare(
    `UPDATE document_run_items SET title = ?, summary = ?, description = ?, open_questions = ?
      WHERE id = ?`
  )
  for (const item of items) {
    const title = rewrittenText(item.title, rewriter)
    const summary = rewrittenText(item.summary, rewriter)
    const description = rewrittenText(item.description, rewriter)
    const openQuestions = rewriteJsonColumn(item.open_questions, (value) =>
      mapStrings(value, rewriter.rewriteText)
    )
    if (
      title === item.title &&
      summary === item.summary &&
      description === item.description &&
      openQuestions === item.open_questions
    ) {
      continue
    }
    changed.add(item.run_id)
    writes.push(() => updateItem.run(title, summary, description, openQuestions, item.id))
  }
  return [...changed]
}

/** What changed on boards: how many tickets (or cards), and of which projects. */
interface RewrittenTickets {
  readonly rewritten: number
  readonly projectIds: readonly string[]
}

const TICKET_TEXT_COLUMNS = [
  'description',
  'attachments',
  'external_url',
  'pending_launch_config'
] as const

/**
 * Tickets of the project and of the connection projects it is a member of, and tickets of any
 * other project that name a moved folder: a run's ticket links to the document the run was
 * made from, which is whatever file was picked, and a description or a queued prompt can
 * quote a path in a neighbouring checkout.
 */
const planTickets = (
  db: Database.Database,
  boardProjectIds: readonly string[],
  rewriter: PathRewriter,
  writes: Write[]
): RewrittenTickets => {
  const rows = db
    .prepare(
      `SELECT id, project_id, ${TICKET_TEXT_COLUMNS.join(', ')}
         FROM kanban_tickets
        WHERE project_id IN (SELECT value FROM json_each(@projects))
           OR ${holdsNeedle(TICKET_TEXT_COLUMNS)}`
    )
    .all({ projects: JSON.stringify(boardProjectIds), needles: contentNeedles(rewriter) }) as {
    id: string
    project_id: string
    description: string | null
    attachments: string | null
    external_url: string | null
    pending_launch_config: string | null
  }[]
  const update = db.prepare(
    `UPDATE kanban_tickets
        SET description = ?, attachments = ?, external_url = ?, pending_launch_config = ?
      WHERE id = ?`
  )
  let rewritten = 0
  const projectIds = new Set<string>()
  for (const row of rows) {
    const description = rewrittenText(row.description, rewriter)
    const attachments = rewriteJsonColumn(row.attachments, (value) =>
      rewriteAttachments(value, rewriter)
    )
    // A run's ticket links to the document the run was made from, as a plain path.
    const externalUrl = swappedPath(row.external_url, rewriter)
    const pendingLaunch = rewriteJsonColumn(row.pending_launch_config, (value) =>
      rewritePendingLaunch(value, rewriter)
    )
    if (
      description === row.description &&
      attachments === row.attachments &&
      externalUrl === row.external_url &&
      pendingLaunch === row.pending_launch_config
    ) {
      continue
    }
    rewritten += 1
    projectIds.add(row.project_id)
    writes.push(() => update.run(description, attachments, externalUrl, pendingLaunch, row.id))
  }
  return { rewritten, projectIds: [...projectIds] }
}

/**
 * What the app keeps for the cards of a markdown board: of the same boards as the tickets,
 * and of any other board whose card files sit in a moved folder (a board folder may be an
 * absolute path into another project's checkout).
 */
const planCardState = (
  db: Database.Database,
  boardProjectIds: readonly string[],
  rewriter: PathRewriter,
  writes: Write[]
): RewrittenTickets => {
  const rows = db
    .prepare(
      `SELECT s.project_id AS project_id, s.card_id AS card_id, s.last_seen_path AS last_seen_path,
              s.attachments AS attachments, s.pending_launch_config AS pending_launch_config
         FROM markdown_kanban_card_state s
        WHERE s.project_id IN (SELECT value FROM json_each(@projects))
           OR EXISTS (
                SELECT 1 FROM json_each(@folders) AS folder
                 WHERE instr(s.last_seen_path, folder.value) = 1
              )`
    )
    .all({
      projects: JSON.stringify(boardProjectIds),
      folders: JSON.stringify(rewriter.spellings.map((spelling) => spelling.from))
    }) as {
    project_id: string
    card_id: string
    last_seen_path: string | null
    attachments: string | null
    pending_launch_config: string | null
  }[]
  const update = db.prepare(
    `UPDATE markdown_kanban_card_state
        SET last_seen_path = ?, attachments = ?, pending_launch_config = ?
      WHERE project_id = ? AND card_id = ?`
  )
  let rewritten = 0
  const projectIds = new Set<string>()
  for (const row of rows) {
    const lastSeenPath = swappedPath(row.last_seen_path, rewriter)
    const attachments = rewriteJsonColumn(row.attachments, (value) =>
      rewriteAttachments(value, rewriter)
    )
    const pendingLaunch = rewriteJsonColumn(row.pending_launch_config, (value) =>
      rewritePendingLaunch(value, rewriter)
    )
    if (
      lastSeenPath === row.last_seen_path &&
      attachments === row.attachments &&
      pendingLaunch === row.pending_launch_config
    ) {
      continue
    }
    rewritten += 1
    projectIds.add(row.project_id)
    writes.push(() =>
      update.run(lastSeenPath, attachments, pendingLaunch, row.project_id, row.card_id)
    )
  }
  return { rewritten, projectIds: [...projectIds] }
}

/**
 * The script snapshots of finished shell-command sessions: the project's own, and those of any
 * other project whose script names a moved folder. Such a project's command is rewritten where
 * it is defined; "Run again" runs the snapshot, which has to say the same.
 */
const planShellCommandSessions = (
  db: Database.Database,
  projectId: string,
  rewriter: PathRewriter,
  writes: Write[]
): { readonly scripts: boolean } => {
  const rows = db
    .prepare(
      `SELECT id, shell_command FROM sessions
        WHERE shell_command IS NOT NULL
          AND (project_id = @project OR ${holdsNeedle(['shell_command'])})`
    )
    .all({ project: projectId, needles: contentNeedles(rewriter) }) as {
    id: string
    shell_command: string
  }[]
  const update = db.prepare('UPDATE sessions SET shell_command = ? WHERE id = ?')
  let scripts = false
  for (const row of rows) {
    const snapshot = rewriteJsonColumn(row.shell_command, (value) =>
      rewriteSessionShellCommand(value, rewriter)
    )
    if (snapshot === row.shell_command) continue
    scripts = true
    writes.push(() => update.run(snapshot, row.id))
  }
  return { scripts }
}

/** Every data project: a SQLite file inside a checkout is a common thing to connect to. */
const planDataProjects = (
  db: Database.Database,
  rewriter: PathRewriter,
  writes: Write[]
): string[] => {
  const rows = db.prepare('SELECT id, config FROM data_projects').all() as {
    id: string
    config: string | null
  }[]
  const update = db.prepare('UPDATE data_projects SET config = ? WHERE id = ?')
  const ids: string[] = []
  for (const row of rows) {
    const config = rewriteJsonColumn(row.config, (value) =>
      rewriteDataProjectConfig(value, rewriter)
    )
    if (config === row.config) continue
    ids.push(row.id)
    writes.push(() => update.run(config, row.id))
  }
  return ids
}

/**
 * Point the project, and everything in the database that names a path inside what moved, at
 * the new place. Must run inside a transaction: when this throws, before or after
 * `input.place()`, the caller's rollback is what leaves the database as it was.
 */
export const relocateProjectRows = (
  db: Database.Database,
  input: RelocateProjectInput
): RelocatedRows => {
  const moved = movedFoldersOf(input)
  const project = readProjectToMove(db, input, moved)
  const rewriter = createPathRewriter(moved, input.homeDir, neighboursOf(db, moved))
  const boardProjectIds = [project.id, ...connectionProjectsContaining(db, project.id)]

  const writes: Write[] = []
  const own = planProjectRow(db, project, rewriter, writes)
  const others = planOtherProjects(db, project.id, rewriter, writes)
  const worktrees = planWorktrees(db, project.id, rewriter, writes)
  planSlashCommandKeys(db, rewriter, writes)
  const runIds = planDocumentRuns(db, project.id, boardProjectIds, rewriter, writes)
  const tickets = planTickets(db, boardProjectIds, rewriter, writes)
  const cards = planCardState(db, boardProjectIds, rewriter, writes)
  const sessions = planShellCommandSessions(db, project.id, rewriter, writes)
  const dataProjectIds = planDataProjects(db, rewriter, writes)
  // Written with the move itself: if the app quits before the follow-up steps have run, the
  // next start finds this row and finishes them.
  const pendingValue = JSON.stringify(input.pending)
  const setPending = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  writes.push(() => setPending.run(DEV_FOLDER_PENDING_MOVE_KEY, pendingValue))

  input.place()
  for (const write of writes) write()

  return {
    worktrees,
    ticketsRewritten: tickets.rewritten + cards.rewritten,
    runsRewritten: runIds.length,
    scriptsRewritten: own.scripts || others.scripts || sessions.scripts,
    otherProjectIds: others.ids,
    dataProjectIds,
    // A card of a markdown board counts as a ticket here, as it does in `ticketsRewritten`.
    ticketProjectIds: [...new Set([...tickets.projectIds, ...cards.projectIds])],
    runIds
  }
}
