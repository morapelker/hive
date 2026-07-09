import { basename } from 'node:path'

import { Effect } from 'effect'
import YAML from 'yaml'
import { z } from 'zod'
import { isDesktopCommandResult, makeDesktopCommandRequest } from '../../../shared/desktop-command'
import type { BackupFile } from '../../../shared/types/backup'
import type { KanbanTicket, Project, TicketDependency, Worktree } from '../../../main/db'
import type { RpcHandler } from '../router'

// Raw SQLite row fields spread onto `Project` by `mapProjectRow` but not
// declared on the `Project` interface (see database.ts:319 and the
// `kanban_simple_mode` column added in the projects table).
interface ProjectRawExtras {
  readonly kanban_simple_mode?: number | boolean
}

const MAX_CUSTOM_ICON_BYTES = 1024 * 1024

export interface BackupExportResult {
  readonly success: boolean
  readonly canceled?: boolean
  readonly path?: string
  readonly projectCount?: number
  readonly error?: string
}

export interface BackupOpenResult {
  readonly canceled: boolean
  readonly backup?: BackupFile
  readonly error?: string
}

interface BackupOpsDb {
  readonly getAllProjects: () => Project[]
  readonly getActiveWorktreesByProject: (projectId: string) => Worktree[]
  readonly getWorktreesByProject: (projectId: string) => Worktree[]
  readonly getKanbanTicketsByProject: (
    projectId: string,
    includeArchived: boolean
  ) => KanbanTicket[]
  readonly getDependenciesForProject: (projectId: string) => TicketDependency[]
}

interface BackupOpsGit {
  // Resolves to the raw remote URL, or null when there is no remote / the
  // lookup fails. Never expected to reject.
  readonly getRemoteUrl: (repoPath: string) => Promise<string | null>
}

interface BackupOpsFs {
  readonly readFile: (path: string) => Promise<Buffer>
  readonly writeFile: (path: string, content: string) => Promise<void>
  readonly stat: (path: string) => Promise<{ readonly size: number }>
}

export interface BackupOpsDeps {
  readonly db: BackupOpsDb
  readonly git: BackupOpsGit
  readonly fs: BackupOpsFs
  readonly getAppVersion: () => Promise<string>
  readonly requestSaveFileDialog: (defaultFileName: string) => Promise<string | null>
  readonly requestOpenFileDialog: () => Promise<string | null>
}

export interface BackupOpsRpcService {
  readonly exportBackup: () => Effect.Effect<BackupExportResult, unknown, never>
  readonly openBackupFile: () => Effect.Effect<BackupOpenResult, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// ---------------------------------------------------------------------------
// backupFileSchema — mirrors src/shared/types/backup.ts. Nested objects use
// .passthrough() so forward-compatible extra keys from a newer Hive version
// don't hard-fail import; the top level still requires `kind: 'hive-backup'`.
// ---------------------------------------------------------------------------

const backupProjectIconSchema = z
  .object({
    filename: z.string(),
    data_base64: z.string()
  })
  .passthrough()

const backupWorktreeSchema = z
  .object({
    name: z.string(),
    branch_name: z.string(),
    base_branch: z.string().nullable()
  })
  .passthrough()

const backupTicketSchema = z
  .object({
    key: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    column: z.enum(['todo', 'in_progress', 'review', 'done']),
    sort_order: z.number(),
    mode: z.enum(['build', 'plan', 'super-plan']).nullable(),
    mark: z.string().nullable(),
    total_tokens: z.number(),
    archived_at: z.string().nullable(),
    worktree_branch: z.string().nullable()
  })
  .passthrough()

const backupTicketDependencySchema = z
  .object({
    dependent: z.string(),
    blocker: z.string()
  })
  .passthrough()

const backupProjectSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    remote_url: z.string().nullable(),
    description: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    language: z.string().nullable(),
    setup_script: z.string().nullable(),
    run_script: z.string().nullable(),
    archive_script: z.string().nullable(),
    worktree_create_script: z.string().nullable(),
    custom_commands: z.array(z.unknown()).nullable(),
    auto_assign_port: z.boolean(),
    sort_order: z.number(),
    kanban_simple_mode: z.boolean(),
    kanban_storage_mode: z.enum(['internal', 'markdown']),
    kanban_markdown_config: z.unknown().nullable(),
    custom_icon: backupProjectIconSchema.nullable(),
    worktrees: z.array(backupWorktreeSchema),
    tickets: z.array(backupTicketSchema).nullable(),
    ticket_dependencies: z.array(backupTicketDependencySchema).nullable()
  })
  .passthrough()

const backupFileSchema = z.object({
  version: z.number(),
  kind: z.literal('hive-backup'),
  created_at: z.string(),
  app_version: z.string(),
  projects: z.array(backupProjectSchema)
})

// ---------------------------------------------------------------------------
// exportBackup
// ---------------------------------------------------------------------------

function defaultBackupFileName(now: Date = new Date()): string {
  return `hive-backup-${now.toISOString().slice(0, 10)}.yaml`
}

