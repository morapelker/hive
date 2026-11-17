import { existsSync } from 'fs'
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../db/types'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  ensureFolderTrustedInClaudeConfig,
  ensureFoldersTrustedInClaudeConfig,
  ensureProjectTrustCheck,
  moveFolderEntryInClaudeConfig,
  reassertSessionFolderTrust,
  resolveClaudeConfigPath,
  trustFoldersInClaudeConfig
} from '../claude-trust'

let dir: string
let configPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-trust-test-'))
  configPath = join(dir, '.claude.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, 'utf-8'))
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    path: '/repo/root',
    description: null,
    tags: null,
    language: null,
    custom_icon: null,
    detected_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    worktree_create_script: null,
    custom_commands: null,
    auto_assign_port: false,
    trust_check_done: false,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    last_accessed_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('ensureFolderTrustedInClaudeConfig', () => {
  it('creates the config with a trusted entry when the file is missing', async () => {
    await expect(ensureFolderTrustedInClaudeConfig(configPath, '/repo/root')).resolves.toBe(true)

    expect(await readConfig()).toEqual({
      projects: { '/repo/root': { hasTrustDialogAccepted: true } }
    })
  })

  it('adds the project entry while preserving unrelated config content', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        numStartups: 12,
        oauthAccount: { emailAddress: 'someone@example.com' },
        projects: { '/other/project': { hasTrustDialogAccepted: false, lastCost: 3 } }
      })
    )

    await expect(ensureFolderTrustedInClaudeConfig(configPath, '/repo/root')).resolves.toBe(true)

    expect(await readConfig()).toEqual({
      numStartups: 12,
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: {
        '/other/project': { hasTrustDialogAccepted: false, lastCost: 3 },
        '/repo/root': { hasTrustDialogAccepted: true }
      }
    })
  })

  it('flips an untrusted entry to trusted while keeping its sibling keys', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        projects: { '/repo/root': { hasTrustDialogAccepted: false, exampleFilesGeneratedAt: 42 } }
      })
    )

    await expect(ensureFolderTrustedInClaudeConfig(configPath, '/repo/root')).resolves.toBe(true)

    expect(await readConfig()).toEqual({
      projects: { '/repo/root': { hasTrustDialogAccepted: true, exampleFilesGeneratedAt: 42 } }
    })
  })

  it('does not rewrite the file when the folder is already trusted', async () => {
    const original = `{"projects":{"/repo/root":{"hasTrustDialogAccepted":true}}}`
    await writeFile(configPath, original)

    await expect(ensureFolderTrustedInClaudeConfig(configPath, '/repo/root')).resolves.toBe(true)

    // A rewrite would pretty-print; byte equality proves the file was untouched.
    expect(await readFile(configPath, 'utf-8')).toBe(original)
  })

  it('leaves an unparseable config untouched and reports failure', async () => {
    await writeFile(configPath, '{ this is not json')

    await expect(ensureFolderTrustedInClaudeConfig(configPath, '/repo/root')).resolves.toBe(false)

    expect(await readFile(configPath, 'utf-8')).toBe('{ this is not json')
  })

  it('leaves a non-object config untouched and reports failure', async () => {
    await writeFile(configPath, '[1,2,3]')

    await expect(ensureFolderTrustedInClaudeConfig(configPath, '/repo/root')).resolves.toBe(false)

    expect(await readFile(configPath, 'utf-8')).toBe('[1,2,3]')
  })

  it('serializes concurrent writes for different folders into one config', async () => {
    await Promise.all([
      ensureFolderTrustedInClaudeConfig(configPath, '/repo/a'),
      ensureFolderTrustedInClaudeConfig(configPath, '/repo/b'),
      ensureFolderTrustedInClaudeConfig(configPath, '/repo/c')
    ])

    expect(await readConfig()).toEqual({
      projects: {
        '/repo/a': { hasTrustDialogAccepted: true },
        '/repo/b': { hasTrustDialogAccepted: true },
        '/repo/c': { hasTrustDialogAccepted: true }
      }
    })
  })
})

