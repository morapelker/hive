import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

describe('dev data setup', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('exposes the fixed dev data + worktrees dirs', async () => {
    const { DEV_DATA_DIR, DEV_WORKTREES_DIR } = await import('../scripts/dev-data-setup.mjs')

    expect(DEV_DATA_DIR).toBe(resolve(homedir(), '.hive-dev'))
    expect(DEV_WORKTREES_DIR).toBe(resolve(homedir(), '.hive-dev-worktrees'))
  })

  test('HIVE_DEV_DATA_DIR relocates both dev dirs as siblings (per-worktree isolation)', async () => {
    vi.stubEnv('HIVE_DEV_DATA_DIR', '/wt/standalone/.hive-data')
    vi.resetModules() // re-evaluate the module so the env override is read at load
    const { DEV_DATA_DIR, DEV_WORKTREES_DIR } = await import('../scripts/dev-data-setup.mjs')

    expect(DEV_DATA_DIR).toBe('/wt/standalone/.hive-data')
    expect(DEV_WORKTREES_DIR).toBe('/wt/standalone/.hive-data-worktrees')
  })

  test('a relative HIVE_DEV_DATA_DIR is resolved to an absolute path and trimmed', async () => {
    vi.stubEnv('HIVE_DEV_DATA_DIR', '  rel/.hive-data  ')
    vi.resetModules()
    const { DEV_DATA_DIR, DEV_WORKTREES_DIR } = await import('../scripts/dev-data-setup.mjs')

    expect(DEV_DATA_DIR).toBe(resolve('rel/.hive-data'))
    expect(DEV_WORKTREES_DIR).toBe(resolve('rel/.hive-data-worktrees'))
  })

  test('parses the clone-vs-fresh answer (empty defaults to sync)', async () => {
    const { parseSyncAnswer } = await import('../scripts/dev-data-setup.mjs')

    for (const fresh of ['f', 'F', 'fresh', 'FRESH', 'n', 'no', 'scratch', '  fresh  ']) {
      expect(parseSyncAnswer(fresh)).toBe('fresh')
    }
    for (const sync of ['', '  ', 's', 'S', 'sync', 'y', 'YES', 'huh?']) {
      expect(parseSyncAnswer(sync)).toBe('sync')
    }
    expect(parseSyncAnswer(undefined)).toBe('sync')
  })

  test('parses the quit-official-app confirm (default No)', async () => {
    const { parseQuitAnswer } = await import('../scripts/dev-data-setup.mjs')

    for (const yes of ['y', 'Y', 'yes', 'YES', '  yes  ']) {
      expect(parseQuitAnswer(yes)).toBe(true)
    }
    for (const no of ['', '  ', 'n', 'no', 'nope', 'sync', undefined]) {
      expect(parseQuitAnswer(no)).toBe(false)
    }
  })

  test('maps a convention-path worktree to its dev twin keeping the full sub-path', async () => {
    const { mapWorktreeDevPath } = await import('../scripts/dev-data-setup.mjs')

    const legacyWorktreesDir = '/home/me/.hive-worktrees'
    const devWorktreesDir = '/home/me/.hive-dev-worktrees'
    const prodPath = `${legacyWorktreesDir}/my-proj/my-proj--golden-retriever`

    expect(
      mapWorktreeDevPath(prodPath, {
        legacyWorktreesDir,
        devWorktreesDir,
        projectName: 'my-proj'
      })
    ).toBe(`${devWorktreesDir}/my-proj/my-proj--golden-retriever`)
  })

  test('consolidates a foreign-path worktree under devWorktreesDir/<project>/<basename>', async () => {
    const { mapWorktreeDevPath } = await import('../scripts/dev-data-setup.mjs')

    const legacyWorktreesDir = '/home/me/.hive-worktrees'
    const devWorktreesDir = '/home/me/.hive-dev-worktrees'
    // A worktree the user created at a custom location (sibling of the repo).
    const prodPath = '/home/me/Personal/wellifiy-ror-standalone-1'

    expect(
      mapWorktreeDevPath(prodPath, {
        legacyWorktreesDir,
        devWorktreesDir,
        projectName: 'wellifiy-ror'
      })
    ).toBe(`${devWorktreesDir}/wellifiy-ror/wellifiy-ror-standalone-1`)
  })

  test('foreign-path mapping sanitizes the project segment and tolerates a missing name', async () => {
    const { mapWorktreeDevPath } = await import('../scripts/dev-data-setup.mjs')

    const legacyWorktreesDir = '/home/me/.hive-worktrees'
    const devWorktreesDir = '/home/me/.hive-dev-worktrees'
    const prodPath = '/tmp/custom/wt-foo'

    // A name containing separators / leading dots can't escape devWorktreesDir.
    expect(
      mapWorktreeDevPath(prodPath, {
        legacyWorktreesDir,
        devWorktreesDir,
        projectName: '../evil/name'
      })
    ).toBe(`${devWorktreesDir}/evil-name/wt-foo`)

    // No project name → fall back to devWorktreesDir/<basename>.
    expect(
      mapWorktreeDevPath(prodPath, { legacyWorktreesDir, devWorktreesDir, projectName: '' })
    ).toBe(`${devWorktreesDir}/wt-foo`)
  })

  test('prefixes cloned branches with hive-dev_, leaving detached unchanged', async () => {
    const { devBranchName } = await import('../scripts/dev-data-setup.mjs')

    expect(devBranchName('golden-retriever')).toBe('hive-dev_golden-retriever')
    expect(devBranchName('feature/x')).toBe('hive-dev_feature/x')
    expect(devBranchName('HEAD', { detached: true })).toBe('HEAD')
  })

  test('connection instructions embed the given (dev) connection + worktree paths', async () => {
    const { buildConnectionInstructions } = await import('../scripts/dev-data-setup.mjs')

    const content = buildConnectionInstructions('/Users/me/.hive-dev/connections/abc', [
      {
        symlinkName: 'web',
        projectName: 'Web',
        branchName: 'hive-dev_main',
        worktreePath: '/Users/me/.hive-dev-worktrees/web/web--main'
      }
    ])

    // The active path the agent is told to stay inside is the dev copy…
    expect(content).toContain('(`/Users/me/.hive-dev/connections/abc`)')
    expect(content).toContain('**Real path:** /Users/me/.hive-dev-worktrees/web/web--main')
    // …and never the official locations.
    expect(content).not.toContain('/.hive/connections/')
    expect(content).not.toContain('/.hive-worktrees/')
  })

  test('connection instructions render an empty Projects list with no members', async () => {
    const { buildConnectionInstructions } = await import('../scripts/dev-data-setup.mjs')

    const content = buildConnectionInstructions('/Users/me/.hive-dev/connections/abc', [])

    expect(content).toContain('## Projects')
    expect(content).not.toContain('**Real path:**')
  })
})
