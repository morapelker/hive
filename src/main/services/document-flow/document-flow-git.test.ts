// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  GitCommandError,
  UnresolvedConflictsError,
  cleanUntracked,
  collectMigrationPaths,
  commitAll,
  commitCount,
  commitsAhead,
  conflictedFiles,
  currentBranch,
  diffNameStatus,
  findMergeCommitOf,
  hasMergeHead,
  isAncestor,
  isDirty,
  isMigrationPath,
  mergeAbort,
  mergeNoFf,
  mergeTreeCheck,
  refExists,
  resetHard,
  revParse,
  runGit,
  shortStat,
  topLevel
} from './document-flow-git'
import { createTestRepo, isolateGitConfig, type TestRepo } from './test-support'

let restoreGitConfig: () => void
let repo: TestRepo
/** The integration worktree: branch `integration`, cut from the base commit. */
let integration: string

beforeAll(() => {
  restoreGitConfig = isolateGitConfig()
  repo = createTestRepo()
  integration = repo.addWorktree('integration', repo.baseSha)
})

afterAll(() => {
  repo.cleanup()
  restoreGitConfig()
})

const head = (cwd: string): string => repo.git(cwd, 'rev-parse', 'HEAD')

describe('reading refs', () => {
  it('resolves revisions and reports missing ones as null', async () => {
    expect(await revParse(repo.projectPath, 'refs/heads/main')).toBe(repo.baseSha)
    expect(await revParse(integration, 'HEAD')).toBe(repo.baseSha)
    expect(await revParse(repo.projectPath, 'refs/heads/nope')).toBeNull()
    expect(await revParse(repo.projectPath, 'refs/remotes/origin/main')).toBeNull()
  })

  it('tells existing refs, branches and worktree roots apart', async () => {
    expect(await refExists(repo.projectPath, 'refs/heads/integration')).toBe(true)
    expect(await refExists(repo.projectPath, 'refs/heads/nope')).toBe(false)
    expect(await currentBranch(repo.projectPath)).toBe('main')
    expect(await currentBranch(integration)).toBe('integration')
    expect(await topLevel(join(integration, 'src'))).toBe(integration)
  })

  it('reports a detached HEAD as no branch', async () => {
    const detached = join(repo.root, 'worktrees', 'detached')
    repo.git(repo.projectPath, 'worktree', 'add', '--detach', detached, repo.baseSha)
    expect(await currentBranch(detached)).toBeNull()
    repo.git(repo.projectPath, 'worktree', 'remove', '--force', detached)
  })

  it('refuses a revision git could read as an option', async () => {
    await expect(revParse(repo.projectPath, '--output=/tmp/x')).rejects.toThrow(
      'Not a valid git revision'
    )
    await expect(commitsAhead(repo.projectPath, 'main', '-x')).rejects.toThrow(
      'Not a valid git revision'
    )
  })

  it('distinguishes a failed git from an answer', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'docflow-not-a-repo-'))
    try {
      const result = await runGit(outside, ['rev-parse', '--show-toplevel'])
      expect(result.code).toBe(128)
      expect(result.stderr).toContain('not a git repository')
      await expect(isDirty(outside)).rejects.toBeInstanceOf(GitCommandError)
      await expect(isDirty(outside)).rejects.toThrow(/^git status exited with code 128: /)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('reports a git that could not run without an exit code', async () => {
    const result = await runGit(join(repo.root, 'missing-directory'), ['status'])
    expect(result.code).toBeNull()
    expect(result.failure).toBeTruthy()
  })
})

