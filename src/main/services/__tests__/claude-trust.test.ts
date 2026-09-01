import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../db/types'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  ensureFolderTrustedInClaudeConfig,
  ensureProjectTrustCheck,
  resolveClaudeConfigPath
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

  it('skips connection projects entirely', async () => {
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