describe('ensureFoldersTrustedInClaudeConfig', () => {
  it('trusts several folders in a single write', async () => {
    await expect(
      ensureFoldersTrustedInClaudeConfig(configPath, ['/repo/root', '/wt/root/feature'])
    ).resolves.toBe(true)

    expect(await readConfig()).toEqual({
      projects: {
        '/repo/root': { hasTrustDialogAccepted: true },
        '/wt/root/feature': { hasTrustDialogAccepted: true }
      }
    })
  })

  it('does not rewrite the file when every folder is already trusted', async () => {
    const original = `{"projects":{"/repo/root":{"hasTrustDialogAccepted":true},"/wt/a":{"hasTrustDialogAccepted":true}}}`
    await writeFile(configPath, original)

    await expect(
      ensureFoldersTrustedInClaudeConfig(configPath, ['/repo/root', '/wt/a'])
    ).resolves.toBe(true)

    expect(await readFile(configPath, 'utf-8')).toBe(original)
  })

  it('only adds the folders that are missing', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ projects: { '/repo/root': { hasTrustDialogAccepted: true, lastCost: 1 } } })
    )

    await ensureFoldersTrustedInClaudeConfig(configPath, ['/repo/root', '/wt/a'])

    expect(await readConfig()).toEqual({
      projects: {
        '/repo/root': { hasTrustDialogAccepted: true, lastCost: 1 },
        '/wt/a': { hasTrustDialogAccepted: true }
      }
    })
  })
})

