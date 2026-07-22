import { randomBytes, randomUUID } from 'node:crypto'
import {
  copyFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import YAML from 'yaml'

import { getDatabase } from '../db'
import { normalizeKanbanBatchDrafts } from '../db/kanban-batch'
import {
  configuredFolders,
  ensureFolder,
  isMarkdownCandidate,
  parseMarkdownConfig,
  parseMarkdownConfigResult,
  resolveProjectPath,
  validateConfiguredFolders,
  validateMarkdownConfigShape
} from './kanban-markdown-paths'
import {
  deactivateMarkdownKanbanProjectWatch,
  restartMarkdownKanbanProjectWatch,
  suppressMarkdownKanbanWatch
} from './markdown-kanban-watcher'
import type {
  KanbanMarkdownConfig,
  KanbanStorageConfig,
  KanbanStorageMode,
  KanbanTicket,
  KanbanTicketBatchCreate,
  KanbanTicketBatchCreateResult,
  KanbanTicketColumn,
  KanbanTicketCreate,
  KanbanTicketDuplicateOverrides,
  KanbanTicketUpdate,
  MarkdownCardDiagnostic,
  Project,
  TicketDependency
} from '../db'

export { getDefaultMarkdownConfig } from './kanban-markdown-paths'

const HIVE_FRONTMATTER_FIELDS = new Set([
  'id',
  'title',
  'column',
  'mode',
  'sort_order',
  'archived_at',
  'created_at',
  'dependencies',
  'external_provider',
  'external_id',
  'external_url',
  'github_pr_number',
  'github_pr_url',
  'mark',
  'goal_mode',
  'goal_success_criteria'
])

const CARD_FILE_SIZE_LIMIT_BYTES = 1024 * 1024
const VALID_COLUMNS = new Set<KanbanTicketColumn>([
  'todo',
  'in_progress',
  'review',
  'merged',
  'done'
])
const VALID_MODES = new Set(['build', 'plan', 'super-plan'])
const VALID_MARKS = new Set(['common', 'rare', 'epic', 'legendary'])

type Frontmatter = Record<string, unknown>

interface MarkdownLayoutMove {
  source: string
  target: string
}

interface ParsedMarkdownCard {
  ticket: KanbanTicket
  filePath: string
  frontmatter: Frontmatter
}

interface AdoptionRepairDraft {
  filePath: string
  id: string
  column: KanbanTicketColumn
  existingSortOrder: number | null
  needsSortOrder: boolean
  updates: Frontmatter
}

interface MarkdownBatchCreatePlan {
  draftKey: string
  id: string
  filePath: string
  frontmatter: Frontmatter
  body: string
  runtime: Partial<MarkdownRuntimeState>
}

interface MarkdownIndex {
  projectId: string
  tickets: KanbanTicket[]
  cardsById: Map<string, ParsedMarkdownCard>
  pathsById: Map<string, string[]>
  diagnostics: MarkdownCardDiagnostic[]
  loadedAt: number
}

interface MarkdownRuntimeState {
  current_session_id: string | null
  worktree_id: string | null
  note: string | null
  attachments: unknown[]
  plan_ready: boolean
  auto_approve_plan: boolean
  total_tokens: number
  pending_launch_config: string | null
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
  variant_group_id: string | null
  updated_at: string | null
}

interface MarkdownRuntimeCleanupRow {
  card_id: string
  last_seen_path: string | null
  orphaned_at: string | null
}

interface ConfiguredMarkdownFileMatch {
  filePath: string
  indexFilePath: string
  column: KanbanTicketColumn | null
}

function emptyRuntimeState(): MarkdownRuntimeState {
  return {
    current_session_id: null,
    worktree_id: null,
    note: null,
    attachments: [],
    plan_ready: false,
    auto_approve_plan: false,
    total_tokens: 0,
    pending_launch_config: null,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    updated_at: null
  }
}

class MarkdownCardError extends Error {
  constructor(
    public readonly kind: MarkdownCardDiagnostic['kind'],
    public readonly ticketId: string | null,
    message: string
  ) {
    super(message)
  }
}

export interface KanbanBackend {
  get(projectId: string, ticketId: string): Promise<KanbanTicket | null>
  list(projectId: string, includeArchived: boolean): Promise<KanbanTicket[]>
  create(projectId: string, data: KanbanTicketCreate): Promise<KanbanTicket>
  duplicate(
    projectId: string,
    ticketId: string,
    overrides?: KanbanTicketDuplicateOverrides
  ): Promise<KanbanTicket>
  createBatch(
    projectId: string,
    data: KanbanTicketBatchCreate
  ): Promise<KanbanTicketBatchCreateResult>
  update(
    projectId: string,
    ticketId: string,
    data: KanbanTicketUpdate
  ): Promise<KanbanTicket | null>
  move(
    projectId: string,
    ticketId: string,
    column: KanbanTicketColumn,
    sortOrder: number
  ): Promise<KanbanTicket | null>
  reorder(projectId: string, ticketId: string, sortOrder: number): Promise<void>
  delete(projectId: string, ticketId: string): Promise<boolean>
  archive(projectId: string, ticketId: string): Promise<KanbanTicket | null>
  archiveAllDone(projectId: string): Promise<number>
  unarchive(projectId: string, ticketId: string): Promise<KanbanTicket | null>
  getBySession(sessionId: string): Promise<KanbanTicket[]>
  addTokens(projectId: string, ticketId: string, tokens: number): Promise<KanbanTicket | null>
  detachWorktree(worktreeId: string): Promise<number>
  syncPR(worktreeId: string, prNumber: number, prUrl: string): Promise<void>
  clearPR(worktreeId: string): Promise<void>
  attachPR(projectId: string, ticketId: string, prNumber: number, prUrl: string): Promise<void>
  detachPR(projectId: string, ticketId: string): Promise<void>
  addDependency(
    projectId: string,
    dependentId: string,
    blockerId: string
  ): Promise<{ success: boolean; error?: string }>
  removeDependency(projectId: string, dependentId: string, blockerId: string): Promise<boolean>
  getBlockers(projectId: string, ticketId: string): Promise<KanbanTicket[]>
  getDependents(projectId: string, ticketId: string): Promise<KanbanTicket[]>
  getDependenciesForProject(projectId: string): Promise<TicketDependency[]>
  removeAllDependencies(projectId: string, ticketId: string): Promise<number>
  exportBoard(
    projectId: string
  ): Promise<{ tickets: KanbanTicket[]; dependencies: TicketDependency[] }>
  importTickets(
    projectId: string,
    tickets: Array<{
      id: string
      title: string
      description?: string | null
      attachments?: unknown[] | null
      column?: string
    }>,
    dependencies?: Array<{ dependentId: string; blockerId: string }>
  ): Promise<{
    created: number
    updated: number
    dependencyCount: number
    ignoredDependencyCount: number
  }>
}

class InternalKanbanBackend implements KanbanBackend {
  async get(_projectId: string, ticketId: string): Promise<KanbanTicket | null> {
    const ticket = getDatabase().getKanbanTicket(ticketId)
    return ticket && ticket.project_id === _projectId ? ticket : null
  }

  async list(projectId: string, includeArchived: boolean): Promise<KanbanTicket[]> {
    return getDatabase().getKanbanTicketsByProject(projectId, includeArchived)
  }

  async create(projectId: string, data: KanbanTicketCreate): Promise<KanbanTicket> {
    assertProjectPayload(projectId, data.project_id)
    return getDatabase().createKanbanTicket({ ...data, project_id: projectId })
  }

  async duplicate(
    projectId: string,
    ticketId: string,
    overrides?: KanbanTicketDuplicateOverrides
  ): Promise<KanbanTicket> {
    const source = await this.get(projectId, ticketId)
    if (!source) throw new Error('Ticket does not exist')
    return getDatabase().createKanbanTicket({
      title: source.title,
      description: source.description,
      attachments: source.attachments,
      mark: source.mark,
      note: source.note,
      ...overrides,
      project_id: projectId,
      column: overrides?.column ?? source.column
    })
  }

  async createBatch(
    projectId: string,
    data: KanbanTicketBatchCreate
  ): Promise<KanbanTicketBatchCreateResult> {
    for (const draft of data.drafts) assertProjectPayload(projectId, draft.project_id)
    return getDatabase().createKanbanTicketBatch({
      drafts: data.drafts.map((draft) => ({ ...draft, project_id: projectId }))
    })
  }

  async update(
    projectId: string,
    ticketId: string,
    data: KanbanTicketUpdate
  ): Promise<KanbanTicket | null> {
    const existing = await this.get(projectId, ticketId)
    if (!existing) return null
    return getDatabase().updateKanbanTicket(ticketId, data)
  }

  async move(
    projectId: string,
    ticketId: string,
    column: KanbanTicketColumn,
    sortOrder: number
  ): Promise<KanbanTicket | null> {
    const existing = await this.get(projectId, ticketId)
    if (!existing) return null
    return getDatabase().moveKanbanTicket(ticketId, column, sortOrder)
  }

  async reorder(projectId: string, ticketId: string, sortOrder: number): Promise<void> {
    const existing = await this.get(projectId, ticketId)
    if (!existing) return
    getDatabase().reorderKanbanTicket(ticketId, sortOrder)
  }

  async delete(projectId: string, ticketId: string): Promise<boolean> {
    const existing = await this.get(projectId, ticketId)
    if (!existing) return false
    getDatabase().removeAllDependenciesForTicket(ticketId)
    return getDatabase().deleteKanbanTicket(ticketId)
  }

  async archive(projectId: string, ticketId: string): Promise<KanbanTicket | null> {
    const existing = await this.get(projectId, ticketId)
    if (!existing) return null
    return getDatabase().archiveKanbanTicket(ticketId)
  }

  async archiveAllDone(projectId: string): Promise<number> {
    return getDatabase().archiveAllDoneKanbanTickets(projectId)
  }

  async unarchive(projectId: string, ticketId: string): Promise<KanbanTicket | null> {
    const existing = await this.get(projectId, ticketId)
    if (!existing) return null
    return getDatabase().unarchiveKanbanTicket(ticketId)
  }

  async getBySession(sessionId: string): Promise<KanbanTicket[]> {
    return getDatabase().getKanbanTicketsBySession(sessionId)
  }

  async addTokens(
    projectId: string,
    ticketId: string,
    tokens: number
  ): Promise<KanbanTicket | null> {
    const existing = await this.get(projectId, ticketId)
    if (!existing) return null
    const db = getDatabase()
    db.addTicketTokens(ticketId, tokens)
    return db.getKanbanTicket(ticketId)
  }

  async detachWorktree(worktreeId: string): Promise<number> {
    return getDatabase().detachWorktreeFromTickets(worktreeId)
  }

  async syncPR(worktreeId: string, prNumber: number, prUrl: string): Promise<void> {
    getDatabase().syncPRToTickets(worktreeId, prNumber, prUrl)
  }

  async clearPR(worktreeId: string): Promise<void> {
    getDatabase().clearPRFromTickets(worktreeId)
  }

  async attachPR(
    projectId: string,
    ticketId: string,
    prNumber: number,
    prUrl: string
  ): Promise<void> {
    getDatabase().attachPRToTicket(ticketId, projectId, prNumber, prUrl)
  }

  async detachPR(projectId: string, ticketId: string): Promise<void> {
    getDatabase().detachPRFromTicket(ticketId, projectId)
  }

  async addDependency(
    projectId: string,
    dependentId: string,
    blockerId: string
  ): Promise<{ success: boolean; error?: string }> {
    const dependent = await this.get(projectId, dependentId)
    const blocker = await this.get(projectId, blockerId)
    if (!dependent || !blocker) return { success: false, error: 'One or both tickets do not exist' }
    return getDatabase().addTicketDependency(dependentId, blockerId)
  }

  async removeDependency(
    projectId: string,
    dependentId: string,
    blockerId: string
  ): Promise<boolean> {
    const dependent = await this.get(projectId, dependentId)
    if (!dependent) return false
    return getDatabase().removeTicketDependency(dependentId, blockerId)
  }

  async getBlockers(projectId: string, ticketId: string): Promise<KanbanTicket[]> {
    const existing = await this.get(projectId, ticketId)
    return existing ? getDatabase().getBlockersForTicket(ticketId) : []
  }

  async getDependents(projectId: string, ticketId: string): Promise<KanbanTicket[]> {
    const existing = await this.get(projectId, ticketId)
    return existing ? getDatabase().getDependentsOfTicket(ticketId) : []
  }

  async getDependenciesForProject(projectId: string): Promise<TicketDependency[]> {
    return getDatabase().getDependenciesForProject(projectId)
  }

  async removeAllDependencies(projectId: string, ticketId: string): Promise<number> {
    const ticket = await this.get(projectId, ticketId)
    if (!ticket) return 0
    return getDatabase().removeAllDependenciesForTicket(ticketId)
  }

  async exportBoard(
    projectId: string
  ): Promise<{ tickets: KanbanTicket[]; dependencies: TicketDependency[] }> {
    return {
      tickets: await this.list(projectId, false),
      dependencies: await this.getDependenciesForProject(projectId)
    }
  }

  async importTickets(
    projectId: string,
    tickets: Array<{
      id: string
      title: string
      description?: string | null
      attachments?: unknown[] | null
      column?: string
    }>,
    dependencies?: Array<{ dependentId: string; blockerId: string }>
  ): Promise<{
    created: number
    updated: number
    dependencyCount: number
    ignoredDependencyCount: number
  }> {
    const db = getDatabase()
    let created = 0
    let updated = 0
    let dependencyCount = 0
    let ignoredDependencyCount = 0
    const selectedIds = new Set(tickets.map((ticket) => ticket.id))

    for (const ticket of tickets) {
      const existing = db.getKanbanTicket(ticket.id)
      if (existing && existing.project_id === projectId) {
        db.updateKanbanTicket(ticket.id, {
          title: ticket.title,
          description: ticket.description ?? null,
          attachments: ticket.attachments ?? [],
          column: asColumn(ticket.column) ?? 'todo'
        })
        updated++
      } else if (existing) {
        db.createKanbanTicket({
          project_id: projectId,
          title: ticket.title,
          description: ticket.description ?? null,
          attachments: ticket.attachments ?? [],
          column: asColumn(ticket.column) ?? 'todo'
        })
        created++
      } else {
        db.createKanbanTicket({
          id: ticket.id,
          project_id: projectId,
          title: ticket.title,
          description: ticket.description ?? null,
          attachments: ticket.attachments ?? [],
          column: asColumn(ticket.column) ?? 'todo'
        })
        created++
      }
    }

    for (const ticketId of selectedIds) {
      const blockers = db.getBlockersForTicket(ticketId)
      for (const blocker of blockers) {
        if (selectedIds.has(blocker.id)) db.removeTicketDependency(ticketId, blocker.id)
      }
    }

    for (const dependency of dependencies ?? []) {
      const dependentId = dependency.dependentId.trim()
      const blockerId = dependency.blockerId.trim()
      if (
        !dependentId ||
        !blockerId ||
        !selectedIds.has(dependentId) ||
        !selectedIds.has(blockerId)
      ) {
        ignoredDependencyCount++
        continue
      }
      const result = db.addTicketDependency(dependentId, blockerId)
      if (result.success) dependencyCount++
      else ignoredDependencyCount++
    }

    return { created, updated, dependencyCount, ignoredDependencyCount }
  }
}

class MarkdownKanbanBackend implements KanbanBackend {
  private indexes = new Map<string, MarkdownIndex>()

  invalidate(projectId: string): void {
    this.indexes.delete(projectId)
  }

  async getDiagnostics(projectId: string): Promise<MarkdownCardDiagnostic[]> {
    if (getProjectStorageMode(projectId) !== 'markdown') return []
    const index = await this.ensureIndex(projectId)
    return index.diagnostics
  }

  async get(projectId: string, ticketId: string): Promise<KanbanTicket | null> {
    const index = await this.ensureIndex(projectId)
    return index.cardsById.get(ticketId)?.ticket ?? null
  }

  async list(projectId: string, includeArchived: boolean): Promise<KanbanTicket[]> {
    const index = await this.reloadIndex(projectId)
    return index.tickets.filter((ticket) => includeArchived || !ticket.archived_at).sort(ticketSort)
  }

  async create(projectId: string, data: KanbanTicketCreate): Promise<KanbanTicket> {
    assertProjectPayload(projectId, data.project_id)
    assertNonEmptyString(data.title, 'Ticket title')
    if (data.id !== undefined) assertNonEmptyString(data.id, 'Ticket id')
    const project = requireProject(projectId)
    const config = parseMarkdownConfig(project)
    const column = data.column ?? 'todo'
    const id = data.id ?? generateTicketId(data.title)
    await this.assertCardIdAvailable(projectId, id)
    const folder = await ensureFolder(project, config, column)
    const sortOrder = data.sort_order ?? (await this.nextSortOrder(projectId, column))
    const now = new Date().toISOString()
    const frontmatter = publicFieldsFromCreate(
      {
        ...data,
        id,
        project_id: projectId,
        column,
        sort_order: sortOrder
      },
      now
    )
    const filename = `${slugify(data.title) || 'ticket'}-${id.slice(-4)}.md`
    const filePath = await uniquePath(folder, filename)
    await writeMarkdownFile(filePath, frontmatter, data.description ?? '')
    suppressMarkdownWrites(projectId, filePath)
    await this.writeRuntime(
      projectId,
      id,
      {
        attachments: data.attachments ?? [],
        current_session_id: data.current_session_id ?? null,
        worktree_id: data.worktree_id ?? null,
        plan_ready: data.plan_ready ?? false,
        note: data.note ?? null,
        model_provider_id: data.model_provider_id ?? null,
        model_id: data.model_id ?? null,
        model_variant: data.model_variant ?? null,
        variant_group_id: data.variant_group_id ?? null
      },
      false
    )
    this.invalidate(projectId)
    const ticket = await this.get(projectId, id)
    if (!ticket) throw new Error('Created markdown ticket could not be loaded')
    return ticket
  }

  async duplicate(
    projectId: string,
    ticketId: string,
    overrides?: KanbanTicketDuplicateOverrides
  ): Promise<KanbanTicket> {
    const card = await this.requireMutableCard(projectId, ticketId)
    const source = card.ticket
    return this.create(projectId, {
      title: source.title,
      description: source.description,
      attachments: source.attachments,
      mark: source.mark,
      note: source.note,
      ...overrides,
      project_id: projectId,
      column: overrides?.column ?? source.column
    })
  }

  async createBatch(
    projectId: string,
    data: KanbanTicketBatchCreate
  ): Promise<KanbanTicketBatchCreateResult> {
    for (const draft of data.drafts) {
      for (const blockerDraftKey of draft.depends_on ?? []) {
        assertNonEmptyString(blockerDraftKey, 'Dependency draft key')
      }
    }
    const drafts = normalizeKanbanBatchDrafts(data.drafts)
    for (const draft of drafts) {
      assertProjectPayload(projectId, draft.project_id)
      assertNonEmptyString(draft.title, 'Ticket title')
      assertNonEmptyString(draft.draft_key, 'Draft key')
      for (const blockerDraftKey of draft.depends_on)
        assertNonEmptyString(blockerDraftKey, 'Dependency draft key')
    }

    const project = requireProject(projectId)
    const config = parseMarkdownConfig(project)
    const index = await this.reloadIndex(projectId)
    const now = new Date().toISOString()
    const ids = new Set<string>()
    const reservedPaths = new Set<string>()
    const maxSortByColumn = new Map<KanbanTicketColumn, number>()
    for (const ticket of index.tickets) {
      const current = maxSortByColumn.get(ticket.column) ?? -1
      maxSortByColumn.set(ticket.column, Math.max(current, ticket.sort_order))
    }

    const plans: MarkdownBatchCreatePlan[] = []
    for (const draft of drafts) {
      const column = draft.column ?? 'todo'
      const id = generateTicketId(draft.title)
      if (ids.has(id)) {
        throw new Error(
          `Cannot create markdown ticket "${id}" because that card id is already used in this batch.`
        )
      }
      this.assertCardIdAvailableInIndex(index, id)
      ids.add(id)

      const sortOrder = draft.sort_order ?? (maxSortByColumn.get(column) ?? -1) + 1
      maxSortByColumn.set(column, sortOrder)
      const folder = await ensureFolder(project, config, column)
      const filename = `${slugify(draft.title) || 'ticket'}-${id.slice(-4)}.md`
      const filePath = await uniquePath(folder, filename, reservedPaths)
      reservedPaths.add(filePath)
      plans.push({
        draftKey: draft.draft_key,
        id,
        filePath,
        frontmatter: publicFieldsFromCreate(
          {
            ...draft,
            id,
            project_id: projectId,
            column,
            sort_order: sortOrder
          },
          now
        ),
        body: draft.description ?? '',
        runtime: {
          attachments: draft.attachments ?? [],
          current_session_id: draft.current_session_id ?? null,
          worktree_id: draft.worktree_id ?? null,
          plan_ready: draft.plan_ready ?? false,
          note: draft.note ?? null,
          model_provider_id: draft.model_provider_id ?? null,
          model_id: draft.model_id ?? null,
          model_variant: draft.model_variant ?? null,
          variant_group_id: draft.variant_group_id ?? null
        }
      })
    }

    try {
      const createdPaths: string[] = []
      for (const plan of plans) {
        await writeMarkdownFile(plan.filePath, plan.frontmatter, plan.body)
        createdPaths.push(plan.filePath)
        await this.writeRuntime(projectId, plan.id, plan.runtime, false)
      }
      suppressMarkdownWrites(projectId, createdPaths)

      this.invalidate(projectId)
      const tickets: KanbanTicket[] = []
      const byDraftKey = new Map<string, KanbanTicket>()
      for (const plan of plans) {
        const ticket = await this.get(projectId, plan.id)
        if (!ticket) throw new Error('Created markdown ticket could not be loaded')
        tickets.push(ticket)
        byDraftKey.set(plan.draftKey, ticket)
      }

      const dependencies: TicketDependency[] = []
      for (const draft of drafts) {
        const dependent = byDraftKey.get(draft.draft_key)
        if (!dependent)
          throw new Error(`Created ticket for draft "${draft.draft_key}" could not be loaded`)
        for (const blockerDraftKey of draft.depends_on) {
          const blocker = byDraftKey.get(blockerDraftKey)
          if (!blocker)
            throw new Error(`Created ticket for draft "${blockerDraftKey}" could not be loaded`)
          const result = await this.addDependency(projectId, dependent.id, blocker.id)
          if (!result.success) {
            throw new Error(result.error ?? 'Failed to create markdown ticket dependency')
          }
          const dep = (await this.getDependenciesForProject(projectId)).find(
            (d) => d.dependent_id === dependent.id && d.blocker_id === blocker.id
          )
          if (!dep) throw new Error('Created markdown ticket dependency could not be loaded')
          dependencies.push(dep)
        }
      }
      return { tickets, dependencies }
    } catch (error) {
      const removedPaths: string[] = []
      for (const plan of [...plans].reverse()) {
        await rm(plan.filePath, { force: true }).catch(() => {})
        removedPaths.push(plan.filePath)
        this.deleteRuntime(projectId, plan.id)
      }
      suppressMarkdownWrites(projectId, removedPaths)
      this.invalidate(projectId)
      throw error
    }
  }

  async update(
    projectId: string,
    ticketId: string,
    data: KanbanTicketUpdate
  ): Promise<KanbanTicket | null> {
    const card = await this.requireMutableCard(projectId, ticketId)
    const publicUpdates: Frontmatter = {}
    const runtimeUpdates: Partial<MarkdownRuntimeState> = {}
    let body: string | undefined

    if (data.title !== undefined) {
      assertNonEmptyString(data.title, 'Ticket title')
      publicUpdates.title = data.title
    }
    if (data.description !== undefined) body = data.description ?? ''
    if (data.column !== undefined) publicUpdates.column = data.column
    if (data.sort_order !== undefined) publicUpdates.sort_order = data.sort_order
    if (data.mode !== undefined) publicUpdates.mode = data.mode
    if (data.github_pr_number !== undefined) publicUpdates.github_pr_number = data.github_pr_number
    if (data.github_pr_url !== undefined) publicUpdates.github_pr_url = data.github_pr_url
    if (data.mark !== undefined) publicUpdates.mark = data.mark
    if (data.archived_at !== undefined) publicUpdates.archived_at = data.archived_at
    if (data.goal_mode !== undefined) publicUpdates.goal_mode = data.goal_mode
    if (data.goal_success_criteria !== undefined)
      publicUpdates.goal_success_criteria = data.goal_success_criteria

    if (data.attachments !== undefined) runtimeUpdates.attachments = data.attachments
    if (data.current_session_id !== undefined)
      runtimeUpdates.current_session_id = data.current_session_id
    if (data.worktree_id !== undefined) runtimeUpdates.worktree_id = data.worktree_id
    if (data.plan_ready !== undefined) runtimeUpdates.plan_ready = data.plan_ready
    if (data.auto_approve_plan !== undefined)
      runtimeUpdates.auto_approve_plan = data.auto_approve_plan
    if (data.pending_launch_config !== undefined)
      runtimeUpdates.pending_launch_config = data.pending_launch_config
    if (data.note !== undefined) runtimeUpdates.note = data.note
    if (data.model_provider_id !== undefined)
      runtimeUpdates.model_provider_id = data.model_provider_id
    if (data.model_id !== undefined) runtimeUpdates.model_id = data.model_id
    if (data.model_variant !== undefined) runtimeUpdates.model_variant = data.model_variant
    if (data.variant_group_id !== undefined)
      runtimeUpdates.variant_group_id = data.variant_group_id

    if (Object.keys(publicUpdates).length > 0 || body !== undefined) {
      let touchedPaths: string[]
      if (data.column !== undefined) {
        const project = requireProject(projectId)
        const config = parseMarkdownConfig(project)
        touchedPaths = await rewriteOrRelocateCard(
          project,
          config,
          card.filePath,
          publicUpdates,
          body
        )
      } else {
        touchedPaths = [await rewriteCard(card.filePath, publicUpdates, body)]
      }
      suppressMarkdownWrites(projectId, touchedPaths)
    }
    if (Object.keys(runtimeUpdates).length > 0) {
      await this.writeRuntime(projectId, ticketId, runtimeUpdates, false)
    }
    this.invalidate(projectId)
    return this.get(projectId, ticketId)
  }

  async move(
    projectId: string,
    ticketId: string,
    column: KanbanTicketColumn,
    sortOrder: number
  ): Promise<KanbanTicket | null> {
    const card = await this.requireMutableCard(projectId, ticketId)
    const project = requireProject(projectId)
    const config = parseMarkdownConfig(project)
    const touchedPaths = await rewriteOrRelocateCard(project, config, card.filePath, {
      column,
      sort_order: sortOrder
    })
    suppressMarkdownWrites(projectId, touchedPaths)
    this.invalidate(projectId)
    return this.get(projectId, ticketId)
  }

  async reorder(projectId: string, ticketId: string, sortOrder: number): Promise<void> {
    await this.update(projectId, ticketId, { sort_order: sortOrder })
  }

  async delete(projectId: string, ticketId: string): Promise<boolean> {
    const card = await this.requireMutableCard(projectId, ticketId)
    await this.removeAllDependencies(projectId, ticketId)
    await unlink(card.filePath)
    suppressMarkdownWrites(projectId, card.filePath)
    this.deleteRuntime(projectId, ticketId)
    this.invalidate(projectId)
    return true
  }

  async archive(projectId: string, ticketId: string): Promise<KanbanTicket | null> {
    await this.update(projectId, ticketId, {
      archived_at: new Date().toISOString()
    } as KanbanTicketUpdate)
    await this.removeAllDependencies(projectId, ticketId)
    return this.get(projectId, ticketId)
  }

  async archiveAllDone(projectId: string): Promise<number> {
    const index = await this.reloadIndex(projectId)
    const archivedIds = new Set(
      index.tickets
        .filter((ticket) => ticket.column === 'done' && !ticket.archived_at)
        .map((ticket) => ticket.id)
    )
    if (archivedIds.size === 0) return 0

    const archivedAt = new Date().toISOString()
    const touchedPaths: string[] = []
    for (const ticket of index.tickets) {
      const card = index.cardsById.get(ticket.id)
      if (!card) continue
      const deps = readDependencies(card.frontmatter, ticket.created_at)
      const archiveCard = archivedIds.has(ticket.id)
      const next = archiveCard ? [] : deps.filter((dep) => !archivedIds.has(dep.blocker_id))
      if (!archiveCard && next.length === deps.length) continue
      touchedPaths.push(
        await rewriteCard(
          card.filePath,
          {
            ...(archiveCard ? { archived_at: archivedAt } : {}),
            dependencies: next.map((dep) => ({
              blocker_id: dep.blocker_id,
              created_at: dep.created_at
            }))
          },
          undefined,
          ['depends_on']
        )
      )
    }
    suppressMarkdownWrites(projectId, touchedPaths)
    this.invalidate(projectId)
    return archivedIds.size
  }

  async unarchive(projectId: string, ticketId: string): Promise<KanbanTicket | null> {
    const card = await this.requireMutableCard(projectId, ticketId)
    const touchedPath = await rewriteCard(card.filePath, { archived_at: null })
    suppressMarkdownWrites(projectId, touchedPath)
    this.invalidate(projectId)
    return this.get(projectId, ticketId)
  }

  async getBySession(sessionId: string): Promise<KanbanTicket[]> {
    const rows = getDatabase()
      .getRawDb()
      .prepare(
        'SELECT project_id, card_id FROM markdown_kanban_card_state WHERE current_session_id = ? ORDER BY updated_at ASC'
      )
      .all(sessionId) as Array<{ project_id: string; card_id: string }>
    const tickets: KanbanTicket[] = []
    for (const row of rows) {
      const ticket = await this.get(row.project_id, row.card_id)
      if (ticket) tickets.push(ticket)
    }
    return tickets
  }

  async addTokens(
    projectId: string,
    ticketId: string,
    tokens: number
  ): Promise<KanbanTicket | null> {
    await this.requireMutableCard(projectId, ticketId)
    const db = getDatabase().getRawDb()
    this.ensureRuntime(projectId, ticketId)
    db.prepare(
      'UPDATE markdown_kanban_card_state SET total_tokens = total_tokens + ?, updated_at = ? WHERE project_id = ? AND card_id = ?'
    ).run(tokens, new Date().toISOString(), projectId, ticketId)
    this.invalidate(projectId)
    return this.get(projectId, ticketId)
  }

  async detachWorktree(worktreeId: string): Promise<number> {
    const db = getDatabase().getRawDb()
    const affectedProjects = db
      .prepare('SELECT DISTINCT project_id FROM markdown_kanban_card_state WHERE worktree_id = ?')
      .all(worktreeId) as Array<{ project_id: string }>
    const result = db
      .prepare(
        'UPDATE markdown_kanban_card_state SET worktree_id = NULL, updated_at = ? WHERE worktree_id = ?'
      )
      .run(new Date().toISOString(), worktreeId)
    for (const row of affectedProjects) {
      this.invalidate(row.project_id)
    }
    return result.changes
  }

  async syncPR(worktreeId: string, prNumber: number, prUrl: string): Promise<void> {
    const rows = getDatabase()
      .getRawDb()
      .prepare('SELECT project_id, card_id FROM markdown_kanban_card_state WHERE worktree_id = ?')
      .all(worktreeId) as Array<{ project_id: string; card_id: string }>
    for (const row of rows) {
      try {
        await this.update(row.project_id, row.card_id, {
          github_pr_number: prNumber,
          github_pr_url: prUrl
        })
      } catch (error) {
        if (isMissingMarkdownCardError(error)) continue
        throw error
      }
    }
  }

  async clearPR(worktreeId: string): Promise<void> {
    const rows = getDatabase()
      .getRawDb()
      .prepare('SELECT project_id, card_id FROM markdown_kanban_card_state WHERE worktree_id = ?')
      .all(worktreeId) as Array<{ project_id: string; card_id: string }>
    for (const row of rows) {
      try {
        await this.update(row.project_id, row.card_id, {
          github_pr_number: null,
          github_pr_url: null
        })
      } catch (error) {
        if (isMissingMarkdownCardError(error)) continue
        throw error
      }
    }
  }

  async attachPR(
    projectId: string,
    ticketId: string,
    prNumber: number,
    prUrl: string
  ): Promise<void> {
    await this.update(projectId, ticketId, { github_pr_number: prNumber, github_pr_url: prUrl })
  }

  async detachPR(projectId: string, ticketId: string): Promise<void> {
    await this.update(projectId, ticketId, { github_pr_number: null, github_pr_url: null })
  }

  async addDependency(
    projectId: string,
    dependentId: string,
    blockerId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (dependentId === blockerId)
      return { success: false, error: 'A ticket cannot depend on itself' }
    const index = await this.reloadIndex(projectId)
    let dependent: ParsedMarkdownCard
    let blocker: ParsedMarkdownCard
    try {
      dependent = this.requireMutableCardFromIndex(index, dependentId)
      blocker = this.requireMutableCardFromIndex(index, blockerId)
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
    const deps = this.getDependenciesFromIndex(index)
    if (wouldCreateDependencyCycle(deps, dependentId, blockerId)) {
      return { success: false, error: 'Adding this dependency would create a circular dependency' }
    }
    const current = readDependencies(dependent.frontmatter, dependent.ticket.created_at)
    if (!current.some((dep) => dep.blocker_id === blockerId)) {
      current.push({
        dependent_id: dependentId,
        blocker_id: blockerId,
        created_at: new Date().toISOString()
      })
      const touchedPath = await rewriteCard(
        dependent.filePath,
        {
          dependencies: current.map((dep) => ({
            blocker_id: dep.blocker_id,
            created_at: dep.created_at
          }))
        },
        undefined,
        ['depends_on']
      )
      suppressMarkdownWrites(projectId, touchedPath)
      this.invalidate(projectId)
    }
    return { success: true }
  }

  async removeDependency(
    projectId: string,
    dependentId: string,
    blockerId: string
  ): Promise<boolean> {
    const dependent = await this.requireMutableCard(projectId, dependentId)
    const current = readDependencies(dependent.frontmatter, dependent.ticket.created_at)
    const next = current.filter((dep) => dep.blocker_id !== blockerId)
    if (next.length === current.length) return false
    const touchedPath = await rewriteCard(
      dependent.filePath,
      {
        dependencies: next.map((dep) => ({
          blocker_id: dep.blocker_id,
          created_at: dep.created_at
        }))
      },
      undefined,
      ['depends_on']
    )
    suppressMarkdownWrites(projectId, touchedPath)
    this.invalidate(projectId)
    return true
  }

  async getBlockers(projectId: string, ticketId: string): Promise<KanbanTicket[]> {
    const index = await this.ensureIndex(projectId)
    const card = index.cardsById.get(ticketId)
    if (!card) return []
    return readDependencies(card.frontmatter, card.ticket.created_at)
      .map((dep) => index.cardsById.get(dep.blocker_id)?.ticket)
      .filter((ticket): ticket is KanbanTicket => !!ticket)
  }

  async getDependents(projectId: string, ticketId: string): Promise<KanbanTicket[]> {
    const index = await this.ensureIndex(projectId)
    return index.tickets.filter((ticket) => {
      const card = index.cardsById.get(ticket.id)
      return card
        ? readDependencies(card.frontmatter, ticket.created_at).some(
            (dep) => dep.blocker_id === ticketId
          )
        : false
    })
  }

  async getDependenciesForProject(projectId: string): Promise<TicketDependency[]> {
    const index = await this.ensureIndex(projectId)
    return this.getDependenciesFromIndex(index)
  }

  private getDependenciesFromIndex(index: MarkdownIndex): TicketDependency[] {
    return index.tickets.flatMap((ticket) => {
      const card = index.cardsById.get(ticket.id)
      return card ? readDependencies(card.frontmatter, ticket.created_at) : []
    })
  }

  private async removeSelectedDependencies(
    projectId: string,
    selectedIds: Set<string>
  ): Promise<number> {
    const index = await this.reloadIndex(projectId)
    let removed = 0
    const touchedPaths: string[] = []
    for (const ticketId of selectedIds) {
      const card = index.cardsById.get(ticketId)
      if (!card) continue
      const deps = readDependencies(card.frontmatter, card.ticket.created_at)
      const next = deps.filter((dep) => !selectedIds.has(dep.blocker_id))
      if (next.length === deps.length) continue
      removed += deps.length - next.length
      touchedPaths.push(
        await rewriteCard(
          card.filePath,
          {
            dependencies: next.map((dep) => ({
              blocker_id: dep.blocker_id,
              created_at: dep.created_at
            }))
          },
          undefined,
          ['depends_on']
        )
      )
    }
    suppressMarkdownWrites(projectId, touchedPaths)
    this.invalidate(projectId)
    return removed
  }

  async removeAllDependencies(projectId: string, ticketId: string): Promise<number> {
    const index = await this.reloadIndex(projectId)
    let removed = 0
    const touchedPaths: string[] = []
    for (const ticket of index.tickets) {
      const card = index.cardsById.get(ticket.id)
      if (!card) continue
      const deps = readDependencies(card.frontmatter, ticket.created_at)
      const next = deps.filter((dep) => dep.blocker_id !== ticketId)
      const removeDependent = ticket.id === ticketId
      if (removeDependent || next.length !== deps.length) {
        removed += removeDependent ? deps.length : deps.length - next.length
        touchedPaths.push(
          await rewriteCard(
            card.filePath,
            {
              dependencies: removeDependent
                ? []
                : next.map((dep) => ({ blocker_id: dep.blocker_id, created_at: dep.created_at }))
            },
            undefined,
            ['depends_on']
          )
        )
      }
    }
    suppressMarkdownWrites(projectId, touchedPaths)
    this.invalidate(projectId)
    return removed
  }

  async exportBoard(
    projectId: string
  ): Promise<{ tickets: KanbanTicket[]; dependencies: TicketDependency[] }> {
    return {
      tickets: await this.list(projectId, false),
      dependencies: await this.getDependenciesForProject(projectId)
    }
  }

  async importTickets(
    projectId: string,
    tickets: Array<{
      id: string
      title: string
      description?: string | null
      attachments?: unknown[] | null
      column?: string
    }>,
    dependencies?: Array<{ dependentId: string; blockerId: string }>
  ): Promise<{
    created: number
    updated: number
    dependencyCount: number
    ignoredDependencyCount: number
  }> {
    let created = 0
    let updated = 0
    let dependencyCount = 0
    let ignoredDependencyCount = 0
    for (const ticket of tickets) {
      assertNonEmptyString(ticket.id, 'Ticket id')
      assertNonEmptyString(ticket.title, 'Ticket title')
    }
    for (const dependency of dependencies ?? []) {
      assertNonEmptyString(dependency.dependentId, 'Dependency dependentId')
      assertNonEmptyString(dependency.blockerId, 'Dependency blockerId')
    }
    const selectedIds = new Set(tickets.map((ticket) => ticket.id))
    const index = await this.reloadIndex(projectId)
    const duplicateId = [...selectedIds].find(
      (ticketId) => (index.pathsById.get(ticketId) ?? []).length > 1
    )
    if (duplicateId) {
      throw new Error(
        `Cannot import ticket "${duplicateId}" because that markdown card id is duplicated. Resolve duplicate markdown IDs before importing.`
      )
    }

    for (const ticket of tickets) {
      const existing = await this.get(projectId, ticket.id)
      if (existing) {
        await this.update(projectId, ticket.id, {
          title: ticket.title,
          description: ticket.description ?? null,
          attachments: ticket.attachments ?? [],
          column: asColumn(ticket.column) ?? 'todo'
        })
        updated++
      } else {
        await this.create(projectId, {
          id: ticket.id,
          project_id: projectId,
          title: ticket.title,
          description: ticket.description ?? null,
          attachments: ticket.attachments ?? [],
          column: asColumn(ticket.column) ?? 'todo'
        })
        created++
      }
    }

    await this.removeSelectedDependencies(projectId, selectedIds)

    for (const dependency of dependencies ?? []) {
      const dependentId = dependency.dependentId.trim()
      const blockerId = dependency.blockerId.trim()
      if (
        !dependentId ||
        !blockerId ||
        !selectedIds.has(dependentId) ||
        !selectedIds.has(blockerId)
      ) {
        ignoredDependencyCount++
        continue
      }
      const result = await this.addDependency(projectId, dependentId, blockerId)
      if (result.success) dependencyCount++
      else ignoredDependencyCount++
    }
    return { created, updated, dependencyCount, ignoredDependencyCount }
  }

  async convertMarkdownFileToCard(projectId: string, filePath: string): Promise<KanbanTicket> {
    if (getProjectStorageMode(projectId) !== 'markdown') {
      throw new Error('Project is not using Markdown Kanban storage.')
    }
    if (!isMarkdownCandidate(basename(filePath))) {
      throw new Error('File is not a Markdown Kanban candidate.')
    }

    const project = requireProject(projectId)
    const config = parseMarkdownConfig(project)
    const match = await this.requireConfiguredMarkdownFile(project, config, filePath)
    const canonicalFilePath = match.filePath
    const indexFilePath = match.indexFilePath
    const fileStat = await stat(canonicalFilePath)
    if (!fileStat.isFile()) throw new Error('Markdown Kanban candidate is not a file.')
    if (fileStat.size > CARD_FILE_SIZE_LIMIT_BYTES) {
      throw new Error('Markdown card exceeds 1 MB limit')
    }

    const raw = await readFile(canonicalFilePath, 'utf-8')
    const parsed = parseMarkdown(raw)
    const frontmatter = parsed.frontmatter
    const existingId = asString(frontmatter.id)
    const removeFields = blankConversionRemoveFields(frontmatter)
    const frontmatterForValidation = withoutBlankConversionFields(frontmatter)
    validateKnownFrontmatter(frontmatterForValidation, existingId)

    const title =
      asString(frontmatter.title) ??
      titleFromBody(parsed.body) ??
      basename(canonicalFilePath, extname(canonicalFilePath))
    const id = existingId ?? generateTicketId(title)
    const column = asColumn(frontmatter.column) ?? match.column ?? 'todo'
    const index = await this.reloadIndex(projectId)
    this.assertCardIdAvailableForFile(index, id, indexFilePath)

    const now = new Date().toISOString()
    const updates: Frontmatter = {}
    if (!existingId) updates.id = id
    if (!hasUsableStringFrontmatter(frontmatter, 'title')) updates.title = title
    if (!hasUsableStringFrontmatter(frontmatter, 'column')) updates.column = column
    if (!hasUsableNullableModeFrontmatter(frontmatter)) updates.mode = 'build'
    if (!hasOwnFrontmatter(frontmatter, 'archived_at')) updates.archived_at = null
    if (!hasUsableStringFrontmatter(frontmatter, 'created_at')) {
      updates.created_at = createdAtFromStat(fileStat, now)
    }
    if (!hasUsableNumberFrontmatter(frontmatter, 'sort_order')) {
      updates.sort_order = nextSortOrderFromIndex(index, column, id)
    }

    if (Object.keys(updates).length > 0 || removeFields.length > 0) {
      await rewriteCard(canonicalFilePath, updates, undefined, removeFields)
      suppressMarkdownWrites(projectId, canonicalFilePath)
      this.invalidate(projectId)
    }

    const ticket = await this.get(projectId, id)
    if (!ticket) throw new Error('Converted markdown ticket could not be loaded')
    return ticket
  }

  async hasAnyCardLikeFiles(projectId: string): Promise<boolean> {
    const project = requireProject(projectId)
    const config = parseMarkdownConfig(project)
    const folders = await configuredFolders(project, config, false)
    for (const folder of folders) {
      try {
        const entries = await readdir(folder, { withFileTypes: true })
        if (entries.some((entry) => entry.isFile() && isMarkdownCandidate(entry.name))) return true
      } catch {
        continue
      }
    }
    return false
  }

  async repairAdoptedCards(projectId: string): Promise<void> {
    const project = requireProject(projectId)
    const config = parseMarkdownConfig(project)
    const folders = await configuredFolders(project, config, false)
    const drafts: AdoptionRepairDraft[] = []
    const now = new Date().toISOString()

    for (const folder of folders) {
      let entries: Array<{ name: string; isFile(): boolean }>
      try {
        entries = await readdir(folder, { withFileTypes: true })
      } catch {
        continue
      }

      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (!entry.isFile() || !isMarkdownCandidate(entry.name)) continue
        const filePath = join(folder, entry.name)
        try {
          const fileStat = await stat(filePath)
          if (fileStat.size > CARD_FILE_SIZE_LIMIT_BYTES) continue

          const raw = await readFile(filePath, 'utf-8')
          const parsed = parseMarkdown(raw)
          const frontmatter = parsed.frontmatter
          const existingId = asString(frontmatter.id)
          validateKnownFrontmatter(frontmatter, existingId)

          const title =
            asString(frontmatter.title) ??
            titleFromBody(parsed.body) ??
            basename(filePath, extname(filePath))
          const id = existingId ?? generateTicketId(title)
          const column = asColumn(frontmatter.column) ?? 'todo'
          const existingSortOrder = asNumber(frontmatter.sort_order)
          const updates: Frontmatter = {}

          if (!existingId) updates.id = id
          if (!hasOwnFrontmatter(frontmatter, 'title')) updates.title = title
          if (!hasOwnFrontmatter(frontmatter, 'column')) updates.column = 'todo'
          if (!hasOwnFrontmatter(frontmatter, 'mode')) updates.mode = 'build'
          if (!hasOwnFrontmatter(frontmatter, 'archived_at')) updates.archived_at = null
          if (!hasOwnFrontmatter(frontmatter, 'created_at')) {
            updates.created_at = createdAtFromStat(fileStat, now)
          }

          drafts.push({
            filePath,
            id,
            column,
            existingSortOrder,
            needsSortOrder: !hasOwnFrontmatter(frontmatter, 'sort_order'),
            updates
          })
        } catch {
          continue
        }
      }
    }

    const pathsById = new Map<string, string[]>()
    for (const draft of drafts) {
      const paths = pathsById.get(draft.id) ?? []
      paths.push(draft.filePath)
      pathsById.set(draft.id, paths)
    }

    const safeDrafts = drafts.filter((draft) => (pathsById.get(draft.id) ?? []).length === 1)
    const maxSortByColumn = new Map<KanbanTicketColumn, number>()
    for (const draft of safeDrafts) {
      if (draft.existingSortOrder === null) continue
      const current = maxSortByColumn.get(draft.column) ?? -1
      maxSortByColumn.set(draft.column, Math.max(current, draft.existingSortOrder))
    }

    const touchedPaths: string[] = []
    for (const draft of safeDrafts) {
      if (draft.needsSortOrder) {
        const nextSortOrder = (maxSortByColumn.get(draft.column) ?? -1) + 1
        draft.updates.sort_order = nextSortOrder
        maxSortByColumn.set(draft.column, nextSortOrder)
      }
      if (Object.keys(draft.updates).length === 0) continue
      try {
        touchedPaths.push(await rewriteCard(draft.filePath, draft.updates))
      } catch {
        continue
      }
    }

    suppressMarkdownWrites(projectId, touchedPaths)
    this.invalidate(projectId)
  }

  private async ensureIndex(projectId: string): Promise<MarkdownIndex> {
    return this.indexes.get(projectId) ?? this.reloadIndex(projectId)
  }

  private async reloadIndex(projectId: string): Promise<MarkdownIndex> {
    const project = requireProject(projectId)
    const config = parseMarkdownConfig(project)
    const diagnostics: MarkdownCardDiagnostic[] = []
    const cards: ParsedMarkdownCard[] = []
    const folders = await configuredFolders(project, config, false)

    for (const folder of folders) {
      let entries: Array<{ name: string; isFile(): boolean }>
      try {
        entries = await readdir(folder, { withFileTypes: true })
      } catch (error) {
        diagnostics.push({
          projectId,
          ticketId: null,
          filePath: folder,
          kind: 'parse_error',
          message: `Cannot read markdown folder: ${errorMessage(error)}`,
          blocking: true
        })
        continue
      }

      for (const entry of entries) {
        if (!entry.isFile() || !isMarkdownCandidate(entry.name)) continue
        const filePath = join(folder, entry.name)
        try {
          const card = await this.parseCard(projectId, filePath)
          if (card) cards.push(card)
        } catch (error) {
          diagnostics.push({
            projectId,
            ticketId: error instanceof MarkdownCardError ? error.ticketId : null,
            filePath,
            kind: error instanceof MarkdownCardError ? error.kind : 'parse_error',
            message: errorMessage(error),
            blocking: true
          })
        }
      }
    }

    const pathsById = new Map<string, string[]>()
    for (const card of cards) {
      const paths = pathsById.get(card.ticket.id) ?? []
      paths.push(card.filePath)
      pathsById.set(card.ticket.id, paths)
    }

    const cardsById = new Map<string, ParsedMarkdownCard>()
    const blockedSeenIds = new Set<string>()
    const blockedSeenPaths = new Set<string>()
    const tickets: KanbanTicket[] = []
    for (const card of cards) {
      const paths = pathsById.get(card.ticket.id) ?? []
      if (paths.length > 1) {
        blockedSeenIds.add(card.ticket.id)
        diagnostics.push({
          projectId,
          ticketId: card.ticket.id,
          filePath: card.filePath,
          kind: 'duplicate_id',
          message: `Duplicate markdown card id "${card.ticket.id}"`,
          blocking: true
        })
        tickets.push(card.ticket)
      } else {
        const hydrated = this.hydrateRuntime(projectId, card)
        cardsById.set(card.ticket.id, hydrated)
        tickets.push(hydrated.ticket)
      }
    }

    for (const diagnostic of diagnostics) {
      if (diagnostic.ticketId) blockedSeenIds.add(diagnostic.ticketId)
      if (diagnostic.blocking && !diagnostic.ticketId) {
        blockedSeenPaths.add(diagnostic.filePath)
      }
    }

    this.cleanupRuntimeRows(projectId, cardsById, blockedSeenIds, blockedSeenPaths)
    const index: MarkdownIndex = {
      projectId,
      tickets,
      cardsById,
      pathsById,
      diagnostics,
      loadedAt: Date.now()
    }
    this.indexes.set(projectId, index)
    return index
  }

  private async parseCard(projectId: string, filePath: string): Promise<ParsedMarkdownCard | null> {
    const fileStat = await stat(filePath)
    if (fileStat.size > CARD_FILE_SIZE_LIMIT_BYTES) {
      throw new Error('Markdown card exceeds 1 MB limit')
    }

    const raw = await readFile(filePath, 'utf-8')
    const parsed = parseMarkdown(raw)
    const frontmatter = parsed.frontmatter
    const id = asString(frontmatter.id)
    validateKnownFrontmatter(frontmatter, id)
    if (!id) {
      throw new MarkdownCardError(
        'invalid_frontmatter',
        null,
        'Markdown card is missing required frontmatter field "id". Run adoption repair before using this card.'
      )
    }

    const title =
      asString(frontmatter.title) ??
      titleFromBody(parsed.body) ??
      basename(filePath, extname(filePath))
    const column = asColumn(frontmatter.column) ?? 'todo'
    const sortOrder = asNumber(frontmatter.sort_order) ?? 0
    const mode = hasOwnFrontmatter(frontmatter, 'mode') ? asMode(frontmatter.mode) : 'build'
    const createdAt = asString(frontmatter.created_at) ?? fileStat.birthtime.toISOString()
    const runtime = emptyRuntimeState()
    const updatedAt = laterIso(fileStat.mtime.toISOString(), createdAt)

    const ticket: KanbanTicket = {
      id,
      project_id: projectId,
      title,
      description: parsed.body || null,
      attachments: runtime.attachments,
      column,
      sort_order: sortOrder,
      current_session_id: runtime.current_session_id,
      worktree_id: runtime.worktree_id,
      mode,
      plan_ready: runtime.plan_ready,
      created_at: createdAt,
      updated_at: updatedAt,
      archived_at: nullableString(frontmatter.archived_at),
      external_provider: nullableString(frontmatter.external_provider),
      external_id: nullableString(frontmatter.external_id),
      external_url: nullableString(frontmatter.external_url),
      github_pr_number: asNumber(frontmatter.github_pr_number),
      github_pr_url: nullableString(frontmatter.github_pr_url),
      mark: asMark(frontmatter.mark),
      total_tokens: runtime.total_tokens,
      pending_launch_config: runtime.pending_launch_config,
      goal_mode: asBoolean(frontmatter.goal_mode) ?? false,
      goal_success_criteria: nullableString(frontmatter.goal_success_criteria),
      note: runtime.note,
      auto_approve_plan: runtime.auto_approve_plan,
      model_provider_id: runtime.model_provider_id,
      model_id: runtime.model_id,
      model_variant: runtime.model_variant,
      variant_group_id: runtime.variant_group_id
    }

    return { ticket, filePath, frontmatter }
  }

  private hydrateRuntime(projectId: string, card: ParsedMarkdownCard): ParsedMarkdownCard {
    const runtime = this.readRuntime(projectId, card.ticket.id)
    const ticket: KanbanTicket = {
      ...card.ticket,
      attachments: runtime.attachments,
      current_session_id: runtime.current_session_id,
      worktree_id: runtime.worktree_id,
      plan_ready: runtime.plan_ready,
      auto_approve_plan: runtime.auto_approve_plan,
      total_tokens: runtime.total_tokens,
      pending_launch_config: runtime.pending_launch_config,
      note: runtime.note,
      model_provider_id: runtime.model_provider_id,
      model_id: runtime.model_id,
      model_variant: runtime.model_variant,
      variant_group_id: runtime.variant_group_id,
      updated_at: laterIso(card.ticket.updated_at, runtime.updated_at ?? card.ticket.created_at)
    }
    this.markRuntimeSeen(projectId, card.ticket.id, card.filePath)
    return { ...card, ticket }
  }

  private async requireMutableCard(
    projectId: string,
    ticketId: string
  ): Promise<ParsedMarkdownCard> {
    const index = await this.reloadIndex(projectId)
    return this.requireMutableCardFromIndex(index, ticketId)
  }

  private requireMutableCardFromIndex(index: MarkdownIndex, ticketId: string): ParsedMarkdownCard {
    const duplicate = index.diagnostics.find(
      (d) => d.ticketId === ticketId && d.kind === 'duplicate_id'
    )
    if (duplicate) throw new Error(duplicate.message)
    const card = index.cardsById.get(ticketId)
    if (!card) throw new Error('Ticket does not exist')
    return card
  }

  private async assertCardIdAvailable(projectId: string, ticketId: string): Promise<void> {
    this.assertCardIdAvailableInIndex(await this.reloadIndex(projectId), ticketId)
  }

  private assertCardIdAvailableInIndex(index: MarkdownIndex, ticketId: string): void {
    if (index.cardsById.has(ticketId) || (index.pathsById.get(ticketId) ?? []).length > 0) {
      throw new Error(
        `Cannot create markdown ticket "${ticketId}" because that card id already exists.`
      )
    }
  }

  private assertCardIdAvailableForFile(
    index: MarkdownIndex,
    ticketId: string,
    filePath: string
  ): void {
    const paths = index.pathsById.get(ticketId) ?? []
    const diagnosticPaths = index.diagnostics
      .filter((diagnostic) => diagnostic.ticketId === ticketId && diagnostic.blocking)
      .map((diagnostic) => diagnostic.filePath)
    const conflictingPaths = [...paths, ...diagnosticPaths].filter((path) => path !== filePath)
    if (conflictingPaths.length > 0) {
      throw new Error(
        `Cannot convert markdown file because card id "${ticketId}" already exists.`
      )
    }
  }

  private async requireConfiguredMarkdownFile(
    project: Project,
    config: KanbanMarkdownConfig,
    filePath: string
  ): Promise<ConfiguredMarkdownFileMatch> {
    const canonicalFilePath = await realpath(filePath)
    const canonicalFileFolder = await realpath(dirname(canonicalFilePath))
    const folders =
      config.layout === 'single-folder'
        ? [{ folder: resolveProjectPath(project.path, config.singleFolder), column: null }]
        : (Object.entries(config.statusFolders) as Array<[KanbanTicketColumn, string]>).map(
            ([column, folder]) => ({
              folder: resolveProjectPath(project.path, folder),
              column
            })
          )
    for (const candidate of folders) {
      const canonicalFolder = await realpath(candidate.folder).catch(() => null)
      if (canonicalFolder === canonicalFileFolder) {
        return {
          filePath: canonicalFilePath,
          indexFilePath: join(candidate.folder, basename(filePath)),
          column: candidate.column
        }
      }
    }
    throw new Error('File is outside configured Markdown Kanban folders.')
  }

  private readRuntime(projectId: string, cardId: string): MarkdownRuntimeState {
    const row = getDatabase()
      .getRawDb()
      .prepare('SELECT * FROM markdown_kanban_card_state WHERE project_id = ? AND card_id = ?')
      .get(projectId, cardId) as
      | {
          current_session_id: string | null
          worktree_id: string | null
          note: string | null
          attachments: string | null
          plan_ready: number
          auto_approve_plan: number
          total_tokens: number
          pending_launch_config: string | null
          model_provider_id: string | null
          model_id: string | null
          model_variant: string | null
          variant_group_id: string | null
          updated_at: string | null
        }
      | undefined
    if (!row) {
      return emptyRuntimeState()
    }
    return {
      current_session_id: row.current_session_id,
      worktree_id: row.worktree_id,
      note: row.note,
      attachments: parseJsonArray(row.attachments),
      plan_ready: row.plan_ready === 1,
      auto_approve_plan: row.auto_approve_plan === 1,
      total_tokens: row.total_tokens ?? 0,
      pending_launch_config: row.pending_launch_config,
      model_provider_id: row.model_provider_id,
      model_id: row.model_id,
      model_variant: row.model_variant,
      variant_group_id: row.variant_group_id,
      updated_at: row.updated_at
    }
  }

  private ensureRuntime(projectId: string, cardId: string): void {
    const now = new Date().toISOString()
    getDatabase()
      .getRawDb()
      .prepare(
        `INSERT OR IGNORE INTO markdown_kanban_card_state
          (project_id, card_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(projectId, cardId, now, now)
  }

  private async writeRuntime(
    projectId: string,
    cardId: string,
    data: Partial<MarkdownRuntimeState>,
    preserveUpdatedAt: boolean
  ): Promise<void> {
    this.ensureRuntime(projectId, cardId)
    const updates: string[] = []
    const values: Array<string | number | null> = []
    if (data.current_session_id !== undefined) {
      updates.push('current_session_id = ?')
      values.push(data.current_session_id)
    }
    if (data.worktree_id !== undefined) {
      updates.push('worktree_id = ?')
      values.push(data.worktree_id)
    }
    if (data.note !== undefined) {
      updates.push('note = ?')
      values.push(data.note)
    }
    if (data.attachments !== undefined) {
      updates.push('attachments = ?')
      values.push(JSON.stringify(data.attachments))
    }
    if (data.plan_ready !== undefined) {
      updates.push('plan_ready = ?')
      values.push(data.plan_ready ? 1 : 0)
    }
    if (data.auto_approve_plan !== undefined) {
      updates.push('auto_approve_plan = ?')
      values.push(data.auto_approve_plan ? 1 : 0)
    }
    if (data.pending_launch_config !== undefined) {
      updates.push('pending_launch_config = ?')
      values.push(data.pending_launch_config)
    }
    if (data.model_provider_id !== undefined) {
      updates.push('model_provider_id = ?')
      values.push(data.model_provider_id)
    }
    if (data.model_id !== undefined) {
      updates.push('model_id = ?')
      values.push(data.model_id)
    }
    if (data.model_variant !== undefined) {
      updates.push('model_variant = ?')
      values.push(data.model_variant)
    }
    if (data.variant_group_id !== undefined) {
      updates.push('variant_group_id = ?')
      values.push(data.variant_group_id)
    }
    if (!preserveUpdatedAt) {
      updates.push('updated_at = ?')
      values.push(new Date().toISOString())
    }
    if (updates.length === 0) return
    values.push(projectId, cardId)
    getDatabase()
      .getRawDb()
      .prepare(
        `UPDATE markdown_kanban_card_state SET ${updates.join(', ')} WHERE project_id = ? AND card_id = ?`
      )
      .run(...values)
  }

  private markRuntimeSeen(projectId: string, cardId: string, filePath: string): void {
    this.ensureRuntime(projectId, cardId)
    getDatabase()
      .getRawDb()
      .prepare(
        'UPDATE markdown_kanban_card_state SET last_seen_path = ?, orphaned_at = NULL WHERE project_id = ? AND card_id = ?'
      )
      .run(filePath, projectId, cardId)
  }

  private cleanupRuntimeRows(
    projectId: string,
    cardsById: Map<string, ParsedMarkdownCard>,
    blockedSeenIds: Set<string> = new Set(),
    blockedSeenPaths: Set<string> = new Set()
  ): void {
    const db = getDatabase().getRawDb()
    const now = new Date().toISOString()
    const rows = db
      .prepare(
        'SELECT card_id, last_seen_path, orphaned_at FROM markdown_kanban_card_state WHERE project_id = ?'
      )
      .all(projectId) as MarkdownRuntimeCleanupRow[]
    for (const row of rows) {
      if (cardsById.has(row.card_id)) continue
      if (blockedSeenIds.has(row.card_id)) continue
      if (row.last_seen_path && blockedSeenPaths.has(row.last_seen_path)) continue
      if (row.orphaned_at) {
        db.prepare(
          'DELETE FROM markdown_kanban_card_state WHERE project_id = ? AND card_id = ?'
        ).run(projectId, row.card_id)
      } else {
        db.prepare(
          'UPDATE markdown_kanban_card_state SET orphaned_at = ?, updated_at = ? WHERE project_id = ? AND card_id = ?'
        ).run(now, now, projectId, row.card_id)
      }
    }
  }

  private deleteRuntime(projectId: string, cardId: string): void {
    getDatabase()
      .getRawDb()
      .prepare('DELETE FROM markdown_kanban_card_state WHERE project_id = ? AND card_id = ?')
      .run(projectId, cardId)
  }

  private async nextSortOrder(projectId: string, column: KanbanTicketColumn): Promise<number> {
    const tickets = await this.list(projectId, false)
    const max = Math.max(
      -1,
      ...tickets.filter((ticket) => ticket.column === column).map((ticket) => ticket.sort_order)
    )
    return max + 1
  }
}

function isMissingMarkdownCardError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Ticket does not exist'
}

const internalBackend = new InternalKanbanBackend()
const markdownBackend = new MarkdownKanbanBackend()

export function getKanbanBackendForProject(projectId: string): KanbanBackend {
  return getProjectStorageMode(projectId) === 'markdown' ? markdownBackend : internalBackend
}

export function getMarkdownKanbanBackend(): MarkdownKanbanBackend {
  return markdownBackend
}

export async function moveKanbanTicketToProject(
  sourceProjectId: string,
  ticketId: string,
  targetProjectId: string
): Promise<KanbanTicket | null> {
  const sourceBackend = getKanbanBackendForProject(sourceProjectId)
  const sourceTicket = await sourceBackend.get(sourceProjectId, ticketId)
  if (!sourceTicket) return null
  requireProject(targetProjectId)
  if (sourceProjectId === targetProjectId) return sourceTicket

  const sourceMode = getProjectStorageMode(sourceProjectId)
  const targetMode = getProjectStorageMode(targetProjectId)

  if (sourceMode === 'internal' && targetMode === 'internal') {
    await internalBackend.removeAllDependencies(sourceProjectId, ticketId)
    const moved = getDatabase().moveKanbanTicketToProject(ticketId, targetProjectId)
    if (!moved) return null
    return internalBackend.update(targetProjectId, ticketId, {
      plan_ready: false,
      auto_approve_plan: false,
      pending_launch_config: null
    })
  }

  const targetBackend = getKanbanBackendForProject(targetProjectId)
  let created: KanbanTicket | null = null
  try {
    created = await targetBackend.create(targetProjectId, {
      id: sourceTicket.id,
      project_id: targetProjectId,
      title: sourceTicket.title,
      description: sourceTicket.description,
      attachments: sourceTicket.attachments,
      column: sourceTicket.column,
      mode: sourceTicket.mode,
      plan_ready: false,
      current_session_id: null,
      worktree_id: null,
      external_provider: sourceTicket.external_provider,
      external_id: sourceTicket.external_id,
      external_url: sourceTicket.external_url,
      github_pr_number: null,
      github_pr_url: null,
      mark: sourceTicket.mark
    })
    const updated =
      (await targetBackend.update(targetProjectId, ticketId, {
        archived_at: sourceTicket.archived_at,
        goal_mode: sourceTicket.goal_mode,
        goal_success_criteria: sourceTicket.goal_success_criteria,
        note: sourceTicket.note,
        // Badge/group metadata survives internal→internal moves untouched —
        // keep the cross-backend recreate path consistent.
        model_provider_id: sourceTicket.model_provider_id,
        model_id: sourceTicket.model_id,
        model_variant: sourceTicket.model_variant,
        variant_group_id: sourceTicket.variant_group_id,
        pending_launch_config: null
      })) ?? created

    const deleted = await sourceBackend.delete(sourceProjectId, ticketId)
    if (!deleted) {
      await targetBackend.delete(targetProjectId, ticketId).catch(() => {})
      throw new Error('Failed to delete source ticket after moving it to another project')
    }
    return updated
  } catch (error) {
    if (created) {
      await targetBackend.delete(targetProjectId, ticketId).catch(() => {})
    }
    throw error
  }
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

function formatInternalTicketModeBlockerError(tickets: KanbanTicket[]): string {
  const activeCount = tickets.filter((ticket) => !ticket.archived_at).length
  const archivedCount = tickets.length - activeCount
  const parts: string[] = []
  if (activeCount > 0) {
    parts.push(`${activeCount} active internal ${pluralize(activeCount, 'card')}`)
  }
  if (archivedCount > 0) {
    parts.push(`${archivedCount} archived internal ${pluralize(archivedCount, 'card')}`)
  }
  const archivedInstruction =
    archivedCount > 0
      ? ` To find archived cards, turn on the archive toggle in the Done column, unarchive them, then remove the remaining internal cards before switching storage.`
      : ` Remove the internal ${pluralize(activeCount, 'card')} before switching storage.`

  return `Markdown mode cannot be enabled because this project still has ${parts.join(
    ' and '
  )}.${archivedInstruction}`
}

export function getKanbanStorageConfig(projectId: string): KanbanStorageConfig {
  const project = requireProject(projectId)
  const parsed = parseMarkdownConfigResult(project)
  const markdown = parsed.config
  if (parsed.repaired) {
    getDatabase().updateProjectKanbanMarkdownConfig(projectId, JSON.stringify(markdown))
  }
  return {
    mode: getProjectStorageMode(projectId),
    markdown
  }
}

export async function updateKanbanMarkdownConfig(
  projectId: string,
  config: KanbanMarkdownConfig
): Promise<KanbanStorageConfig> {
  validateMarkdownConfigShape(config)
  const project = requireProject(projectId)
  const currentMode = getProjectStorageMode(projectId)
  if (currentMode === 'markdown') {
    await validateConfiguredFolders(project, config)
  }
  const previousConfig = parseMarkdownConfig(project)
  if (currentMode === 'markdown' && previousConfig.layout !== config.layout) {
    await migrateMarkdownLayout(projectId, project, previousConfig, config)
  }
  getDatabase().updateProjectKanbanMarkdownConfig(projectId, JSON.stringify(config))
  markdownBackend.invalidate(projectId)
  if (currentMode === 'markdown') {
    await restartMarkdownKanbanProjectWatch(projectId)
  }
  return getKanbanStorageConfig(projectId)
}

export async function setKanbanStorageMode(
  projectId: string,
  mode: KanbanStorageMode
): Promise<{ success: boolean; error?: string }> {
  const currentMode = getProjectStorageMode(projectId)
  if (currentMode === mode) return { success: true }
  const internalTickets = getDatabase().getKanbanTicketsByProject(projectId, true)
  if (internalTickets.length > 0) {
    return {
      success: false,
      error: formatInternalTicketModeBlockerError(internalTickets)
    }
  }
  if (currentMode === 'markdown' && (await markdownBackend.hasAnyCardLikeFiles(projectId))) {
    return {
      success: false,
      error:
        'Changing Kanban storage mode is only supported after clearing markdown card files from the current board folders.'
    }
  }
  if (currentMode === 'internal' && mode === 'markdown') {
    const project = requireProject(projectId)
    const config = parseMarkdownConfig(project)
    try {
      await validateConfiguredFolders(project, config)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    await markdownBackend.repairAdoptedCards(projectId)
  }
  getDatabase().updateProjectKanbanStorageMode(projectId, mode)
  markdownBackend.invalidate(projectId)
  if (mode === 'markdown') {
    await restartMarkdownKanbanProjectWatch(projectId)
    await markdownBackend.getDiagnostics(projectId)
  } else {
    await deactivateMarkdownKanbanProjectWatch(projectId)
  }
  return { success: true }
}

export async function createConfiguredMarkdownFolders(
  projectId: string,
  configOverride?: KanbanMarkdownConfig
): Promise<void> {
  const project = requireProject(projectId)
  const config = configOverride ?? parseMarkdownConfig(project)
  validateMarkdownConfigShape(config)
  await configuredFolders(project, config, true)
}

async function migrateMarkdownLayout(
  projectId: string,
  project: Project,
  previousConfig: KanbanMarkdownConfig,
  nextConfig: KanbanMarkdownConfig
): Promise<void> {
  const moves =
    previousConfig.layout === 'single-folder'
      ? await planSingleFolderToStatusFolders(project, previousConfig, nextConfig)
      : await planStatusFoldersToSingleFolder(project, previousConfig, nextConfig)

  await preflightMarkdownLayoutMoves(moves)
  const committedMoves: MarkdownLayoutMove[] = []
  try {
    for (const move of moves) {
      if (move.source === move.target) continue
      let copiedTarget: string | null = null
      try {
        await copyFile(move.source, move.target)
        copiedTarget = move.target
        suppressMarkdownWrites(projectId, move.target)
        await unlink(move.source)
        suppressMarkdownWrites(projectId, move.source)
        committedMoves.push(move)
        copiedTarget = null
      } catch (error) {
        if (copiedTarget) {
          await rm(copiedTarget, { force: true }).catch(() => {})
          suppressMarkdownWrites(projectId, copiedTarget)
        }
        throw error
      }
    }
  } catch (error) {
    const rollbackErrors = await rollbackMarkdownLayoutMoves(projectId, committedMoves)
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Cannot change Kanban folder layout because migration failed: ${errorMessage(error)}; rollback failed: ${rollbackErrors.map(errorMessage).join('; ')}`
      )
    }
    throw error
  }
}

