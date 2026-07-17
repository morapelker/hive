import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { Effect } from 'effect'
import YAML from 'yaml'
import { z } from 'zod'
import type { CustomProjectCommand } from '@shared/lib/custom-commands'
import { isDesktopCommandResult, makeDesktopCommandRequest } from '../../../shared/desktop-command'
import type {
  BackupExportResult,
  BackupFile,
  BackupOpenResult,
  BackupProject,
  ProjectClassification,
  RestoreProjectResult,
  RestoreWorktreeResult
} from '../../../shared/types/backup'
import type {
  KanbanTicket,
  KanbanTicketCreate,
  KanbanTicketUpdate,
  Project,
  ProjectCreate,
  ProjectUpdate,
  TicketDependency,
  TicketMark,
  Worktree,
  WorktreeCreate
} from '../../../main/db'
import { normalizeGitRemoteUrl } from '../../../main/services/git-repository'
import type { RpcHandler } from '../router'

const execFileAsync = promisify(execFile)

// Raw SQLite row fields spread onto `Project` by `mapProjectRow` but not
// declared on the `Project` interface (see database.ts:319 and the
// `kanban_simple_mode` column added in the projects table).
interface ProjectRawExtras {
  readonly kanban_simple_mode?: number | boolean
}

const MAX_CUSTOM_ICON_BYTES = 1024 * 1024
const MAX_BACKUP_FILE_BYTES = 50 * 1024 * 1024

interface BackupOpsDb {
  readonly getAllProjects: () => Project[]
  readonly getActiveWorktreesByProject: (projectId: string) => Worktree[]
  readonly getWorktreesByProject: (projectId: string) => Worktree[]
  readonly getKanbanTicketsByProject: (
    projectId: string,
    includeArchived: boolean
  ) => KanbanTicket[]
  readonly getDependenciesForProject: (projectId: string) => TicketDependency[]
  readonly getProjectByPath: (path: string) => Project | null
  readonly createWorktree: (data: WorktreeCreate) => Worktree
  readonly updateProject: (
    id: string,
    data: Pick<ProjectUpdate, 'language' | 'custom_commands' | 'auto_assign_port'>
  ) => Project | null
  readonly updateProjectKanbanStorageMode: (
    id: string,
    mode: 'internal' | 'markdown'
  ) => Project | null
  readonly updateProjectKanbanMarkdownConfig: (id: string, config: string | null) => Project | null
  readonly updateProjectSimpleMode: (id: string, enabled: boolean) => void
  readonly createKanbanTicket: (data: KanbanTicketCreate) => KanbanTicket
  readonly updateKanbanTicket: (
    id: string,
    data: Pick<KanbanTicketUpdate, 'archived_at'>
  ) => KanbanTicket | null
  readonly addTicketTokens: (ticketId: string, tokens: number) => void
  readonly addTicketDependency: (
    dependentId: string,
    blockerId: string
  ) => { success: boolean; error?: string }
  readonly transaction: <T>(fn: () => T) => T
}

interface BackupOpsGit {
  // Resolves to the raw remote URL, or null when there is no remote / the
  // lookup fails. Never expected to reject.
  readonly getRemoteUrl: (repoPath: string) => Promise<string | null>
  readonly hasUncommittedChanges: (repoPath: string) => Promise<boolean>
  readonly getDefaultBranch: (repoPath: string) => Promise<string>
}

interface BackupOpsFs {
  readonly readFile: (path: string) => Promise<Buffer>
  readonly writeFile: (path: string, content: string) => Promise<void>
  readonly stat: (path: string) => Promise<{ readonly size: number }>
  readonly exists: (path: string) => Promise<boolean>
  readonly mkdir: (path: string) => Promise<void>
}