describe('ensureProjectTrustCheck', () => {
  function makeDb(
    project: Project | null,
    setting: string | null = null
  ): {
    getProject: ReturnType<typeof vi.fn>
    updateProjectTrustCheck: ReturnType<typeof vi.fn>
    getSetting: ReturnType<typeof vi.fn>
  } {
    return {
      getProject: vi.fn(() => project),
      updateProjectTrustCheck: vi.fn(),
      getSetting: vi.fn(() => setting)
    }
  }

  it('trusts the project root and stamps trust_check_done', async () => {
    const db = makeDb(makeProject())

    await ensureProjectTrustCheck(db, 'project-1', { configPath })

    expect(await readConfig()).toEqual({
      projects: { '/repo/root': { hasTrustDialogAccepted: true } }
    })
    expect(db.updateProjectTrustCheck).toHaveBeenCalledWith('project-1', true)
  })

  it('trusts the connection directory for a connection project, not its project path', async () => {
    const db = makeDb(
      makeProject({ kind: 'connection', path: '/home/dev/.hive/connection-projects/abcd1234' })
    )

    await ensureProjectTrustCheck(db, 'project-1', {
      configPath,
      worktreePath: '/home/dev/.hive/connections/37feb7fd'
    })

    expect(await readConfig()).toEqual({
      projects: { '/home/dev/.hive/connections/37feb7fd': { hasTrustDialogAccepted: true } }
    })
    // The project path is never a session cwd, so there is no root check to stamp.
    expect(db.updateProjectTrustCheck).not.toHaveBeenCalled()
  })

  it('does nothing for a connection project launched without a session directory', async () => {
    const db = makeDb(makeProject({ kind: 'connection' }))

    await ensureProjectTrustCheck(db, 'project-1', { configPath })

    await expect(readFile(configPath, 'utf-8')).rejects.toThrow()
    expect(db.updateProjectTrustCheck).not.toHaveBeenCalled()
  })

  it('skips projects already stamped trust_check_done', async () => {
    const db = makeDb(makeProject({ trust_check_done: true }))

    await ensureProjectTrustCheck(db, 'project-1', { configPath })

    await expect(readFile(configPath, 'utf-8')).rejects.toThrow()
    expect(db.updateProjectTrustCheck).not.toHaveBeenCalled()
  })

  it('trusts the worktree alongside the root — worktrees live outside the repo', async () => {
    const db = makeDb(makeProject())

    await ensureProjectTrustCheck(db, 'project-1', {
      configPath,
      worktreePath: '/home/dev/.hive-worktrees/project/project--feature'
    })

    expect(await readConfig()).toEqual({
      projects: {
        '/repo/root': { hasTrustDialogAccepted: true },
        '/home/dev/.hive-worktrees/project/project--feature': { hasTrustDialogAccepted: true }
      }
    })
    expect(db.updateProjectTrustCheck).toHaveBeenCalledWith('project-1', true)
  })

  it('still trusts a new worktree when the project is already stamped trust_check_done', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ projects: { '/repo/root': { hasTrustDialogAccepted: true } } })
    )
    const db = makeDb(makeProject({ trust_check_done: true }))

    await ensureProjectTrustCheck(db, 'project-1', {
      configPath,
      worktreePath: '/home/dev/.hive-worktrees/project/project--feature'
    })

    expect(await readConfig()).toEqual({
      projects: {
        '/repo/root': { hasTrustDialogAccepted: true },
        '/home/dev/.hive-worktrees/project/project--feature': { hasTrustDialogAccepted: true }
      }
    })
    // The root stamp is already set; nothing to re-stamp.
    expect(db.updateProjectTrustCheck).not.toHaveBeenCalled()
  })

  it('does not duplicate the root entry when the session runs in the repo root itself', async () => {
    const db = makeDb(makeProject())

    await ensureProjectTrustCheck(db, 'project-1', { configPath, worktreePath: '/repo/root' })

    expect(await readConfig()).toEqual({
      projects: { '/repo/root': { hasTrustDialogAccepted: true } }
    })
  })

  it('does not stamp trust_check_done when the config could not be updated', async () => {
    await writeFile(configPath, '{ corrupt')
    const db = makeDb(makeProject())

    await ensureProjectTrustCheck(db, 'project-1', { configPath })

    expect(db.updateProjectTrustCheck).not.toHaveBeenCalled()
  })

  it('is a no-op for an unknown project', async () => {
    const db = makeDb(null)

    await ensureProjectTrustCheck(db, 'missing', { configPath })

    expect(db.updateProjectTrustCheck).not.toHaveBeenCalled()
  })

  it('never throws, even when the db lookup fails', async () => {
    const db = {
      getProject: vi.fn(() => {
        throw new Error('db exploded')
      }),
      updateProjectTrustCheck: vi.fn(),
      getSetting: vi.fn(() => null)
    }

    await expect(ensureProjectTrustCheck(db, 'project-1', { configPath })).resolves.toBeUndefined()
    expect(db.updateProjectTrustCheck).not.toHaveBeenCalled()
  })

  it("honors a CLAUDE_CONFIG_DIR from the user's settings env vars", async () => {
    const db = makeDb(
      makeProject(),
      JSON.stringify({ environmentVariables: [{ key: 'CLAUDE_CONFIG_DIR', value: dir }] })
    )

    await ensureProjectTrustCheck(db, 'project-1')

    expect(await readConfig()).toEqual({
      projects: { '/repo/root': { hasTrustDialogAccepted: true } }
    })
    expect(db.updateProjectTrustCheck).toHaveBeenCalledWith('project-1', true)
  })
})

describe('resolveClaudeConfigPath', () => {
  it('uses $CLAUDE_CONFIG_DIR/.claude.json when the variable is set', () => {
    expect(resolveClaudeConfigPath({ CLAUDE_CONFIG_DIR: '/custom/cfg' })).toBe(
      join('/custom/cfg', '.claude.json')
    )
  })

  it('falls back to ~/.claude.json when unset or empty', () => {
    expect(resolveClaudeConfigPath({})).toBe(join(homedir(), '.claude.json'))
    expect(resolveClaudeConfigPath({ CLAUDE_CONFIG_DIR: '' })).toBe(join(homedir(), '.claude.json'))
  })
})

