import { execFile } from 'node:child_process'

/**
 * Git plumbing for the document flow: the integration branch is built by merging ticket
 * branches one at a time, so these need exact exit codes (a dry-run merge exits 1 for a
 * conflict, which is an answer, not a failure) and options the app's git facade does not
 * offer (`--no-ff`, merge-base checks, MERGE_HEAD). Every call is `git <args>` with an
 * argument array; nothing goes through a shell.
 */

const MAX_BUFFER = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
/** Merges, commits and resets on large repositories (and their post-* hooks). */
const SLOW_TIMEOUT_MS = 600_000
const ERROR_DETAIL_CHARS = 600

// Never wait on a credential prompt or an editor: nobody is at this terminal.
const NON_INTERACTIVE_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' }

export interface GitRunResult {
  /** Exit code; null when git could not be started or was killed (timeout, signal). */
  code: number | null
  stdout: string
  stderr: string
  /** Why there is no exit code. */
  failure?: string
}

export interface GitRunOptions {
  timeoutMs?: number
  env?: Record<string, string>
}

const describeFailure = (args: readonly string[], result: GitRunResult): string => {
  const detail = (result.stderr.trim() || result.stdout.trim() || result.failure || '').slice(
    -ERROR_DETAIL_CHARS
  )
  const exit = result.code === null ? 'did not finish' : `exited with code ${result.code}`
  return `git ${args[0]} ${exit}${detail ? `: ${detail}` : ''}`
}

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitRunResult
  ) {
    super(describeFailure(args, result))
    this.name = 'GitCommandError'
  }
}

/** `git add -A` would mark files that still hold conflict markers as resolved. */
export class UnresolvedConflictsError extends Error {
  constructor(readonly files: string[]) {
    super(`Unresolved merge conflicts in: ${files.join(', ')}`)
    this.name = 'UnresolvedConflictsError'
  }
}

/** Run git and report how it ended. Never rejects. */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, ...NON_INTERACTIVE_ENV, ...options.env }
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr })
          return
        }
        // A non-zero exit carries a numeric code; a spawn failure carries a string (ENOENT).
        const code = typeof error.code === 'number' ? error.code : null
        resolve({
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          ...(code === null ? { failure: error.message } : {})
        })
      }
    )
  })
}

async function gitOutput(
  cwd: string,
  args: readonly string[],
  options?: GitRunOptions
): Promise<string> {
  const result = await runGit(cwd, args, options)
  if (result.code !== 0) throw new GitCommandError(args, result)
  return result.stdout
}

/** Exit 0 → true, exit 1 → false, anything else is a real failure. */
async function gitTest(cwd: string, args: readonly string[]): Promise<boolean> {
  const result = await runGit(cwd, args)
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw new GitCommandError(args, result)
}

/** A revision that git cannot mistake for an option. */
function revision(value: string): string {
  if (!value || value.startsWith('-') || /[\s\0]/.test(value)) {
    throw new Error(`Not a valid git revision: "${value}"`)
  }
  return value
}

const splitNul = (output: string): string[] => output.split('\0').filter((entry) => entry !== '')

/** The commit a revision points at, or null when it does not exist. */
export async function revParse(cwd: string, ref: string): Promise<string | null> {
  const args = ['rev-parse', '--verify', '--quiet', `${revision(ref)}^{commit}`]
  const result = await runGit(cwd, args)
  if (result.code === 0) return result.stdout.trim() || null
  if (result.code === 1) return null
  throw new GitCommandError(args, result)
}

/** `fullRef` is a complete ref name (`refs/heads/main`), not a short branch name. */
export function refExists(cwd: string, fullRef: string): Promise<boolean> {
  return gitTest(cwd, ['show-ref', '--verify', '--quiet', revision(fullRef)])
}

/** The checked-out branch, or null on a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const args = ['symbolic-ref', '--quiet', '--short', 'HEAD']
  const result = await runGit(cwd, args)
  if (result.code === 0) return result.stdout.trim() || null
  if (result.code === 1) return null
  throw new GitCommandError(args, result)
}

/** The root of the working tree `cwd` is in. */
export async function topLevel(cwd: string): Promise<string> {
  return (await gitOutput(cwd, ['rev-parse', '--show-toplevel'])).trim()
}

/** Uncommitted changes, untracked files included (whatever `status.showUntrackedFiles` says). */
export async function isDirty(cwd: string): Promise<boolean> {
  const status = await gitOutput(cwd, ['status', '--porcelain', '--untracked-files=normal'])
  return status.trim() !== ''
}

