import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import YAML from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KanbanTicket, Project, TicketDependency, Worktree } from '../../../../main/db'
import type { BackupFile, BackupProject } from '../../../../shared/types/backup'
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
    stat: (path) => stat(path),
    exists: (path) =>
      access(path)
        .then(() => true)
        .catch(() => false),
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined)
  }
}

function makeDeps(overrides: Partial<BackupOpsDeps> = {}): BackupOpsDeps {
  return {
    db: {
      getAllProjects: () => [],
      getActiveWorktreesByProject: () => [],
      getWorktreesByProject: () => [],
      getKanbanTicketsByProject: () => [],
      getDependenciesForProject: () => [],
      getProjectByPath: () => null,
      createWorktree: vi.fn((data) => worktree({ ...data, id: `wt-${data.branch_name}` })),
      updateProject: vi.fn(() => null),
      updateProjectKanbanStorageMode: vi.fn(() => null),
      updateProjectKanbanMarkdownConfig: vi.fn(() => null),
      updateProjectSimpleMode: vi.fn(),
      createKanbanTicket: vi.fn((data) =>
        ticket({ ...data, id: `ticket-${data.title}`, mark: null })
      ),
      updateKanbanTicket: vi.fn(() => null),
      addTicketTokens: vi.fn(),
      addTicketDependency: vi.fn(() => ({ success: true })),
      transaction: vi.fn((fn) => fn())
    },
    git: {
      getRemoteUrl: vi.fn(async () => null),
      hasUncommittedChanges: vi.fn(async () => false),
      getDefaultBranch: vi.fn(async () => 'main')
    },
    fs: makeFsDeps(),
    getAppVersion: vi.fn(async () => '1.2.3'),
    requestSaveFileDialog: vi.fn(async () => null),
    requestOpenFileDialog: vi.fn(async () => null),
    execGit: vi.fn(async () => ''),
    homedir: vi.fn(() => '/home/tester'),
    cloneRepository: vi.fn(async () => ({ success: true })),
    isGitRepository: vi.fn(() => true),
    createProjectWithDefaultWorktree: vi.fn((data) =>
      project({ id: `project-${data.name}`, name: data.name, path: data.path })
    ),
    uploadIcon: vi.fn(() => ({ success: true })),
    syncWorktreesOp: vi.fn(async () => ({ success: true })),
    ...overrides
  }
}

function backupProject(overrides: Partial<BackupProject> = {}): BackupProject {
  return {
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
    tickets: null,
    ticket_dependencies: null,
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
        ...makeDeps().db,
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
      git: { ...makeDeps().git, getRemoteUrl },
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
        ...makeDeps().db,
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
        ...makeDeps().db,
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
        ...makeDeps().db,
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
        ...makeDeps().db,
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
        ...makeDeps().db,
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

/** fs deps that never touch the real filesystem — every existence check is
 * driven by an explicit allow-list, and mkdir/readFile/writeFile/stat are
 * no-op mocks. */
function mockFs(existingPaths: string[] = []): BackupOpsDeps['fs'] {
  const set = new Set(existingPaths)
  return {
    readFile: vi.fn(async () => Buffer.from('')),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: 0 })),
    exists: vi.fn(async (path: string) => set.has(path)),
    mkdir: vi.fn(async () => undefined)
  }
}

interface ExecGitScript {
  revParseHeads?: Record<string, boolean>
  revParseRemotes?: Record<string, boolean>
  fetchFails?: boolean
  worktreeAddFailFor?: Set<string>
  branchCreateFailFor?: Set<string>
  pullFailsWith?: string
}

/** Dispatches the raw `execGit(cwd, args)` calls restoreProject issues for
 * worktree/branch plumbing, driven by a small script object per test. */