async function getRemoteUrlSafe(deps: BackupOpsDeps, repoPath: string): Promise<string | null> {
  try {
    return await deps.git.getRemoteUrl(repoPath)
  } catch {
    return null
  }
}

function parseProjectTags(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseKanbanMarkdownConfig(raw: string | null | undefined): unknown | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isProjectSimpleMode(project: Project): boolean {
  return Boolean((project as unknown as ProjectRawExtras).kanban_simple_mode)
}

function resolveStorageMode(project: Project): 'internal' | 'markdown' {
  return project.kanban_storage_mode === 'markdown' ? 'markdown' : 'internal'
}

async function readCustomIcon(
  deps: BackupOpsDeps,
  iconPath: string | null
): Promise<BackupFile['projects'][number]['custom_icon']> {
  if (!iconPath) return null
  try {
    const stats = await deps.fs.stat(iconPath)
    if (stats.size > MAX_CUSTOM_ICON_BYTES) return null
    const data = await deps.fs.readFile(iconPath)
    return { filename: basename(iconPath), data_base64: data.toString('base64') }
  } catch {
    return null
  }
}

function buildTicketsAndDependencies(
  deps: BackupOpsDeps,
  project: Project
): {
  tickets: BackupFile['projects'][number]['tickets']
  ticketDependencies: BackupFile['projects'][number]['ticket_dependencies']
} {
  const worktreeBranchById = new Map(
    deps.db.getWorktreesByProject(project.id).map((worktree) => [worktree.id, worktree.branch_name])
  )
  const kanbanTickets = deps.db.getKanbanTicketsByProject(project.id, true)
  const keyByTicketId = new Map<string, string>()

  const tickets = kanbanTickets.map((ticket, index) => {
    const key = `t${index + 1}`
    keyByTicketId.set(ticket.id, key)
    return {
      key,
      title: ticket.title,
      description: ticket.description,
      column: ticket.column,
      sort_order: ticket.sort_order,
      mode: ticket.mode,
      mark: ticket.mark,
      total_tokens: ticket.total_tokens,
      archived_at: ticket.archived_at,
      worktree_branch: ticket.worktree_id
        ? (worktreeBranchById.get(ticket.worktree_id) ?? null)
        : null
    }
  })

  const ticketDependencies = deps.db
    .getDependenciesForProject(project.id)
    .map((dependency) => ({
      dependent: keyByTicketId.get(dependency.dependent_id),
      blocker: keyByTicketId.get(dependency.blocker_id)
    }))
    .filter(
      (edge): edge is { dependent: string; blocker: string } =>
        edge.dependent !== undefined && edge.blocker !== undefined
    )

  return { tickets, ticketDependencies }
}

async function buildBackupProject(
  deps: BackupOpsDeps,
  project: Project
): Promise<BackupFile['projects'][number]> {
  const storageMode = resolveStorageMode(project)
  const isMarkdownMode = storageMode === 'markdown'

  const { tickets, ticketDependencies } = isMarkdownMode
    ? { tickets: null, ticketDependencies: null }
    : buildTicketsAndDependencies(deps, project)

  return {
    name: project.name,
    path: project.path,
    remote_url: await getRemoteUrlSafe(deps, project.path),
    description: project.description,
    tags: parseProjectTags(project.tags),
    language: project.language,
    setup_script: project.setup_script,
    run_script: project.run_script,
    archive_script: project.archive_script,
    worktree_create_script: project.worktree_create_script,
    custom_commands: project.custom_commands,
    auto_assign_port: project.auto_assign_port,
    sort_order: project.sort_order,
    kanban_simple_mode: isProjectSimpleMode(project),
    kanban_storage_mode: storageMode,
    kanban_markdown_config: parseKanbanMarkdownConfig(project.kanban_markdown_config),
    custom_icon: await readCustomIcon(deps, project.custom_icon),
    worktrees: deps.db
      .getActiveWorktreesByProject(project.id)
      .filter((worktree) => !worktree.is_default)
      .map((worktree) => ({
        name: worktree.name,
        branch_name: worktree.branch_name,
        base_branch: worktree.base_branch
      })),
    tickets,
    ticket_dependencies: ticketDependencies
  }
}

async function exportBackup(deps: BackupOpsDeps): Promise<BackupExportResult> {
  try {
    const projects = deps.db.getAllProjects()
    const backupProjects: BackupFile['projects'] = []
    for (const project of projects) {
      backupProjects.push(await buildBackupProject(deps, project))
    }

    const backupFile: BackupFile = {
      version: 1,
      kind: 'hive-backup',
      created_at: new Date().toISOString(),
      app_version: await deps.getAppVersion(),
      projects: backupProjects
    }

    const filePath = await deps.requestSaveFileDialog(defaultBackupFileName())
    if (filePath === null) {
      return { success: false, canceled: true }
    }

    await deps.fs.writeFile(filePath, YAML.stringify(backupFile))

    return { success: true, path: filePath, projectCount: backupProjects.length }
  } catch (error) {
    return { success: false, error: errorMessage(error) }
  }
}

// ---------------------------------------------------------------------------
// openBackupFile
// ---------------------------------------------------------------------------

async function openBackupFile(deps: BackupOpsDeps): Promise<BackupOpenResult> {
  try {
    const filePath = await deps.requestOpenFileDialog()
    if (filePath === null) {
      return { canceled: true }
    }

    let raw: string
    try {
      raw = (await deps.fs.readFile(filePath)).toString('utf-8')
    } catch (error) {
      return { canceled: false, error: errorMessage(error) }
    }

    let parsed: unknown
    try {
      parsed = YAML.parse(raw)
    } catch (error) {
      return { canceled: false, error: `Failed to parse backup file: ${errorMessage(error)}` }
    }

    if (isRecord(parsed) && typeof parsed.version === 'number' && parsed.version > 1) {
      return { canceled: false, error: 'This backup was created by a newer version of Hive.' }
    }

    const result = backupFileSchema.safeParse(parsed)
    if (!result.success) {
      return { canceled: false, error: z.prettifyError(result.error) }
    }

    return { canceled: false, backup: result.data }
  } catch (error) {
    return { canceled: false, error: errorMessage(error) }
  }
}

// ---------------------------------------------------------------------------
// Dialog request helpers — structurally copied from
// requestKanbanSaveBoardExportDialog / requestKanbanOpenBoardImportFileDialog
// in kanban.ts (~lines 870-976), injected through BackupOpsDeps for testing.
// ---------------------------------------------------------------------------

const isBackupDialogResult = (value: unknown): value is { readonly filePath: string | null } => {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return result.filePath === null || typeof result.filePath === 'string'
}

function requestBackupSaveFileDialog(defaultFileName: string): Promise<string | null> {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve(null)
  }

  const id = `backup-save-file-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'backupSaveFileDialog'

  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      process.off('message', onMessage)
    }
    const finish = (value?: string | null, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? null)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(null, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (!isBackupDialogResult(message.value)) {
        finish(null, new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      finish(message.value.filePath)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { defaultFileName }), (error) => {
      if (!error) return
      finish(null, error)
    })
  })
}

function requestBackupOpenFileDialog(): Promise<string | null> {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve(null)
  }

  const id = `backup-open-file-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'backupOpenFileDialog'

  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      process.off('message', onMessage)
    }
    const finish = (value?: string | null, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? null)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(null, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (!isBackupDialogResult(message.value)) {
        finish(null, new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      finish(message.value.filePath)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      finish(null, error)
    })
  })
}

