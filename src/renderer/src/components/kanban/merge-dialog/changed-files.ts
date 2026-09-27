import { gitApi } from '@/api/git-api'

/** Status letters the changed-files views understand */
export type ChangedFileStatus = 'A' | 'M' | 'D' | 'T' | 'U' | '?' | ''

export interface ChangedFile {
  /** Path relative to the worktree root */
  path: string
  status: ChangedFileStatus
  additions: number
  deletions: number
  binary: boolean
}

export interface ChangedFilesTotals {
  files: number
  additions: number
  deletions: number
}

/**
 * Where a list of changed files comes from.
 * - `branch`: what the feature branch adds on top of its base — the merge-base
 *   of `baseBranch` and HEAD compared with the working tree.
 * - `worktree`: uncommitted changes — HEAD compared with the working tree,
 *   untracked files included.
 */
export type ChangedFilesSource =
  | { kind: 'branch'; worktreePath: string; baseBranch: string }
  | { kind: 'worktree'; worktreePath: string }

export interface ChangedFileStatusMeta {
  letter: string
  label: string
  className: string
}

export const CHANGED_FILE_STATUS: Record<ChangedFileStatus, ChangedFileStatusMeta> = {
  A: { letter: 'A', label: 'Added', className: 'text-green-500' },
  M: { letter: 'M', label: 'Modified', className: 'text-yellow-500' },
  D: { letter: 'D', label: 'Deleted', className: 'text-red-500' },
  T: { letter: 'T', label: 'Type changed', className: 'text-violet-500' },
  U: { letter: 'U', label: 'Conflict', className: 'text-red-500' },
  '?': { letter: '?', label: 'Untracked', className: 'text-muted-foreground' },
  '': { letter: '•', label: 'Changed', className: 'text-muted-foreground' }
}

/** Diffs with more changed lines than this wait for an explicit "Load diff" */
export const LARGE_DIFF_LINES = 1500
/** Patches above this size are offered for copying instead of being rendered */
export const MAX_PATCH_BYTES = 1_000_000

export type LoadResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Map a raw git status letter to the set we render. `git diff --name-status`
 * yields A/M/D/T/U; `getFileStatuses` yields M/A/D/?/C where C is a conflict.
 */
export function normalizeStatus(raw: string | undefined): ChangedFileStatus {
  switch (raw) {
    case 'A':
    case 'M':
    case 'D':
    case 'T':
    case 'U':
    case '?':
      return raw
    case 'C':
      return 'U'
    default:
      return ''
  }
}

/**
 * git prints paths with non-ASCII or special characters as C-quoted strings
 * ("caf\303\251.txt") unless core.quotePath is off. Decode them so rows show
 * the real name and per-file lookups hit the real path.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw
  const inner = raw.slice(1, -1)
  const encoder = new TextEncoder()
  const bytes: number[] = []
  const simple: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    b: 8,
    f: 12,
    v: 11,
    a: 7,
    '\\': 92,
    '"': 34
  }
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch !== '\\') {
      bytes.push(...encoder.encode(ch))
      continue
    }
    const next = inner[i + 1]
    if (next === undefined) break
    const octal = inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      i += octal[0].length
      continue
    }
    bytes.push(simple[next] ?? next.charCodeAt(0))
    i += 1
  }
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes))
  } catch {
    return raw
  }
}

/**
 * With rename detection on, `git diff --numstat` reports a rename as
 * `old => new` or `dir/{old => new}/file`. The row belongs to the new path.
 */
