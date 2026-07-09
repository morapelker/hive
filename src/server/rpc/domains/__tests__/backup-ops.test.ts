import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import YAML from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KanbanTicket, Project, TicketDependency, Worktree } from '../../../../main/db'
import type { BackupFile } from '../../../../shared/types/backup'
import {
  makeBackupOpsRpcHandlers,
  makeBackupOpsRpcService,
  type BackupOpsDeps
} from '../backup-ops'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-backup-ops-'))
  tempDirs.push(dir)
  return dir
}

const now = '2026-06-04T00:00:00.000Z'

function project(overrides: Partial<Project> & Record<string, unknown> = {}): Project {
  return {
    id: 'project-1',
    name: 'repo',
    path: '/repo',
    description: null,
    tags: null,
    language: null,
    custom_icon: null,
    detected_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    worktree_create_script: null,
    custom_commands: [],
    auto_assign_port: false,
    kanban_storage_mode: 'internal',
    kanban_markdown_config: null,
    sort_order: 0,
    created_at: now,
    last_accessed_at: now,
    ...overrides
  } as Project
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'worktree-1',
    project_id: 'project-1',
    name: 'repo',
    branch_name: 'main',
    path: '/repo-worktree',
    status: 'active',
    is_default: false,
    branch_renamed: 1,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    attachments: '[]',
    pinned: 0,
    context: null,
    github_pr_number: null,
    github_pr_url: null,
    teleported_to: null,
    base_branch: null,
    created_at: now,
    last_accessed_at: now,
    ...overrides
  }
}

function ticket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Ticket',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: now,
    updated_at: now,
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    created_from_session: false,
    auto_approve_plan: false,
    ...overrides
  }
}

/** Builds real fs-backed deps for exportBackup tests: writeFile/readFile/stat hit disk. */
function makeFsDeps(): BackupOpsDeps['fs'] {
  return {
    readFile: (path) => readFile(path),
    writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    stat: (path) => stat(path)
  }
}

function makeDeps(overrides: Partial<BackupOpsDeps> = {}): BackupOpsDeps {
  return {
    db: {
      getAllProjects: () => [],
      getActiveWorktreesByProject: () => [],
      getWorktreesByProject: () => [],
      getKanbanTicketsByProject: () => [],
      getDependenciesForProject: () => []
    },
    git: {
      getRemoteUrl: vi.fn(async () => null)
    },
    fs: makeFsDeps(),
    getAppVersion: vi.fn(async () => '1.2.3'),
    requestSaveFileDialog: vi.fn(async () => null),
    requestOpenFileDialog: vi.fn(async () => null),
    ...overrides
  }
}