export interface BackupOpsDeps {
  readonly db: BackupOpsDb
  readonly git: BackupOpsGit
  readonly fs: BackupOpsFs
  readonly getAppVersion: () => Promise<string>
  readonly requestSaveFileDialog: (defaultFileName: string) => Promise<string | null>
  readonly requestOpenFileDialog: () => Promise<string | null>
  // Raw `git` invocation for worktree/branch plumbing not covered by the
  // gitService facade (rev-parse existence checks, fetch, worktree add).
  // Rejects on non-zero exit, mirroring teleport-ops.ts's execGit.
  readonly execGit: (cwd: string, args: string[]) => Promise<string>
  readonly homedir: () => string
  readonly cloneRepository: (
    url: string,
    destDir: string
  ) => Promise<{ success: boolean; error?: string }>
  readonly isGitRepository: (path: string) => boolean
  readonly createProjectWithDefaultWorktree: (data: ProjectCreate) => Project
  readonly uploadIcon: (
    projectId: string,
    base64Data: string,
    filename: string
  ) => { success: boolean; error?: string }
  readonly syncWorktreesOp: (params: {
    projectId: string
    projectPath: string
  }) => Promise<{ success: boolean; error?: string }>
}

export interface BackupOpsRpcService {
  readonly exportBackup: () => Effect.Effect<BackupExportResult, unknown, never>
  readonly openBackupFile: () => Effect.Effect<BackupOpenResult, unknown, never>
  readonly classifyProjects: (params: {
    projects: ReadonlyArray<{ name: string; path: string; remoteUrl: string | null }>
  }) => Effect.Effect<ProjectClassification[], unknown, never>
  readonly restoreProject: (params: {
    project: BackupProject
    options: { cloneParentDir: string | null }
  }) => Effect.Effect<RestoreProjectResult, unknown, never>
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
  // Ticket dependency edges and worktree_branch assignments are resolved by
  // `key` during restore (see `keyToId` in restoreProject) — a duplicate key
  // within one project would silently misroute a dependency/worktree edge to
  // whichever ticket happens to win the map insert.
  .superRefine((project, ctx) => {
    if (!project.tickets) return
    const seen = new Set<string>()
    for (const ticket of project.tickets) {
      if (seen.has(ticket.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate ticket key "${ticket.key}" in project "${project.name}"`,
          path: ['tickets']
        })
      }
      seen.add(ticket.key)
    }
  })

const backupFileSchema = z.object({
  version: z.number(),
  kind: z.literal('hive-backup'),
  created_at: z.string(),
  app_version: z.string(),
  projects: z.array(backupProjectSchema)
})

// ---------------------------------------------------------------------------
// classifyProjects / restoreProject param schemas
// ---------------------------------------------------------------------------

const classifyProjectsParamsSchema = z
  .object({
    projects: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        remoteUrl: z.string().nullable()
      })
    )
  })
  .strict()

const restoreProjectParamsSchema = z
  .object({
    project: backupProjectSchema,
    options: z.object({ cloneParentDir: z.string().nullable() }).strict()
  })
  .strict()

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
  projectName: string,
  iconPath: string | null,
  warnings: string[]
): Promise<BackupFile['projects'][number]['custom_icon']> {
  if (!iconPath) return null
  try {
    const stats = await deps.fs.stat(iconPath)
    if (stats.size > MAX_CUSTOM_ICON_BYTES) {
      warnings.push(`custom icon for ${projectName} skipped (larger than 1 MB)`)
      return null
    }
    const data = await deps.fs.readFile(iconPath)
    return { filename: basename(iconPath), data_base64: data.toString('base64') }
  } catch (error) {
    warnings.push(`custom icon for ${projectName} skipped (${errorMessage(error)})`)
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
  project: Project,
  warnings: string[]
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
    custom_icon: await readCustomIcon(deps, project.name, project.custom_icon, warnings),
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
    const warnings: string[] = []
    for (const project of projects) {
      backupProjects.push(await buildBackupProject(deps, project, warnings))
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

    return {
      success: true,
      path: filePath,
      projectCount: backupProjects.length,
      ...(warnings.length > 0 ? { warnings } : {})
    }
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

    try {
      const stats = await deps.fs.stat(filePath)
      if (stats.size > MAX_BACKUP_FILE_BYTES) {
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(1)
        return {
          canceled: false,
          error: `Backup file is too large (${sizeMb} MB — limit is 50 MB).`
        }
      }
    } catch (error) {
      return { canceled: false, error: errorMessage(error) }
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
// classifyProjects
// ---------------------------------------------------------------------------

/**
 * One normalized-remote lookup per Hive project, computed once per
 * classifyProjects/restoreProject call (never per input entry) — mirrors
 * `ensureRemoteProject` in teleport-ops.ts.
 */
async function buildHiveRemoteMap(
  deps: BackupOpsDeps
): Promise<Map<string, { project: Project; rawRemote: string | null }>> {
  const map = new Map<string, { project: Project; rawRemote: string | null }>()
  for (const project of deps.db.getAllProjects()) {
    const rawRemote = await getRemoteUrlSafe(deps, project.path)
    const normalized = normalizeGitRemoteUrl(rawRemote)
    if (normalized !== null && !map.has(normalized)) {
      map.set(normalized, { project, rawRemote })
    }
  }
  return map
}

async function classifyOne(
  deps: BackupOpsDeps,
  hiveByRemote: Map<string, { project: Project; rawRemote: string | null }>,
  input: { name: string; path: string; remoteUrl: string | null }
): Promise<ProjectClassification> {
  const backupRemote = normalizeGitRemoteUrl(input.remoteUrl)

  if (backupRemote !== null) {
    const match = hiveByRemote.get(backupRemote)
    if (match) {
      return {
        path: input.path,
        classification: 'exists-match',
        alreadyInHive: true,
        hiveProjectId: match.project.id,
        effectivePath: match.project.path,
        localRemoteUrl: match.rawRemote
      }
    }
  }

  const pathExists = await deps.fs.exists(input.path)
  if (pathExists) {
    if (!deps.isGitRepository(input.path)) {
      return {
        path: input.path,
        classification: 'conflict',
        alreadyInHive: false,
        hiveProjectId: null,
        effectivePath: input.path,
        localRemoteUrl: null
      }
    }

    const localRemoteRaw = await getRemoteUrlSafe(deps, input.path)
    const localRemote = normalizeGitRemoteUrl(localRemoteRaw)
    const remotesMatch =
      (localRemote !== null && localRemote === backupRemote) ||
      (localRemote === null && backupRemote === null)

    if (remotesMatch) {
      const existing = deps.db.getProjectByPath(input.path)
      return {
        path: input.path,
        classification: 'exists-match',
        alreadyInHive: existing !== null,
        hiveProjectId: existing?.id ?? null,
        effectivePath: input.path,
        localRemoteUrl: localRemoteRaw
      }
    }

    return {
      path: input.path,
      classification: 'conflict',
      alreadyInHive: false,
      hiveProjectId: null,
      effectivePath: input.path,
      localRemoteUrl: localRemoteRaw
    }
  }

  return {
    path: input.path,
    classification: backupRemote === null ? 'skipped-no-remote' : 'missing-clone',
    alreadyInHive: false,
    hiveProjectId: null,
    effectivePath: input.path,
    localRemoteUrl: null
  }
}

async function classifyProjects(
  deps: BackupOpsDeps,
  projects: ReadonlyArray<{ name: string; path: string; remoteUrl: string | null }>
): Promise<ProjectClassification[]> {
  const hiveByRemote = await buildHiveRemoteMap(deps)
  const results: ProjectClassification[] = []
  for (const project of projects) {
    results.push(await classifyOne(deps, hiveByRemote, project))
  }
  return results
}

// ---------------------------------------------------------------------------
// restoreProject
// ---------------------------------------------------------------------------

// Local copies of teleport-ops.ts's `slug`/`uniquePath` helpers. Duplicated
// rather than imported so backup-ops.ts doesn't pull in teleport-ops.ts's
// module graph (Discord/teleport-remote-client wiring) for two small pure
// helpers; per the task brief this duplication is acceptable.
//
// NOTE: unlike teleport-ops.ts's `slug`, this is used to build filesystem
// path SEGMENTS (project name / worktree name) that are later joined under
// `~/.hive-worktrees`, and those values come from a hand-editable backup
// YAML. A slug that preserves `/` and only trims LEADING/TRAILING `-/.`
// runs (e.g. teleport-ops.ts's version) lets an embedded `a/../../../tmp/x`
// segment survive untouched and `path.join` will happily normalize the
// `..` components right out of the intended `.hive-worktrees` root. This
// version therefore replaces `/`/`\` with `-` (so no path separator ever
// reaches `join`) and collapses runs of 2+ dots down to a single `.` (so
// `..` can never reappear even after the separator replacement), before
// applying the original charset/trim behavior.
function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
  return cleaned || fallback
}

async function uniquePath(deps: BackupOpsDeps, basePath: string): Promise<string> {
  if (!(await deps.fs.exists(basePath))) return basePath
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${basePath}-${i}`
    if (!(await deps.fs.exists(candidate))) return candidate
  }
  throw new Error(`Could not choose a free path for ${basePath}`)
}

// Backed-up branch names come from a hand-editable YAML file and flow into
// `git branch <name> <start>` / `git worktree add <path> <name>` as raw
// positional argv (see execGitScript in the test file for the exact call
// shapes). A name starting with `-` would be parsed by git as a flag (e.g.
// `-f` force-resets whatever ref happens to sit in that argv slot) instead of
// a ref — mirrors `invalidBranch` in `src/main/effect/git/layers.ts:37`,
// widened to also reject whitespace/control characters, which are never
// valid in a git ref name.
function invalidBranchName(branch: string): boolean {
  return !branch || branch.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(branch)
}

// A clone destination basename derived from a backed-up `path` that is empty
// or resolves to `.`/`..` (e.g. a `path` ending in `/..`) would place the
// clone outside the user-chosen parent folder.
function invalidCloneBasename(name: string): boolean {
  return !name || name === '.' || name === '..'
}

const nonSuccessActions: ReadonlySet<RestoreProjectResult['action']> = new Set([
  'failed',
  'skipped-conflict',
  'skipped-no-remote'
])

async function restoreProject(
  deps: BackupOpsDeps,
  project: BackupProject,
  options: { cloneParentDir: string | null }
): Promise<RestoreProjectResult> {
  const projectName = project.name
  const warnings: string[] = []

  try {
    const hiveByRemote = await buildHiveRemoteMap(deps)
    const classification = await classifyOne(deps, hiveByRemote, {
      name: project.name,
      path: project.path,
      remoteUrl: project.remote_url
    })

    if (classification.classification === 'conflict') {
      return {
        success: false,
        projectName,
        action: 'skipped-conflict',
        warnings: ['path exists but contains a different repository'],
        worktrees: [],
        tickets: null
      }
    }
    if (classification.classification === 'skipped-no-remote') {
      return {
        success: false,
        projectName,
        action: 'skipped-no-remote',
        warnings: [],
        worktrees: [],
        tickets: null
      }
    }

    let effectivePath: string
    let action: RestoreProjectResult['action']
    let isFreshClone = false

    if (classification.classification === 'exists-match') {
      effectivePath = classification.effectivePath
      action = 'attached'
    } else {
      // missing-clone
      if (!options.cloneParentDir) {
        return {
          success: false,
          projectName,
          action: 'failed',
          error: 'no clone folder selected',
          warnings: [],
          worktrees: [],
          tickets: null
        }
      }
      if (!project.remote_url) {
        return {
          success: false,
          projectName,
          action: 'failed',
          error: 'no remote url to clone from',
          warnings: [],
          worktrees: [],
          tickets: null
        }
      }

      const cloneBasename = basename(project.path)
      if (invalidCloneBasename(cloneBasename)) {
        return {
          success: false,
          projectName,
          action: 'failed',
          error: `cannot derive a clone destination from path "${project.path}"`,
          warnings: [],
          worktrees: [],
          tickets: null
        }
      }

      const dest = await uniquePath(deps, join(options.cloneParentDir, cloneBasename))
      const cloneResult = await deps.cloneRepository(project.remote_url, dest)
      if (!cloneResult.success) {
        return {
          success: false,
          projectName,
          action: 'failed',
          error: cloneResult.error ?? 'Failed to clone repository',
          warnings: [],
          worktrees: [],
          tickets: null
        }
      }
      effectivePath = dest
      action = 'cloned'
      isFreshClone = true
    }

    // Step 3: pull (only for exists-match — a fresh clone is already current)
    if (!isFreshClone) {
      const dirty = await deps.git.hasUncommittedChanges(effectivePath)
      if (dirty) {
        warnings.push('uncommitted changes — pull skipped')
        action = 'attached'
      } else {
        try {
          await deps.execGit(effectivePath, ['pull', '--ff-only'])
          action = 'pulled'
        } catch (error) {
          warnings.push(errorMessage(error))
          action = 'attached'
        }
      }
    }

    // Step 4: register in Hive
    const existingProject = deps.db.getProjectByPath(effectivePath)
    let projectId: string
    let wasAlreadyInHive: boolean

    if (existingProject) {
      projectId = existingProject.id
      wasAlreadyInHive = true
    } else {
      const created = deps.createProjectWithDefaultWorktree({
        name: project.name,
        path: effectivePath,
        description: project.description,
        tags: project.tags,
        setup_script: project.setup_script,
        run_script: project.run_script,
        archive_script: project.archive_script,
        worktree_create_script: project.worktree_create_script
      })
      projectId = created.id

      deps.db.updateProject(projectId, {
        language: project.language,
        custom_commands: project.custom_commands as CustomProjectCommand[] | null,
        auto_assign_port: project.auto_assign_port
      })
      deps.db.updateProjectKanbanStorageMode(projectId, project.kanban_storage_mode)
      if (project.kanban_markdown_config != null) {
        deps.db.updateProjectKanbanMarkdownConfig(
          projectId,
          JSON.stringify(project.kanban_markdown_config)
        )
      }
      deps.db.updateProjectSimpleMode(projectId, project.kanban_simple_mode)

      if (project.custom_icon) {
        const iconResult = deps.uploadIcon(
          projectId,
          project.custom_icon.data_base64,
          project.custom_icon.filename
        )
        if (!iconResult.success) {
          warnings.push(`Failed to restore project icon: ${iconResult.error ?? 'unknown error'}`)
        }
      }

      wasAlreadyInHive = false
    }

    // Step 5: sync worktrees from disk
    const syncResult = await deps.syncWorktreesOp({ projectId, projectPath: effectivePath })
    if (!syncResult.success) {
      warnings.push(syncResult.error ?? 'Failed to sync worktrees')
    }

    // Step 6: worktrees (raw git, teleport-style)
    const worktreeResults: RestoreWorktreeResult[] = []
    const knownBranches = new Set(
      deps.db.getActiveWorktreesByProject(projectId).map((worktree) => worktree.branch_name)
    )

    if (project.worktrees.length > 0 && project.remote_url !== null) {
      try {
        await deps.execGit(effectivePath, ['fetch', 'origin'])
      } catch (error) {
        warnings.push(`git fetch origin failed: ${errorMessage(error)}`)
      }
    }

    const safeProjectName = sanitizePathSegment(project.name, 'project')
    const hiveWorktreesRoot = join(deps.homedir(), '.hive-worktrees')

    for (const entry of project.worktrees) {
      if (knownBranches.has(entry.branch_name)) {
        worktreeResults.push({ branch: entry.branch_name, status: 'skipped-existing' })
        continue
      }

      if (invalidBranchName(entry.branch_name)) {
        worktreeResults.push({
          branch: entry.branch_name,
          status: 'failed',
          error: 'invalid branch name'
        })
        continue
      }

      let localExists = true
      try {
        await deps.execGit(effectivePath, [
          'rev-parse',
          '--verify',
          `refs/heads/${entry.branch_name}`
        ])
      } catch {
        localExists = false
      }

      let status: 'created' | 'created-fresh-branch' = 'created'

      if (!localExists) {
        let remoteExists = true
        try {
          await deps.execGit(effectivePath, [
            'rev-parse',
            '--verify',
            `refs/remotes/origin/${entry.branch_name}`
          ])
        } catch {
          remoteExists = false
        }

        try {
          if (remoteExists) {
            await deps.execGit(effectivePath, [
              'branch',
              entry.branch_name,
              `origin/${entry.branch_name}`
            ])
            status = 'created'
          } else {
            const defaultBranch = await deps.git.getDefaultBranch(effectivePath)
            await deps.execGit(effectivePath, ['branch', entry.branch_name, defaultBranch])
            status = 'created-fresh-branch'
            warnings.push(
              `branch ${entry.branch_name} not found on remote — created from ${defaultBranch}`
            )
          }
        } catch (error) {
          worktreeResults.push({
            branch: entry.branch_name,
            status: 'failed',
            error: errorMessage(error)
          })
          continue
        }
      }

      const worktreePath = await uniquePath(
        deps,
        join(
          deps.homedir(),
          '.hive-worktrees',
          safeProjectName,
          `${safeProjectName}--${sanitizePathSegment(entry.name, 'worktree')}`
        )
      )

      // Defense in depth: sanitizePathSegment above should already keep
      // worktreePath under hiveWorktreesRoot, but a hand-edited backup YAML
      // is untrusted input, so re-verify the fully resolved path before ever
      // touching the filesystem or invoking git — never mkdir/execGit
      // outside the `.hive-worktrees` boundary.
      const resolvedWorktreePath = resolve(worktreePath)
      if (
        resolvedWorktreePath !== hiveWorktreesRoot &&
        !resolvedWorktreePath.startsWith(hiveWorktreesRoot + sep)
      ) {
        worktreeResults.push({
          branch: entry.branch_name,
          status: 'failed',
          error: 'invalid worktree path'
        })
        continue
      }

      try {
        await deps.fs.mkdir(dirname(worktreePath))
        await deps.execGit(effectivePath, ['worktree', 'add', worktreePath, entry.branch_name])
      } catch (error) {
        worktreeResults.push({
          branch: entry.branch_name,
          status: 'failed',
          error: errorMessage(error)
        })
        continue
      }

      deps.db.createWorktree({
        project_id: projectId,
        name: entry.name,
        branch_name: entry.branch_name,
        path: worktreePath,
        base_branch: entry.base_branch
      })
      knownBranches.add(entry.branch_name)
      worktreeResults.push({ branch: entry.branch_name, status })
    }

    // Step 7: tickets
    let tickets: RestoreProjectResult['tickets']
    const shouldSkipTickets =
      project.kanban_storage_mode === 'markdown' ||
      !project.tickets ||
      project.tickets.length === 0 ||
      wasAlreadyInHive

    if (shouldSkipTickets) {
      tickets = { restored: 0, dependencyErrors: 0, skipped: true }
    } else {
      const branchToWorktreeId = new Map(
        deps.db
          .getActiveWorktreesByProject(projectId)
          .map((worktree) => [worktree.branch_name, worktree.id])
      )
      const keyToId = new Map<string, string>()
      const ticketList = project.tickets ?? []

      deps.db.transaction(() => {
        for (const ticketEntry of ticketList) {
          const created = deps.db.createKanbanTicket({
            project_id: projectId,
            title: ticketEntry.title,
            description: ticketEntry.description,
            attachments: [],
            column: ticketEntry.column,
            sort_order: ticketEntry.sort_order,
            worktree_id: ticketEntry.worktree_branch
              ? (branchToWorktreeId.get(ticketEntry.worktree_branch) ?? null)
              : null,
            mode: ticketEntry.mode,
            mark: ticketEntry.mark as TicketMark | null
          })
          if (ticketEntry.archived_at) {
            deps.db.updateKanbanTicket(created.id, { archived_at: ticketEntry.archived_at })
          }
          if (ticketEntry.total_tokens > 0) {
            deps.db.addTicketTokens(created.id, ticketEntry.total_tokens)
          }
          keyToId.set(ticketEntry.key, created.id)
        }
      })

      let dependencyErrors = 0
      for (const edge of project.ticket_dependencies ?? []) {
        const dependentId = keyToId.get(edge.dependent)
        const blockerId = keyToId.get(edge.blocker)
        if (!dependentId || !blockerId) {
          dependencyErrors += 1
          warnings.push(
            `Could not restore dependency ${edge.dependent} -> ${edge.blocker}: unknown ticket key`
          )
          continue
        }
        const depResult = deps.db.addTicketDependency(dependentId, blockerId)
        if (!depResult.success) {
          dependencyErrors += 1
          warnings.push(
            depResult.error ?? `Could not restore dependency ${edge.dependent} -> ${edge.blocker}`
          )
        }
      }

      tickets = { restored: keyToId.size, dependencyErrors, skipped: false }
    }

    // Step 8
    return {
      success: !nonSuccessActions.has(action),
      projectId,
      projectName,
      action,
      warnings,
      worktrees: worktreeResults,
      tickets
    }
  } catch (error) {
    return {
      success: false,
      projectName,
      action: 'failed',
      error: errorMessage(error),
      warnings,
      worktrees: [],
      tickets: null
    }
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

// Local copy of teleport-ops.ts's execGit — duplicated for the same reason as
// `slug`/`uniquePath` above (avoid pulling teleport-ops.ts's module graph in).
async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' })
  return stdout.trim()
}

async function createLiveDeps(): Promise<BackupOpsDeps> {
  const [
    { getDatabase },
    { gitService },
    fsModule,
    { isGitRepository, createProjectWithDefaultWorktree, uploadIcon, cloneRepository },
    { syncWorktreesOp }
  ] = await Promise.all([
    import('../../../main/db'),
    import('../../../main/effect/git/facade'),
    import('node:fs/promises'),
    import('../../../main/services/project-ops'),
    import('../../../main/services/worktree-ops')
  ])
  const db = getDatabase()

  return {
    db: {
      getAllProjects: () => db.getAllProjects(),
      getActiveWorktreesByProject: (projectId) => db.getActiveWorktreesByProject(projectId),
      getWorktreesByProject: (projectId) => db.getWorktreesByProject(projectId),
      getKanbanTicketsByProject: (projectId, includeArchived) =>
        db.getKanbanTicketsByProject(projectId, includeArchived),
      getDependenciesForProject: (projectId) => db.getDependenciesForProject(projectId),
      getProjectByPath: (path) => db.getProjectByPath(path),
      createWorktree: (data) => db.createWorktree(data),
      updateProject: (id, data) => db.updateProject(id, data),
      updateProjectKanbanStorageMode: (id, mode) => db.updateProjectKanbanStorageMode(id, mode),
      updateProjectKanbanMarkdownConfig: (id, config) =>
        db.updateProjectKanbanMarkdownConfig(id, config),
      updateProjectSimpleMode: (id, enabled) => db.updateProjectSimpleMode(id, enabled),
      createKanbanTicket: (data) => db.createKanbanTicket(data),
      updateKanbanTicket: (id, data) => db.updateKanbanTicket(id, data),
      addTicketTokens: (ticketId, tokens) => db.addTicketTokens(ticketId, tokens),
      addTicketDependency: (dependentId, blockerId) =>
        db.addTicketDependency(dependentId, blockerId),
      transaction: (fn) => db.transaction(fn)
    },
    git: {
      getRemoteUrl: (repoPath) =>
        gitService.getRemoteUrl(repoPath).then((result) => result.url ?? null),
      hasUncommittedChanges: (repoPath) => gitService.hasUncommittedChanges(repoPath),
      getDefaultBranch: (repoPath) => gitService.getDefaultBranch(repoPath)
    },
    fs: {
      readFile: (path) => fsModule.readFile(path),
      writeFile: (path, content) => fsModule.writeFile(path, content, 'utf-8'),
      stat: (path) => fsModule.stat(path),
      exists: (path) =>
        fsModule
          .access(path)
          .then(() => true)
          .catch(() => false),
      mkdir: (path) => fsModule.mkdir(path, { recursive: true }).then(() => undefined)
    },
    getAppVersion: () => readLiveAppVersion(),
    requestSaveFileDialog: (defaultFileName) => requestBackupSaveFileDialog(defaultFileName),
    requestOpenFileDialog: () => requestBackupOpenFileDialog(),
    execGit: (cwd, args) => runGit(cwd, args),
    homedir: () => homedir(),
    cloneRepository: (url, destDir) => cloneRepository(url, destDir),
    isGitRepository: (path) => isGitRepository(path),
    createProjectWithDefaultWorktree: (data) => createProjectWithDefaultWorktree(db, data),
    uploadIcon: (projectId, base64Data, filename) => uploadIcon(projectId, base64Data, filename),
    syncWorktreesOp: (params) => syncWorktreesOp(params)
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
    }),
  classifyProjects: (params) =>
    Effect.tryPromise({
      try: () => classifyProjects(deps, params.projects),
      catch: (cause) => cause
    }),
  restoreProject: (params) =>
    Effect.tryPromise({
      try: () => restoreProject(deps, params.project, params.options),
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
    }),
  classifyProjects: (params) =>
    Effect.tryPromise({
      try: async () => classifyProjects(await createLiveDeps(), params.projects),
      catch: (cause) => cause
    }),
  restoreProject: (params) =>
    Effect.tryPromise({
      try: async () => restoreProject(await createLiveDeps(), params.project, params.options),
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
    ],
    [
      'backupOps.classifyProjects',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => classifyProjectsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.classifyProjects(parsed)
        })
    ],
    [
      'backupOps.restoreProject',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => restoreProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.restoreProject(parsed)
        })
    ]
  ])