describe('merging ticket branches into the integration branch', () => {
  let ticketA: string
  let ticketB: string
  let ticketC: string
  let preMergeA: string
  let mergeA: string

  beforeAll(() => {
    ticketA = repo.addWorktree('ticket-a', 'integration')
    ticketB = repo.addWorktree('ticket-b', 'integration')
    ticketC = repo.addWorktree('ticket-c', 'integration')
  })

  it('reports a branch without commits as having no changes', async () => {
    expect(await commitsAhead(integration, 'integration', 'ticket-a')).toBe(0)
    expect(await isAncestor(integration, 'ticket-a', 'integration')).toBe(true)
    expect(await isDirty(ticketA)).toBe(false)
  })

  it('commits a dirty tree, untracked files included, and nothing when it is clean', async () => {
    repo.write(ticketA, {
      'src/app.ts': 'export const app = 2\n',
      'src/feature-a.ts': 'export const a = true\n'
    })
    expect(await isDirty(ticketA)).toBe(true)

    const first = await commitAll(ticketA, 'A1 · Feature "a"')
    expect(first.committed).toBe(true)
    expect(first.sha).toBe(head(ticketA))
    expect(repo.git(ticketA, 'log', '-1', '--format=%s')).toBe('A1 · Feature "a"')
    expect(await isDirty(ticketA)).toBe(false)
    expect(repo.git(ticketA, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual([
      'src/app.ts',
      'src/feature-a.ts'
    ])

    expect(await commitAll(ticketA, 'nothing')).toEqual({ committed: false, sha: null })
    expect(head(ticketA)).toBe(first.sha)
    expect(await commitsAhead(integration, 'integration', 'ticket-a')).toBe(1)
  })

  it('merges a clean branch with a merge commit', async () => {
    expect(await mergeTreeCheck(integration, 'integration', 'ticket-a')).toEqual({
      state: 'clean'
    })
    // The dry run touched neither the branch nor the working tree.
    expect(head(integration)).toBe(repo.baseSha)
    expect(await isDirty(integration)).toBe(false)

    preMergeA = head(integration)
    const attempt = await mergeNoFf(integration, 'ticket-a', 'Merge A1 · Feature a')
    expect(attempt.ok).toBe(true)
    mergeA = head(integration)

    // --no-ff: a merge commit even though a fast-forward was possible.
    const parents = repo.git(integration, 'log', '-1', '--format=%P').split(' ')
    expect(parents).toEqual([preMergeA, head(ticketA)])
    expect(repo.git(integration, 'log', '-1', '--format=%s')).toBe('Merge A1 · Feature a')
    expect(await hasMergeHead(integration)).toBe(false)
    expect(readFileSync(join(integration, 'src/feature-a.ts'), 'utf8')).toContain('a = true')
  })

  it('recognises a branch that was already merged by its tip', async () => {
    const tipA = head(ticketA)
    expect(
      await findMergeCommitOf(integration, { since: repo.baseSha, head: 'integration', tip: tipA })
    ).toBe(mergeA)
    // The integration branch's own previous tip is a first parent, not something merged in.
    expect(
      await findMergeCommitOf(integration, {
        since: repo.baseSha,
        head: 'integration',
        tip: preMergeA
      })
    ).toBeNull()
    expect(
      await findMergeCommitOf(integration, {
        since: repo.baseSha,
        head: 'integration',
        tip: head(ticketB)
      })
    ).toBeNull()
    expect(await commitsAhead(integration, 'integration', 'ticket-a')).toBe(0)
  })

  it('detects a conflict in the dry run without touching anything', async () => {
    repo.commit(ticketB, 'B edits shared', { 'src/shared.ts': 'export const shared = "b"\n' })
    repo.commit(ticketC, 'C edits shared', {
      'src/shared.ts': 'export const shared = "c"\n',
      'src/feature-c.ts': 'export const c = true\n'
    })
    expect((await mergeNoFf(integration, 'ticket-b', 'Merge B1')).ok).toBe(true)
    const before = head(integration)

    expect(await mergeTreeCheck(integration, 'integration', 'ticket-c')).toEqual({
      state: 'conflict',
      files: ['src/shared.ts']
    })
    expect(head(integration)).toBe(before)
    expect(await isDirty(integration)).toBe(false)
    expect(await hasMergeHead(integration)).toBe(false)
  })

  it('cannot answer a dry run for a branch that does not exist', async () => {
    const check = await mergeTreeCheck(integration, 'integration', 'no-such-branch')
    expect(check.state).toBe('unknown')
  })

  it('reports the conflicted files of a real merge and leaves a clean tree after aborting', async () => {
    const before = head(integration)
    const attempt = await mergeNoFf(integration, 'ticket-c', 'Merge C1')
    expect(attempt.ok).toBe(false)
    expect(attempt.output).toContain('CONFLICT')
    expect(await conflictedFiles(integration)).toEqual(['src/shared.ts'])
    expect(await hasMergeHead(integration)).toBe(true)

    // Committing now would record the conflict markers as the resolution.
    await expect(commitAll(integration, 'no')).rejects.toBeInstanceOf(UnresolvedConflictsError)

    await mergeAbort(integration)
    expect(await hasMergeHead(integration)).toBe(false)
    expect(await isDirty(integration)).toBe(false)
    expect(await conflictedFiles(integration)).toEqual([])
    expect(head(integration)).toBe(before)
    expect(existsSync(join(integration, 'src/feature-c.ts'))).toBe(false)

    // Aborting again is a no-op, not an error.
    await expect(mergeAbort(integration)).resolves.toBeUndefined()
  })

  it('concludes a merge whose conflicts were resolved', async () => {
    expect((await mergeNoFf(ticketC, 'integration', 'Merge integration into C')).ok).toBe(false)
    repo.write(ticketC, { 'src/shared.ts': 'export const shared = "b+c"\n' })
    repo.git(ticketC, 'add', 'src/shared.ts')
    expect(await conflictedFiles(ticketC)).toEqual([])
    expect(await hasMergeHead(ticketC)).toBe(true)

    const resolved = await commitAll(ticketC, 'C1 · Resolve conflicts')
    expect(resolved.committed).toBe(true)
    expect(await hasMergeHead(ticketC)).toBe(false)
    expect(repo.git(ticketC, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2)

    expect(await mergeTreeCheck(integration, 'integration', 'ticket-c')).toEqual({
      state: 'clean'
    })
    expect((await mergeNoFf(integration, 'ticket-c', 'Merge C1')).ok).toBe(true)
    expect(readFileSync(join(integration, 'src/shared.ts'), 'utf8')).toContain('b+c')
  })

  it('rolls a merge back to the pre-merge commit and removes untracked files', async () => {
    const ticketD = repo.addWorktree('ticket-d', 'integration')
    repo.commit(ticketD, 'D adds a file', { 'src/feature-d.ts': 'export const d = true\n' })
    const preMerge = head(integration)
    expect((await mergeNoFf(integration, 'ticket-d', 'Merge D1')).ok).toBe(true)
    // What a failed fix session leaves behind.
    repo.write(integration, {
      'scratch/notes.txt': 'left over\n',
      'src/app.ts': 'export const app = "half-fixed"\n'
    })

    expect(await isAncestor(integration, preMerge, 'HEAD')).toBe(true)
    await resetHard(integration, preMerge)
    await cleanUntracked(integration)

    expect(head(integration)).toBe(preMerge)
    expect(await isDirty(integration)).toBe(false)
    expect(existsSync(join(integration, 'scratch'))).toBe(false)
    expect(existsSync(join(integration, 'src/feature-d.ts'))).toBe(false)
    expect(
      await findMergeCommitOf(integration, {
        since: repo.baseSha,
        head: 'integration',
        tip: head(ticketD)
      })
    ).toBeNull()
    // The ticket branch keeps its work.
    expect(await commitsAhead(integration, 'integration', 'ticket-d')).toBe(1)
  })

  it('lists changed files, migrations among them, and sums the diff', async () => {
    const ticketE = repo.addWorktree('ticket-e', 'integration')
    repo.git(ticketE, 'rm', '-q', 'README.md')
    repo.commit(ticketE, 'E adds migrations', {
      'db/migrations/001_init.sql': 'create table a (id int);\n',
      'drizzle/0001_add_b.sql': 'create table b (id int);\n',
      'drizzle/meta/_journal.json': '{}\n',
      'drizzle/meta/0001_snapshot.json': '{}\n',
      'src/feature e.ts': 'export const e = true\n'
    })
    expect((await mergeNoFf(integration, 'ticket-e', 'Merge E1')).ok).toBe(true)

    const entries = await diffNameStatus(integration, repo.baseSha, 'HEAD')
    expect(entries).toContainEqual({ status: 'D', path: 'README.md' })
    expect(entries).toContainEqual({ status: 'A', path: 'db/migrations/001_init.sql' })
    expect(entries).toContainEqual({ status: 'M', path: 'src/shared.ts' })
    // Paths arrive unquoted, spaces and all.
    expect(entries).toContainEqual({ status: 'A', path: 'src/feature e.ts' })

    const changed = entries.filter((entry) => entry.status !== 'D').map((entry) => entry.path)
    expect(collectMigrationPaths(changed)).toEqual([
      'db/migrations/001_init.sql',
      'drizzle/0001_add_b.sql'
    ])

    const stat = await shortStat(integration, repo.baseSha, 'HEAD')
    expect(stat.filesChanged).toBe(entries.length)
    expect(stat.insertions).toBeGreaterThan(0)
    expect(stat.deletions).toBeGreaterThan(0)
    expect(await shortStat(integration, 'HEAD', 'HEAD')).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0
    })
    expect(await commitCount(integration, repo.baseSha, 'HEAD')).toBe(
      Number(repo.git(integration, 'rev-list', '--count', `${repo.baseSha}..HEAD`))
    )
  })

  it('left the base branch and the main checkout exactly as they were', async () => {
    expect(await revParse(repo.projectPath, 'refs/heads/main')).toBe(repo.baseSha)
    expect(head(repo.projectPath)).toBe(repo.baseSha)
    expect(await currentBranch(repo.projectPath)).toBe('main')
    expect(await isDirty(repo.projectPath)).toBe(false)
    expect(readFileSync(join(repo.projectPath, 'src/shared.ts'), 'utf8')).toBe(
      'export const shared = "base"\n'
    )
  })
})

describe('isMigrationPath', () => {
  it.each([
    'db/migrations/001_init.sql',
    'migrations/2024_01_01_add_users.ts',
    'apps/api/src/migrations/1700000000-AddUsers.ts',
    'prisma/migrations/20240101120000_init/migration.sql',
    'db/migrate/20240101120000_create_users.rb',
    'drizzle/0003_brave_wolverine.sql',
    'packages/db/drizzle/meta/_journal.json',
    'alembic/versions/3f2a_add_users.py',
    'backend/db/versions/0002_add_orders.py',
    'app/Migration/Version20240101.php',
    'database/schema.sql',
    'supabase/seed.sql',
    'src\\db\\migrations\\002_more.sql'
  ])('%s is a migration', (path) => {
    expect(isMigrationPath(path)).toBe(true)
  })

  it.each([
    'src/app.ts',
    'src/versions/list.ts',
    'docs/versions/v2.html',
    'scripts/report.sql',
    'src/migrations.ts',
    'src/lib/migrate.ts',
    'db/migrations/README.md',
    'src/drizzle.config.ts',
    'packages/database/src/client.ts'
  ])('%s is not a migration', (path) => {
    expect(isMigrationPath(path)).toBe(false)
  })
})

describe('collectMigrationPaths', () => {
  it('drops generated bookkeeping next to a listed migration, and duplicates', () => {
    expect(
      collectMigrationPaths([
        'prisma/migrations/20240101_init/migration.sql',
        'prisma/migrations/migration_lock.toml',
        'app/migrations/0002_add_field.py',
        'app/migrations/__init__.py',
        'app/migrations/0002_add_field.py',
        'src/index.ts'
      ])
    ).toEqual(['prisma/migrations/20240101_init/migration.sql', 'app/migrations/0002_add_field.py'])
  })

  it('keeps bookkeeping that changed on its own: it is the only sign of a schema change', () => {
    expect(
      collectMigrationPaths(['drizzle/meta/_journal.json', 'db/migrations/001_init.sql'])
    ).toEqual(['drizzle/meta/_journal.json', 'db/migrations/001_init.sql'])
  })
})