export function numstatDestinationPath(path: string): string {
  const braced = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`
  const plain = path.match(/^(.*) => (.*)$/)
  return plain ? plain[2] : path
}

export function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/')
  return idx === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) }
}

export function fileExtension(name: string): string | null {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1) : null
}

export function sortChangedFiles(files: ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path))
}

export function changedFilesTotals(files: ChangedFile[]): ChangedFilesTotals {
  return files.reduce(
    (acc, file) => ({
      files: acc.files + 1,
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions
    }),
    { files: 0, additions: 0, deletions: 0 }
  )
}

export function filterChangedFiles(files: ChangedFile[], query: string): ChangedFile[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return files
  return files.filter((file) => file.path.toLowerCase().includes(needle))
}

export function isLargeDiff(file: ChangedFile): boolean {
  return !file.binary && file.additions + file.deletions > LARGE_DIFF_LINES
}

export function changedFilesSourceKey(source: ChangedFilesSource): string {
  return source.kind === 'branch'
    ? `branch:${source.worktreePath}:${source.baseBranch}`
    : `worktree:${source.worktreePath}`
}

export function changedFileKey(source: ChangedFilesSource, path: string): string {
  return `${changedFilesSourceKey(source)}:${path}`
}

// Statuses reported by getFileStatuses can repeat per path (staged + unstaged
// rows); keep the one that best describes the file relative to HEAD
const STATUS_PRIORITY: ChangedFileStatus[] = ['U', '?', 'A', 'D', 'T', 'M', '']

function preferStatus(a: ChangedFileStatus, b: ChangedFileStatus): ChangedFileStatus {
  return STATUS_PRIORITY.indexOf(a) <= STATUS_PRIORITY.indexOf(b) ? a : b
}

export async function loadChangedFiles(
  source: ChangedFilesSource
): Promise<LoadResult<ChangedFile[]>> {
  if (source.kind === 'branch') {
    const result = await gitApi.getBranchDiffFiles(source.worktreePath, source.baseBranch)
    if (!result.success) {
      return { ok: false, error: result.error ?? 'Failed to load changed files' }
    }
    return {
      ok: true,
      value: sortChangedFiles(
        (result.files ?? []).map((file) => ({
          path: unquoteGitPath(file.relativePath),
          status: normalizeStatus(file.status),
          additions: file.additions,
          deletions: file.deletions,
          binary: file.binary
        }))
      )
    }
  }

  // getDiffStat lists every uncommitted file (staged, unstaged and untracked)
  // with line counts but no status; getFileStatuses supplies the letters
  const [stat, statuses] = await Promise.all([
    gitApi.getDiffStat(source.worktreePath),
    gitApi.getFileStatuses(source.worktreePath).catch(() => null)
  ])
  if (!stat.success) {
    return { ok: false, error: stat.error ?? 'Failed to load uncommitted changes' }
  }
  const statusByPath = new Map<string, ChangedFileStatus>()
  for (const entry of statuses?.success ? (statuses.files ?? []) : []) {
    const path = unquoteGitPath(entry.relativePath)
    const status = normalizeStatus(entry.status)
    const previous = statusByPath.get(path)
    statusByPath.set(path, previous === undefined ? status : preferStatus(previous, status))
  }
  return {
    ok: true,
    value: sortChangedFiles(
      (stat.files ?? []).map((file) => {
        const path = numstatDestinationPath(unquoteGitPath(file.path))
        return {
          path,
          status: statusByPath.get(path) ?? 'M',
          additions: file.additions,
          deletions: file.deletions,
          binary: file.binary
        }
      })
    )
  }
}

export async function loadChangedFileDiff(
  source: ChangedFilesSource,
  file: ChangedFile
): Promise<LoadResult<string>> {
  const unwrap = (result: {
    success: boolean
    diff?: string
    error?: string
  }): LoadResult<string> =>
    result.success
      ? { ok: true, value: result.diff ?? '' }
      : { ok: false, error: result.error ?? 'Failed to load diff' }

  if (source.kind === 'branch') {
    return unwrap(await gitApi.getBranchFileDiff(source.worktreePath, source.baseBranch, file.path))
  }
  if (file.status === '?') {
    // Untracked files have no HEAD side — the server synthesises an all-added patch
    return unwrap(await gitApi.getDiff(source.worktreePath, file.path, false, true))
  }
  // Tracked uncommitted changes, staged or not, in one patch. getBranchFileDiff
  // diffs the working tree against merge-base(<branch>, HEAD); with HEAD as the
  // branch that is `git diff HEAD -- <file>` — exactly what "Commit" will land.
  return unwrap(await gitApi.getBranchFileDiff(source.worktreePath, 'HEAD', file.path))
}