describe('trustFoldersInClaudeConfig', () => {
  it('reports which folders had to be written', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ projects: { '/already': { hasTrustDialogAccepted: true } } })
    )

    const first = await trustFoldersInClaudeConfig(configPath, ['/already', '/fresh'])
    expect(first).toEqual({ ok: true, newlyTrusted: ['/fresh'] })

    const second = await trustFoldersInClaudeConfig(configPath, ['/already', '/fresh'])
    expect(second).toEqual({ ok: true, newlyTrusted: [] })
  })

  it('waits for a live lock on the config and leaves no lock behind', async () => {
    const lockPath = `${configPath}.lock`
    await mkdir(lockPath)

    let settled = false
    const pending = trustFoldersInClaudeConfig(configPath, ['/repo/root']).then((result) => {
      settled = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(settled).toBe(false)
    expect(existsSync(configPath)).toBe(false)

    await rm(lockPath, { recursive: true })
    await expect(pending).resolves.toEqual({ ok: true, newlyTrusted: ['/repo/root'] })
    expect(await readConfig()).toEqual({
      projects: { '/repo/root': { hasTrustDialogAccepted: true } }
    })
    expect(existsSync(lockPath)).toBe(false)
  })

  it('takes over a stale lock left by a dead process', async () => {
    const lockPath = `${configPath}.lock`
    await mkdir(lockPath)
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    await expect(trustFoldersInClaudeConfig(configPath, ['/repo/root'])).resolves.toEqual({
      ok: true,
      newlyTrusted: ['/repo/root']
    })
    expect(existsSync(lockPath)).toBe(false)
  })
})

describe('reassertSessionFolderTrust', () => {
  const db = { getSetting: () => null }

  it('reports a missing entry (lost to a concurrent writer) and writes it back', async () => {
    await writeFile(configPath, JSON.stringify({ projects: {} }))

    await expect(reassertSessionFolderTrust(db, '/repo/worktree', { configPath })).resolves.toEqual(
      { wasMissing: true }
    )
    expect(await readConfig()).toEqual({
      projects: { '/repo/worktree': { hasTrustDialogAccepted: true } }
    })
  })

  it('reports an entry that was there all along', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ projects: { '/repo/worktree': { hasTrustDialogAccepted: true } } })
    )

    await expect(reassertSessionFolderTrust(db, '/repo/worktree', { configPath })).resolves.toEqual(
      { wasMissing: false }
    )
  })
})