function execGitScript(script: ExecGitScript = {}): BackupOpsDeps['execGit'] {
  return vi.fn(async (_cwd: string, args: string[]) => {
    const [cmd] = args
    if (cmd === 'pull') {
      if (script.pullFailsWith) throw new Error(script.pullFailsWith)
      return ''
    }
    if (cmd === 'fetch') {
      if (script.fetchFails) throw new Error('fetch failed')
      return ''
    }
    if (cmd === 'rev-parse') {
      const ref = args[2] ?? ''
      if (ref.startsWith('refs/heads/')) {
        const branch = ref.slice('refs/heads/'.length)
        if (script.revParseHeads?.[branch]) return 'deadbeef'
        throw new Error(`unknown revision: ${branch}`)
      }
      if (ref.startsWith('refs/remotes/origin/')) {
        const branch = ref.slice('refs/remotes/origin/'.length)
        if (script.revParseRemotes?.[branch]) return 'deadbeef'
        throw new Error(`unknown revision: ${branch}`)
      }
      throw new Error(`unexpected rev-parse ref: ${ref}`)
    }
    if (cmd === 'branch') {
      const branch = args[1]
      if (script.branchCreateFailFor?.has(branch)) throw new Error('branch create failed')
      return ''
    }
    if (cmd === 'worktree') {
      const branch = args[3]
      if (script.worktreeAddFailFor?.has(branch)) throw new Error('already checked out')
      return ''
    }
    return ''
  })
}