export function hasMergeHead(cwd: string): Promise<boolean> {
  return gitTest(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
}

/** Paths with unresolved conflicts in the index. */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  return splitNul(await gitOutput(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']))
}

export interface CommitAllResult {
  /** False when there was nothing to commit. */
  committed: boolean
  sha: string | null
}

/**
 * Stage everything and commit it without hooks. Also concludes a merge whose conflicts are all
 * resolved. Refuses (UnresolvedConflictsError) while any path is still conflicted.
 */
export async function commitAll(cwd: string, message: string): Promise<CommitAllResult> {
  const unresolved = await conflictedFiles(cwd)
  if (unresolved.length > 0) throw new UnresolvedConflictsError(unresolved)

  const merging = await hasMergeHead(cwd)
  if (!merging && !(await isDirty(cwd))) return { committed: false, sha: null }

  await gitOutput(cwd, ['add', '-A'], { timeoutMs: SLOW_TIMEOUT_MS })
  // A merge is concluded even when its result equals HEAD; otherwise an empty index means the
  // "dirt" was nothing git records (an empty directory, a mode change it ignores).
  if (!merging && (await gitTest(cwd, ['diff', '--cached', '--quiet']))) {
    return { committed: false, sha: null }
  }
  await gitOutput(cwd, ['commit', '--no-verify', '-m', message], { timeoutMs: SLOW_TIMEOUT_MS })
  return { committed: true, sha: await revParse(cwd, 'HEAD') }
}

async function countCommits(cwd: string, from: string, to: string): Promise<number> {
  const range = `${revision(from)}..${revision(to)}`
  const count = Number.parseInt(await gitOutput(cwd, ['rev-list', '--count', range]), 10)
  return Number.isFinite(count) ? count : 0
}

/** Commits on `branch` that `base` does not have. */
export function commitsAhead(cwd: string, base: string, branch: string): Promise<number> {
  return countCommits(cwd, base, branch)
}

/** Commits reachable from `to` but not from `from`. */
export function commitCount(cwd: string, from: string, to: string): Promise<number> {
  return countCommits(cwd, from, to)
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitTest(cwd, ['merge-base', '--is-ancestor', revision(ancestor), revision(descendant)])
}

export type MergeTreeCheck =
  | { state: 'clean' }
  | { state: 'conflict'; files: string[] }
  /** git could not answer (older than 2.38, or it failed): only the real merge can tell. */
  | { state: 'unknown'; detail: string }

/**
 * Dry-run merging `branch` into `into` without touching any working tree or ref
 * (`git merge-tree --write-tree`): exit 0 is a clean merge, exit 1 a conflict.
 */
export async function mergeTreeCheck(
  cwd: string,
  into: string,
  branch: string
): Promise<MergeTreeCheck> {
  const args = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    '-z',
    revision(into),
    revision(branch)
  ]
  const result = await runGit(cwd, args)
  if (result.code === 0) return { state: 'clean' }

  // A conflict prints the merged tree id first and the conflicted paths after it. Exit 1
  // without a tree id is git refusing the request, not a conflict.
  const [tree, ...files] = splitNul(result.stdout)
  if (result.code === 1 && tree && /^[0-9a-f]{40,64}$/.test(tree.trim())) {
    return { state: 'conflict', files: [...new Set(files)] }
  }
  return { state: 'unknown', detail: describeFailure(args, result) }
}

export interface MergeAttempt {
  ok: boolean
  /** What git printed; names the reason when the merge did not go through. */
  output: string
}

/** `git merge --no-ff` into the checked-out branch. A failed merge is left in progress. */
export async function mergeNoFf(
  cwd: string,
  branch: string,
  message: string
): Promise<MergeAttempt> {
  const result = await runGit(
    cwd,
    ['merge', '--no-ff', '--no-verify', '-m', message, revision(branch)],
    { timeoutMs: SLOW_TIMEOUT_MS }
  )
  const output = [result.stdout.trim(), result.stderr.trim(), result.failure ?? '']
    .filter(Boolean)
    .join('\n')
  return { ok: result.code === 0, output }
}

/** Abort the merge in progress. A no-op when there is none. */
export async function mergeAbort(cwd: string): Promise<void> {
  const args = ['merge', '--abort']
  const result = await runGit(cwd, args, { timeoutMs: SLOW_TIMEOUT_MS })
  if (result.code !== 0 && (await hasMergeHead(cwd))) throw new GitCommandError(args, result)
}

/**
 * The merge commit on the first-parent history of `head` (after `since`) that merged `tip` in:
 * one of its merged-in parents is `tip`. This is how a merge that completed just before a
 * crash is recognised afterwards. null when there is none.
 */
export async function findMergeCommitOf(
  cwd: string,
  input: { since: string; head: string; tip: string }
): Promise<string | null> {
  const range = `${revision(input.since)}..${revision(input.head)}`
  const output = await gitOutput(cwd, [
    'rev-list',
    '--first-parent',
    '--merges',
    '--parents',
    range
  ])
  for (const line of output.split('\n')) {
    // "<commit> <first parent> <merged parent>…": the first parent is the branch itself.
    const [commit, , ...merged] = line.trim().split(/\s+/)
    if (commit && merged.includes(input.tip)) return commit
  }
  return null
}

export async function resetHard(cwd: string, sha: string): Promise<void> {
  await gitOutput(cwd, ['reset', '--hard', revision(sha)], { timeoutMs: SLOW_TIMEOUT_MS })
}

/** Remove untracked files and directories; ignored files (dependencies, build output) stay. */
export async function cleanUntracked(cwd: string): Promise<void> {
  await gitOutput(cwd, ['clean', '-fd'], { timeoutMs: SLOW_TIMEOUT_MS })
}

export interface NameStatusEntry {
  /** `A`, `M`, `D`, `T`, … (renames are reported as a delete plus an add). */
  status: string
  path: string
}

/** Files that differ between two commits. */
export async function diffNameStatus(
  cwd: string,
  from: string,
  to: string
): Promise<NameStatusEntry[]> {
  const fields = splitNul(
    await gitOutput(cwd, [
      'diff',
      '--name-status',
      '--no-renames',
      '-z',
      revision(from),
      revision(to)
    ])
  )
  const entries: NameStatusEntry[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    entries.push({ status: fields[index], path: fields[index + 1] })
  }
  return entries
}

export interface ShortStat {
  filesChanged: number
  insertions: number
  deletions: number
}

export async function shortStat(cwd: string, from: string, to: string): Promise<ShortStat> {
  // The summary line is translated; pin the locale so it can be read.
  const output = await gitOutput(cwd, ['diff', '--shortstat', revision(from), revision(to)], {
    env: { LC_ALL: 'C', LANGUAGE: 'C' }
  })
  const read = (pattern: RegExp): number => Number(pattern.exec(output)?.[1] ?? 0)
  return {
    filesChanged: read(/(\d+) files? changed/),
    insertions: read(/(\d+) insertions?\(\+\)/),
    deletions: read(/(\d+) deletions?\(-\)/)
  }
}

const MIGRATION_DIRECTORIES = new Set(['migrations', 'migration', 'migrate', 'drizzle', 'alembic'])
/** Directories whose `versions/` child or `.sql` files are schema changes. */
const DATABASE_DIRECTORIES = new Set([
  'db',
  'database',
  'databases',
  'sql',
  'schema',
  'schemas',
  'prisma',
  'supabase',
  'alembic',
  'migrations',
  'migration',
  'migrate'
])
/** Generated or scaffolding files that live next to migrations without being one. */
const MIGRATION_METADATA_FILE =
  /^(?:_journal\.json|(?:.*_)?snapshot\.json|migration_lock\.toml|__init__\.py|env\.py|script\.py\.mako)$/
const DOCUMENTATION_FILE = /\.(?:md|mdx|txt|rst)$/

const directoriesOf = (path: string): string[] =>
  path.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean).slice(0, -1)