describe('moveFolderEntryInClaudeConfig', () => {
  const entry = {
    allowedTools: ['Bash(pnpm test:*)'],
    mcpServers: { docs: { command: 'docs-server', args: ['--stdio'] } },
    hasTrustDialogAccepted: true,
    lastCost: 1.25
  }
  // The config is always the one in this test's temp directory; the folders are paths in it.
  const oldFolder = (): string => join(dir, 'dev-old', 'app')
  const newFolder = (): string => join(dir, 'dev-new', 'app')

  it('copies the entry to the new folder and removes the old one when that folder is gone', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        numStartups: 12,
        oauthAccount: { emailAddress: 'someone@example.com' },
        projects: { '/other/project': { hasTrustDialogAccepted: false }, [oldFolder()]: entry }
      })
    )

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: true, removed: true })

    expect(await readConfig()).toEqual({
      numStartups: 12,
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: { '/other/project': { hasTrustDialogAccepted: false }, [newFolder()]: entry }
    })
  })

  it('keeps the old entry while the old folder is still on disk', async () => {
    await mkdir(oldFolder(), { recursive: true })
    await writeFile(configPath, JSON.stringify({ projects: { [oldFolder()]: entry } }))

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: true, removed: false })

    expect(await readConfig()).toEqual({
      projects: { [oldFolder()]: entry, [newFolder()]: entry }
    })

    // Once the old folder has been cleaned up, a second call only removes its entry.
    await rm(oldFolder(), { recursive: true })
    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: false, removed: true })
    expect(await readConfig()).toEqual({ projects: { [newFolder()]: entry } })
  })

  it('never replaces a value the new folder already has', async () => {
    const existing = {
      allowedTools: ['Bash(ls:*)'],
      mcpServers: { own: { type: 'stdio', command: 'own-server', args: [], env: {} } },
      hasTrustDialogAccepted: true,
      lastCost: 0.5
    }
    await writeFile(
      configPath,
      JSON.stringify({ projects: { [oldFolder()]: entry, [newFolder()]: existing } })
    )

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: false, removed: true })

    expect(await readConfig()).toEqual({ projects: { [newFolder()]: existing } })
  })

  // What the CLI keeps for a folder it has been used and configured in.
  const configuredEntry = {
    allowedTools: ['Bash(pnpm test:*)', 'Read'],
    mcpContextUris: [],
    mcpServers: {
      docs: {
        type: 'stdio',
        command: 'docs-server',
        args: ['--stdio'],
        env: { DOCS_TOKEN: 'secret' }
      }
    },
    enabledMcpjsonServers: ['github'],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    lastCost: 1.25,
    lastDuration: 8990,
    lastSessionId: '1721ffd4-cd4e-410c-9300-387ecf0a094e'
  }

  // What the CLI (2.1.326) writes on exit for a folder nothing was ever set up in: every key
  // is there, with nothing in it, next to the counters of that one run.
  const untouchedEntry = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: false,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    lastCost: 0,
    lastAPIDuration: 0,
    lastAPIDurationWithoutRetries: 0,
    lastToolDuration: 0,
    lastDuration: 17990,
    lastStartTime: 1794915639557,
    lastLinesAdded: 0,
    lastLinesRemoved: 0,
    lastTotalInputTokens: 0,
    lastTotalOutputTokens: 0,
    lastTotalCacheCreationInputTokens: 0,
    lastTotalCacheReadInputTokens: 0,
    lastTotalWebSearchRequests: 0,
    lastFpsAverage: 1.26,
    lastFpsLow1Pct: 404.97,
    lastGracefulShutdown: true,
    lastVersionBase: '2.1.326',
    lastModelUsage: {},
    lastSessionId: '4783e530-84ce-4fa3-97d0-d14c40fca919'
  }

  it('keeps what the CLI stored under the real path when the app trusted another spelling', async () => {
    // The app trusts a folder under the path it stores; the CLI keys everything else by the
    // real path. Both spellings move to the one new folder, the stored one first.
    const storedSpelling = join(dir, 'link-to-dev-old', 'app')
    await writeFile(
      configPath,
      JSON.stringify({
        projects: {
          [storedSpelling]: { hasTrustDialogAccepted: true },
          [oldFolder()]: { ...configuredEntry, hasTrustDialogAccepted: false }
        }
      })
    )

    await expect(
      moveFolderEntryInClaudeConfig(configPath, storedSpelling, newFolder())
    ).resolves.toEqual({ ok: true, copied: true, removed: true })
    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: true, removed: true })

    expect(await readConfig()).toEqual({ projects: { [newFolder()]: configuredEntry } })
  })

  it('fills an entry the CLI wrote with nothing in it from the old folder', async () => {
    // A CLI left open in a worktree that stayed where it was writes such an entry for the
    // project's earlier path when it exits; the project then moves back to that path.
    await writeFile(
      configPath,
      JSON.stringify({
        projects: { [oldFolder()]: configuredEntry, [newFolder()]: untouchedEntry }
      })
    )

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: true, removed: true })

    expect(await readConfig()).toEqual({
      projects: {
        [newFolder()]: {
          // Its own counters stay; what it left open comes from the old folder.
          ...untouchedEntry,
          allowedTools: configuredEntry.allowedTools,
          mcpServers: configuredEntry.mcpServers,
          enabledMcpjsonServers: configuredEntry.enabledMcpjsonServers,
          hasTrustDialogAccepted: true,
          lastCost: 1.25
        }
      }
    })
  })

  it('takes nothing more from the old folder the second time', async () => {
    await mkdir(oldFolder(), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        projects: { [oldFolder()]: configuredEntry, [newFolder()]: untouchedEntry }
      })
    )

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: true, removed: false })
    const afterFirst = await readFile(configPath, 'utf-8')

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: false, removed: false })
    expect(await readFile(configPath, 'utf-8')).toBe(afterFirst)
  })

  it('removes the old entry of a folder that is still on disk when told to', async () => {
    await mkdir(oldFolder(), { recursive: true })
    await writeFile(configPath, JSON.stringify({ projects: { [oldFolder()]: entry } }))

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder(), { removeOld: 'always' })
    ).resolves.toEqual({ ok: true, copied: true, removed: true })
    expect(await readConfig()).toEqual({ projects: { [newFolder()]: entry } })

    // Running it again finds nothing left to do.
    const afterFirst = await readFile(configPath, 'utf-8')
    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder(), { removeOld: 'always' })
    ).resolves.toEqual({ ok: true, copied: false, removed: false })
    expect(await readFile(configPath, 'utf-8')).toBe(afterFirst)
  })

  it('removes the old entry when told to, also when the new folder has an entry already', async () => {
    await mkdir(oldFolder(), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        projects: {
          [oldFolder()]: configuredEntry,
          [newFolder()]: { hasTrustDialogAccepted: true }
        }
      })
    )

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder(), { removeOld: 'always' })
    ).resolves.toEqual({ ok: true, copied: true, removed: true })

    expect(await readConfig()).toEqual({ projects: { [newFolder()]: configuredEntry } })
  })

  it("keeps the old entry of a folder that is still on disk under 'when-gone'", async () => {
    await mkdir(oldFolder(), { recursive: true })
    await writeFile(configPath, JSON.stringify({ projects: { [oldFolder()]: entry } }))

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder(), {
        removeOld: 'when-gone'
      })
    ).resolves.toEqual({ ok: true, copied: true, removed: false })

    expect(await readConfig()).toEqual({
      projects: { [oldFolder()]: entry, [newFolder()]: entry }
    })
  })

  it('does not rewrite the file when there is nothing to do', async () => {
    await mkdir(oldFolder(), { recursive: true })
    const untouched = [
      // No entry for the old folder.
      `{"projects":{"/other/project":{"hasTrustDialogAccepted":true}}}`,
      // No projects at all.
      `{"numStartups":3}`,
      // The new folder's entry leaves nothing open that the old one could fill (an empty
      // value at both ends is not one), and the old folder is still on disk.
      JSON.stringify({
        projects: {
          [oldFolder()]: { ...entry, mcpContextUris: [], lastModelUsage: {} },
          [newFolder()]: { ...entry, mcpContextUris: [], lastModelUsage: {}, lastCost: 0.5 }
        }
      }),
      // The new folder's entry is not an object: it is left as it is.
      JSON.stringify({ projects: { [oldFolder()]: entry, [newFolder()]: 'garbage' } })
    ]
    for (const original of untouched) {
      await writeFile(configPath, original)

      await expect(
        moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
      ).resolves.toEqual({ ok: true, copied: false, removed: false })

      // A rewrite would pretty-print; byte equality proves the file was untouched.
      expect(await readFile(configPath, 'utf-8')).toBe(original)
    }
  })

  it('is a no-op the second time', async () => {
    await writeFile(configPath, JSON.stringify({ projects: { [oldFolder()]: entry } }))

    await moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    const afterFirst = await readFile(configPath, 'utf-8')

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: false, removed: false })
    expect(await readFile(configPath, 'utf-8')).toBe(afterFirst)
  })

  it('does nothing when the old and the new folder are the same path', async () => {
    const original = JSON.stringify({ projects: { [oldFolder()]: entry } })
    await writeFile(configPath, original)

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), oldFolder())
    ).resolves.toEqual({ ok: true, copied: false, removed: false })

    expect(await readFile(configPath, 'utf-8')).toBe(original)
  })

  it('does not create a config that is missing', async () => {
    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: false, removed: false })

    expect(existsSync(configPath)).toBe(false)
    expect(existsSync(`${configPath}.lock`)).toBe(false)
  })

  it('leaves an unparseable config untouched and reports failure', async () => {
    for (const broken of ['{ this is not json', '[1,2,3]']) {
      await writeFile(configPath, broken)

      await expect(
        moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
      ).resolves.toEqual({ ok: false, copied: false, removed: false })

      expect(await readFile(configPath, 'utf-8')).toBe(broken)
    }
  })

  it('removes an old entry that is not an object without copying it', async () => {
    await writeFile(configPath, JSON.stringify({ projects: { [oldFolder()]: 'garbage' } }))

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: true, copied: false, removed: true })

    expect(await readConfig()).toEqual({ projects: {} })
  })

  it('queues behind the trust writes of this process: neither loses the other', async () => {
    await writeFile(configPath, JSON.stringify({ projects: { [oldFolder()]: entry } }))

    const [trusted, moved, trustedAgain] = await Promise.all([
      trustFoldersInClaudeConfig(configPath, ['/repo/a']),
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder()),
      trustFoldersInClaudeConfig(configPath, ['/repo/b'])
    ])

    expect(trusted.ok).toBe(true)
    expect(moved).toEqual({ ok: true, copied: true, removed: true })
    expect(trustedAgain.ok).toBe(true)
    expect(await readConfig()).toEqual({
      projects: {
        [newFolder()]: entry,
        '/repo/a': { hasTrustDialogAccepted: true },
        '/repo/b': { hasTrustDialogAccepted: true }
      }
    })
  })

  it('waits for a live lock on the config and leaves no lock behind', async () => {
    await writeFile(configPath, JSON.stringify({ projects: { [oldFolder()]: entry } }))
    const lockPath = `${configPath}.lock`
    await mkdir(lockPath)

    let settled = false
    const pending = moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder()).then(
      (result) => {
        settled = true
        return result
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(settled).toBe(false)
    expect(await readConfig()).toEqual({ projects: { [oldFolder()]: entry } })

    await rm(lockPath, { recursive: true })
    await expect(pending).resolves.toEqual({ ok: true, copied: true, removed: true })
    expect(await readConfig()).toEqual({ projects: { [newFolder()]: entry } })
    expect(existsSync(lockPath)).toBe(false)
  })

  it('reports failure for a config that cannot be read as a file', async () => {
    await mkdir(configPath)

    await expect(
      moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
    ).resolves.toEqual({ ok: false, copied: false, removed: false })

    expect(existsSync(`${configPath}.lock`)).toBe(false)
  })

  // The superuser writes into a read-only directory all the same.
  it.skipIf(process.getuid?.() === 0)(
    'resolves with a failure instead of rejecting when the config cannot be written',
    async () => {
      const original = JSON.stringify({ projects: { [oldFolder()]: entry } })
      await writeFile(configPath, original)
      await chmod(dir, 0o500)
      try {
        await expect(
          moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
        ).resolves.toEqual({ ok: false, copied: false, removed: false })

        expect(await readFile(configPath, 'utf-8')).toBe(original)
        // The queue is not left broken: the next write goes through once it can.
        await chmod(dir, 0o700)
        await expect(
          moveFolderEntryInClaudeConfig(configPath, oldFolder(), newFolder())
        ).resolves.toEqual({ ok: true, copied: true, removed: true })
      } finally {
        await chmod(dir, 0o700)
      }
    }
  )
})