describe('backupOps.classifyProjects', () => {
  it('classifies ssh-form backup remote vs https-form local remote as exists-match', async () => {
    const deps = makeDeps({
      fs: mockFs(['/backup/repo']),
      isGitRepository: vi.fn(() => true),
      git: {
        ...makeDeps().git,
        getRemoteUrl: vi.fn(async (repoPath: string) =>
          repoPath === '/backup/repo' ? 'https://github.com/org/repo.git' : null
        )
      },
      db: { ...makeDeps().db, getProjectByPath: () => null }
    })

    const service = makeBackupOpsRpcService(deps)
    const [result] = await Effect.runPromise(
      service.classifyProjects({
        projects: [
          { name: 'repo', path: '/backup/repo', remoteUrl: 'git@github.com:org/repo.git' }
        ]
      })
    )

    expect(result).toMatchObject({
      path: '/backup/repo',
      classification: 'exists-match',
      alreadyInHive: false,
      hiveProjectId: null,
      effectivePath: '/backup/repo',
      localRemoteUrl: 'https://github.com/org/repo.git'
    })
  })

  it('classifies path exists + different remote as conflict', async () => {
    const deps = makeDeps({
      fs: mockFs(['/backup/repo']),
      isGitRepository: vi.fn(() => true),
      git: {
        ...makeDeps().git,
        getRemoteUrl: vi.fn(async () => 'git@github.com:org/other.git')
      }
    })

    const service = makeBackupOpsRpcService(deps)
    const [result] = await Effect.runPromise(
      service.classifyProjects({
        projects: [
          { name: 'repo', path: '/backup/repo', remoteUrl: 'git@github.com:org/repo.git' }
        ]
      })
    )

    expect(result.classification).toBe('conflict')
    expect(result.alreadyInHive).toBe(false)
    expect(result.hiveProjectId).toBeNull()
  })

  it('classifies path exists + non-git dir as conflict', async () => {
    const deps = makeDeps({
      fs: mockFs(['/backup/repo']),
      isGitRepository: vi.fn(() => false)
    })

    const service = makeBackupOpsRpcService(deps)
    const [result] = await Effect.runPromise(
      service.classifyProjects({
        projects: [{ name: 'repo', path: '/backup/repo', remoteUrl: null }]
      })
    )

    expect(result).toMatchObject({
      classification: 'conflict',
      alreadyInHive: false,
      hiveProjectId: null,
      localRemoteUrl: null
    })
  })

  it('classifies missing path + remote as missing-clone', async () => {
    const deps = makeDeps({ fs: mockFs([]) })

    const service = makeBackupOpsRpcService(deps)
    const [result] = await Effect.runPromise(
      service.classifyProjects({
        projects: [
          { name: 'repo', path: '/backup/repo', remoteUrl: 'git@github.com:org/repo.git' }
        ]
      })
    )

    expect(result.classification).toBe('missing-clone')
  })

  it('classifies missing path + null remote as skipped-no-remote', async () => {
    const deps = makeDeps({ fs: mockFs([]) })

    const service = makeBackupOpsRpcService(deps)
    const [result] = await Effect.runPromise(
      service.classifyProjects({
        projects: [{ name: 'repo', path: '/backup/repo', remoteUrl: null }]
      })
    )

    expect(result.classification).toBe('skipped-no-remote')
  })

  it('marks a path-matched project already-in-Hive', async () => {
    const hiveProject = project({ id: 'hive-1', path: '/backup/repo' })
    const deps = makeDeps({
      fs: mockFs(['/backup/repo']),
      isGitRepository: vi.fn(() => true),
      git: { ...makeDeps().git, getRemoteUrl: vi.fn(async () => null) },
      db: { ...makeDeps().db, getProjectByPath: (path) => (path === '/backup/repo' ? hiveProject : null) }
    })

    const service = makeBackupOpsRpcService(deps)
    const [result] = await Effect.runPromise(
      service.classifyProjects({
        projects: [{ name: 'repo', path: '/backup/repo', remoteUrl: null }]
      })
    )

    expect(result).toMatchObject({
      classification: 'exists-match',
      alreadyInHive: true,
      hiveProjectId: 'hive-1',
      effectivePath: '/backup/repo'
    })
  })

  it('matches by remote across Hive with a different local path than the backup', async () => {
    const hiveProject = project({ id: 'hive-1', path: '/hive/other-repo' })
    const deps = makeDeps({
      fs: mockFs([]), // backup path itself does not exist on disk
      db: { ...makeDeps().db, getAllProjects: () => [hiveProject] },
      git: {
        ...makeDeps().git,
        getRemoteUrl: vi.fn(async (repoPath: string) =>
          repoPath === '/hive/other-repo' ? 'git@github.com:org/repo.git' : null
        )
      }
    })

    const service = makeBackupOpsRpcService(deps)
    const [result] = await Effect.runPromise(
      service.classifyProjects({
        projects: [
          { name: 'repo', path: '/backup/repo', remoteUrl: 'https://github.com/org/repo.git' }
        ]
      })
    )

    expect(result).toMatchObject({
      path: '/backup/repo',
      classification: 'exists-match',
      alreadyInHive: true,
      hiveProjectId: 'hive-1',
      effectivePath: '/hive/other-repo'
    })
  })

  it('classifies both-null remotes at the same path as exists-match', async () => {
    const deps = makeDeps({
      fs: mockFs(['/backup/repo']),
      isGitRepository: vi.fn(() => true),
      git: { ...makeDeps().git, getRemoteUrl: vi.fn(async () => null) }
    })

    const service = makeBackupOpsRpcService(deps)
    const [result] = await Effect.runPromise(
      service.classifyProjects({
        projects: [{ name: 'repo', path: '/backup/repo', remoteUrl: null }]
      })
    )

    expect(result.classification).toBe('exists-match')
  })

  it('computes each Hive project remote once per batch, not per input entry', async () => {
    const hiveA = project({ id: 'hive-a', path: '/hive/a' })
    const hiveB = project({ id: 'hive-b', path: '/hive/b' })
    const getRemoteUrl = vi.fn(async (repoPath: string) => {
      if (repoPath === '/hive/a') return 'git@github.com:org/a.git'
      if (repoPath === '/hive/b') return 'git@github.com:org/b.git'
      return null
    })
    const deps = makeDeps({
      fs: mockFs([]),
      db: { ...makeDeps().db, getAllProjects: () => [hiveA, hiveB] },
      git: { ...makeDeps().git, getRemoteUrl }
    })

    const service = makeBackupOpsRpcService(deps)
    await Effect.runPromise(
      service.classifyProjects({
        projects: [
          { name: 'a', path: '/backup/a', remoteUrl: 'git@github.com:org/a.git' },
          { name: 'b', path: '/backup/b', remoteUrl: 'git@github.com:org/b.git' },
          { name: 'c', path: '/backup/c', remoteUrl: 'git@github.com:org/c.git' }
        ]
      })
    )

    // Exactly one lookup per Hive project (2), regardless of the 3 input entries.
    expect(getRemoteUrl).toHaveBeenCalledTimes(2)
  })
})