/**
 * Whether a repository path looks like a database migration: a file under a `migrations`,
 * `migration`, `migrate`, `drizzle` or `alembic` directory (`prisma/migrations/…`,
 * `db/migrate/…`), under `versions/` of a database directory, or a `.sql` file anywhere below
 * a database directory.
 */
export function isMigrationPath(path: string): boolean {
  if (DOCUMENTATION_FILE.test(path.toLowerCase())) return false
  const directories = directoriesOf(path)
  if (directories.some((directory) => MIGRATION_DIRECTORIES.has(directory))) return true
  if (
    directories.some(
      (directory, index) =>
        directory === 'versions' && index > 0 && DATABASE_DIRECTORIES.has(directories[index - 1])
    )
  ) {
    return true
  }
  return (
    path.toLowerCase().endsWith('.sql') &&
    directories.some((directory) => DATABASE_DIRECTORIES.has(directory))
  )
}

/** The directory a migration file belongs to: the path up to its migration directory. */
function migrationRoot(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/')
  const index = segments.findIndex((segment) => MIGRATION_DIRECTORIES.has(segment.toLowerCase()))
  return index === -1 ? segments.slice(0, -1).join('/') : segments.slice(0, index + 1).join('/')
}

const isMigrationMetadata = (path: string): boolean =>
  MIGRATION_METADATA_FILE.test(path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '')

/**
 * The migration files among `paths`. Generated bookkeeping (drizzle's journal and snapshots,
 * prisma's lock file) is left out when the migration it describes is listed; on its own it is
 * kept, since it is then the only sign that the schema changed.
 */
export function collectMigrationPaths(paths: readonly string[]): string[] {
  const candidates = [...new Set(paths.filter(isMigrationPath))]
  const rootsWithMigrations = new Set(
    candidates.filter((path) => !isMigrationMetadata(path)).map(migrationRoot)
  )
  return candidates.filter(
    (path) => !isMigrationMetadata(path) || !rootsWithMigrations.has(migrationRoot(path))
  )
}