async function rollbackMarkdownLayoutMoves(
  projectId: string,
  committedMoves: MarkdownLayoutMove[]
): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const move of [...committedMoves].reverse()) {
    try {
      await copyFile(move.target, move.source)
      suppressMarkdownWrites(projectId, [move.source, move.target])
      await unlink(move.target)
      suppressMarkdownWrites(projectId, move.target)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

async function planSingleFolderToStatusFolders(
  project: Project,
  previousConfig: KanbanMarkdownConfig,
  nextConfig: KanbanMarkdownConfig
): Promise<MarkdownLayoutMove[]> {
  if (previousConfig.layout !== 'single-folder' || nextConfig.layout !== 'status-folders') return []
  const sourceFolder = resolveProjectPath(project.path, previousConfig.singleFolder)
  const moves: MarkdownLayoutMove[] = []
  let entries: Array<{ name: string; isFile(): boolean }>
  try {
    entries = await readdir(sourceFolder, { withFileTypes: true })
  } catch {
    return moves
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isMarkdownCandidate(entry.name)) continue
    const source = join(sourceFolder, entry.name)
    try {
      const raw = await readFile(source, 'utf-8')
      const parsed = parseMarkdown(raw)
      const id = asString(parsed.frontmatter.id)
      validateKnownFrontmatter(parsed.frontmatter, id)
      const column = asColumn(parsed.frontmatter.column) ?? 'todo'
      const targetFolder = nextConfig.statusFolders[column] ?? nextConfig.statusFolders.done
      moves.push({
        source,
        target: join(resolveProjectPath(project.path, targetFolder), entry.name)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Cannot change Kanban folder layout because "${source}" is not a valid markdown Kanban card: ${message}`
      )
    }
  }
  return moves
}

async function planStatusFoldersToSingleFolder(
  project: Project,
  previousConfig: KanbanMarkdownConfig,
  nextConfig: KanbanMarkdownConfig
): Promise<MarkdownLayoutMove[]> {
  if (previousConfig.layout !== 'status-folders' || nextConfig.layout !== 'single-folder') return []
  const sourceFolders = await configuredFolders(project, previousConfig, false)
  const targetFolder = resolveProjectPath(project.path, nextConfig.singleFolder)
  const moves: MarkdownLayoutMove[] = []

  for (const sourceFolder of sourceFolders) {
    let entries: Array<{ name: string; isFile(): boolean }>
    try {
      entries = await readdir(sourceFolder, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isMarkdownCandidate(entry.name)) continue
      moves.push({
        source: join(sourceFolder, entry.name),
        target: join(targetFolder, entry.name)
      })
    }
  }
  return moves
}

async function preflightMarkdownLayoutMoves(moves: MarkdownLayoutMove[]): Promise<void> {
  const targets = new Map<string, string>()
  for (const move of moves) {
    const previousSource = targets.get(move.target)
    if (previousSource && previousSource !== move.source) {
      throw new Error(
        `Cannot change Kanban folder layout because multiple cards would move to "${move.target}"`
      )
    }
    targets.set(move.target, move.source)
  }

  for (const move of moves) {
    if (move.source === move.target) continue
    try {
      await stat(move.target)
      throw new Error(`Cannot change Kanban folder layout because "${move.target}" already exists`)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOENT') continue
      throw error
    }
  }
}

export async function getAllKanbanTicketsBySession(sessionId: string): Promise<KanbanTicket[]> {
  return [
    ...(await internalBackend.getBySession(sessionId)),
    ...(await markdownBackend.getBySession(sessionId))
  ]
}

export async function detachWorktreeFromAllKanbanBackends(worktreeId: string): Promise<number> {
  return (
    (await internalBackend.detachWorktree(worktreeId)) +
    (await markdownBackend.detachWorktree(worktreeId))
  )
}

export async function syncPRToAllKanbanBackends(
  worktreeId: string,
  prNumber: number,
  prUrl: string
): Promise<void> {
  await internalBackend.syncPR(worktreeId, prNumber, prUrl)
  await markdownBackend.syncPR(worktreeId, prNumber, prUrl)
}

export async function clearPRFromAllKanbanBackends(worktreeId: string): Promise<void> {
  await internalBackend.clearPR(worktreeId)
  await markdownBackend.clearPR(worktreeId)
}

function requireProject(projectId: string): Project {
  const project = getDatabase().getProject(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)
  return project
}

function getProjectStorageMode(projectId: string): KanbanStorageMode {
  const project = requireProject(projectId)
  return project.kanban_storage_mode === 'markdown' ? 'markdown' : 'internal'
}

function assertProjectPayload(projectId: string, payloadProjectId: string | undefined): void {
  if (payloadProjectId && payloadProjectId !== projectId) {
    throw new Error('Ticket project_id does not match the project routing key')
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

function hasOwnFrontmatter(frontmatter: Frontmatter, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(frontmatter, field)
}

function withoutBlankConversionFields(frontmatter: Frontmatter): Frontmatter {
  const next = { ...frontmatter }
  for (const field of ['id', 'title', 'column', 'sort_order', 'created_at']) {
    if (isBlankFrontmatterValue(next[field])) delete next[field]
  }
  for (const field of blankConversionRemoveFields(frontmatter)) delete next[field]
  if (typeof next.mode === 'string' && next.mode.trim() === '') delete next.mode
  return next
}

function blankConversionRemoveFields(frontmatter: Frontmatter): string[] {
  return ['dependencies', 'depends_on'].filter((field) =>
    isBlankFrontmatterValue(frontmatter[field])
  )
}

function isBlankFrontmatterValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

function hasUsableStringFrontmatter(frontmatter: Frontmatter, field: string): boolean {
  return hasOwnFrontmatter(frontmatter, field) && !isBlankFrontmatterValue(frontmatter[field])
}

function hasUsableNumberFrontmatter(frontmatter: Frontmatter, field: string): boolean {
  return hasOwnFrontmatter(frontmatter, field) && asNumber(frontmatter[field]) !== null
}

function hasUsableNullableModeFrontmatter(frontmatter: Frontmatter): boolean {
  return (
    hasOwnFrontmatter(frontmatter, 'mode') &&
    (frontmatter.mode === null || asMode(frontmatter.mode) !== null)
  )
}

function createdAtFromStat(
  fileStat: { birthtime: Date; birthtimeMs: number },
  fallback: string
): string {
  return Number.isFinite(fileStat.birthtimeMs) && fileStat.birthtimeMs > 0
    ? fileStat.birthtime.toISOString()
    : fallback
}

function parseMarkdown(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: raw }
  const document = YAML.parseDocument(match[1])
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join('; '))
  }
  const data = document.toJSON()
  if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
    throw new Error('Markdown frontmatter must be a YAML object')
  }
  return { frontmatter: (data ?? {}) as Frontmatter, body: match[2] }
}

function validateKnownFrontmatter(frontmatter: Frontmatter, ticketId: string | null): void {
  const invalid = (field: string, expected: string): never => {
    throw new MarkdownCardError(
      'invalid_frontmatter',
      ticketId,
      `Invalid ${field}; expected ${expected}`
    )
  }
  if ('id' in frontmatter && !asString(frontmatter.id)) invalid('id', 'a non-empty string')
  if ('title' in frontmatter && !asString(frontmatter.title)) invalid('title', 'a non-empty string')
  if ('column' in frontmatter && !asColumn(frontmatter.column)) {
    invalid('column', 'todo, in_progress, review, merged, or done')
  }
  if ('mode' in frontmatter && frontmatter.mode !== null && !asMode(frontmatter.mode)) {
    invalid('mode', 'build, plan, super-plan, or null')
  }
  if ('sort_order' in frontmatter && asNumber(frontmatter.sort_order) === null) {
    invalid('sort_order', 'a finite number')
  }
  if ('created_at' in frontmatter && !asString(frontmatter.created_at)) {
    invalid('created_at', 'an ISO timestamp string')
  }
  if (
    'archived_at' in frontmatter &&
    frontmatter.archived_at !== null &&
    typeof frontmatter.archived_at !== 'string'
  ) {
    invalid('archived_at', 'a string or null')
  }
  for (const field of [
    'external_provider',
    'external_id',
    'external_url',
    'github_pr_url',
    'mark',
    'goal_success_criteria'
  ]) {
    const value = frontmatter[field]
    if (field in frontmatter && value !== null && typeof value !== 'string')
      invalid(field, 'a string or null')
  }
  if ('mark' in frontmatter && frontmatter.mark !== null && !asMark(frontmatter.mark)) {
    invalid('mark', 'common, rare, epic, legendary, or null')
  }
  if (
    'github_pr_number' in frontmatter &&
    frontmatter.github_pr_number !== null &&
    asNumber(frontmatter.github_pr_number) === null
  ) {
    invalid('github_pr_number', 'a finite number or null')
  }
  if (
    'goal_mode' in frontmatter &&
    frontmatter.goal_mode !== null &&
    asBoolean(frontmatter.goal_mode) === null
  ) {
    invalid('goal_mode', 'a boolean or null')
  }
  if ('dependencies' in frontmatter && !Array.isArray(frontmatter.dependencies)) {
    invalid('dependencies', 'an array')
  }
  if ('depends_on' in frontmatter && !Array.isArray(frontmatter.depends_on)) {
    invalid('depends_on', 'an array')
  }
}

async function rewriteCard(
  filePath: string,
  updates: Frontmatter,
  bodyOverride?: string,
  removeFields: string[] = []
): Promise<string> {
  const raw = await readFile(filePath, 'utf-8')
  const parsed = parseMarkdown(raw)
  const nextFrontmatter = mergeFrontmatter(parsed.frontmatter, updates, removeFields)
  const body = bodyOverride ?? parsed.body
  await writeMarkdownFile(filePath, nextFrontmatter, body)
  return filePath
}

async function rewriteOrRelocateCard(
  project: Project,
  config: KanbanMarkdownConfig,
  filePath: string,
  updates: Frontmatter,
  bodyOverride?: string,
  removeFields: string[] = []
): Promise<string[]> {
  const raw = await readFile(filePath, 'utf-8')
  const parsed = parseMarkdown(raw)
  const nextFrontmatter = mergeFrontmatter(parsed.frontmatter, updates, removeFields)
  const body = bodyOverride ?? parsed.body
  const column = asColumn(nextFrontmatter.column) ?? asColumn(parsed.frontmatter.column) ?? 'todo'

  if (config.layout !== 'status-folders') {
    await writeMarkdownFile(filePath, nextFrontmatter, body)
    return [filePath]
  }

  const folder = await ensureFolder(project, config, column)
  if (dirname(filePath) === folder) {
    await writeMarkdownFile(filePath, nextFrontmatter, body)
    return [filePath]
  }

  const target = await uniquePath(folder, basename(filePath))
  await writeMarkdownFile(target, nextFrontmatter, body)
  try {
    await unlink(filePath)
  } catch (error) {
    await rm(target, { force: true }).catch(() => {})
    throw error
  }
  return [target, filePath]
}

function suppressMarkdownWrites(projectId: string, paths: string | string[]): void {
  const pathList = Array.isArray(paths) ? paths : [paths]
  if (pathList.length === 0) return
  suppressMarkdownKanbanWatch(projectId, pathList)
}

function nextSortOrderFromIndex(
  index: MarkdownIndex,
  column: KanbanTicketColumn,
  excludeTicketId?: string
): number {
  const max = Math.max(
    -1,
    ...index.tickets
      .filter((ticket) => ticket.column === column && ticket.id !== excludeTicketId)
      .map((ticket) => ticket.sort_order)
  )
  return max + 1
}

function mergeFrontmatter(
  frontmatter: Frontmatter,
  updates: Frontmatter,
  removeFields: string[] = []
): Frontmatter {
  const nextFrontmatter = { ...frontmatter }
  for (const key of removeFields) delete nextFrontmatter[key]
  for (const [key, value] of Object.entries(updates)) {
    if (!HIVE_FRONTMATTER_FIELDS.has(key)) continue
    if (value === undefined) continue
    nextFrontmatter[key] = value
  }
  return nextFrontmatter
}

async function writeMarkdownFile(
  filePath: string,
  frontmatter: Frontmatter,
  body: string
): Promise<void> {
  const yaml = YAML.stringify(frontmatter).trimEnd()
  const tmpPath = `${filePath}.tmp-${randomUUID()}`
  await writeFile(tmpPath, `---\n${yaml}\n---\n${body}`, 'utf-8')
  await rename(tmpPath, filePath)
}

function publicFieldsFromCreate(data: KanbanTicketCreate, now: string): Frontmatter {
  return {
    id: data.id,
    title: data.title,
    column: data.column ?? 'todo',
    mode: data.mode === undefined ? 'build' : data.mode,
    sort_order: data.sort_order ?? 0,
    archived_at: null,
    created_at: now,
    external_provider: data.external_provider ?? null,
    external_id: data.external_id ?? null,
    external_url: data.external_url ?? null,
    github_pr_number: data.github_pr_number ?? null,
    github_pr_url: data.github_pr_url ?? null,
    mark: data.mark ?? null
  }
}

function readDependencies(frontmatter: Frontmatter, fallbackCreatedAt: string): TicketDependency[] {
  const dependencies = frontmatter.dependencies
  if (Array.isArray(dependencies)) {
    return dependencies
      .map((dep) => {
        if (!dep || typeof dep !== 'object') return null
        const record = dep as Record<string, unknown>
        const blockerId = asString(record.blocker_id)
        if (!blockerId) return null
        return {
          dependent_id: asString(frontmatter.id) ?? '',
          blocker_id: blockerId,
          created_at: asString(record.created_at) ?? fallbackCreatedAt
        }
      })
      .filter((dep): dep is TicketDependency => !!dep && !!dep.dependent_id)
  }
  if (Array.isArray(frontmatter.depends_on)) {
    return frontmatter.depends_on
      .map((blockerId) =>
        typeof blockerId === 'string'
          ? {
              dependent_id: asString(frontmatter.id) ?? '',
              blocker_id: blockerId,
              created_at: fallbackCreatedAt
            }
          : null
      )
      .filter((dep): dep is TicketDependency => !!dep && !!dep.dependent_id)
  }
  return []
}

function wouldCreateDependencyCycle(
  deps: TicketDependency[],
  dependentId: string,
  blockerId: string
): boolean {
  const graph = new Map<string, string[]>()
  for (const dep of deps) {
    const blockers = graph.get(dep.dependent_id) ?? []
    blockers.push(dep.blocker_id)
    graph.set(dep.dependent_id, blockers)
  }
  const blockers = graph.get(dependentId) ?? []
  blockers.push(blockerId)
  graph.set(dependentId, blockers)

  const visit = (node: string, seen: Set<string>): boolean => {
    if (node === dependentId && seen.size > 0) return true
    if (seen.has(node)) return false
    seen.add(node)
    return (graph.get(node) ?? []).some((next) => visit(next, new Set(seen)))
  }

  return visit(blockerId, new Set())
}

function generateTicketId(seed: string): string {
  const suffix = randomBytes(3)
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 4)
  return `${slugify(seed) || 'ticket'}-${suffix || 'x0x'}`
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\u0020-\u007E]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

async function uniquePath(
  folder: string,
  fileName: string,
  reservedPaths: Set<string> = new Set()
): Promise<string> {
  const ext = extname(fileName)
  const base = basename(fileName, ext) || 'ticket'
  for (let index = 0; index < 1000; index++) {
    const suffix = index === 0 ? '' : `-${index + 1}`
    const candidate = join(folder, `${base}${suffix}${ext}`)
    if (reservedPaths.has(candidate)) continue
    try {
      await stat(candidate)
    } catch (error) {
      if (isMissingFileError(error)) return candidate
      throw error
    }
  }
  throw new Error('Unable to find an available markdown card filename')
}

function titleFromBody(body: string): string | null {
  const heading = body.match(/^#\s+(.+)$/m)
  return heading?.[1]?.trim() || null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asColumn(value: unknown): KanbanTicketColumn | null {
  return typeof value === 'string' && VALID_COLUMNS.has(value as KanbanTicketColumn)
    ? (value as KanbanTicketColumn)
    : null
}

function asMode(value: unknown): KanbanTicket['mode'] {
  return typeof value === 'string' && VALID_MODES.has(value)
    ? (value as KanbanTicket['mode'])
    : null
}

function asMark(value: unknown): KanbanTicket['mark'] {
  return typeof value === 'string' && VALID_MARKS.has(value)
    ? (value as KanbanTicket['mark'])
    : null
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function laterIso(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}

function ticketSort(a: KanbanTicket, b: KanbanTicket): number {
  if (a.column !== b.column) return a.column.localeCompare(b.column)
  return a.sort_order - b.sort_order
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