describe('backupOps.restoreProject', () => {
  it('clones a missing project and creates it in Hive', async () => {
    const deps = makeDeps({
      fs: mockFs([]),
      cloneRepository: vi.fn(async () => ({ success: true })),
      execGit: execGitScript()
    })
    const bp = backupProject({
      name: 'repo',
      path: '/original/repo',
      remote_url: 'git@github.com:org/repo.git'
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: '/clones' } })
    )

    expect(result.action).toBe('cloned')
    expect(result.success).toBe(true)
    expect(deps.cloneRepository).toHaveBeenCalledWith(
      'git@github.com:org/repo.git',
      '/clones/repo'
    )
    expect(deps.createProjectWithDefaultWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'repo', path: '/clones/repo' })
    )
    expect(deps.syncWorktreesOp).toHaveBeenCalledWith({
      projectId: 'project-repo',
      projectPath: '/clones/repo'
    })
  })

  it('suffixes the clone destination on collision', async () => {
    const deps = makeDeps({
      fs: mockFs(['/clones/repo']),
      cloneRepository: vi.fn(async () => ({ success: true })),
      execGit: execGitScript()
    })
    const bp = backupProject({
      name: 'repo',
      path: '/original/repo',
      remote_url: 'git@github.com:org/repo.git'
    })

    const service = makeBackupOpsRpcService(deps)
    await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: '/clones' } })
    )

    expect(deps.cloneRepository).toHaveBeenCalledWith(
      'git@github.com:org/repo.git',
      '/clones/repo-2'
    )
  })

  it('fails with no clone folder selected when missing-clone and cloneParentDir is null', async () => {
    const deps = makeDeps({ fs: mockFs([]) })
    const bp = backupProject({ remote_url: 'git@github.com:org/repo.git' })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result).toMatchObject({
      success: false,
      action: 'failed',
      error: 'no clone folder selected'
    })
    expect(deps.cloneRepository).not.toHaveBeenCalled()
  })

  it('skips the pull and warns when the working tree is dirty', async () => {
    const deps = makeDeps({
      fs: mockFs(['/repo']),
      isGitRepository: vi.fn(() => true),
      git: {
        ...makeDeps().git,
        getRemoteUrl: vi.fn(async () => null),
        hasUncommittedChanges: vi.fn(async () => true)
      },
      execGit: execGitScript()
    })
    const bp = backupProject({ path: '/repo' })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result.action).toBe('attached')
    expect(result.warnings).toContain('uncommitted changes — pull skipped')
    const execGitCalls = (deps.execGit as ReturnType<typeof vi.fn>).mock.calls
    expect(execGitCalls.some((call) => call[1][0] === 'pull')).toBe(false)
  })

  it('pulls fast-forward-only via execGit on a clean tree and reports pulled', async () => {
    const deps = makeDeps({
      fs: mockFs(['/repo']),
      isGitRepository: vi.fn(() => true),
      git: {
        ...makeDeps().git,
        getRemoteUrl: vi.fn(async () => null),
        hasUncommittedChanges: vi.fn(async () => false)
      },
      execGit: execGitScript()
    })
    const bp = backupProject({ path: '/repo' })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result.action).toBe('pulled')
    expect(result.warnings).toEqual([])
    expect(deps.execGit).toHaveBeenCalledWith('/repo', ['pull', '--ff-only'])
  })

  it('warns and reports attached (not pulled) when the ff-only pull fails, and still processes worktrees/tickets', async () => {
    const deps = makeDeps({
      fs: mockFs(['/repo']),
      isGitRepository: vi.fn(() => true),
      git: {
        ...makeDeps().git,
        getRemoteUrl: vi.fn(async () => null),
        hasUncommittedChanges: vi.fn(async () => false)
      },
      execGit: execGitScript({
        pullFailsWith: 'fatal: Not possible to fast-forward, aborting.',
        revParseHeads: { 'feature/a': true }
      })
    })
    const bp = backupProject({
      path: '/repo',
      worktrees: [{ name: 'feature-a', branch_name: 'feature/a', base_branch: 'main' }],
      tickets: [
        {
          key: 't1',
          title: 'Ticket',
          description: null,
          column: 'todo',
          sort_order: 0,
          mode: null,
          mark: null,
          total_tokens: 0,
          archived_at: null,
          worktree_branch: null
        }
      ]
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result.action).toBe('attached')
    expect(
      result.warnings.some((w) => w.includes('fatal: Not possible to fast-forward'))
    ).toBe(true)
    expect(result.worktrees).toEqual([{ branch: 'feature/a', status: 'created' }])
    expect(result.tickets).toEqual({ restored: 1, dependencyErrors: 0, skipped: false })
    expect(result.success).toBe(true)
  })

  it('skips worktree creation when an active worktree already has the branch', async () => {
    const deps = makeDeps({
      fs: mockFs(['/repo']),
      isGitRepository: vi.fn(() => true),
      git: { ...makeDeps().git, getRemoteUrl: vi.fn(async () => null) },
      db: {
        ...makeDeps().db,
        getActiveWorktreesByProject: () => [worktree({ branch_name: 'feature/a' })]
      },
      execGit: execGitScript()
    })
    const bp = backupProject({
      path: '/repo',
      worktrees: [{ name: 'feature-a', branch_name: 'feature/a', base_branch: 'main' }]
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result.worktrees).toEqual([{ branch: 'feature/a', status: 'skipped-existing' }])
    const execGitCalls = (deps.execGit as ReturnType<typeof vi.fn>).mock.calls
    expect(execGitCalls.some((call) => call[1][0] === 'worktree')).toBe(false)
  })

  it('falls back to a fresh branch from default when local and remote branches are missing', async () => {
    const deps = makeDeps({
      fs: mockFs(['/repo']),
      isGitRepository: vi.fn(() => true),
      git: {
        ...makeDeps().git,
        getRemoteUrl: vi.fn(async () => 'git@github.com:org/repo.git'),
        getDefaultBranch: vi.fn(async () => 'main')
      },
      db: { ...makeDeps().db, getActiveWorktreesByProject: () => [] },
      execGit: execGitScript({ revParseHeads: {}, revParseRemotes: {} })
    })
    const bp = backupProject({
      path: '/repo',
      remote_url: 'git@github.com:org/repo.git',
      worktrees: [{ name: 'feature-a', branch_name: 'feature/missing', base_branch: 'main' }]
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result.worktrees).toEqual([
      { branch: 'feature/missing', status: 'created-fresh-branch' }
    ])
    expect(
      result.warnings.some((w) => w.includes('feature/missing') && w.includes('main'))
    ).toBe(true)
  })

  it('marks a failed worktree add as failed and still attempts later worktrees', async () => {
    const deps = makeDeps({
      fs: mockFs(['/repo']),
      isGitRepository: vi.fn(() => true),
      git: { ...makeDeps().git, getRemoteUrl: vi.fn(async () => null) },
      db: { ...makeDeps().db, getActiveWorktreesByProject: () => [] },
      execGit: execGitScript({
        revParseHeads: { 'feature/a': true, 'feature/b': true },
        worktreeAddFailFor: new Set(['feature/a'])
      })
    })
    const bp = backupProject({
      path: '/repo',
      worktrees: [
        { name: 'feature-a', branch_name: 'feature/a', base_branch: 'main' },
        { name: 'feature-b', branch_name: 'feature/b', base_branch: 'main' }
      ]
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result.success).toBe(true)
    expect(result.worktrees).toEqual([
      { branch: 'feature/a', status: 'failed', error: 'already checked out' },
      { branch: 'feature/b', status: 'created' }
    ])
  })

  it('skips tickets and leaves the project row untouched when already in Hive', async () => {
    const existing = project({ id: 'existing-1', path: '/repo' })
    const deps = makeDeps({
      fs: mockFs(['/repo']),
      isGitRepository: vi.fn(() => true),
      git: { ...makeDeps().git, getRemoteUrl: vi.fn(async () => null) },
      db: { ...makeDeps().db, getProjectByPath: () => existing },
      execGit: execGitScript()
    })
    const bp = backupProject({
      path: '/repo',
      tickets: [
        {
          key: 't1',
          title: 'Ticket',
          description: null,
          column: 'todo',
          sort_order: 0,
          mode: null,
          mark: null,
          total_tokens: 0,
          archived_at: null,
          worktree_branch: null
        }
      ]
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result.tickets).toEqual({ restored: 0, dependencyErrors: 0, skipped: true })
    expect(result.projectId).toBe('existing-1')
    expect(deps.db.updateProject).not.toHaveBeenCalled()
  })

  it('restores tickets, remaps keys, resolves worktree_id by branch, and reports a dependency error for an unknown key', async () => {
    const createdWorktree = worktree({ id: 'wt-feature-a', branch_name: 'feature/a' })
    const deps = makeDeps({
      fs: mockFs(['/repo']),
      isGitRepository: vi.fn(() => true),
      git: { ...makeDeps().git, getRemoteUrl: vi.fn(async () => null) },
      db: {
        ...makeDeps().db,
        getActiveWorktreesByProject: () => [createdWorktree],
        createKanbanTicket: vi.fn((data) => ticket({ ...data, id: `created-${data.title}` })),
        addTicketDependency: vi.fn((dependentId: string, blockerId: string) => {
          if (dependentId === 'created-Second' && blockerId === 'created-First') {
            return { success: true }
          }
          return { success: false, error: 'unexpected dependency' }
        })
      },
      execGit: execGitScript()
    })
    const bp = backupProject({
      path: '/repo',
      worktrees: [{ name: 'feature-a', branch_name: 'feature/a', base_branch: 'main' }],
      tickets: [
        {
          key: 't1',
          title: 'First',
          description: null,
          column: 'todo',
          sort_order: 0,
          mode: null,
          mark: null,
          total_tokens: 0,
          archived_at: null,
          worktree_branch: 'feature/a'
        },
        {
          key: 't2',
          title: 'Second',
          description: null,
          column: 'done',
          sort_order: 1,
          mode: null,
          mark: null,
          total_tokens: 500,
          archived_at: '2026-01-01T00:00:00.000Z',
          worktree_branch: null
        }
      ],
      ticket_dependencies: [
        { dependent: 't2', blocker: 't1' },
        { dependent: 't2', blocker: 'unknown-key' }
      ]
    })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(deps.db.createKanbanTicket).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'First', worktree_id: 'wt-feature-a' })
    )
    expect(deps.db.createKanbanTicket).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Second', worktree_id: null })
    )
    expect(deps.db.updateKanbanTicket).toHaveBeenCalledWith('created-Second', {
      archived_at: '2026-01-01T00:00:00.000Z'
    })
    expect(deps.db.addTicketTokens).toHaveBeenCalledWith('created-Second', 500)
    expect(deps.db.addTicketDependency).toHaveBeenCalledWith('created-Second', 'created-First')
    expect(result.tickets).toEqual({ restored: 2, dependencyErrors: 1, skipped: false })
  })

  it('returns skipped-conflict and touches nothing when the path holds a different repo', async () => {
    const deps = makeDeps({
      fs: mockFs(['/repo']),
      isGitRepository: vi.fn(() => false)
    })
    const bp = backupProject({ path: '/repo', remote_url: 'git@github.com:org/repo.git' })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result).toMatchObject({
      success: false,
      action: 'skipped-conflict',
      warnings: ['path exists but contains a different repository'],
      worktrees: [],
      tickets: null
    })
    expect(deps.cloneRepository).not.toHaveBeenCalled()
    expect(deps.createProjectWithDefaultWorktree).not.toHaveBeenCalled()
    expect(deps.syncWorktreesOp).not.toHaveBeenCalled()
    expect(deps.execGit).not.toHaveBeenCalled()
  })

  it('returns skipped-no-remote when the path is missing and there is no remote', async () => {
    const deps = makeDeps({ fs: mockFs([]) })
    const bp = backupProject({ path: '/repo', remote_url: null })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result).toMatchObject({
      success: false,
      action: 'skipped-no-remote',
      worktrees: [],
      tickets: null
    })
  })

  it('never throws out of the service when a dep throws unexpectedly', async () => {
    const deps = makeDeps({
      fs: mockFs(['/repo']),
      isGitRepository: vi.fn(() => true),
      git: {
        ...makeDeps().git,
        getRemoteUrl: vi.fn(async () => null),
        hasUncommittedChanges: vi.fn(async () => {
          throw new Error('boom')
        })
      }
    })
    const bp = backupProject({ path: '/repo' })

    const service = makeBackupOpsRpcService(deps)
    const result = await Effect.runPromise(
      service.restoreProject({ project: bp, options: { cloneParentDir: null } })
    )

    expect(result.success).toBe(false)
    expect(result.action).toBe('failed')
    expect(result.error).toContain('boom')
  })
})

describe('backupOps handler param validation', () => {
  it('rejects backupOps.exportBackup params with unexpected keys', async () => {
    const exportBackup = vi.fn(() => Effect.succeed({ success: true }))
    const handlers = makeBackupOpsRpcHandlers({
      exportBackup,
      openBackupFile: vi.fn(() => Effect.succeed({ canceled: true })),
      classifyProjects: vi.fn(() => Effect.succeed([])),
      restoreProject: vi.fn(() =>
        Effect.succeed({
          success: true,
          projectName: 'repo',
          action: 'pulled' as const,
          warnings: [],
          worktrees: [],
          tickets: null
        })
      )
    })
    const handler = handlers.get('backupOps.exportBackup')!

    await expect(
      Effect.runPromise(handler({ unexpected: true }, { eventBus: {} as never }))
    ).rejects.toBeTruthy()
    expect(exportBackup).not.toHaveBeenCalled()
  })
})