// ---------------------------------------------------------------------------
// Live deps + service/handler wiring
// ---------------------------------------------------------------------------

async function readLiveAppVersion(): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile('package.json', 'utf-8')
    const parsed = JSON.parse(raw) as { readonly version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}

async function createLiveDeps(): Promise<BackupOpsDeps> {
  const [{ getDatabase }, { gitService }, fsModule] = await Promise.all([
    import('../../../main/db'),
    import('../../../main/effect/git/facade'),
    import('node:fs/promises')
  ])
  const db = getDatabase()

  return {
    db: {
      getAllProjects: () => db.getAllProjects(),
      getActiveWorktreesByProject: (projectId) => db.getActiveWorktreesByProject(projectId),
      getWorktreesByProject: (projectId) => db.getWorktreesByProject(projectId),
      getKanbanTicketsByProject: (projectId, includeArchived) =>
        db.getKanbanTicketsByProject(projectId, includeArchived),
      getDependenciesForProject: (projectId) => db.getDependenciesForProject(projectId)
    },
    git: {
      getRemoteUrl: (repoPath) =>
        gitService.getRemoteUrl(repoPath).then((result) => result.url ?? null)
    },
    fs: {
      readFile: (path) => fsModule.readFile(path),
      writeFile: (path, content) => fsModule.writeFile(path, content, 'utf-8'),
      stat: (path) => fsModule.stat(path)
    },
    getAppVersion: () => readLiveAppVersion(),
    requestSaveFileDialog: (defaultFileName) => requestBackupSaveFileDialog(defaultFileName),
    requestOpenFileDialog: () => requestBackupOpenFileDialog()
  }
}

export const makeBackupOpsRpcService = (deps: BackupOpsDeps): BackupOpsRpcService => ({
  exportBackup: () =>
    Effect.tryPromise({
      try: () => exportBackup(deps),
      catch: (cause) => cause
    }),
  openBackupFile: () =>
    Effect.tryPromise({
      try: () => openBackupFile(deps),
      catch: (cause) => cause
    })
})

export const makeLiveBackupOpsRpcService = (): BackupOpsRpcService => ({
  exportBackup: () =>
    Effect.tryPromise({
      try: async () => exportBackup(await createLiveDeps()),
      catch: (cause) => cause
    }),
  openBackupFile: () =>
    Effect.tryPromise({
      try: async () => openBackupFile(await createLiveDeps()),
      catch: (cause) => cause
    })
})

export const makeBackupOpsRpcHandlers = (
  service: BackupOpsRpcService = makeLiveBackupOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'backupOps.exportBackup',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.exportBackup()
        })
    ],
    [
      'backupOps.openBackupFile',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openBackupFile()
        })
    ]
  ])