describe('backupOps.exportBackup', () => {
  it('exports internal-mode tickets/dependencies and omits tickets for markdown-mode projects', async () => {
    const dir = makeTempDir()
    const outPath = join(dir, 'out.yaml')

    const internalProject = project({
      id: 'project-a',
      name: 'internal-repo',
      path: '/internal-repo',
      kanban_storage_mode: 'internal'
    })
    const markdownProject = project({
      id: 'project-b',
      name: 'markdown-repo',
      path: '/markdown-repo',
      kanban_storage_mode: 'markdown'
    })

    const wtA = worktree({ id: 'wt-a', project_id: 'project-a', branch_name: 'feature/a' })
    const ticketA1 = ticket({
      id: 'ticket-a1',
      project_id: 'project-a',
      title: 'First',
      worktree_id: 'wt-a'
    })
    const ticketA2 = ticket({
      id: 'ticket-a2',
      project_id: 'project-a',
      title: 'Second',
      archived_at: '2026-01-01T00:00:00.000Z'
    })
    const dependencyA: TicketDependency = {
      dependent_id: 'ticket-a2',
      blocker_id: 'ticket-a1',
      created_at: now
    }

    // Tickets exist in the DB for the markdown-mode project too — they must
    // NOT appear in the export.
    const markdownTicket = ticket({ id: 'ticket-b1', project_id: 'project-b', title: 'Hidden' })

    const getRemoteUrl = vi.fn(async (repoPath: string) =>
      repoPath === '/internal-repo' ? 'git@github.com:org/internal-repo.git' : null
    )

    const deps = makeDeps({
      db: {
        getAllProjects: () => [internalProject, markdownProject],
        getActiveWorktreesByProject: (projectId) => (projectId === 'project-a' ? [wtA] : []),
        getWorktreesByProject: (projectId) => (projectId === 'project-a' ? [wtA] : []),
        getKanbanTicketsByProject: (projectId) => {
          if (projectId === 'project-a') return [ticketA1, ticketA2]
          if (projectId === 'project-b') return [markdownTicket]
          return []
        },
        getDependenciesForProject: (projectId) => (projectId === 'project-a' ? [dependencyA] : [])
      },
      git: { getRemoteUrl },
      requestSaveFileDialog: vi.fn(async () => outPath)
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.exportBackup())

    expect(result).toMatchObject({ success: true, path: outPath, projectCount: 2 })

    const written = YAML.parse(readFileSync(outPath, 'utf-8')) as BackupFile
    expect(written.version).toBe(1)
    expect(written.kind).toBe('hive-backup')
    expect(typeof written.created_at).toBe('string')
    expect(written.app_version).toBe('1.2.3')

    const exportedA = written.projects.find((p) => p.name === 'internal-repo')!
    expect(exportedA.remote_url).toBe('git@github.com:org/internal-repo.git')
    expect(exportedA.kanban_storage_mode).toBe('internal')
    expect(exportedA.tickets).toHaveLength(2)
    expect(exportedA.tickets?.map((t) => t.key)).toEqual(['t1', 't2'])
    const first = exportedA.tickets?.find((t) => t.title === 'First')
    const second = exportedA.tickets?.find((t) => t.title === 'Second')
    expect(first?.worktree_branch).toBe('feature/a')
    expect(second?.archived_at).toBe('2026-01-01T00:00:00.000Z')
    expect(exportedA.ticket_dependencies).toEqual([{ dependent: 't2', blocker: 't1' }])
    for (const t of exportedA.tickets ?? []) {
      expect(t).not.toHaveProperty('attachments')
    }

    const exportedB = written.projects.find((p) => p.name === 'markdown-repo')!
    expect(exportedB.remote_url).toBeNull()
    expect(exportedB.kanban_storage_mode).toBe('markdown')
    expect(exportedB.tickets).toBeNull()
    expect(exportedB.ticket_dependencies).toBeNull()
  })

  it('returns canceled without writing when the save dialog is dismissed', async () => {
    const writeFileSpy = vi.fn(async () => undefined)
    const deps = makeDeps({
      db: {
        getAllProjects: () => [project()],
        getActiveWorktreesByProject: () => [],
        getWorktreesByProject: () => [],
        getKanbanTicketsByProject: () => [],
        getDependenciesForProject: () => []
      },
      fs: { ...makeFsDeps(), writeFile: writeFileSpy },
      requestSaveFileDialog: vi.fn(async () => null)
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.exportBackup())

    expect(result).toEqual({ success: false, canceled: true })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('drops a custom_icon that is missing on disk and continues exporting', async () => {
    const dir = makeTempDir()
    const outPath = join(dir, 'out.yaml')
    const proj = project({ custom_icon: join(dir, 'does-not-exist.png') })

    const deps = makeDeps({
      db: {
        getAllProjects: () => [proj],
        getActiveWorktreesByProject: () => [],
        getWorktreesByProject: () => [],
        getKanbanTicketsByProject: () => [],
        getDependenciesForProject: () => []
      },
      requestSaveFileDialog: vi.fn(async () => outPath)
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.exportBackup())

    expect(result.success).toBe(true)
    const written = YAML.parse(readFileSync(outPath, 'utf-8')) as BackupFile
    expect(written.projects[0].custom_icon).toBeNull()
  })

  it('embeds a custom_icon under the size limit as base64', async () => {
    const dir = makeTempDir()
    const outPath = join(dir, 'out.yaml')
    const iconPath = join(dir, 'icon.png')
    writeFileSync(iconPath, Buffer.from('fake-png-bytes'))
    const proj = project({ custom_icon: iconPath })

    const deps = makeDeps({
      db: {
        getAllProjects: () => [proj],
        getActiveWorktreesByProject: () => [],
        getWorktreesByProject: () => [],
        getKanbanTicketsByProject: () => [],
        getDependenciesForProject: () => []
      },
      requestSaveFileDialog: vi.fn(async () => outPath)
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.exportBackup())

    expect(result.success).toBe(true)
    const written = YAML.parse(readFileSync(outPath, 'utf-8')) as BackupFile
    expect(written.projects[0].custom_icon).toEqual({
      filename: 'icon.png',
      data_base64: Buffer.from('fake-png-bytes').toString('base64')
    })
  })

  it('drops a custom_icon larger than 1 MB and continues exporting', async () => {
    const dir = makeTempDir()
    const outPath = join(dir, 'out.yaml')
    const iconPath = join(dir, 'big-icon.png')
    writeFileSync(iconPath, Buffer.alloc(1024 * 1024 + 1))
    const proj = project({ custom_icon: iconPath })

    const deps = makeDeps({
      db: {
        getAllProjects: () => [proj],
        getActiveWorktreesByProject: () => [],
        getWorktreesByProject: () => [],
        getKanbanTicketsByProject: () => [],
        getDependenciesForProject: () => []
      },
      requestSaveFileDialog: vi.fn(async () => outPath)
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.exportBackup())

    expect(result.success).toBe(true)
    const written = YAML.parse(readFileSync(outPath, 'utf-8')) as BackupFile
    expect(written.projects[0].custom_icon).toBeNull()
  })

  it('returns a failure result when an unexpected error occurs', async () => {
    const deps = makeDeps({
      db: {
        getAllProjects: () => {
          throw new Error('db exploded')
        },
        getActiveWorktreesByProject: () => [],
        getWorktreesByProject: () => [],
        getKanbanTicketsByProject: () => [],
        getDependenciesForProject: () => []
      }
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.exportBackup())

    expect(result).toEqual({ success: false, error: 'db exploded' })
  })
})

describe('backupOps.openBackupFile', () => {
  const validBackup: BackupFile = {
    version: 1,
    kind: 'hive-backup',
    created_at: now,
    app_version: '1.2.3',
    projects: [
      {
        name: 'repo',
        path: '/repo',
        remote_url: null,
        description: null,
        tags: null,
        language: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        worktree_create_script: null,
        custom_commands: null,
        auto_assign_port: false,
        sort_order: 0,
        kanban_simple_mode: false,
        kanban_storage_mode: 'internal',
        kanban_markdown_config: null,
        custom_icon: null,
        worktrees: [],
        tickets: [],
        ticket_dependencies: []
      }
    ]
  }

  it('round-trips a valid backup file', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'valid.yaml')
    writeFileSync(filePath, YAML.stringify(validBackup), 'utf-8')

    const deps = makeDeps({ requestOpenFileDialog: vi.fn(async () => filePath) })
    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.openBackupFile())

    expect(result.canceled).toBe(false)
    expect(result.backup).toMatchObject({
      version: 1,
      kind: 'hive-backup',
      app_version: '1.2.3'
    })
  })

  it('reports a newer-version error for version > 1', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'newer.yaml')
    writeFileSync(filePath, YAML.stringify({ ...validBackup, version: 2 }), 'utf-8')

    const deps = makeDeps({ requestOpenFileDialog: vi.fn(async () => filePath) })
    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.openBackupFile())

    expect(result.canceled).toBe(false)
    expect(result.backup).toBeUndefined()
    expect(result.error).toMatch(/newer version of Hive/)
  })

  it('reports a readable error for malformed YAML without throwing', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'broken.yaml')
    writeFileSync(filePath, 'foo: [unclosed', 'utf-8')

    const deps = makeDeps({ requestOpenFileDialog: vi.fn(async () => filePath) })
    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.openBackupFile())

    expect(result.canceled).toBe(false)
    expect(result.backup).toBeUndefined()
    expect(typeof result.error).toBe('string')
  })

  it('reports an error when kind is not hive-backup', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'wrong-kind.yaml')
    writeFileSync(filePath, YAML.stringify({ ...validBackup, kind: 'something-else' }), 'utf-8')

    const deps = makeDeps({ requestOpenFileDialog: vi.fn(async () => filePath) })
    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.openBackupFile())

    expect(result.canceled).toBe(false)
    expect(result.backup).toBeUndefined()
    expect(typeof result.error).toBe('string')
  })

  it('returns canceled when the open dialog is dismissed', async () => {
    const deps = makeDeps({ requestOpenFileDialog: vi.fn(async () => null) })
    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.openBackupFile())

    expect(result).toEqual({ canceled: true })
  })

  it('handles requestOpenFileDialog rejection gracefully', async () => {
    const deps = makeDeps({
      requestOpenFileDialog: vi.fn(async () => {
        throw new Error('Desktop command failed: backupOpenFileDialog')
      })
    })
    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(service.openBackupFile())

    expect(result.canceled).toBe(false)
    expect(result.backup).toBeUndefined()
    expect(result.error).toContain('Desktop command failed')
  })
})

describe('backupOps handler param validation', () => {
  it('rejects backupOps.exportBackup params with unexpected keys', async () => {
    const exportBackup = vi.fn(() => Effect.succeed({ success: true }))
    const handlers = makeBackupOpsRpcHandlers({
      exportBackup,
      openBackupFile: vi.fn(() => Effect.succeed({ canceled: true }))
    })
    const handler = handlers.get('backupOps.exportBackup')!

    await expect(
      Effect.runPromise(handler({ unexpected: true }, { eventBus: {} as never }))
    ).rejects.toBeTruthy()
    expect(exportBackup).not.toHaveBeenCalled()
  })
})
