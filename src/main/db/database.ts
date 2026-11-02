import { deleteAttachment } from '../services/attachment-storage'
import type { AgentSdk } from '@shared/types/agent-sdk'
import { parseProjectShellCommands } from '@shared/lib/shell-commands'
import { emitDbChanged, withDbChangeBatch } from '../services/db-change-events'
import {
  SAVED_TICKET_LABELS_MAX,
  applySavedTicketLabelChange,
  isTicketLabelColor,
  normalizeTicketLabelName,
  parseTicketLabels,
  ticketLabelNameKey
} from '@shared/lib/ticket-labels'
import type { SessionProfilerTicket } from '@shared/types/session-profiler'
import { formatTicketKey, TICKET_KEY_PREFIX_SETTING } from '@shared/ticket-key'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  SESSION_TURN_STATES,
  normalizeVerificationMethods
} from '@shared/types/document-flow'
import type {
  DocumentRun,
  DocumentRunConfig,
  DocumentRunEvent,
  DocumentRunItem,
  SessionFinalMessage,
  SessionTurnState
} from '@shared/types/document-flow'
import type {
  DocumentFlowDb,
  DocumentRunCreate,
  DocumentRunEventCreate,
  DocumentRunItemCreate,
  DocumentRunItemRowPatch,
  DocumentRunnerClaimResult,
  DocumentRunRowPatch,
  SessionFinalMessageUpsert
} from '../services/document-flow/db-port'
import type {
  DataProjectRecord,
  DataProjectRecordCreate,
  DataProjectRecordPatch,
  DataProjectsRepository
} from '../services/data-projects/contracts'
import {
  DATA_ENVIRONMENTS,
  DATA_SAFE_MODES,
  DEFAULT_DATA_ROW_LIMIT,
  isDataEngine,
  type DataEnvironment,
  type DataHistoryEntry,
  type DataProjectIcon,
  type DataSafeMode,
  type DataSavedQuery,
  type DataSecretState,
  type SidebarOrderEntry
} from '@shared/data-projects/types'
import Database from 'better-sqlite3'
import { instrumentDatabase } from '../services/perf-logging/db-instrumentation'

/**
 * Every ticket read joins the parent orchestrator ticket for its key (`parent_ticket_key`);
 * the alias is `kt`, so WHERE clauses must qualify their columns.
 */
const KANBAN_TICKET_SELECT = `SELECT kt.*, p.ticket_prefix AS parent_ticket_prefix, p.ticket_number AS parent_ticket_number
  FROM kanban_tickets kt
  LEFT JOIN kanban_tickets p ON p.id = kt.parent_ticket_id`
/** The one row of `ticket_counters` behind the machine-wide ticket sequence. */
const TICKET_COUNTER_SCOPE = 'kanban_tickets'
import { perfLog } from '../services/perf-logging/perf-logger'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, statSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { Worker as NodeWorker } from 'node:worker_threads'
import {
  DATA_PROJECT_TABLES_SQL,
  DOCUMENT_FLOW_TABLES_SQL,
  MIGRATIONS,
  TICKET_LABELS_TABLES_SQL,
  VOICE_HISTORY_TABLES_SQL
} from './schema'
import type {
  Project,
  ProjectCreate,
  ProjectUpdate,
  Worktree,
  WorktreeCreate,
  WorktreeUpdate,
  DiscordResource,
  DiscordResourceCreate,
  Session,
  SessionCreate,
  SessionUpdate,
  SessionMessage,
  SessionMessageCreate,
  SessionMessageUpdate,
  SessionMessageUpsertByOpenCode,
  SessionActivity,
  SessionActivityCreate,
  StorageStats,
  CompactionPreview,
  CompactionResult,
  Setting,
  SessionSearchOptions,
  SessionWithWorktree,
  Space,
  SpaceCreate,
  SpaceUpdate,
  ProjectSpaceAssignment,
  Connection,
  ConnectionCreate,
  ConnectionMember,
  ConnectionMemberCreate,
  ConnectionWithMembers,
  ConnectionHistoryEntry,
  FavoriteTicket,
  FavoriteTicketCreate,
  FavoriteTicketUpdate,
  SavedTicketLabel,
  SavedTicketLabelChange,
  SavedTicketLabelCreate,
  SavedTicketLabelMutationResult,
  SavedTicketLabelUpdate,
  TicketLabelColor,
  KanbanTicket,
  KanbanTicketCreate,
  KanbanTicketBatchCreate,
  KanbanTicketBatchCreateItem,
  KanbanTicketBatchCreateResult,
  KanbanTicketUpdate,
  KanbanTicketColumn,
  KanbanStorageMode,
  TicketMark,
  TicketFollowupMessage,
  TicketFollowupMessageCreate,
  TicketDependency,
  DiffComment,
  DiffCommentCreate,
  DiffCommentUpdate,
  SavedUsageAccount,
  SavedUsageAccountUpsert,
  SavedUsageAccountUsageUpdate,
  SavedUsageProvider,
  VoiceHistoryRow,
  VoiceHistoryRowCreate
} from './types'

/** Escape `%`, `_` and `\` for a LIKE pattern used with `ESCAPE '\'`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * LIKE pattern (with `ESCAPE '\'`) that pre-selects the tickets whose labels JSON mentions a
 * label id: the id as JSON.stringify writes it, quotes included.
 */
function ticketLabelIdPattern(id: string): string {
  return `%${escapeLike(JSON.stringify(id))}%`
}

/** A palette colour as is; anything else (never expected past the RPC schemas) as gray. */
function ticketLabelColorOrGray(color: string): TicketLabelColor {
  return isTicketLabelColor(color) ? color : 'gray'
}

// Every other Hive process runs the server bundle as plain node
// (ELECTRON_RUN_AS_NODE=1), so this is only true in the desktop main process.
const isDesktopMainProcess = (): boolean =>
  process.versions.electron !== undefined && process.env.ELECTRON_RUN_AS_NODE !== '1'

export function resolveDatabasePath(options?: {
  readonly explicitPath?: string
  readonly desktopBaseDir?: string
  readonly serverBaseDir?: string
  readonly homeDir?: string
}): string {
  // Explicit full-path override (HIVE_SERVER_DB_PATH) wins over base-dir
  // resolution. The desktop backend sets this to ~/.hive/hive.db so it reads
  // the existing desktop database (preserving the user's projects/sessions on
  // update) rather than the server-mode userdata/state.sqlite.
  const explicitPath = options?.explicitPath ?? process.env.HIVE_SERVER_DB_PATH
  if (explicitPath) {
    return explicitPath
  }

  const serverBaseDir = options?.serverBaseDir ?? process.env.HIVE_SERVER_BASE_DIR
  if (serverBaseDir) {
    return join(serverBaseDir, 'userdata', 'state.sqlite')
  }

  // Dev/E2E data dir for the desktop app. The backend child gets it as an
  // explicit HIVE_SERVER_DB_PATH, so main must derive the same path or the two
  // halves of one app open different databases. Read from the environment in the
  // desktop main process only: a server process can inherit the variable from
  // the shell that started it, and its state belongs under its own base dir.
  const desktopBaseDir =
    options?.desktopBaseDir ??
    (isDesktopMainProcess() ? process.env.HIVE_DESKTOP_BASE_DIR : undefined)
  if (desktopBaseDir) {
    return join(desktopBaseDir, 'hive.db')
  }

  const homeDir = options?.homeDir ?? homedir()
  return join(homeDir, '.hive', 'hive.db')
}

/** A `data_projects` row as stored (JSON TEXT and 0/1 columns), before mapping. */
interface DataProjectRow {
  id: string
  name: string
  engine: string
  config: string | null
  icon: string | null
  icon_color: string | null
  environment: string
  color: string | null
  safe_mode: string
  default_limit: number
  allow_ai_data_access: number
  pinned: number
  secret_ciphertext: string | null
  secret_state: string
  sort_order: number
  created_at: string
  last_accessed_at: string
}

interface DataQueryHistoryRow {
  id: string
  data_project_id: string
  database_name: string | null
  text: string
  status: string
  duration_ms: number | null
  row_count: number | null
  error: string | null
  executed_at: string
}

interface DataSavedQueryRow {
  id: string
  data_project_id: string
  name: string
  text: string
  database_name: string | null
  created_at: string
  updated_at: string
}

/** History keeps the newest N statements per data project (pruned on insert). */
export const DATA_QUERY_HISTORY_LIMIT = 1000
/**
 * Stored history text / error caps: a pasted multi-megabyte dump must not turn the 1000-row
 * history into gigabytes of app database. The cut is marked so "open from history" is honest.
 */
const DATA_HISTORY_TEXT_MAX = 100_000
const DATA_HISTORY_ERROR_MAX = 4_000
const DATA_HISTORY_STATUSES: ReadonlySet<string> = new Set(['ok', 'error', 'cancelled', 'blocked'])
const DATA_ICON_KINDS: ReadonlySet<string> = new Set(['engine', 'emoji', 'lucide', 'image'])

const truncateStored = (text: string, max: number): string =>
  text.length > max
    ? `${text.slice(0, max)}\n-- [truncated: ${text.length - max} more characters]`
    : text

const parseJsonObject = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** A stored icon JSON, or null when it is missing or not one of the known shapes. */
const parseDataProjectIcon = (raw: string | null): DataProjectIcon | null => {
  const value = parseJsonObject(raw)
  if (!value || typeof value.kind !== 'string' || !DATA_ICON_KINDS.has(value.kind)) return null
  switch (value.kind) {
    case 'engine':
      return isDataEngine(value.engine) ? { kind: 'engine', engine: value.engine } : null
    case 'emoji':
      return typeof value.emoji === 'string' ? { kind: 'emoji', emoji: value.emoji } : null
    case 'lucide':
      return typeof value.name === 'string' ? { kind: 'lucide', name: value.name } : null
    default:
      return typeof value.fileName === 'string' ? { kind: 'image', fileName: value.fileName } : null
  }
}

/** Integer auto-limit ≥ 0 (0 = none); anything unusable falls back to the default. */
const normalizeDataLimit = (value: number): number =>
  Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_DATA_ROW_LIMIT

type ProjectRow = Omit<
  Project,
  'auto_assign_port' | 'custom_commands' | 'shell_commands' | 'trust_check_done'
> & {
  auto_assign_port: number | boolean
  custom_commands: string | null
  shell_commands: string | null
  trust_check_done?: number | boolean
}

type CompactionWorkerSuccess = CompactionResult & { ok: true }
type CompactionWorkerFailure = {
  ok: false
  message: string
  stack?: string
}
type CompactionWorkerMessage = CompactionWorkerSuccess | CompactionWorkerFailure

const DATABASE_COMPACTION_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { copyFileSync, existsSync, renameSync, rmSync, statSync } = require('node:fs')
const Database = require('better-sqlite3')

const fileSize = (filePath) => (existsSync(filePath) ? statSync(filePath).size : 0)
const cleanupTemp = (basePath) => {
  rmSync(basePath, { force: true })
  rmSync(basePath + '-wal', { force: true })
  rmSync(basePath + '-shm', { force: true })
}

let db
try {
  const { dbPath, beforeBytes, tempPath } = workerData
  cleanupTemp(tempPath)
  copyFileSync(dbPath, tempPath)

  db = new Database(tempPath)
  db.pragma('journal_mode = DELETE')
  db.pragma('foreign_keys = ON')

  const prune = db.transaction(() => {
    const orphanedMessages = db
      .prepare('DELETE FROM session_messages WHERE session_id NOT IN (SELECT id FROM sessions)')
      .run().changes
    const orphanedActivities = db
      .prepare('DELETE FROM session_activities WHERE session_id NOT IN (SELECT id FROM sessions)')
      .run().changes
    // No foreign key: the worktree and project cascades leave these behind.
    db.prepare(
      'DELETE FROM session_final_messages WHERE session_id NOT IN (SELECT id FROM sessions)'
    ).run()

    return {
      orphanedMessages,
      orphanedActivities
    }
  })
  const deletedCounts = prune()

  db.exec('VACUUM')
  db.close()
  db = undefined

  rmSync(dbPath + '-wal', { force: true })
  rmSync(dbPath + '-shm', { force: true })
  renameSync(tempPath, dbPath)
  cleanupTemp(tempPath)

  const afterBytes = fileSize(dbPath) + fileSize(dbPath + '-wal')
  parentPort.postMessage({
    ok: true,
    beforeBytes,
    afterBytes,
    savedBytes: Math.max(0, beforeBytes - afterBytes),
    deletedCounts
  })
} catch (error) {
  if (db) {
    try {
      db.close()
    } catch {
      // Ignore cleanup failure while reporting the original compaction error.
    }
  }
  cleanupTemp(workerData.tempPath)
  parentPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  })
}
`

const runCompactionWorker = (dbPath: string, beforeBytes: number): Promise<CompactionResult> => {
  const tempPath = `${dbPath}.compact-${process.pid}-${Date.now()}-${randomUUID()}.tmp`

  return new Promise((resolve, reject) => {
    const worker = new NodeWorker(DATABASE_COMPACTION_WORKER, {
      eval: true,
      workerData: { dbPath, beforeBytes, tempPath }
    })
    let settled = false

    worker.once('message', (message: CompactionWorkerMessage) => {
      settled = true
      if (message.ok) {
        resolve({
          beforeBytes: message.beforeBytes,
          afterBytes: message.afterBytes,
          savedBytes: message.savedBytes,
          deletedCounts: message.deletedCounts
        })
      } else {
        const error = new Error(message.message)
        if (message.stack) error.stack = message.stack
        reject(error)
      }
    })

    worker.once('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })

    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true
        reject(new Error(`Database compaction worker exited with code ${code}`))
      }
    })
  })
}

/** How a patchable document-flow column is written: as given, JSON-stringified, or as 0/1. */
type DocumentFlowColumnKind = 'plain' | 'json' | 'flag'

// Keyed by the patch types, so a field added to one of them does not compile until it has a
// column here — a patch key the UPDATE silently dropped would look like a lost write.
const DOCUMENT_RUN_PATCH_COLUMNS: Record<keyof DocumentRunRowPatch, DocumentFlowColumnKind> = {
  title: 'plain',
  document_path: 'plain',
  status: 'plain',
  error: 'plain',
  config: 'json',
  extraction: 'json',
  base_branch: 'plain',
  base_sha: 'plain',
  integration_branch: 'plain',
  integration_worktree_id: 'plain',
  integration_worktree_path: 'plain',
  integration_connection_id: 'plain',
  integration_connection_path: 'plain',
  members: 'json',
  ticket_id: 'plain',
  report: 'json',
  migration_session_id: 'plain',
  migration_started_at: 'plain',
  migration_owner_pid: 'plain',
  started_at: 'plain',
  finished_at: 'plain'
}

const DOCUMENT_RUN_ITEM_PATCH_COLUMNS: Record<
  keyof DocumentRunItemRowPatch,
  DocumentFlowColumnKind
> = {
  title: 'plain',
  summary: 'plain',
  description: 'plain',
  depends_on: 'json',
  selected: 'flag',
  verification: 'json',
  launch_config: 'json',
  status: 'plain',
  status_detail: 'plain',
  ticket_id: 'plain',
  worktree_id: 'plain',
  connection_id: 'plain',
  members: 'json',
  session_id: 'plain',
  fix_ticket_id: 'plain',
  fix_session_id: 'plain',
  branch_name: 'plain',
  verdict: 'json',
  nudge_count: 'plain',
  conflict_attempts: 'plain',
  conflict_head: 'plain',
  fix_attempts: 'plain',
  continue_attempts: 'plain',
  pre_merge_sha: 'plain',
  merge_sha: 'plain',
  last_prompt_at: 'plain',
  last_checked_at: 'plain',
  retry_at: 'plain',
  wait_until: 'plain',
  wait_timeouts: 'plain',
  document_update_status: 'plain',
  document_update_detail: 'plain',
  document_update_queued_at: 'plain',
  document_update_attempts: 'plain',
  document_update_hash: 'plain',
  document_update_report: 'json',
  document_update_finished_at: 'plain',
  started_at: 'plain',
  finished_at: 'plain'
}

/** One session's DB context for the session profiler (see getSessionProfilerRows). */
export interface SessionProfilerDbRow {
  id: string
  /** False when no `sessions` row has this id (deleted, or the DB was reset). */
  sessionExists: boolean
  name: string | null
  status: string | null
  agentSdk: string | null
  /** Worktree name, or the connection name for connection sessions. */
  worktreeName: string | null
  /** Worktree path, or the connection path for connection sessions. */
  worktreePath: string | null
  worktreeArchived: boolean
  projectName: string | null
  ticket: SessionProfilerTicket | null
  /** A running / paused document run still needs this session (turn or document update ahead). */
  documentRunBusy: boolean
}

// `implements DocumentFlowDb` is the compile-time check that the document-flow section below
// still matches the port its service and tests are written against (services/document-flow).
export class DatabaseService implements DocumentFlowDb, DataProjectsRepository {
  private db: Database.Database | null = null
  private dbPath: string
  private compactionInProgress = false
  private maintenanceMode = false

  constructor(dbPath?: string) {
    if (dbPath) {
      this.dbPath = dbPath
    } else {
      this.dbPath = resolveDatabasePath()
      const dbDir = dirname(this.dbPath)
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true })
      }
    }
  }

  getDbPath(): string {
    return this.dbPath
  }

  init(): void {
    if (this.db) return

    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    instrumentDatabase(this.db)
    perfLog.registerGauge('db.walBytes', () => {
      try {
        return existsSync(`${this.dbPath}-wal`) ? statSync(`${this.dbPath}-wal`).size : 0
      } catch {
        return -1
      }
    })

    this.runMigrations()
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  private getDb(): Database.Database {
    if (this.maintenanceMode) {
      throw new Error('Database compaction is in progress. Try again after it finishes.')
    }
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.')
    }
    return this.db
  }

  /**
   * Public accessor for the raw better-sqlite3 handle. Used by the Effect DB
   * island (`src/main/effect/db`) which prepares its own statements. Callers
   * outside the Effect island should keep using the typed methods on
   * DatabaseService rather than reaching for this.
   */
  getRawDb(): Database.Database {
    return this.getDb()
  }

  // Maps SQLite INTEGER 0/1 to boolean for worktree rows
  private mapWorktreeRow(row: Record<string, unknown>): Worktree {
    return {
      ...row,
      is_default: !!row.is_default,
      branch_renamed: (row.branch_renamed as number) ?? 0,
      last_message_at: (row.last_message_at as number) ?? null,
      session_titles: (row.session_titles as string) ?? '[]',
      last_model_provider_id: (row.last_model_provider_id as string) ?? null,
      last_model_id: (row.last_model_id as string) ?? null,
      last_model_variant: (row.last_model_variant as string) ?? null,
      attachments: (row.attachments as string) ?? '[]',
      pinned: (row.pinned as number) ?? 0,
      context: (row.context as string) ?? null,
      github_pr_number: (row.github_pr_number as number) ?? null,
      github_pr_url: (row.github_pr_url as string) ?? null,
      teleported_to: (row.teleported_to as string) ?? null,
      base_branch: (row.base_branch as string) ?? null
    } as Worktree
  }

  // Maps SQLite INTEGER 0/1 to boolean for session rows.
  // NOTE: If future boolean or JSON columns are added to sessions, they must be
  // explicitly mapped here (the spread passes raw SQLite values through).
  private mapSessionRow(row: Record<string, unknown>): Session {
    return {
      ...row,
      claude_session_id: (row.claude_session_id as string) ?? null,
      custom_provider_id: (row.custom_provider_id as string) ?? null,
      pinned_to_board: !!(row.pinned_to_board as number),
      session_type: (row.session_type as string) ?? 'default',
      shell_command: (row.shell_command as string) ?? null
    } as Session
  }

  private parseProjectCustomCommands(value: unknown): Project['custom_commands'] {
    if (typeof value !== 'string' || value.trim() === '') {
      return []
    }
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private mapProjectRow(row: ProjectRow): Project {
    return {
      ...row,
      auto_assign_port: Boolean(row.auto_assign_port),
      trust_check_done: Boolean(row.trust_check_done),
      custom_commands: this.parseProjectCustomCommands(row.custom_commands),
      shell_commands: parseProjectShellCommands(row.shell_commands)
    } as Project
  }

  // Maps SQLite row to KanbanTicket (INTEGER 0/1 → boolean, JSON string → array)
  private mapKanbanTicketRow(row: Record<string, unknown>): KanbanTicket {
    let attachments: unknown[] = []
    try {
      const raw = row.attachments as string
      if (raw) {
        attachments = JSON.parse(raw)
      }
    } catch {
      attachments = []
    }

    return {
      id: row.id as string,
      project_id: row.project_id as string,
      title: row.title as string,
      description: (row.description as string) ?? null,
      attachments,
      column: row.column as KanbanTicketColumn,
      sort_order: row.sort_order as number,
      current_session_id: (row.current_session_id as string) ?? null,
      worktree_id: (row.worktree_id as string) ?? null,
      mode: (row.mode as 'build' | 'plan' | 'super-plan' | 'super-build') ?? null,
      plan_ready: !!(row.plan_ready as number),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      column_changed_at: (row.column_changed_at as string) ?? null,
      archived_at: (row.archived_at as string) ?? null,
      external_provider: (row.external_provider as string) ?? null,
      external_id: (row.external_id as string) ?? null,
      external_url: (row.external_url as string) ?? null,
      github_pr_number: (row.github_pr_number as number) ?? null,
      github_pr_url: (row.github_pr_url as string) ?? null,
      mark: (row.mark as TicketMark) ?? null,
      total_tokens: (row.total_tokens as number) ?? 0,
      pending_launch_config: (row.pending_launch_config as string) ?? null,
      goal_mode: row.goal_mode === 1,
      goal_success_criteria: (row.goal_success_criteria as string) ?? null,
      note: (row.note as string) ?? null,
      labels: parseTicketLabels(row.labels),
      created_from_session: row.created_from_session === 1,
      auto_approve_plan: row.auto_approve_plan === 1,
      unread: row.unread === 1,
      awaiting_completion: row.awaiting_completion === 1,
      model_provider_id: (row.model_provider_id as string) ?? null,
      model_id: (row.model_id as string) ?? null,
      model_variant: (row.model_variant as string) ?? null,
      variant_group_id: (row.variant_group_id as string) ?? null,
      ticket_prefix: (row.ticket_prefix as string) ?? null,
      ticket_number: (row.ticket_number as number) ?? null,
      parent_ticket_id: (row.parent_ticket_id as string) ?? null,
      parent_ticket_key: formatTicketKey(
        (row.parent_ticket_prefix as string) ?? null,
        (row.parent_ticket_number as number) ?? null
      )
    }
  }

  private mapDiffCommentRow(row: Record<string, unknown>): DiffComment {
    return {
      id: row.id as string,
      worktree_id: row.worktree_id as string,
      file_path: row.file_path as string,
      line_start: row.line_start as number,
      line_end: (row.line_end as number) ?? null,
      anchor_text: (row.anchor_text as string) ?? null,
      anchor_context_before: (row.anchor_context_before as string) ?? null,
      anchor_context_after: (row.anchor_context_after as string) ?? null,
      body: row.body as string,
      is_outdated: !!(row.is_outdated as number),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string
    }
  }

  private normalizeBatchDrafts(drafts: KanbanTicketBatchCreateItem[]): Array<
    KanbanTicketBatchCreateItem & {
      draft_key: string
      title: string
      project_id: string
      depends_on: string[]
    }
  > {
    if (drafts.length === 0) {
      throw new Error('Batch ticket creation requires at least one draft')
    }

    const normalized: Array<
      KanbanTicketBatchCreateItem & {
        draft_key: string
        title: string
        project_id: string
        depends_on: string[]
      }
    > = []
    const draftKeys = new Set<string>()
    let projectId: string | null = null

    for (const draft of drafts) {
      const draftKey = draft.draft_key.trim()
      const title = draft.title.trim()
      const nextProjectId = draft.project_id.trim()

      if (!draftKey) {
        throw new Error('Each batch draft must include a draft_key')
      }
      if (!title) {
        throw new Error(`Draft "${draftKey}" must include a title`)
      }
      if (!nextProjectId) {
        throw new Error(`Draft "${draftKey}" must include a project_id`)
      }
      if (draftKeys.has(draftKey)) {
        throw new Error(`Duplicate draft_key "${draftKey}" in batch`)
      }

      if (projectId === null) {
        projectId = nextProjectId
      } else if (projectId !== nextProjectId) {
        throw new Error('All drafts in a batch must belong to the same project')
      }

      const dependsOn = Array.from(
        new Set(
          (draft.depends_on ?? [])
            .filter((dependency): dependency is string => typeof dependency === 'string')
            .map((dependency) => dependency.trim())
            .filter(Boolean)
        )
      )

      if (dependsOn.includes(draftKey)) {
        throw new Error(`Draft "${draftKey}" cannot depend on itself`)
      }

      draftKeys.add(draftKey)
      normalized.push({
        ...draft,
        draft_key: draftKey,
        title,
        project_id: nextProjectId,
        depends_on: dependsOn
      })
    }

    const normalizedKeySet = new Set(normalized.map((draft) => draft.draft_key))
    for (const draft of normalized) {
      for (const dependency of draft.depends_on) {
        if (!normalizedKeySet.has(dependency)) {
          throw new Error(`Draft "${draft.draft_key}" depends on unknown draft "${dependency}"`)
        }
      }
    }

    const visitState = new Map<string, 'visiting' | 'done'>()
    const visit = (draftKey: string): void => {
      const state = visitState.get(draftKey)
      if (state === 'visiting') {
        throw new Error(`Draft dependencies contain a cycle involving "${draftKey}"`)
      }
      if (state === 'done') return

      visitState.set(draftKey, 'visiting')
      const draft = normalized.find((item) => item.draft_key === draftKey)
      if (!draft) return

      for (const dependency of draft.depends_on) {
        visit(dependency)
      }

      visitState.set(draftKey, 'done')
    }

    for (const draft of normalized) {
      visit(draft.draft_key)
    }

    return normalized
  }

  private wouldCreateTicketDependencyCycle(
    db: Database.Database,
    dependentId: string,
    blockerId: string
  ): boolean {
    const visited = new Set<string>()
    const queue: string[] = [blockerId]
    visited.add(blockerId)

    while (queue.length > 0) {
      const node = queue.shift()!
      const dependents = db
        .prepare('SELECT dependent_id FROM ticket_dependencies WHERE blocker_id = ?')
        .all(node) as { dependent_id: string }[]

      for (const row of dependents) {
        if (row.dependent_id === dependentId) {
          return true
        }
        if (!visited.has(row.dependent_id)) {
          visited.add(row.dependent_id)
          queue.push(row.dependent_id)
        }
      }
    }

    return false
  }

  private runMigrations(): void {
    const db = this.getDb()

    // Ensure settings table exists for version tracking
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    const currentVersion = this.getSetting('schema_version')
    const version = currentVersion ? parseInt(currentVersion, 10) : 0

    for (const migration of MIGRATIONS) {
      if (migration.version > version) {
        try {
          db.exec(migration.up)
        } catch (err) {
          // Log but don't crash -- partial migrations (e.g. duplicate column)
          // are handled by the idempotent repair step below.
          console.error(
            `[db] Migration v${migration.version} (${migration.name}) failed:`,
            err instanceof Error ? err.message : String(err)
          )
        }
        this.setSetting('schema_version', migration.version.toString())
      }
    }

    // Post-migration repair: idempotently ensure all expected tables/columns
    // exist. This handles partial migrations, merge conflicts, or version
    // skew between worktree builds.
    this.ensureConnectionTables()
    this.ensureVoiceHistoryTable()
    this.ensureDocumentFlowTables()
    // After the document-flow tables: the key backfill reads document_runs / document_run_items.
    this.ensureTicketKeys()
    this.ensureTicketLabelTables()
    this.ensureDataProjectTables()
  }

  /**
   * Idempotently ensure the data-project tables exist (repair for v60): a database stamped 60 by
   * another build that never created them, or one whose tables were dropped, gets them back.
   */
  private ensureDataProjectTables(): void {
    this.getDb().exec(DATA_PROJECT_TABLES_SQL)
  }

  /** Idempotently ensure the voice dictation history table exists (repair for the v48 migration). */
  private ensureVoiceHistoryTable(): void {
    this.getDb().exec(VOICE_HISTORY_TABLES_SQL)
  }

  /**
   * Idempotently ensure the saved ticket-label catalog exists (repair for v59). The per-ticket
   * `labels` columns are repaired in ensureConnectionTables(), next to `note`.
   */
  private ensureTicketLabelTables(): void {
    this.getDb().exec(TICKET_LABELS_TABLES_SQL)
  }

  /**
   * Idempotently ensure the "Implement document" tables exist (repair for the v52 migration):
   * runs, their items and events, and the per-session final messages. IF NOT EXISTS only.
   */
  private ensureDocumentFlowTables(): void {
    this.getDb().exec(DOCUMENT_FLOW_TABLES_SQL)
    this.safeAddColumn('session_final_messages', 'state', "TEXT NOT NULL DEFAULT 'ended'")
    this.safeAddColumn('session_final_messages', 'detail', 'TEXT DEFAULT NULL')
    this.safeAddColumn('session_final_messages', 'background_work', 'INTEGER DEFAULT NULL')
    this.safeAddColumn('document_run_items', 'conflict_head', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_run_items', 'verification_suggested', "TEXT NOT NULL DEFAULT '[]'")
    this.safeAddColumn('document_run_items', 'verification', "TEXT NOT NULL DEFAULT '[]'")
    this.safeAddColumn('document_run_items', 'verification_reason', "TEXT NOT NULL DEFAULT ''")
    this.safeAddColumn('document_runs', 'ticket_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_runs', 'migration_session_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_runs', 'migration_started_at', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_runs', 'migration_owner_pid', 'INTEGER DEFAULT NULL')
    this.safeAddColumn('document_runs', 'integration_connection_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_runs', 'integration_connection_path', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_runs', 'members', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_run_items', 'connection_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_run_items', 'members', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_run_items', 'wait_until', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_run_items', 'wait_timeouts', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('document_run_items', 'document_update_status', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_run_items', 'document_update_detail', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_run_items', 'document_update_queued_at', 'TEXT DEFAULT NULL')
    this.safeAddColumn(
      'document_run_items',
      'document_update_attempts',
      'INTEGER NOT NULL DEFAULT 0'
    )
    this.safeAddColumn('document_run_items', 'document_update_hash', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_run_items', 'document_update_report', 'TEXT DEFAULT NULL')
    this.safeAddColumn('document_run_items', 'document_update_finished_at', 'TEXT DEFAULT NULL')
  }

  /**
   * Idempotently add a column to a table. No-op if column already exists.
   * Safe to call repeatedly (e.g. after merges that replay migrations).
   */
  /** Depth of the kanban batch in progress; a row write inside one emits no event of its own. */
  private kanbanBatchDepth = 0

  private lookupWorktreeProjectId(worktreeId: string): string | null {
    try {
      const row = this.getDb()
        .prepare('SELECT project_id FROM worktrees WHERE id = ?')
        .get(worktreeId) as { project_id: string } | undefined
      return row?.project_id ?? null
    } catch {
      return null
    }
  }

  private safeAddColumn(table: string, column: string, definition: string): void {
    const db = this.getDb()
    const columns = db.pragma(`table_info(${table})`) as { name: string }[]
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  /**
   * Idempotently ensure connection-related tables and columns exist.
   * Safe to run multiple times -- uses IF NOT EXISTS and checks column presence.
   */
  private ensureConnectionTables(): void {
    const db = this.getDb()

    db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        color TEXT DEFAULT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connection_members (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        symlink_name TEXT NOT NULL,
        added_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE,
        FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_connection_members_connection ON connection_members(connection_id);
      CREATE INDEX IF NOT EXISTS idx_connection_members_worktree ON connection_members(worktree_id);
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS saved_usage_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('anthropic','openai')),
        email TEXT NOT NULL,
        credentials_json TEXT NOT NULL,
        last_usage_json TEXT DEFAULT NULL,
        last_fetched_at TEXT DEFAULT NULL,
        status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','stale','error')),
        last_error TEXT DEFAULT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_usage_accounts_provider_email
        ON saved_usage_accounts(provider, email);
      CREATE INDEX IF NOT EXISTS idx_saved_usage_accounts_provider_created
        ON saved_usage_accounts(provider, created_at);
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS discord_resources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worktree_id TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
        discord_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('category','channel')),
        guild_id TEXT NOT NULL,
        managed_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_discord_resources_project ON discord_resources(project_id);
      CREATE INDEX IF NOT EXISTS idx_discord_resources_guild ON discord_resources(guild_id);
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS connection_history (
        id TEXT PRIMARY KEY,
        project_set_key TEXT NOT NULL UNIQUE,
        project_ids TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        note TEXT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_connection_history_last_used
        ON connection_history(last_used_at DESC);
    `)

    this.safeAddColumn('connection_history', 'note', 'TEXT DEFAULT NULL')

    this.safeAddColumn(
      'sessions',
      'connection_id',
      'TEXT DEFAULT NULL REFERENCES connections(id) ON DELETE SET NULL'
    )
    this.safeAddColumn('sessions', 'agent_sdk', "TEXT NOT NULL DEFAULT 'opencode'")
    this.safeAddColumn('sessions', 'claude_session_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('connections', 'color', 'TEXT DEFAULT NULL')
    this.safeAddColumn('connections', 'custom_name', 'TEXT DEFAULT NULL')
    this.safeAddColumn('worktrees', 'attachments', "TEXT DEFAULT '[]'")
    this.safeAddColumn('worktrees', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('worktrees', 'context', 'TEXT DEFAULT NULL')
    this.safeAddColumn('worktrees', 'github_pr_number', 'INTEGER DEFAULT NULL')
    this.safeAddColumn('worktrees', 'github_pr_url', 'TEXT DEFAULT NULL')
    this.safeAddColumn('worktrees', 'teleported_to', 'TEXT DEFAULT NULL')
    this.safeAddColumn('connections', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('projects', 'kind', "TEXT NOT NULL DEFAULT 'git'")
    this.safeAddColumn('projects', 'member_project_ids', 'TEXT DEFAULT NULL')
    this.safeAddColumn(
      'connections',
      'saved_project_id',
      'TEXT DEFAULT NULL REFERENCES projects(id) ON DELETE SET NULL'
    )
    this.safeAddColumn('connections', 'is_base', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('projects', 'kanban_simple_mode', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('projects', 'trust_check_done', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('projects', 'kanban_storage_mode', "TEXT NOT NULL DEFAULT 'internal'")
    this.safeAddColumn('projects', 'kanban_markdown_config', 'TEXT DEFAULT NULL')
    this.safeAddColumn('projects', 'custom_commands', 'TEXT DEFAULT NULL')
    this.safeAddColumn('projects', 'shell_commands', 'TEXT DEFAULT NULL')
    this.safeAddColumn('projects', 'worktree_create_script', 'TEXT DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'archived_at', 'TEXT DEFAULT NULL')
    this.safeAddColumn('sessions', 'pinned_to_board', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('kanban_tickets', 'github_pr_number', 'INTEGER DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'github_pr_url', 'TEXT DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'mark', 'TEXT DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'note', 'TEXT DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'labels', "TEXT NOT NULL DEFAULT '[]'")
    this.safeAddColumn('kanban_tickets', 'goal_mode', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('kanban_tickets', 'goal_success_criteria', 'TEXT DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'created_from_session', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('kanban_tickets', 'auto_approve_plan', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('kanban_tickets', 'unread', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('kanban_tickets', 'awaiting_completion', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('kanban_tickets', 'model_provider_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'model_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'model_variant', 'TEXT DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'variant_group_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'column_changed_at', 'TEXT DEFAULT NULL')
    this.safeAddColumn('sessions', 'session_type', "TEXT NOT NULL DEFAULT 'default'")
    this.safeAddColumn('sessions', 'remote_launch', 'TEXT DEFAULT NULL')
    this.safeAddColumn('sessions', 'custom_provider_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('sessions', 'shell_command', 'TEXT DEFAULT NULL')
    this.safeAddColumn(
      'discord_resources',
      'managed_session_id',
      'TEXT DEFAULT NULL REFERENCES sessions(id) ON DELETE SET NULL'
    )

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_connection ON sessions(connection_id);
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_activities (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_session_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        item_id TEXT,
        request_id TEXT,
        kind TEXT NOT NULL,
        tone TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT,
        sequence INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_activities_session_created
        ON session_activities(session_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_session_activities_session_turn
        ON session_activities(session_id, turn_id, created_at);
    `)

    // Kanban tickets table + indexes (idempotent repair for v11 migration)
    db.exec(`
      CREATE TABLE IF NOT EXISTS kanban_tickets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        "column" TEXT NOT NULL DEFAULT 'todo',
        sort_order REAL NOT NULL DEFAULT 0,
        current_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
        mode TEXT,
        plan_ready INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_tickets_project ON kanban_tickets(project_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_tickets_session ON kanban_tickets(current_session_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_tickets_worktree ON kanban_tickets(worktree_id);
    `)

    // Favorite ticket templates (idempotent repair for v43 migration)
    db.exec(`
      CREATE TABLE IF NOT EXISTS favorite_tickets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        goal_mode INTEGER NOT NULL DEFAULT 0,
        goal_success_criteria TEXT DEFAULT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    // Ticket followup messages table + index (idempotent repair for v13/v14 migrations)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_followup_messages (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES kanban_tickets(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        mode TEXT,
        session_id TEXT,
        source TEXT,
        created_at TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user'
      );

      CREATE INDEX IF NOT EXISTS idx_ticket_followup_messages_ticket
        ON ticket_followup_messages(ticket_id, created_at);
    `)
    this.safeAddColumn('ticket_followup_messages', 'role', "TEXT NOT NULL DEFAULT 'user'")

    db.exec(`
      CREATE TABLE IF NOT EXISTS markdown_kanban_card_state (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        card_id TEXT NOT NULL,
        current_session_id TEXT DEFAULT NULL REFERENCES sessions(id) ON DELETE SET NULL,
        worktree_id TEXT DEFAULT NULL REFERENCES worktrees(id) ON DELETE SET NULL,
        note TEXT DEFAULT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        plan_ready INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        pending_launch_config TEXT DEFAULT NULL,
        last_seen_path TEXT DEFAULT NULL,
        orphaned_at TEXT DEFAULT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, card_id)
      );

      CREATE INDEX IF NOT EXISTS idx_markdown_kanban_card_state_session
        ON markdown_kanban_card_state(current_session_id);
      CREATE INDEX IF NOT EXISTS idx_markdown_kanban_card_state_worktree
        ON markdown_kanban_card_state(worktree_id);
      CREATE INDEX IF NOT EXISTS idx_markdown_kanban_card_state_project_card
        ON markdown_kanban_card_state(project_id, card_id);
    `)
    this.safeAddColumn('markdown_kanban_card_state', 'note', 'TEXT DEFAULT NULL')
    this.safeAddColumn('markdown_kanban_card_state', 'labels', "TEXT NOT NULL DEFAULT '[]'")
    this.safeAddColumn('markdown_kanban_card_state', 'attachments', "TEXT NOT NULL DEFAULT '[]'")
    this.safeAddColumn('markdown_kanban_card_state', 'plan_ready', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('markdown_kanban_card_state', 'total_tokens', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('markdown_kanban_card_state', 'pending_launch_config', 'TEXT DEFAULT NULL')
    this.safeAddColumn('markdown_kanban_card_state', 'last_seen_path', 'TEXT DEFAULT NULL')
    this.safeAddColumn('markdown_kanban_card_state', 'orphaned_at', 'TEXT DEFAULT NULL')
    this.safeAddColumn('markdown_kanban_card_state', 'auto_approve_plan', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('markdown_kanban_card_state', 'model_provider_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('markdown_kanban_card_state', 'model_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('markdown_kanban_card_state', 'model_variant', 'TEXT DEFAULT NULL')
    this.safeAddColumn('markdown_kanban_card_state', 'variant_group_id', 'TEXT DEFAULT NULL')
    this.safeAddColumn('markdown_kanban_card_state', 'column_changed_at', 'TEXT DEFAULT NULL')
    this.safeAddColumn('markdown_kanban_card_state', 'last_known_column', 'TEXT DEFAULT NULL')
    this.safeAddColumn('markdown_kanban_card_state', 'unread', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn(
      'markdown_kanban_card_state',
      'awaiting_completion',
      'INTEGER NOT NULL DEFAULT 0'
    )

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_usage_state (
        hive_session_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        last_reported_json TEXT DEFAULT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  }

  // Session usage state (accurate cost/token reporting cursors + totals)
  getSessionUsageState(
    hiveSessionId: string
  ): { stateJson: string; lastReportedJson: string | null } | null {
    const db = this.getDb()
    const row = db
      .prepare(
        'SELECT state_json, last_reported_json FROM session_usage_state WHERE hive_session_id = ?'
      )
      .get(hiveSessionId) as { state_json: string; last_reported_json: string | null } | undefined
    return row ? { stateJson: row.state_json, lastReportedJson: row.last_reported_json } : null
  }

  setSessionUsageState(
    hiveSessionId: string,
    stateJson: string,
    lastReportedJson: string | null
  ): void {
    const db = this.getDb()
    db.prepare(
      `INSERT INTO session_usage_state (hive_session_id, state_json, last_reported_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(hive_session_id) DO UPDATE SET
         state_json = excluded.state_json,
         last_reported_json = excluded.last_reported_json,
         updated_at = excluded.updated_at`
    ).run(hiveSessionId, stateJson, lastReportedJson, new Date().toISOString())
  }

  /** Recent sessions eligible for the usage sweep (agent SDKs with local logs).
   * Active sessions stay eligible regardless of row recency: a long-running
   * CLI session can burn tokens for hours without any Hive-side DB mutation,
   * and aging it out would blind the burn-rate tally to exactly the workload
   * it protects. */
  listRecentUsageSessionIds(sinceIso: string): string[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        `SELECT id FROM sessions
         WHERE (updated_at >= ? OR status = 'active')
           AND agent_sdk IN ('claude-code', 'claude-code-cli', 'codex', 'codex-cli')
         ORDER BY (status = 'active') DESC, updated_at DESC`
      )
      .all(sinceIso) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  // Settings operations
  getSetting(key: string): string | null {
    const db = this.getDb()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | Setting
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    const db = this.getDb()
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  }

  deleteSetting(key: string): void {
    const db = this.getDb()
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  getAllSettings(): Setting[] {
    const db = this.getDb()
    return db.prepare('SELECT key, value FROM settings').all() as Setting[]
  }

  // Voice dictation history

  private mapVoiceHistoryRow(row: Record<string, unknown>): VoiceHistoryRow {
    return {
      id: row.id as string,
      text: row.text as string,
      raw_text: (row.raw_text as string | null) ?? null,
      duration_ms: (row.duration_ms as number) ?? 0,
      cleaned: !!row.cleaned,
      speech_model: (row.speech_model as string) ?? '',
      created_at: row.created_at as string
    }
  }

  addVoiceHistory(data: VoiceHistoryRowCreate): VoiceHistoryRow {
    const db = this.getDb()
    const row: VoiceHistoryRow = {
      id: randomUUID(),
      text: data.text,
      raw_text: data.raw_text ?? null,
      duration_ms: data.duration_ms ?? 0,
      cleaned: data.cleaned ?? false,
      speech_model: data.speech_model ?? '',
      created_at: new Date().toISOString()
    }
    db.prepare(
      `INSERT INTO voice_history (id, text, raw_text, duration_ms, cleaned, speech_model, created_at)
       VALUES (@id, @text, @raw_text, @duration_ms, @cleaned, @speech_model, @created_at)`
    ).run({ ...row, cleaned: row.cleaned ? 1 : 0 })
    return row
  }

  /** Newest first. `query` filters on the delivered text (case-insensitive substring). */
  listVoiceHistory(options: { limit: number; offset?: number; query?: string } = { limit: 20 }): VoiceHistoryRow[] {
    const db = this.getDb()
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit)))
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const query = options.query?.trim()
    const rows = query
      ? (db
          .prepare(
            `SELECT * FROM voice_history WHERE text LIKE @pattern ESCAPE '\\'
             ORDER BY created_at DESC, rowid DESC LIMIT @limit OFFSET @offset`
          )
          .all({ pattern: `%${escapeLike(query)}%`, limit, offset }) as Record<string, unknown>[])
      : (db
          .prepare(
            `SELECT * FROM voice_history ORDER BY created_at DESC, rowid DESC LIMIT @limit OFFSET @offset`
          )
          .all({ limit, offset }) as Record<string, unknown>[])
    return rows.map((row) => this.mapVoiceHistoryRow(row))
  }

  countVoiceHistory(query?: string): number {
    const db = this.getDb()
    const trimmed = query?.trim()
    const row = trimmed
      ? (db
          .prepare(`SELECT COUNT(*) AS count FROM voice_history WHERE text LIKE @pattern ESCAPE '\\'`)
          .get({ pattern: `%${escapeLike(trimmed)}%` }) as { count: number })
      : (db.prepare('SELECT COUNT(*) AS count FROM voice_history').get() as { count: number })
    return row?.count ?? 0
  }

  deleteVoiceHistory(id: string): boolean {
    const result = this.getDb().prepare('DELETE FROM voice_history WHERE id = ?').run(id)
    return result.changes > 0
  }

  clearVoiceHistory(): number {
    const result = this.getDb().prepare('DELETE FROM voice_history').run()
    return result.changes
  }

  // "Implement document" flow: runs, their items and audit log, per-session final messages.
  // Not `db:changed` entities — the flow publishes its own channel
  // (shared/document-flow-events.ts), so none of these writes call emitDbChanged.

  /** A JSON object column; null when it is NULL, corrupt or not an object. */
  private parseDocumentFlowObject<T extends object>(value: unknown): T | null {
    if (typeof value !== 'string' || value === '') return null
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as T)
        : null
    } catch {
      return null
    }
  }

  /** A JSON array column; empty when it is NULL, corrupt or not an array. */
  private parseDocumentFlowArray<T>(value: unknown): T[] {
    if (typeof value !== 'string' || value === '') return []
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }

  private clampDocumentFlowLimit(limit: number | undefined, fallback: number, max: number): number {
    const wanted =
      typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback
    return Math.max(1, Math.min(max, wanted))
  }

  private mapDocumentRunRow(row: Record<string, unknown>): DocumentRun {
    return {
      id: row.id as string,
      project_id: row.project_id as string,
      title: row.title as string,
      source_path: row.source_path as string,
      run_dir: row.run_dir as string,
      document_path: (row.document_path as string | null) ?? null,
      status: row.status as DocumentRun['status'],
      error: (row.error as string | null) ?? null,
      // Over the defaults, so a row written before a setting existed still has every field.
      config: {
        ...DEFAULT_DOCUMENT_RUN_CONFIG,
        ...this.parseDocumentFlowObject<Partial<DocumentRunConfig>>(row.config)
      },
      extraction: this.parseDocumentFlowObject<NonNullable<DocumentRun['extraction']>>(
        row.extraction
      ),
      base_branch: (row.base_branch as string | null) ?? null,
      base_sha: (row.base_sha as string | null) ?? null,
      integration_branch: (row.integration_branch as string | null) ?? null,
      integration_worktree_id: (row.integration_worktree_id as string | null) ?? null,
      integration_worktree_path: (row.integration_worktree_path as string | null) ?? null,
      integration_connection_id: (row.integration_connection_id as string | null) ?? null,
      integration_connection_path: (row.integration_connection_path as string | null) ?? null,
      members:
        row.members === null || row.members === undefined
          ? null
          : this.parseDocumentFlowArray<NonNullable<DocumentRun['members']>[number]>(row.members),
      ticket_id: (row.ticket_id as string | null) ?? null,
      report: this.parseDocumentFlowObject<NonNullable<DocumentRun['report']>>(row.report),
      migration_session_id: (row.migration_session_id as string | null) ?? null,
      migration_started_at: (row.migration_started_at as string | null) ?? null,
      migration_owner_pid: (row.migration_owner_pid as number | null) ?? null,
      runner_client_id: (row.runner_client_id as string | null) ?? null,
      runner_heartbeat_at: (row.runner_heartbeat_at as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      started_at: (row.started_at as string | null) ?? null,
      finished_at: (row.finished_at as string | null) ?? null
    }
  }

  private mapDocumentRunItemRow(row: Record<string, unknown>): DocumentRunItem {
    return {
      id: row.id as string,
      run_id: row.run_id as string,
      key: row.item_key as string,
      position: (row.position as number) ?? 0,
      title: row.title as string,
      summary: (row.summary as string) ?? '',
      description: (row.description as string) ?? '',
      kind: (row.kind as DocumentRunItem['kind']) ?? 'change',
      depends_on: this.parseDocumentFlowArray<string>(row.depends_on),
      has_migration: !!row.has_migration,
      size: (row.size as DocumentRunItem['size']) ?? null,
      conflict_risk: (row.conflict_risk as DocumentRunItem['conflict_risk']) ?? null,
      doc_status: (row.doc_status as DocumentRunItem['doc_status']) ?? 'unknown',
      selected: !!row.selected,
      figures: this.parseDocumentFlowArray<DocumentRunItem['figures'][number]>(row.figures),
      open_questions: this.parseDocumentFlowArray<string>(row.open_questions),
      verification_suggested: normalizeVerificationMethods(
        this.parseDocumentFlowArray<unknown>(row.verification_suggested)
      ),
      verification: normalizeVerificationMethods(
        this.parseDocumentFlowArray<unknown>(row.verification)
      ),
      verification_reason: (row.verification_reason as string) ?? '',
      launch_config: this.parseDocumentFlowObject<NonNullable<DocumentRunItem['launch_config']>>(
        row.launch_config
      ),
      status: row.status as DocumentRunItem['status'],
      status_detail: (row.status_detail as string | null) ?? null,
      ticket_id: (row.ticket_id as string | null) ?? null,
      worktree_id: (row.worktree_id as string | null) ?? null,
      connection_id: (row.connection_id as string | null) ?? null,
      members:
        row.members === null || row.members === undefined
          ? null
          : this.parseDocumentFlowArray<NonNullable<DocumentRunItem['members']>[number]>(
              row.members
            ),
      session_id: (row.session_id as string | null) ?? null,
      fix_ticket_id: (row.fix_ticket_id as string | null) ?? null,
      fix_session_id: (row.fix_session_id as string | null) ?? null,
      branch_name: (row.branch_name as string | null) ?? null,
      verdict: this.parseDocumentFlowObject<NonNullable<DocumentRunItem['verdict']>>(row.verdict),
      nudge_count: (row.nudge_count as number) ?? 0,
      conflict_attempts: (row.conflict_attempts as number) ?? 0,
      conflict_head: (row.conflict_head as string | null) ?? null,
      fix_attempts: (row.fix_attempts as number) ?? 0,
      continue_attempts: (row.continue_attempts as number) ?? 0,
      pre_merge_sha: (row.pre_merge_sha as string | null) ?? null,
      merge_sha: (row.merge_sha as string | null) ?? null,
      last_prompt_at: (row.last_prompt_at as string | null) ?? null,
      last_checked_at: (row.last_checked_at as string | null) ?? null,
      retry_at: (row.retry_at as string | null) ?? null,
      wait_until: (row.wait_until as string | null) ?? null,
      wait_timeouts: (row.wait_timeouts as number) ?? 0,
      document_update_status:
        (row.document_update_status as DocumentRunItem['document_update_status']) ?? null,
      document_update_detail: (row.document_update_detail as string | null) ?? null,
      document_update_queued_at: (row.document_update_queued_at as string | null) ?? null,
      document_update_attempts: (row.document_update_attempts as number) ?? 0,
      document_update_hash: (row.document_update_hash as string | null) ?? null,
      document_update_report: this.parseDocumentFlowObject<
        NonNullable<DocumentRunItem['document_update_report']>
      >(row.document_update_report),
      document_update_finished_at: (row.document_update_finished_at as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      started_at: (row.started_at as string | null) ?? null,
      finished_at: (row.finished_at as string | null) ?? null
    }
  }

  private mapDocumentRunEventRow(row: Record<string, unknown>): DocumentRunEvent {
    let data: unknown = null
    if (typeof row.data === 'string' && row.data !== '') {
      try {
        data = JSON.parse(row.data)
      } catch {
        data = null
      }
    }
    return {
      id: row.id as number,
      run_id: row.run_id as string,
      item_id: (row.item_id as string | null) ?? null,
      at: row.at as string,
      type: row.type as string,
      message: row.message as string,
      data
    }
  }

  /**
   * Write the columns whose key is present in `patch` (undefined leaves a column alone, null
   * clears it) and stamp `updated_at`. Column names come from `columns`, never from the patch,
   * so an unknown key is ignored; with nothing to write the row is left untouched.
   */
  private patchDocumentFlowRow<P extends object>(
    table: 'document_runs' | 'document_run_items',
    id: string,
    patch: P,
    columns: Record<keyof P, DocumentFlowColumnKind>
  ): void {
    const sets: string[] = []
    const values: (string | number | null)[] = []
    for (const column of Object.keys(columns) as (keyof P & string)[]) {
      const value: unknown = patch[column]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      if (value === null) values.push(null)
      else if (columns[column] === 'json') values.push(JSON.stringify(value))
      else if (columns[column] === 'flag') values.push(value ? 1 : 0)
      else values.push(value as string | number)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    values.push(new Date().toISOString(), id)
    this.getDb()
      .prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values)
  }

  createDocumentRun(data: DocumentRunCreate): DocumentRun {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO document_runs (
         id, project_id, title, source_path, run_dir, document_path, status, config,
         created_at, updated_at
       ) VALUES (
         @id, @project_id, @title, @source_path, @run_dir, @document_path, @status, @config,
         @now, @now
       )`
    ).run({
      id: data.id,
      project_id: data.project_id,
      title: data.title,
      source_path: data.source_path,
      run_dir: data.run_dir,
      document_path: data.document_path ?? null,
      status: data.status,
      config: JSON.stringify(data.config),
      now
    })
    const created = this.getDocumentRun(data.id)
    if (!created) throw new Error(`[db] document_runs: row ${data.id} missing right after insert`)
    return created
  }

  getDocumentRun(id: string): DocumentRun | null {
    const row = this.getDb().prepare('SELECT * FROM document_runs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined
    return row ? this.mapDocumentRunRow(row) : null
  }

  /** Newest first, of one project or of all. */
  listDocumentRuns(projectId?: string, limit?: number): DocumentRun[] {
    const db = this.getDb()
    const max = this.clampDocumentFlowLimit(limit, 50, 200)
    const rows = projectId
      ? (db
          .prepare(
            `SELECT * FROM document_runs WHERE project_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?`
          )
          .all(projectId, max) as Record<string, unknown>[])
      : (db
          .prepare('SELECT * FROM document_runs ORDER BY created_at DESC, rowid DESC LIMIT ?')
          .all(max) as Record<string, unknown>[])
    return rows.map((row) => this.mapDocumentRunRow(row))
  }

  updateDocumentRun(id: string, patch: DocumentRunRowPatch): DocumentRun | null {
    if (!this.getDocumentRun(id)) return null
    this.patchDocumentFlowRow('document_runs', id, patch, DOCUMENT_RUN_PATCH_COLUMNS)
    return this.getDocumentRun(id)
  }

  /** Deletes the run with its items and events; explicit, so it holds without foreign keys. */
  deleteDocumentRun(id: string): boolean {
    const db = this.getDb()
    return db.transaction((): boolean => {
      db.prepare('DELETE FROM document_run_events WHERE run_id = ?').run(id)
      db.prepare('DELETE FROM document_run_items WHERE run_id = ?').run(id)
      return db.prepare('DELETE FROM document_runs WHERE id = ?').run(id).changes > 0
    })()
  }

  /** Replace every item of the run in one transaction; `position` follows the array order. */
  replaceDocumentRunItems(runId: string, items: DocumentRunItemCreate[]): DocumentRunItem[] {
    const db = this.getDb()
    return db.transaction((): DocumentRunItem[] => {
      db.prepare('DELETE FROM document_run_items WHERE run_id = ?').run(runId)
      const insert = db.prepare(
        `INSERT INTO document_run_items (
           id, run_id, item_key, position, title, summary, description, kind, depends_on,
           has_migration, size, conflict_risk, doc_status, selected, figures, open_questions,
           verification_suggested, verification, verification_reason,
           launch_config, status, created_at, updated_at
         ) VALUES (
           @id, @run_id, @item_key, @position, @title, @summary, @description, @kind, @depends_on,
           @has_migration, @size, @conflict_risk, @doc_status, @selected, @figures, @open_questions,
           @verification_suggested, @verification, @verification_reason,
           @launch_config, 'pending', @now, @now
         )`
      )
      const now = new Date().toISOString()
      items.forEach((item, position) => {
        insert.run({
          id: randomUUID(),
          run_id: runId,
          item_key: item.key,
          position,
          title: item.title,
          summary: item.summary,
          description: item.description,
          kind: item.kind,
          depends_on: JSON.stringify(item.depends_on),
          has_migration: item.has_migration ? 1 : 0,
          size: item.size ?? null,
          conflict_risk: item.conflict_risk ?? null,
          doc_status: item.doc_status,
          selected: item.selected ? 1 : 0,
          figures: JSON.stringify(item.figures),
          open_questions: JSON.stringify(item.open_questions),
          verification_suggested: JSON.stringify(item.verification_suggested),
          verification: JSON.stringify(item.verification),
          verification_reason: item.verification_reason,
          launch_config: item.launch_config ? JSON.stringify(item.launch_config) : null,
          now
        })
      })
      return this.getDocumentRunItems(runId)
    })()
  }

  /** Ordered by `position`. */
  getDocumentRunItems(runId: string): DocumentRunItem[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM document_run_items WHERE run_id = ? ORDER BY position, rowid')
      .all(runId) as Record<string, unknown>[]
    return rows.map((row) => this.mapDocumentRunItemRow(row))
  }

  getDocumentRunItem(id: string): DocumentRunItem | null {
    const row = this.getDb().prepare('SELECT * FROM document_run_items WHERE id = ?').get(id) as
      Record<string, unknown> | undefined
    return row ? this.mapDocumentRunItemRow(row) : null
  }

  updateDocumentRunItem(id: string, patch: DocumentRunItemRowPatch): DocumentRunItem | null {
    if (!this.getDocumentRunItem(id)) return null
    this.patchDocumentFlowRow('document_run_items', id, patch, DOCUMENT_RUN_ITEM_PATCH_COLUMNS)
    return this.getDocumentRunItem(id)
  }

  appendDocumentRunEvent(data: DocumentRunEventCreate): DocumentRunEvent {
    const db = this.getDb()
    const result = db
      .prepare(
        `INSERT INTO document_run_events (run_id, item_id, at, type, message, data)
         VALUES (@run_id, @item_id, @at, @type, @message, @data)`
      )
      .run({
        run_id: data.run_id,
        item_id: data.item_id ?? null,
        at: new Date().toISOString(),
        type: data.type,
        message: data.message,
        data: data.data === undefined ? null : (JSON.stringify(data.data) ?? null)
      })
    const row = db
      .prepare('SELECT * FROM document_run_events WHERE id = ?')
      .get(result.lastInsertRowid) as Record<string, unknown>
    return this.mapDocumentRunEventRow(row)
  }

  /** The newest `limit` events of the run, oldest first; only those of `type` when given. */
  listDocumentRunEvents(runId: string, limit?: number, type?: string): DocumentRunEvent[] {
    const max = this.clampDocumentFlowLimit(limit, 200, 1000)
    const rows =
      type === undefined
        ? (this.getDb()
            .prepare(
              `SELECT * FROM (
                 SELECT * FROM document_run_events WHERE run_id = ? ORDER BY id DESC LIMIT ?
               ) ORDER BY id ASC`
            )
            .all(runId, max) as Record<string, unknown>[])
        : (this.getDb()
            .prepare(
              `SELECT * FROM (
                 SELECT * FROM document_run_events WHERE run_id = ? AND type = ?
                 ORDER BY id DESC LIMIT ?
               ) ORDER BY id ASC`
            )
            .all(runId, type, max) as Record<string, unknown>[])
    return rows.map((row) => this.mapDocumentRunEventRow(row))
  }

  /**
   * Single-owner lease on a run: granted (and the heartbeat stamped) when it has no owner, the
   * owner is `clientId`, or the owner's heartbeat is older than `staleBeforeIso`. One UPDATE,
   * so two clients racing for a stale lease cannot both win. `updated_at` is left alone: a
   * heartbeat is not a change to the run.
   */
  claimDocumentRunRunner(
    runId: string,
    clientId: string,
    nowIso: string,
    staleBeforeIso: string
  ): DocumentRunnerClaimResult {
    const db = this.getDb()
    db.prepare(
      `UPDATE document_runs
       SET runner_client_id = @clientId, runner_heartbeat_at = @nowIso
       WHERE id = @runId
         AND (runner_client_id IS NULL
           OR runner_client_id = @clientId
           OR runner_heartbeat_at IS NULL
           OR runner_heartbeat_at < @staleBeforeIso)`
    ).run({ runId, clientId, nowIso, staleBeforeIso })
    const row = db.prepare('SELECT runner_client_id FROM document_runs WHERE id = ?').get(runId) as
      { runner_client_id: string | null } | undefined
    const ownerClientId = row?.runner_client_id ?? null
    return { owned: ownerClientId === clientId, ownerClientId }
  }

  /** One row per session: the latest turn end replaces the previous one. */
  upsertSessionFinalMessage(data: SessionFinalMessageUpsert): void {
    // A blocking or busy state keeps the text of the last turn end unless new text is given.
    this.getDb()
      .prepare(
        `INSERT INTO session_final_messages (
           session_id, state, text, completion, api_error, hook_event, detail, background_work,
           updated_at
         ) VALUES (
           @session_id, @state, COALESCE(@text, ''), @completion, @api_error, @hook_event,
           @detail, @background_work, @updated_at
         )
         ON CONFLICT(session_id) DO UPDATE SET
           state = excluded.state,
           text = COALESCE(@text, session_final_messages.text),
           completion = excluded.completion,
           api_error = excluded.api_error,
           hook_event = excluded.hook_event,
           detail = excluded.detail,
           background_work = excluded.background_work,
           updated_at = excluded.updated_at`
      )
      .run({
        session_id: data.session_id,
        state: data.state ?? 'ended',
        text: data.text ?? null,
        completion: data.completion ?? null,
        api_error: data.api_error ?? null,
        hook_event: data.hook_event,
        detail: data.detail ?? null,
        background_work: data.background_work ?? null,
        updated_at: new Date().toISOString()
      })
  }

  deleteSessionFinalMessage(sessionId: string): void {
    this.getDb().prepare('DELETE FROM session_final_messages WHERE session_id = ?').run(sessionId)
  }

  getSessionFinalMessage(sessionId: string): SessionFinalMessage | null {
    const row = this.getDb()
      .prepare('SELECT * FROM session_final_messages WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined
    if (!row) return null
    const state = row.state as string
    return {
      session_id: row.session_id as string,
      state: SESSION_TURN_STATES.includes(state as SessionTurnState)
        ? (state as SessionTurnState)
        : 'ended',
      text: (row.text as string) ?? '',
      completion: (row.completion as string | null) ?? null,
      api_error: (row.api_error as string | null) ?? null,
      hook_event: row.hook_event as string,
      detail: (row.detail as string | null) ?? null,
      background_work: (row.background_work as number | null) ?? null,
      updated_at: row.updated_at as string
    }
  }

  // Saved usage account operations
  //
  // Emails are normalized to lowercase here, but legacy rows created before
  // that normalization may still carry a mixed-case email. The
  // (provider, email) unique index is case-sensitive (SQLite's default TEXT
  // collation), so `INSERT ... ON CONFLICT(provider, email)` would not
  // detect a case-variant match and would insert a duplicate row for the
  // same account. To avoid that, look up any existing row
  // case-insensitively first (via getSavedUsageAccountByProviderEmail) and
  // update it directly when found, instead of relying on the unique index.
  upsertSavedUsageAccount(data: SavedUsageAccountUpsert): SavedUsageAccount {
    const db = this.getDb()
    const now = new Date().toISOString()
    const email = data.email.toLowerCase()
    const hasLastUsage = data.last_usage_json !== undefined
    const hasStatus = data.status !== undefined
    const hasLastError = data.last_error !== undefined

    const existing = this.getSavedUsageAccountByProviderEmail(data.provider, email)

    if (existing) {
      db.prepare(
        `UPDATE saved_usage_accounts SET
           email = ?,
           credentials_json = ?,
           last_usage_json = CASE WHEN ? THEN ? ELSE last_usage_json END,
           last_fetched_at = CASE WHEN ? THEN ? ELSE last_fetched_at END,
           status = CASE WHEN ? THEN ? ELSE status END,
           last_error = CASE WHEN ? THEN ? ELSE last_error END,
           updated_at = ?
         WHERE id = ?`
      ).run(
        email,
        data.credentials_json,
        hasLastUsage ? 1 : 0,
        data.last_usage_json ?? null,
        hasLastUsage ? 1 : 0,
        now,
        hasStatus ? 1 : 0,
        data.status ?? 'ok',
        hasLastError ? 1 : 0,
        data.last_error ?? null,
        now,
        existing.id
      )
    } else {
      db.prepare(
        `INSERT INTO saved_usage_accounts (
           id, provider, email, credentials_json, last_usage_json, last_fetched_at,
           status, last_error, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        data.provider,
        email,
        data.credentials_json,
        data.last_usage_json ?? null,
        hasLastUsage ? now : null,
        data.status ?? 'ok',
        data.last_error ?? null,
        now,
        now
      )
    }

    const saved = this.getSavedUsageAccountByProviderEmail(data.provider, email)
    if (!saved) {
      throw new Error('Failed to upsert saved usage account')
    }
    return saved
  }

  updateSavedUsageAccountUsage(
    id: string,
    data: SavedUsageAccountUsageUpdate
  ): SavedUsageAccount | null {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare(
      `UPDATE saved_usage_accounts
       SET last_usage_json = ?,
           last_fetched_at = ?,
           status = ?,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(data.last_usage_json, now, data.status, data.last_error ?? null, now, id)
    return this.getSavedUsageAccountById(id)
  }

  /**
   * Replace only the cached usage snapshot (the live API-proxy path).
   * Deliberately leaves `last_fetched_at` / `status` / `last_error` alone:
   * those describe the last usage-endpoint POLL, which the refresh sweeps key
   * their "is this row fresh" decisions on — and the poll is still the only
   * source for the fields the response headers lack.
   */
  updateSavedUsageAccountLiveUsage(id: string, lastUsageJson: string): SavedUsageAccount | null {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare(
      `UPDATE saved_usage_accounts SET last_usage_json = ?, updated_at = ? WHERE id = ?`
    ).run(lastUsageJson, now, id)
    return this.getSavedUsageAccountById(id)
  }

  getSavedUsageAccountById(id: string): SavedUsageAccount | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM saved_usage_accounts WHERE id = ?').get(id) as
      | SavedUsageAccount
      | undefined
    return row ?? null
  }

  getSavedUsageAccountByProviderEmail(
    provider: SavedUsageProvider,
    email: string
  ): SavedUsageAccount | null {
    const db = this.getDb()
    // COLLATE NOCASE: legacy rows may carry a mixed-case email pre-dating
    // lowercase normalization, so match case-insensitively.
    const row = db
      .prepare('SELECT * FROM saved_usage_accounts WHERE provider = ? AND email = ? COLLATE NOCASE')
      .get(provider, email) as SavedUsageAccount | undefined
    return row ?? null
  }

  getSavedUsageAccountsByProvider(provider: SavedUsageProvider): SavedUsageAccount[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM saved_usage_accounts WHERE provider = ? ORDER BY created_at ASC')
      .all(provider) as SavedUsageAccount[]
  }

  clearSavedUsageAccountCredentials(): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare(`UPDATE saved_usage_accounts SET credentials_json = '', updated_at = ?`).run(now)
  }

  /**
   * Blank a single row's credentials by id. Used by the one-time credentials
   * migration so it can blank ONLY the rows it successfully migrated (or
   * deliberately skipped), leaving a row whose keychain add hit a transient
   * failure with its credentials intact for the next boot to retry.
   */
  clearSavedUsageAccountCredentialsById(id: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare(
      `UPDATE saved_usage_accounts SET credentials_json = '', updated_at = ? WHERE id = ?`
    ).run(now, id)
  }

  deleteSavedUsageAccount(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM saved_usage_accounts WHERE id = ?').run(id)
    return result.changes > 0
  }

  // Project operations
  createProject(data: ProjectCreate): Project {
    const db = this.getDb()
    const now = new Date().toISOString()
    // New projects get sort_order 0 (top), bump all others down — data projects too: both
    // tables share one sidebar order (see DATA_PROJECT_TABLES_SQL).
    this.shiftSidebarOrder()

    const project: Project = {
      id: randomUUID(),
      name: data.name,
      path: data.path,
      description: data.description ?? null,
      tags: data.tags ? JSON.stringify(data.tags) : null,
      language: null,
      custom_icon: null,
      detected_icon: null,
      setup_script: data.setup_script ?? null,
      run_script: data.run_script ?? null,
      archive_script: data.archive_script ?? null,
      worktree_create_script: data.worktree_create_script ?? null,
      custom_commands: null,
      shell_commands: [],
      auto_assign_port: false,
      sort_order: 0,
      created_at: now,
      last_accessed_at: now
    }

    db.prepare(
      `INSERT INTO projects (id, name, path, description, tags, language, setup_script, run_script, archive_script, worktree_create_script, custom_commands, auto_assign_port, sort_order, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      project.id,
      project.name,
      project.path,
      project.description,
      project.tags,
      project.language,
      project.setup_script,
      project.run_script,
      project.archive_script,
      project.worktree_create_script,
      project.custom_commands ? JSON.stringify(project.custom_commands) : null,
      project.auto_assign_port ? 1 : 0,
      project.sort_order,
      project.created_at,
      project.last_accessed_at
    )

    return project
  }

  /**
   * Create a "connection project": a projects row with kind='connection' that owns a
   * kanban board for a saved connection. It has NO default worktree and never points
   * at a git repo — path is a dedicated symlink directory. detected_icon is set to
   * 'none' so the renderer's favicon scan skips it.
   */
  createConnectionProject(data: {
    name: string
    path: string
    member_project_ids: string[]
  }): Project {
    const db = this.getDb()
    const now = new Date().toISOString()
    // New projects get sort_order 0 (top), bump all others down — data projects too: both
    // tables share one sidebar order (see DATA_PROJECT_TABLES_SQL).
    this.shiftSidebarOrder()

    const id = randomUUID()
    const memberIdsJson = JSON.stringify(data.member_project_ids)
    db.prepare(
      `INSERT INTO projects (id, name, path, kind, member_project_ids, description, tags, language, setup_script, run_script, archive_script, worktree_create_script, custom_commands, custom_icon, detected_icon, auto_assign_port, sort_order, created_at, last_accessed_at)
       VALUES (?, ?, ?, 'connection', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'none', 0, 0, ?, ?)`
    ).run(id, data.name, data.path, memberIdsJson, now, now)

    const created = this.getProject(id)
    if (!created) {
      throw new Error('Failed to create connection project')
    }
    return created
  }

  getProject(id: string): Project | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    if (!row) return null
    return this.mapProjectRow(row)
  }

  getProjectByPath(path: string): Project | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as
      | ProjectRow
      | undefined
    if (!row) return null
    return this.mapProjectRow(row)
  }

  getAllProjects(): Project[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM projects ORDER BY sort_order ASC, last_accessed_at DESC')
      .all() as ProjectRow[]

    return rows.map((row) => this.mapProjectRow(row))
  }

  reorderProjects(orderedIds: string[]): void {
    const db = this.getDb()
    const stmt = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    const tx = db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run(i, orderedIds[i])
      }
    })
    tx()
  }

  getProjectIdsSortedByLastMessage(): string[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        `SELECT p.id
         FROM projects p
         LEFT JOIN worktrees w ON w.project_id = p.id
         GROUP BY p.id
         ORDER BY
           CASE WHEN MAX(w.last_message_at) IS NULL THEN 1 ELSE 0 END ASC,
           MAX(w.last_message_at) DESC`
      )
      .all() as { id: string }[]
    return rows.map((r) => r.id)
  }

  updateProject(id: string, data: ProjectUpdate): Project | null {
    const db = this.getDb()
    const existing = this.getProject(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.description !== undefined) {
      updates.push('description = ?')
      values.push(data.description)
    }
    if (data.tags !== undefined) {
      updates.push('tags = ?')
      values.push(data.tags ? JSON.stringify(data.tags) : null)
    }
    if (data.language !== undefined) {
      updates.push('language = ?')
      values.push(data.language)
    }
    if (data.custom_icon !== undefined) {
      updates.push('custom_icon = ?')
      values.push(data.custom_icon)
    }
    if (data.detected_icon !== undefined) {
      updates.push('detected_icon = ?')
      values.push(data.detected_icon)
    }
    if (data.setup_script !== undefined) {
      updates.push('setup_script = ?')
      values.push(data.setup_script)
    }
    if (data.run_script !== undefined) {
      updates.push('run_script = ?')
      values.push(data.run_script)
    }
    if (data.archive_script !== undefined) {
      updates.push('archive_script = ?')
      values.push(data.archive_script)
    }
    if (data.worktree_create_script !== undefined) {
      updates.push('worktree_create_script = ?')
      values.push(data.worktree_create_script)
    }
    if (data.custom_commands !== undefined) {
      updates.push('custom_commands = ?')
      values.push(data.custom_commands ? JSON.stringify(data.custom_commands) : null)
    }
    if (data.shell_commands !== undefined) {
      // Drops invalid entries and unknown keys: defence in depth behind the zod schema.
      const commands = parseProjectShellCommands(data.shell_commands)
      updates.push('shell_commands = ?')
      values.push(commands.length > 0 ? JSON.stringify(commands) : null)
    }
    if (data.auto_assign_port !== undefined) {
      updates.push('auto_assign_port = ?')
      values.push(data.auto_assign_port ? 1 : 0)
    }
    if (data.last_accessed_at !== undefined) {
      updates.push('last_accessed_at = ?')
      values.push(data.last_accessed_at)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getProject(id)
  }

  /**
   * Replace the member project ids of a connection project (`projects.member_project_ids`),
   * in the given order. Null for a project that is not a connection project.
   */
  updateConnectionProjectMembers(id: string, memberProjectIds: string[]): Project | null {
    const db = this.getDb()
    const existing = this.getProject(id)
    if (!existing || existing.kind !== 'connection') return null
    db.prepare('UPDATE projects SET member_project_ids = ? WHERE id = ?').run(
      JSON.stringify(memberProjectIds),
      id
    )
    emitDbChanged({ entity: 'project', op: 'update', id, projectId: id })
    return this.getProject(id)
  }

  updateProjectKanbanStorageMode(id: string, mode: KanbanStorageMode): Project | null {
    const db = this.getDb()
    if (!this.getProject(id)) return null
    db.prepare('UPDATE projects SET kanban_storage_mode = ? WHERE id = ?').run(mode, id)
    return this.getProject(id)
  }

  updateProjectKanbanMarkdownConfig(id: string, config: string | null): Project | null {
    const db = this.getDb()
    if (!this.getProject(id)) return null
    db.prepare('UPDATE projects SET kanban_markdown_config = ? WHERE id = ?').run(config, id)
    return this.getProject(id)
  }

  deleteProject(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return result.changes > 0
  }

  touchProject(id: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare('UPDATE projects SET last_accessed_at = ? WHERE id = ?').run(now, id)
  }

  // Data projects (DataProjectsRepository, src/main/services/data-projects/contracts.ts).
  // Rows of their own table; only the sidebar order is shared with `projects`.

  /**
   * Moves every git project and data project down one slot so a new item lands on top; the
   * counts tell the caller whether the other kind moved (and needs a reorder event).
   */
  private shiftSidebarOrder(): { projects: number; dataProjects: number } {
    const db = this.getDb()
    const projects = db.prepare('UPDATE projects SET sort_order = sort_order + 1').run().changes
    const dataProjects = db
      .prepare('UPDATE data_projects SET sort_order = sort_order + 1')
      .run().changes
    return { projects, dataProjects }
  }

  /**
   * Row → record. Unknown enum values from a newer build degrade to the conservative choice
   * (safe mode 'safe'), never to something that would run writes unconfirmed.
   */
  private mapDataProjectRow(row: DataProjectRow): DataProjectRecord | null {
    if (!isDataEngine(row.engine)) return null
    const environment: DataEnvironment = (DATA_ENVIRONMENTS as readonly string[]).includes(
      row.environment
    )
      ? (row.environment as DataEnvironment)
      : 'development'
    const safeMode: DataSafeMode = (DATA_SAFE_MODES as readonly string[]).includes(row.safe_mode)
      ? (row.safe_mode as DataSafeMode)
      : 'safe'
    const secretState: DataSecretState =
      row.secret_state === 'none' || row.secret_state === 'stored' || row.secret_state === 'session'
        ? row.secret_state
        : row.secret_ciphertext
          ? 'stored'
          : 'none'
    return {
      id: row.id,
      name: row.name,
      engine: row.engine,
      config: parseJsonObject(row.config) ?? {},
      icon: parseDataProjectIcon(row.icon),
      iconColor: row.icon_color ?? null,
      environment,
      color: row.color ?? null,
      safeMode,
      defaultLimit: normalizeDataLimit(row.default_limit),
      allowAiDataAccess: Boolean(row.allow_ai_data_access),
      pinned: Boolean(row.pinned),
      secretCiphertext: row.secret_ciphertext ?? null,
      secretState,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at
    }
  }

  getDataProjects(): DataProjectRecord[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM data_projects ORDER BY sort_order ASC, last_accessed_at DESC')
      .all() as DataProjectRow[]
    const records: DataProjectRecord[] = []
    for (const row of rows) {
      const record = this.mapDataProjectRow(row)
      if (record) records.push(record)
    }
    return records
  }

  getDataProject(id: string): DataProjectRecord | null {
    const row = this.getDb().prepare('SELECT * FROM data_projects WHERE id = ?').get(id) as
      DataProjectRow | undefined
    return row ? this.mapDataProjectRow(row) : null
  }

  createDataProject(data: DataProjectRecordCreate): DataProjectRecord {
    const db = this.getDb()
    const now = new Date().toISOString()
    const id = data.id ?? randomUUID()
    let shiftedProjects = 0
    // One transaction: a failed insert must not leave the whole sidebar shifted by one.
    db.transaction(() => {
      shiftedProjects = this.shiftSidebarOrder().projects
      db.prepare(
        `INSERT INTO data_projects (id, name, engine, config, icon, icon_color, environment, color,
           safe_mode, default_limit, allow_ai_data_access, pinned, secret_ciphertext, secret_state,
           sort_order, created_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(
        id,
        data.name,
        data.engine,
        JSON.stringify(data.config ?? {}),
        data.icon ? JSON.stringify(data.icon) : null,
        data.iconColor,
        data.environment,
        data.color,
        data.safeMode,
        normalizeDataLimit(data.defaultLimit),
        data.allowAiDataAccess ? 1 : 0,
        data.pinned ? 1 : 0,
        data.secretCiphertext,
        data.secretState,
        now,
        now
      )
    })()
    const created = this.getDataProject(id)
    if (!created) throw new Error('Failed to create data project')
    emitDbChanged({ entity: 'dataProject', op: 'create', id, projectId: null })
    // Every git project moved down one slot too.
    if (shiftedProjects > 0) {
      emitDbChanged({ entity: 'project', op: 'reorder', id: null, projectId: null })
    }
    return created
  }

  updateDataProject(id: string, patch: DataProjectRecordPatch): DataProjectRecord | null {
    const db = this.getDb()
    const existing = this.getDataProject(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number | null)[] = []
    const set = (column: string, value: string | number | null): void => {
      updates.push(`${column} = ?`)
      values.push(value)
    }
    if (patch.name !== undefined) set('name', patch.name)
    if (patch.config !== undefined) set('config', JSON.stringify(patch.config ?? {}))
    if (patch.icon !== undefined) set('icon', patch.icon ? JSON.stringify(patch.icon) : null)
    if (patch.iconColor !== undefined) set('icon_color', patch.iconColor)
    if (patch.environment !== undefined) set('environment', patch.environment)
    if (patch.color !== undefined) set('color', patch.color)
    if (patch.safeMode !== undefined) set('safe_mode', patch.safeMode)
    if (patch.defaultLimit !== undefined)
      set('default_limit', normalizeDataLimit(patch.defaultLimit))
    if (patch.allowAiDataAccess !== undefined) {
      set('allow_ai_data_access', patch.allowAiDataAccess ? 1 : 0)
    }
    if (patch.pinned !== undefined) set('pinned', patch.pinned ? 1 : 0)
    if (patch.secretCiphertext !== undefined) set('secret_ciphertext', patch.secretCiphertext)
    if (patch.secretState !== undefined) set('secret_state', patch.secretState)

    if (updates.length === 0) return existing
    values.push(id)
    db.prepare(`UPDATE data_projects SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    emitDbChanged({ entity: 'dataProject', op: 'update', id, projectId: null })
    return this.getDataProject(id)
  }

  /** Deletes the row; its history and saved queries go with it (ON DELETE CASCADE). */
  deleteDataProject(id: string): boolean {
    const result = this.getDb().prepare('DELETE FROM data_projects WHERE id = ?').run(id)
    if (result.changes > 0) {
      emitDbChanged({ entity: 'dataProject', op: 'delete', id, projectId: null })
    }
    return result.changes > 0
  }

  touchDataProject(id: string): void {
    const now = new Date().toISOString()
    const result = this.getDb()
      .prepare('UPDATE data_projects SET last_accessed_at = ? WHERE id = ?')
      .run(now, id)
    if (result.changes > 0) {
      emitDbChanged({ entity: 'dataProject', op: 'update', id, projectId: null })
    }
  }

  /**
   * The merged sidebar order: `sort_order = index` across both tables in one transaction (ids
   * are UUIDs, so a git project and a data project never collide).
   */
  reorderSidebar(entries: SidebarOrderEntry[]): void {
    const db = this.getDb()
    const projectStmt = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    const dataStmt = db.prepare('UPDATE data_projects SET sort_order = ? WHERE id = ?')
    db.transaction(() => {
      entries.forEach((entry, index) => {
        if (entry.kind === 'data') dataStmt.run(index, entry.id)
        else projectStmt.run(index, entry.id)
      })
    })()
    emitDbChanged({ entity: 'project', op: 'reorder', id: null, projectId: null })
    emitDbChanged({ entity: 'dataProject', op: 'reorder', id: null, projectId: null })
  }

  private mapDataHistoryRow(row: DataQueryHistoryRow): DataHistoryEntry {
    return {
      id: row.id,
      dataProjectId: row.data_project_id,
      database: row.database_name ?? null,
      text: row.text,
      status: DATA_HISTORY_STATUSES.has(row.status)
        ? (row.status as DataHistoryEntry['status'])
        : 'error',
      durationMs: row.duration_ms ?? null,
      rowCount: row.row_count ?? null,
      error: row.error ?? null,
      executedAt: row.executed_at
    }
  }

  /**
   * Appends one history entry and prunes the project's history to the newest
   * DATA_QUERY_HISTORY_LIMIT rows in the same transaction. No db:changed: history is written on
   * every run and has no cross-client consumer.
   */
  addDataQueryHistory(entry: Omit<DataHistoryEntry, 'id'>): DataHistoryEntry {
    const db = this.getDb()
    const stored: DataHistoryEntry = {
      id: randomUUID(),
      dataProjectId: entry.dataProjectId,
      database: entry.database ?? null,
      text: truncateStored(entry.text, DATA_HISTORY_TEXT_MAX),
      status: entry.status,
      durationMs:
        entry.durationMs === null || !Number.isFinite(entry.durationMs)
          ? null
          : Math.round(entry.durationMs),
      rowCount:
        entry.rowCount === null || !Number.isFinite(entry.rowCount)
          ? null
          : Math.round(entry.rowCount),
      error: entry.error === null ? null : truncateStored(entry.error, DATA_HISTORY_ERROR_MAX),
      executedAt: entry.executedAt || new Date().toISOString()
    }
    db.transaction(() => {
      db.prepare(
        `INSERT INTO data_query_history (id, data_project_id, database_name, text, status,
           duration_ms, row_count, error, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        stored.id,
        stored.dataProjectId,
        stored.database,
        stored.text,
        stored.status,
        stored.durationMs,
        stored.rowCount,
        stored.error,
        stored.executedAt
      )
      db.prepare(
        `DELETE FROM data_query_history WHERE rowid IN (
           SELECT rowid FROM data_query_history WHERE data_project_id = ?
           ORDER BY executed_at DESC, rowid DESC LIMIT -1 OFFSET ?)`
      ).run(stored.dataProjectId, DATA_QUERY_HISTORY_LIMIT)
    })()
    return stored
  }

  listDataQueryHistory(
    dataProjectId: string,
    options: { search?: string; limit?: number } = {}
  ): DataHistoryEntry[] {
    const limit =
      options.limit !== undefined && Number.isFinite(options.limit)
        ? Math.min(Math.max(Math.floor(options.limit), 1), DATA_QUERY_HISTORY_LIMIT)
        : 200
    const search = options.search?.trim() ?? ''
    const rows = (
      search
        ? this.getDb()
            .prepare(
              `SELECT * FROM data_query_history
               WHERE data_project_id = ? AND text LIKE ? ESCAPE '\\'
               ORDER BY executed_at DESC, rowid DESC LIMIT ?`
            )
            .all(dataProjectId, `%${escapeLike(search)}%`, limit)
        : this.getDb()
            .prepare(
              `SELECT * FROM data_query_history WHERE data_project_id = ?
               ORDER BY executed_at DESC, rowid DESC LIMIT ?`
            )
            .all(dataProjectId, limit)
    ) as DataQueryHistoryRow[]
    return rows.map((row) => this.mapDataHistoryRow(row))
  }

  clearDataQueryHistory(dataProjectId: string): void {
    this.getDb()
      .prepare('DELETE FROM data_query_history WHERE data_project_id = ?')
      .run(dataProjectId)
  }

  private mapDataSavedQueryRow(row: DataSavedQueryRow): DataSavedQuery {
    return {
      id: row.id,
      dataProjectId: row.data_project_id,
      name: row.name,
      text: row.text,
      database: row.database_name ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  listDataSavedQueries(dataProjectId: string): DataSavedQuery[] {
    const rows = this.getDb()
      .prepare(
        `SELECT * FROM data_saved_queries WHERE data_project_id = ?
         ORDER BY name COLLATE NOCASE ASC, created_at ASC`
      )
      .all(dataProjectId) as DataSavedQueryRow[]
    return rows.map((row) => this.mapDataSavedQueryRow(row))
  }

  /**
   * Updates the saved query `query.id` when it belongs to this data project, otherwise inserts a
   * new one under a fresh id (an id from another project is never reused or overwritten).
   */
  saveDataSavedQuery(
    dataProjectId: string,
    query: { id?: string; name: string; text: string; database?: string | null }
  ): DataSavedQuery {
    const db = this.getDb()
    const now = new Date().toISOString()
    const database = query.database ?? null
    let id: string | null = null
    if (query.id) {
      const result = db
        .prepare(
          `UPDATE data_saved_queries SET name = ?, text = ?, database_name = ?, updated_at = ?
           WHERE id = ? AND data_project_id = ?`
        )
        .run(query.name, query.text, database, now, query.id, dataProjectId)
      if (result.changes > 0) id = query.id
    }
    if (!id) {
      id = randomUUID()
      db.prepare(
        `INSERT INTO data_saved_queries (id, data_project_id, name, text, database_name,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, dataProjectId, query.name, query.text, database, now, now)
    }
    const row = db.prepare('SELECT * FROM data_saved_queries WHERE id = ?').get(id) as
      DataSavedQueryRow | undefined
    if (!row) throw new Error('Failed to save the query')
    emitDbChanged({ entity: 'dataProject', op: 'update', id: dataProjectId, projectId: null })
    return this.mapDataSavedQueryRow(row)
  }

  deleteDataSavedQuery(dataProjectId: string, savedId: string): void {
    const result = this.getDb()
      .prepare('DELETE FROM data_saved_queries WHERE id = ? AND data_project_id = ?')
      .run(savedId, dataProjectId)
    if (result.changes > 0) {
      emitDbChanged({ entity: 'dataProject', op: 'update', id: dataProjectId, projectId: null })
    }
  }

  // Worktree operations
  createWorktree(data: WorktreeCreate): Worktree {
    const db = this.getDb()
    const now = new Date().toISOString()
    const isDefault = data.is_default ?? false
    const worktree: Worktree = {
      id: randomUUID(),
      project_id: data.project_id,
      name: data.name,
      branch_name: data.branch_name,
      path: data.path,
      status: 'active',
      is_default: isDefault,
      branch_renamed: 0,
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
      base_branch: data.base_branch ?? null,
      created_at: now,
      last_accessed_at: now
    }

    db.prepare(
      `INSERT INTO worktrees (id, project_id, name, branch_name, path, status, is_default, branch_renamed, base_branch, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      worktree.id,
      worktree.project_id,
      worktree.name,
      worktree.branch_name,
      worktree.path,
      worktree.status,
      isDefault ? 1 : 0,
      worktree.branch_renamed,
      worktree.base_branch,
      worktree.created_at,
      worktree.last_accessed_at
    )

    return worktree
  }

  getWorktree(id: string): Worktree | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapWorktreeRow(row) : null
  }

  getWorktreeByPath(path: string): Worktree | null {
    const db = this.getDb()
    const row = db
      .prepare("SELECT * FROM worktrees WHERE path = ? AND status = 'active'")
      .get(path) as Record<string, unknown> | undefined
    return row ? this.mapWorktreeRow(row) : null
  }

  getWorktreesByProject(projectId: string): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        'SELECT * FROM worktrees WHERE project_id = ? ORDER BY is_default ASC, last_accessed_at DESC'
      )
      .all(projectId) as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  getActiveWorktreesByProject(projectId: string): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM worktrees WHERE project_id = ? AND status = 'active' ORDER BY is_default ASC, last_accessed_at DESC"
      )
      .all(projectId) as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  // Every active worktree across all projects in one query. Feeds the sidebar's
  // bulk hydrate so a project filter never needs a per-project round trip.
  getAllActiveWorktrees(): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM worktrees WHERE status = 'active' ORDER BY project_id ASC, is_default ASC, last_accessed_at DESC"
      )
      .all() as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  getDiscordResourcesByGuild(guildId: string): DiscordResource[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM discord_resources WHERE guild_id = ? ORDER BY created_at ASC')
      .all(guildId) as DiscordResource[]
  }

  getDiscordResourcesByProject(projectId: string): DiscordResource[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM discord_resources WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as DiscordResource[]
  }

  getDiscordChannelResourceByWorktree(worktreeId: string): DiscordResource | null {
    const db = this.getDb()
    const row = db
      .prepare(
        "SELECT * FROM discord_resources WHERE worktree_id = ? AND type = 'channel' ORDER BY created_at ASC LIMIT 1"
      )
      .get(worktreeId) as DiscordResource | undefined
    return row ?? null
  }

  insertDiscordResource(data: DiscordResourceCreate): DiscordResource {
    const db = this.getDb()
    const resource: DiscordResource = {
      id: data.id ?? randomUUID(),
      project_id: data.project_id,
      worktree_id: data.worktree_id,
      discord_id: data.discord_id,
      type: data.type,
      guild_id: data.guild_id,
      managed_session_id: data.managed_session_id ?? null,
      created_at: data.created_at ?? new Date().toISOString()
    }
    db.prepare(
      `INSERT INTO discord_resources
        (id, project_id, worktree_id, discord_id, type, guild_id, managed_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      resource.id,
      resource.project_id,
      resource.worktree_id,
      resource.discord_id,
      resource.type,
      resource.guild_id,
      resource.managed_session_id,
      resource.created_at
    )
    return resource
  }

  setDiscordResourceManagedSession(
    resourceId: string,
    sessionId: string | null
  ): DiscordResource | null {
    const db = this.getDb()
    db.prepare('UPDATE discord_resources SET managed_session_id = ? WHERE id = ?').run(
      sessionId,
      resourceId
    )
    const row = db.prepare('SELECT * FROM discord_resources WHERE id = ?').get(resourceId) as
      | DiscordResource
      | undefined
    return row ?? null
  }

  deleteDiscordResource(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM discord_resources WHERE id = ?').run(id)
    return result.changes > 0
  }

  getRecentlyActiveWorktrees(cutoffMs: number): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM worktrees WHERE status = 'active' AND last_message_at IS NOT NULL AND last_message_at > ? ORDER BY last_message_at DESC"
      )
      .all(cutoffMs) as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  getPinnedWorktrees(): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM worktrees WHERE status = 'active' AND pinned = 1 ORDER BY last_accessed_at DESC"
      )
      .all() as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  getPinnedConnections(): ConnectionWithMembers[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM connections WHERE status = 'active' AND pinned = 1 ORDER BY updated_at DESC"
      )
      .all() as Connection[]

    return rows.map((row) => {
      const members = db
        .prepare(
          `SELECT cm.*, w.name as worktree_name, w.branch_name as worktree_branch,
                  w.path as worktree_path, p.name as project_name
           FROM connection_members cm
           JOIN worktrees w ON cm.worktree_id = w.id
           JOIN projects p ON cm.project_id = p.id
           WHERE cm.connection_id = ?
           ORDER BY cm.added_at ASC`
        )
        .all(row.id) as ConnectionWithMembers['members']
      return { ...row, members }
    })
  }

  updateWorktree(id: string, data: WorktreeUpdate): Worktree | null {
    const db = this.getDb()
    const existing = this.getWorktree(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.branch_name !== undefined) {
      updates.push('branch_name = ?')
      values.push(data.branch_name)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
    }
    if (data.branch_renamed !== undefined) {
      updates.push('branch_renamed = ?')
      values.push(data.branch_renamed)
    }
    if (data.last_message_at !== undefined) {
      updates.push('last_message_at = ?')
      values.push(data.last_message_at)
    }
    if (data.pinned !== undefined) {
      updates.push('pinned = ?')
      values.push(data.pinned)
    }
    if (data.last_accessed_at !== undefined) {
      updates.push('last_accessed_at = ?')
      values.push(data.last_accessed_at)
    }
    if (data.teleported_to !== undefined) {
      updates.push('teleported_to = ?')
      values.push(data.teleported_to)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE worktrees SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    // Keep the project's default (main, no-worktree) row at least as recent as
    // any worktree bump, so the project retains its recency for sorting even
    // after the worktree is archived or deleted. MAX guards against regressing
    // the default row when older timestamps are re-persisted (e.g. hydration).
    if (data.last_message_at !== undefined && data.last_message_at !== null && !existing.is_default) {
      db.prepare(
        `UPDATE worktrees
         SET last_message_at = MAX(COALESCE(last_message_at, 0), ?)
         WHERE project_id = ? AND is_default = 1`
      ).run(data.last_message_at, existing.project_id)
    }

    return this.getWorktree(id)
  }

  deleteWorktree(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM worktrees WHERE id = ?').run(id)
    return result.changes > 0
  }

  archiveWorktree(id: string): Worktree | null {
    return this.updateWorktree(id, { status: 'archived' })
  }

  /**
   * Re-point the branch a worktree's work is merged into. Not part of `WorktreeUpdate` (and so
   * of the RPC) on purpose: only the document flow calls it, for task worktrees recorded
   * against a run's integration branch before v57.
   */
  setWorktreeBaseBranch(id: string, baseBranch: string): boolean {
    const projectId = this.lookupWorktreeProjectId(id)
    const result = this.getDb()
      .prepare('UPDATE worktrees SET base_branch = ? WHERE id = ?')
      .run(baseBranch, id)
    if (result.changes > 0) emitDbChanged({ entity: 'worktree', op: 'update', id, projectId })
    return result.changes > 0
  }

  touchWorktree(id: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare('UPDATE worktrees SET last_accessed_at = ? WHERE id = ?').run(now, id)
  }

  updateWorktreeContext(worktreeId: string, context: string | null): void {
    const db = this.getDb()
    db.prepare('UPDATE worktrees SET context = ? WHERE id = ?').run(context, worktreeId)
  }

  /**
   * Append a session title to the worktree's session_titles JSON array.
   * Skips duplicates.
   */
  appendSessionTitle(worktreeId: string, title: string): void {
    const db = this.getDb()
    const row = db.prepare('SELECT session_titles FROM worktrees WHERE id = ?').get(worktreeId) as
      | Record<string, unknown>
      | undefined
    const titles: string[] = JSON.parse((row?.session_titles as string) || '[]')
    if (!titles.includes(title)) {
      titles.push(title)
      db.prepare('UPDATE worktrees SET session_titles = ? WHERE id = ?').run(
        JSON.stringify(titles),
        worktreeId
      )
    }
  }

  /**
   * Add an attachment to a worktree's attachments JSON array.
   * Rejects duplicates by URL.
   */
  addAttachment(
    worktreeId: string,
    attachment: { type: 'jira' | 'figma'; url: string; label: string }
  ): { success: boolean; error?: string } {
    const db = this.getDb()
    const row = db.prepare('SELECT attachments FROM worktrees WHERE id = ?').get(worktreeId) as
      | Record<string, unknown>
      | undefined
    if (!row) return { success: false, error: 'Worktree not found' }
    const attachments: Array<{
      id: string
      type: string
      url: string
      label: string
      created_at: string
    }> = JSON.parse((row.attachments as string) || '[]')
    if (attachments.some((a) => a.url === attachment.url)) {
      return { success: false, error: 'Already attached' }
    }
    const id = randomUUID()
    attachments.push({
      id,
      type: attachment.type,
      url: attachment.url,
      label: attachment.label,
      created_at: new Date().toISOString()
    })
    db.prepare('UPDATE worktrees SET attachments = ? WHERE id = ?').run(
      JSON.stringify(attachments),
      worktreeId
    )
    return { success: true }
  }

  /**
   * Remove an attachment from a worktree by attachment ID.
   */
  removeAttachment(worktreeId: string, attachmentId: string): { success: boolean; error?: string } {
    const db = this.getDb()
    const row = db.prepare('SELECT attachments FROM worktrees WHERE id = ?').get(worktreeId) as
      | Record<string, unknown>
      | undefined
    if (!row) return { success: false, error: 'Worktree not found' }
    const attachments: Array<{ id: string }> = JSON.parse((row.attachments as string) || '[]')
    const filtered = attachments.filter((a) => a.id !== attachmentId)
    if (filtered.length === attachments.length) {
      return { success: false, error: 'Attachment not found' }
    }
    db.prepare('UPDATE worktrees SET attachments = ? WHERE id = ?').run(
      JSON.stringify(filtered),
      worktreeId
    )
    return { success: true }
  }

  /**
   * Attach a GitHub PR to a worktree.
   */
  attachPR(
    worktreeId: string,
    prNumber: number,
    prUrl: string
  ): { success: boolean; error?: string } {
    const db = this.getDb()
    const row = db.prepare('SELECT id FROM worktrees WHERE id = ?').get(worktreeId)
    if (!row) return { success: false, error: 'Worktree not found' }
    db.prepare('UPDATE worktrees SET github_pr_number = ?, github_pr_url = ? WHERE id = ?').run(
      prNumber,
      prUrl,
      worktreeId
    )
    return { success: true }
  }

  /**
   * Detach a GitHub PR from a worktree.
   */
  detachPR(worktreeId: string): { success: boolean; error?: string } {
    const db = this.getDb()
    const row = db.prepare('SELECT id FROM worktrees WHERE id = ?').get(worktreeId)
    if (!row) return { success: false, error: 'Worktree not found' }
    db.prepare(
      'UPDATE worktrees SET github_pr_number = NULL, github_pr_url = NULL WHERE id = ?'
    ).run(worktreeId)
    return { success: true }
  }

  /**
   * Update the last-used model for a worktree.
   */
  updateWorktreeModel(
    worktreeId: string,
    modelProviderId: string,
    modelId: string,
    modelVariant: string | null
  ): void {
    const db = this.getDb()
    db.prepare(
      `UPDATE worktrees
       SET last_model_provider_id = ?, last_model_id = ?, last_model_variant = ?
       WHERE id = ?`
    ).run(modelProviderId, modelId, modelVariant, worktreeId)
  }

  /**
   * Look up the worktree that owns a given session.
   */
  getWorktreeBySessionId(sessionId: string): Worktree | null {
    const session = this.getSession(sessionId)
    if (!session?.worktree_id) return null
    return this.getWorktree(session.worktree_id)
  }

  // Session operations
  createSession(data: SessionCreate): Session {
    const db = this.getDb()
    const now = new Date().toISOString()
    const session: Session = {
      id: randomUUID(),
      worktree_id: data.worktree_id,
      project_id: data.project_id,
      connection_id: data.connection_id ?? null,
      name: data.name ?? null,
      status: 'active',
      opencode_session_id: data.opencode_session_id ?? null,
      claude_session_id: data.claude_session_id ?? null,
      agent_sdk: data.agent_sdk ?? 'opencode',
      custom_provider_id: data.custom_provider_id ?? null,
      mode: data.mode ?? 'build',
      session_type: data.session_type ?? 'default',
      model_provider_id: data.model_provider_id ?? null,
      model_id: data.model_id ?? null,
      model_variant: data.model_variant ?? null,
      remote_launch: data.remote_launch ?? null,
      shell_command: data.shell_command ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null,
      pinned_to_board: false
    }

    db.prepare(
      `INSERT INTO sessions (id, worktree_id, project_id, connection_id, name, status, opencode_session_id, claude_session_id, agent_sdk, custom_provider_id, mode, session_type, model_provider_id, model_id, model_variant, remote_launch, shell_command, created_at, updated_at, completed_at, pinned_to_board)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.worktree_id,
      session.project_id,
      session.connection_id,
      session.name,
      session.status,
      session.opencode_session_id,
      session.claude_session_id,
      session.agent_sdk,
      session.custom_provider_id,
      session.mode,
      session.session_type,
      session.model_provider_id,
      session.model_id,
      session.model_variant,
      session.remote_launch,
      session.shell_command ?? null,
      session.created_at,
      session.updated_at,
      session.completed_at,
      0
    )

    return session
  }

  getSession(id: string): Session | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapSessionRow(row) : null
  }

  getSessionByOpenCodeSessionId(opencodeSessionId: string): Session | null {
    const db = this.getDb()
    const row = db
      .prepare('SELECT * FROM sessions WHERE opencode_session_id = ? LIMIT 1')
      .get(opencodeSessionId) as Record<string, unknown> | undefined
    return row ? this.mapSessionRow(row) : null
  }

  // Role-qualified: when host and client share a DB (self-launch), one
  // launchId matches BOTH the host-role and client-role rows, and an
  // unqualified LIMIT 1 could hand either caller the other side's row.
  findSessionByRemoteLaunchId(launchId: string, role: 'client' | 'host'): Session | null {
    const db = this.getDb()
    const row = db
      .prepare(
        "SELECT * FROM sessions WHERE json_extract(remote_launch, '$.launchId') = ? AND json_extract(remote_launch, '$.role') = ? LIMIT 1"
      )
      .get(launchId, role) as Record<string, unknown> | undefined
    return row ? this.mapSessionRow(row) : null
  }

  getAgentSdkForSession(agentSessionId: string): AgentSdk | null {
    const db = this.getDb()
    const row = db
      .prepare('SELECT agent_sdk FROM sessions WHERE opencode_session_id = ? LIMIT 1')
      .get(agentSessionId) as { agent_sdk: AgentSdk } | undefined
    return row?.agent_sdk ?? null
  }

  getSessionsByWorktree(worktreeId: string): Session[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM sessions WHERE worktree_id = ? ORDER BY updated_at DESC')
      .all(worktreeId) as Record<string, unknown>[]
    return rows.map((row) => this.mapSessionRow(row))
  }

  getSessionsByProject(projectId: string): Session[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as Record<string, unknown>[]
    return rows.map((row) => this.mapSessionRow(row))
  }

  getActiveSessionsByWorktree(worktreeId: string): Session[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM sessions WHERE worktree_id = ? AND status = 'active' ORDER BY updated_at DESC"
      )
      .all(worktreeId) as Record<string, unknown>[]
    return rows.map((row) => this.mapSessionRow(row))
  }

  /**
   * Session profiler enrichment: one row per requested id (also for ids with no
   * session row), joined to its worktree / connection, project, the ticket that
   * points at it (non-archived first, then the most recently updated) and
   * whether a live document run still needs the session.
   */
  getSessionProfilerRows(ids: readonly string[]): SessionProfilerDbRow[] {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    const db = this.getDb()
    const out: SessionProfilerDbRow[] = []
    // Well under SQLite's bound-parameter limit even on old builds.
    const CHUNK = 400
    for (let start = 0; start < unique.length; start += CHUNK) {
      const chunk = unique.slice(start, start + CHUNK)
      const values = chunk.map(() => '(?)').join(', ')
      const rows = db
        .prepare(
          `WITH ids(id) AS (VALUES ${values})
           SELECT ids.id AS id,
                  s.id AS session_row_id,
                  s.name AS session_name,
                  s.status AS session_status,
                  s.agent_sdk AS agent_sdk,
                  w.name AS worktree_name,
                  w.path AS worktree_path,
                  w.status AS worktree_status,
                  c.name AS connection_name,
                  c.path AS connection_path,
                  p.name AS project_name,
                  k.id AS ticket_id,
                  k.title AS ticket_title,
                  k."column" AS ticket_column,
                  k.archived_at AS ticket_archived_at,
                  k.project_id AS ticket_project_id,
                  EXISTS (
                    SELECT 1 FROM document_run_items di
                    JOIN document_runs dr ON dr.id = di.run_id
                    WHERE (di.session_id = ids.id OR di.fix_session_id = ids.id)
                      AND dr.status IN ('running', 'paused')
                      AND di.selected = 1
                      AND (
                        di.status NOT IN ('merged', 'skipped', 'cancelled')
                        OR di.document_update_status IN ('queued', 'updating')
                      )
                  ) AS document_run_busy
           FROM ids
           LEFT JOIN sessions s ON s.id = ids.id
           LEFT JOIN worktrees w ON w.id = s.worktree_id
           LEFT JOIN connections c ON c.id = s.connection_id
           LEFT JOIN projects p ON p.id = s.project_id
           LEFT JOIN kanban_tickets k ON k.id = (
             -- One session can serve several tickets (pre-assign, bulk handoffs): a live
             -- ticket (not archived, not done / merged) wins, so the row only reads as
             -- "ticket done" once no live ticket rides the session — the same rule the
             -- renderer's Done / archive close follows (isSessionSharedWithLiveTicket).
             SELECT kt.id FROM kanban_tickets kt
             WHERE kt.current_session_id = ids.id
             ORDER BY (kt.archived_at IS NOT NULL) ASC,
                      (kt."column" IN ('done', 'merged')) ASC,
                      kt.updated_at DESC
             LIMIT 1
           )`
        )
        .all(...chunk) as Record<string, unknown>[]
      for (const row of rows) {
        const str = (key: string): string | null =>
          typeof row[key] === 'string' ? (row[key] as string) : null
        out.push({
          id: String(row.id),
          sessionExists: row.session_row_id != null,
          name: str('session_name'),
          status: str('session_status'),
          agentSdk: str('agent_sdk'),
          worktreeName: str('worktree_name') ?? str('connection_name'),
          worktreePath: str('worktree_path') ?? str('connection_path'),
          worktreeArchived: row.worktree_status === 'archived',
          projectName: str('project_name'),
          ticket:
            row.ticket_id == null
              ? null
              : {
                  id: String(row.ticket_id),
                  title: str('ticket_title') ?? '',
                  column: str('ticket_column') ?? '',
                  archived: row.ticket_archived_at != null,
                  projectId: str('ticket_project_id')
                },
          documentRunBusy: Number(row.document_run_busy) === 1
        })
      }
    }
    return out
  }

  getSessionByClaudeSessionId(claudeSessionId: string): Session | null {
    const db = this.getDb()
    const row = db
      .prepare('SELECT * FROM sessions WHERE claude_session_id = ? LIMIT 1')
      .get(claudeSessionId) as Record<string, unknown> | undefined
    return row ? this.mapSessionRow(row) : null
  }

  getActiveBoardAssistantByProject(projectId: string): Session | null {
    const db = this.getDb()
    const row = db
      .prepare(
        "SELECT * FROM sessions WHERE project_id = ? AND session_type = 'board-assistant' AND status = 'active' ORDER BY updated_at DESC LIMIT 1"
      )
      .get(projectId) as Record<string, unknown> | undefined
    return row ? this.mapSessionRow(row) : null
  }

  countActiveSessions(): number {
    const db = this.getDb()
    const row = db
      .prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'active'")
      .get() as { count: number } | undefined
    return row?.count ?? 0
  }

  updateSession(id: string, data: SessionUpdate): Session | null {
    const db = this.getDb()
    const existing = this.getSession(id)
    if (!existing) return null

    const updates: string[] = ['updated_at = ?']
    const values: (string | number | null)[] = [new Date().toISOString()]

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
    }
    if (data.opencode_session_id !== undefined) {
      updates.push('opencode_session_id = ?')
      values.push(data.opencode_session_id)
    }
    if (data.claude_session_id !== undefined) {
      updates.push('claude_session_id = ?')
      values.push(data.claude_session_id)
    }
    if (data.agent_sdk !== undefined) {
      updates.push('agent_sdk = ?')
      values.push(data.agent_sdk)
    }
    if (data.custom_provider_id !== undefined) {
      updates.push('custom_provider_id = ?')
      values.push(data.custom_provider_id)
    }
    if (data.mode !== undefined) {
      updates.push('mode = ?')
      values.push(data.mode)
    }
    if (data.session_type !== undefined) {
      updates.push('session_type = ?')
      values.push(data.session_type)
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
    if (data.remote_launch !== undefined) {
      updates.push('remote_launch = ?')
      values.push(data.remote_launch)
    }
    if (data.shell_command !== undefined) {
      updates.push('shell_command = ?')
      values.push(data.shell_command)
    }
    if (data.completed_at !== undefined) {
      updates.push('completed_at = ?')
      values.push(data.completed_at)
    }
    if (data.pinned_to_board !== undefined) {
      updates.push('pinned_to_board = ?')
      values.push(data.pinned_to_board ? 1 : 0)
    }

    values.push(id)
    db.prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getSession(id)
  }

  deleteSession(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    // The usage reporter's rows have no foreign key (they may outlive a wiped sessions table
    // in tests and repairs): drop them with the session so nothing orphans. The recorded
    // final message is keyed the same way, and holds the session's last assistant text.
    db.prepare('DELETE FROM session_usage_state WHERE hive_session_id = ?').run(id)
    db.prepare('DELETE FROM session_final_messages WHERE session_id = ?').run(id)
    return result.changes > 0
  }

  getPinnedSessions(worktreeId: string): Session[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        'SELECT * FROM sessions WHERE pinned_to_board = 1 AND worktree_id = ? ORDER BY updated_at DESC'
      )
      .all(worktreeId) as Record<string, unknown>[]
    return rows.map((row) => this.mapSessionRow(row))
  }

  /** Shell-command sessions whose persisted run state is one of `states` (startup reconcile). */
  getShellCommandSessionsInStates(states: readonly string[]): Session[] {
    if (states.length === 0) return []
    const db = this.getDb()
    const placeholders = states.map(() => '?').join(', ')
    // json_extract raises on malformed JSON, so guard it: one bad row must not break the reconcile.
    const rows = db
      .prepare(
        `SELECT * FROM sessions
         WHERE session_type = 'shell-command' AND shell_command IS NOT NULL
           AND CASE WHEN json_valid(shell_command)
                    THEN json_extract(shell_command, '$.state') END IN (${placeholders})`
      )
      .all(...states) as Record<string, unknown>[]
    return rows.map((row) => this.mapSessionRow(row))
  }

  /** Run snapshot of every shell-command session, newest first (the renderer's run index). */
  getShellCommandRunRows(limit = 1000): Array<{
    sessionId: string
    projectId: string
    worktreeId: string | null
    shellCommand: string
  }> {
    const db = this.getDb()
    const rows = db
      .prepare(
        `SELECT id, project_id, worktree_id, shell_command FROM sessions
         WHERE session_type = 'shell-command' AND shell_command IS NOT NULL
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      id: string
      project_id: string
      worktree_id: string | null
      shell_command: string
    }>
    return rows.map((row) => ({
      sessionId: row.id,
      projectId: row.project_id,
      worktreeId: row.worktree_id,
      shellCommand: row.shell_command
    }))
  }

  searchSessions(options: SessionSearchOptions): SessionWithWorktree[] {
    const db = this.getDb()
    const conditions: string[] = []
    const values: (string | null)[] = []

    let query = `
      SELECT
        s.*,
        w.name as worktree_name,
        w.branch_name as worktree_branch_name,
        p.name as project_name,
        c.name as connection_name
      FROM sessions s
      LEFT JOIN worktrees w ON s.worktree_id = w.id
      LEFT JOIN projects p ON s.project_id = p.id
      LEFT JOIN connections c ON s.connection_id = c.id
    `

    if (options.keyword) {
      conditions.push(`(
        s.name LIKE ? OR
        p.name LIKE ? OR
        w.name LIKE ? OR
        w.branch_name LIKE ? OR
        c.name LIKE ?
      )`)
      const keyword = `%${options.keyword}%`
      values.push(keyword, keyword, keyword, keyword, keyword)
    }

    if (options.project_id) {
      conditions.push('s.project_id = ?')
      values.push(options.project_id)
    }

    if (options.worktree_id) {
      conditions.push('s.worktree_id = ?')
      values.push(options.worktree_id)
    }

    if (options.dateFrom) {
      conditions.push('s.created_at >= ?')
      values.push(options.dateFrom)
    }

    if (options.dateTo) {
      conditions.push('s.created_at <= ?')
      values.push(options.dateTo)
    }

    if (!options.includeArchived) {
      conditions.push("(w.status = 'active' OR w.id IS NULL)")
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ')
    }

    query += ' ORDER BY s.updated_at DESC'

    const rows = db.prepare(query).all(...values) as Record<string, unknown>[]
    return rows.map((row) => this.mapSessionRow(row) as SessionWithWorktree)
  }

  // Session draft operations
  getSessionDraft(sessionId: string): string | null {
    const db = this.getDb()
    const row = db.prepare('SELECT draft_input FROM sessions WHERE id = ?').get(sessionId) as
      | { draft_input: string | null }
      | undefined
    return row?.draft_input ?? null
  }

  updateSessionDraft(sessionId: string, draft: string | null): void {
    const db = this.getDb()
    db.prepare('UPDATE sessions SET draft_input = ? WHERE id = ?').run(draft, sessionId)
  }

  // Session message operations
  createSessionMessage(data: SessionMessageCreate): SessionMessage {
    const db = this.getDb()
    const now = data.created_at ?? new Date().toISOString()
    const message: SessionMessage = {
      id: randomUUID(),
      session_id: data.session_id,
      role: data.role,
      content: data.content,
      opencode_message_id: data.opencode_message_id ?? null,
      opencode_message_json: data.opencode_message_json ?? null,
      opencode_parts_json: data.opencode_parts_json ?? null,
      opencode_timeline_json: data.opencode_timeline_json ?? null,
      created_at: now
    }

    db.prepare(
      `INSERT INTO session_messages (
        id,
        session_id,
        role,
        content,
        opencode_message_id,
        opencode_message_json,
        opencode_parts_json,
        opencode_timeline_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      message.id,
      message.session_id,
      message.role,
      message.content,
      message.opencode_message_id,
      message.opencode_message_json,
      message.opencode_parts_json,
      message.opencode_timeline_json,
      message.created_at
    )

    // Update session updated_at
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id)

    return message
  }

  updateSessionMessage(id: string, data: SessionMessageUpdate): SessionMessage | null {
    const db = this.getDb()
    const existing = db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id) as
      | SessionMessage
      | undefined
    if (!existing) return null

    const updates: string[] = []
    const values: (string | null)[] = []

    if (data.content !== undefined) {
      updates.push('content = ?')
      values.push(data.content)
    }
    if (data.opencode_message_json !== undefined) {
      updates.push('opencode_message_json = ?')
      values.push(data.opencode_message_json)
    }
    if (data.opencode_parts_json !== undefined) {
      updates.push('opencode_parts_json = ?')
      values.push(data.opencode_parts_json)
    }
    if (data.opencode_timeline_json !== undefined) {
      updates.push('opencode_timeline_json = ?')
      values.push(data.opencode_timeline_json)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE session_messages SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    const updated = db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id) as
      | SessionMessage
      | undefined
    if (!updated) return null

    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      updated.session_id
    )

    return updated
  }

  getSessionMessageByOpenCodeId(
    sessionId: string,
    opencodeMessageId: string
  ): SessionMessage | null {
    const db = this.getDb()
    const row = db
      .prepare(
        `SELECT * FROM session_messages
         WHERE session_id = ? AND opencode_message_id = ?
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(sessionId, opencodeMessageId) as SessionMessage | undefined
    return row ?? null
  }

  upsertSessionMessageByOpenCodeId(data: SessionMessageUpsertByOpenCode): SessionMessage {
    const existing = this.getSessionMessageByOpenCodeId(data.session_id, data.opencode_message_id)
    if (existing) {
      const updated = this.updateSessionMessage(existing.id, {
        content: data.content,
        opencode_message_json: data.opencode_message_json ?? existing.opencode_message_json,
        opencode_parts_json: data.opencode_parts_json ?? existing.opencode_parts_json,
        opencode_timeline_json: data.opencode_timeline_json ?? existing.opencode_timeline_json
      })
      if (!updated) return existing
      return updated
    }

    return this.createSessionMessage({
      session_id: data.session_id,
      role: data.role,
      content: data.content,
      opencode_message_id: data.opencode_message_id,
      opencode_message_json: data.opencode_message_json ?? null,
      opencode_parts_json: data.opencode_parts_json ?? null,
      opencode_timeline_json: data.opencode_timeline_json ?? null,
      created_at: data.created_at
    })
  }

  getSessionMessages(sessionId: string): SessionMessage[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as SessionMessage[]
  }

  deleteSessionMessage(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM session_messages WHERE id = ?').run(id)
    return result.changes > 0
  }

  replaceSessionMessages(sessionId: string, messages: SessionMessageCreate[]): SessionMessage[] {
    const db = this.getDb()
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
      const created: SessionMessage[] = []
      for (const message of messages) {
        created.push(
          this.createSessionMessage({
            ...message,
            session_id: sessionId
          })
        )
      }
      return created
    })
    return tx()
  }

  upsertSessionActivity(data: SessionActivityCreate): SessionActivity {
    const db = this.getDb()
    const now = data.created_at ?? new Date().toISOString()
    const id = data.id ?? randomUUID()

    db.prepare(
      `INSERT INTO session_activities (
        id,
        session_id,
        agent_session_id,
        thread_id,
        turn_id,
        item_id,
        request_id,
        kind,
        tone,
        summary,
        payload_json,
        sequence,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent_session_id = excluded.agent_session_id,
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        item_id = excluded.item_id,
        request_id = excluded.request_id,
        kind = excluded.kind,
        tone = excluded.tone,
        summary = excluded.summary,
        payload_json = excluded.payload_json,
        sequence = excluded.sequence,
        created_at = excluded.created_at`
    ).run(
      id,
      data.session_id,
      data.agent_session_id ?? null,
      data.thread_id ?? null,
      data.turn_id ?? null,
      data.item_id ?? null,
      data.request_id ?? null,
      data.kind,
      data.tone,
      data.summary,
      data.payload_json ?? null,
      data.sequence ?? null,
      now
    )

    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id)

    const row = db.prepare('SELECT * FROM session_activities WHERE id = ?').get(id) as
      | SessionActivity
      | undefined
    if (!row) {
      throw new Error(`Failed to load session activity after upsert: ${id}`)
    }
    return row
  }

  getSessionActivities(sessionId: string): SessionActivity[] {
    const db = this.getDb()
    return db
      .prepare(
        `SELECT * FROM session_activities
         WHERE session_id = ?
         ORDER BY
           CASE WHEN sequence IS NULL THEN 1 ELSE 0 END,
           sequence ASC,
           created_at ASC,
           id ASC`
      )
      .all(sessionId) as SessionActivity[]
  }

  deleteSessionActivities(sessionId: string): number {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM session_activities WHERE session_id = ?').run(sessionId)
    return result.changes
  }

  // Connection operations
  createConnection(data: ConnectionCreate): Connection {
    const db = this.getDb()
    const now = new Date().toISOString()
    const connection: Connection = {
      id: randomUUID(),
      name: data.name,
      custom_name: data.custom_name ?? null,
      path: data.path,
      color: data.color ?? null,
      pinned: 0,
      status: 'active',
      saved_project_id: data.saved_project_id ?? null,
      is_base: data.is_base ? 1 : 0,
      created_at: now,
      updated_at: now
    }

    db.prepare(
      `INSERT INTO connections (id, name, custom_name, path, color, status, saved_project_id, is_base, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      connection.id,
      connection.name,
      connection.custom_name,
      connection.path,
      connection.color,
      connection.status,
      connection.saved_project_id,
      connection.is_base,
      connection.created_at,
      connection.updated_at
    )

    return connection
  }

  getConnection(id: string): ConnectionWithMembers | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
      | Connection
      | undefined
    if (!row) return null

    const members = db
      .prepare(
        `SELECT cm.*, w.name as worktree_name, w.branch_name as worktree_branch,
                w.path as worktree_path, p.name as project_name
         FROM connection_members cm
         JOIN worktrees w ON cm.worktree_id = w.id
         JOIN projects p ON cm.project_id = p.id
         WHERE cm.connection_id = ?
         ORDER BY cm.added_at ASC`
      )
      .all(id) as ConnectionWithMembers['members']

    return { ...row, members }
  }

  getAllConnections(): ConnectionWithMembers[] {
    const db = this.getDb()
    const rows = db
      .prepare("SELECT * FROM connections WHERE status = 'active' ORDER BY updated_at DESC")
      .all() as Connection[]

    return rows.map((row) => {
      const members = db
        .prepare(
          `SELECT cm.*, w.name as worktree_name, w.branch_name as worktree_branch,
                  w.path as worktree_path, p.name as project_name
           FROM connection_members cm
           JOIN worktrees w ON cm.worktree_id = w.id
           JOIN projects p ON cm.project_id = p.id
           WHERE cm.connection_id = ?
           ORDER BY cm.added_at ASC`
        )
        .all(row.id) as ConnectionWithMembers['members']
      return { ...row, members }
    })
  }

  updateConnection(id: string, data: Partial<Connection>): Connection | null {
    const db = this.getDb()
    const existing = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
      | Connection
      | undefined
    if (!existing) return null

    const updates: string[] = ['updated_at = ?']
    const values: (string | number | null)[] = [new Date().toISOString()]

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.custom_name !== undefined) {
      updates.push('custom_name = ?')
      values.push(data.custom_name ?? null)
    }
    if (data.path !== undefined) {
      updates.push('path = ?')
      values.push(data.path)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
    }
    if (data.color !== undefined) {
      updates.push('color = ?')
      values.push(data.color)
    }
    if (data.pinned !== undefined) {
      updates.push('pinned = ?')
      values.push(data.pinned)
    }
    if (data.saved_project_id !== undefined) {
      updates.push('saved_project_id = ?')
      values.push(data.saved_project_id)
    }
    if (data.is_base !== undefined) {
      updates.push('is_base = ?')
      values.push(data.is_base ? 1 : 0)
    }

    values.push(id)
    db.prepare(`UPDATE connections SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Connection
  }

  deleteConnection(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM connections WHERE id = ?').run(id)
    return result.changes > 0
  }

  /**
   * Demote base instances that lost their project (saved_project_id nulled by the
   * FK when a project row was deleted by a path that could not take the base
   * down first, e.g. an older build). They become ordinary, deletable connections.
   * Returns the number of rows repaired.
   */
  clearOrphanedBaseFlags(): number {
    const db = this.getDb()
    const result = db
      .prepare(
        `UPDATE connections SET is_base = 0, updated_at = ?
         WHERE is_base = 1 AND saved_project_id IS NULL`
      )
      .run(new Date().toISOString())
    return result.changes
  }

  /**
   * The BASE instance of a connection project (connections.is_base = 1 linked via
   * saved_project_id) — the connection-project twin of a project's default worktree.
   */
  getBaseConnectionForProject(projectId: string): ConnectionWithMembers | null {
    const db = this.getDb()
    const row = db
      .prepare(
        `SELECT * FROM connections
         WHERE saved_project_id = ? AND is_base = 1 AND status = 'active'
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(projectId) as Connection | undefined
    if (!row) return null
    return this.getConnection(row.id)
  }

  createConnectionMember(data: ConnectionMemberCreate): ConnectionMember {
    const db = this.getDb()
    const now = new Date().toISOString()
    const member: ConnectionMember = {
      id: randomUUID(),
      connection_id: data.connection_id,
      worktree_id: data.worktree_id,
      project_id: data.project_id,
      symlink_name: data.symlink_name,
      added_at: now
    }

    db.prepare(
      `INSERT INTO connection_members (id, connection_id, worktree_id, project_id, symlink_name, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      member.id,
      member.connection_id,
      member.worktree_id,
      member.project_id,
      member.symlink_name,
      member.added_at
    )

    return member
  }

  deleteConnectionMember(connectionId: string, worktreeId: string): boolean {
    const db = this.getDb()
    const result = db
      .prepare('DELETE FROM connection_members WHERE connection_id = ? AND worktree_id = ?')
      .run(connectionId, worktreeId)
    return result.changes > 0
  }

  getConnectionMembersByWorktree(worktreeId: string): ConnectionMember[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM connection_members WHERE worktree_id = ?')
      .all(worktreeId) as ConnectionMember[]
  }

  upsertConnectionHistory(projectIds: string[]): ConnectionHistoryEntry | null {
    const distinct = [...new Set(projectIds)].sort()
    if (distinct.length < 2) return null

    const db = this.getDb()
    const key = distinct.join('|')
    const now = new Date().toISOString()

    db.prepare(
      `INSERT INTO connection_history (id, project_set_key, project_ids, last_used_at, use_count, created_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(project_set_key) DO UPDATE SET
         last_used_at = excluded.last_used_at,
         use_count = connection_history.use_count + 1`
    ).run(randomUUID(), key, JSON.stringify(distinct), now, now)

    return db
      .prepare('SELECT * FROM connection_history WHERE project_set_key = ?')
      .get(key) as ConnectionHistoryEntry
  }

  setConnectionHistoryNote(id: string, note: string | null): boolean {
    const db = this.getDb()
    const result = db.prepare('UPDATE connection_history SET note = ? WHERE id = ?').run(note, id)
    return result.changes > 0
  }

  getRecentConnectionHistory(limit = 50): ConnectionHistoryEntry[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM connection_history ORDER BY last_used_at DESC LIMIT ?')
      .all(limit) as ConnectionHistoryEntry[]
  }

  getActiveSessionsByConnection(connectionId: string): Session[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM sessions WHERE connection_id = ? AND status = 'active' ORDER BY updated_at DESC"
      )
      .all(connectionId) as Record<string, unknown>[]
    return rows.map((row) => this.mapSessionRow(row))
  }

  getSessionsByConnection(connectionId: string): Session[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM sessions WHERE connection_id = ? ORDER BY updated_at DESC')
      .all(connectionId) as Record<string, unknown>[]
    return rows.map((row) => this.mapSessionRow(row))
  }

  // Space operations
  createSpace(data: SpaceCreate): Space {
    const db = this.getDb()
    const now = new Date().toISOString()

    // New spaces get sort_order at the end
    const maxOrder = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM spaces')
      .get() as { max_order: number }

    const space: Space = {
      id: randomUUID(),
      name: data.name,
      icon_type: data.icon_type ?? 'default',
      icon_value: data.icon_value ?? 'Folder',
      sort_order: maxOrder.max_order + 1,
      created_at: now
    }

    db.prepare(
      `INSERT INTO spaces (id, name, icon_type, icon_value, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      space.id,
      space.name,
      space.icon_type,
      space.icon_value,
      space.sort_order,
      space.created_at
    )

    return space
  }

  getSpace(id: string): Space | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space | undefined
    return row ?? null
  }

  listSpaces(): Space[] {
    const db = this.getDb()
    return db.prepare('SELECT * FROM spaces ORDER BY sort_order ASC').all() as Space[]
  }

  updateSpace(id: string, data: SpaceUpdate): Space | null {
    const db = this.getDb()
    const existing = this.getSpace(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.icon_type !== undefined) {
      updates.push('icon_type = ?')
      values.push(data.icon_type)
    }
    if (data.icon_value !== undefined) {
      updates.push('icon_value = ?')
      values.push(data.icon_value)
    }
    if (data.sort_order !== undefined) {
      updates.push('sort_order = ?')
      values.push(data.sort_order)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE spaces SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getSpace(id)
  }

  deleteSpace(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
    return result.changes > 0
  }

  reorderSpaces(orderedIds: string[]): void {
    const db = this.getDb()
    const stmt = db.prepare('UPDATE spaces SET sort_order = ? WHERE id = ?')
    const tx = db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run(i, orderedIds[i])
      }
    })
    tx()
  }

  // Project-Space assignment operations
  assignProjectToSpace(projectId: string, spaceId: string): void {
    const db = this.getDb()
    db.prepare('INSERT OR IGNORE INTO project_spaces (project_id, space_id) VALUES (?, ?)').run(
      projectId,
      spaceId
    )
  }

  removeProjectFromSpace(projectId: string, spaceId: string): void {
    const db = this.getDb()
    db.prepare('DELETE FROM project_spaces WHERE project_id = ? AND space_id = ?').run(
      projectId,
      spaceId
    )
  }

  getProjectIdsForSpace(spaceId: string): string[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT project_id FROM project_spaces WHERE space_id = ?')
      .all(spaceId) as { project_id: string }[]
    return rows.map((r) => r.project_id)
  }

  getAllProjectSpaceAssignments(): ProjectSpaceAssignment[] {
    const db = this.getDb()
    return db
      .prepare('SELECT project_id, space_id FROM project_spaces')
      .all() as ProjectSpaceAssignment[]
  }

  // Utility methods
  private getFileSize(filePath: string): number {
    if (!existsSync(filePath)) return 0
    return statSync(filePath).size
  }

  private getTotalDatabaseFileBytes(): number {
    return this.getFileSize(this.dbPath) + this.getFileSize(`${this.dbPath}-wal`)
  }

  private getPragmaNumber(name: 'freelist_count' | 'page_size' | 'page_count'): number {
    const db = this.getDb()
    const value = db.pragma(name, { simple: true }) as unknown
    return typeof value === 'number' ? value : Number(value) || 0
  }

  getStorageStats(): StorageStats {
    const pageSize = this.getPragmaNumber('page_size')
    const pageCount = this.getPragmaNumber('page_count')
    const freePages = this.getPragmaNumber('freelist_count')
    const dbFileBytes = this.getFileSize(this.dbPath)
    const walFileBytes = this.getFileSize(`${this.dbPath}-wal`)
    const shmFileBytes = this.getFileSize(`${this.dbPath}-shm`)

    return {
      dbFileBytes,
      walFileBytes,
      shmFileBytes,
      totalFileBytes: dbFileBytes + walFileBytes,
      freeBytes: freePages * pageSize,
      pageSize,
      pageCount
    }
  }

  previewCompaction(): CompactionPreview {
    const db = this.getDb()
    const storage = this.getStorageStats()
    const orphanedMessages = db
      .prepare(
        `SELECT
           COUNT(*) AS rows,
           COALESCE(SUM(
             LENGTH(CAST(content AS BLOB)) +
             LENGTH(CAST(COALESCE(opencode_message_json, '') AS BLOB)) +
             LENGTH(CAST(COALESCE(opencode_parts_json, '') AS BLOB)) +
             LENGTH(CAST(COALESCE(opencode_timeline_json, '') AS BLOB))
           ), 0) AS bytes
         FROM session_messages
         WHERE session_id NOT IN (SELECT id FROM sessions)`
      )
      .get() as { rows: number; bytes: number }
    const orphanedActivities = db
      .prepare(
        `SELECT
           COUNT(*) AS rows,
           COALESCE(SUM(
             LENGTH(CAST(summary AS BLOB)) +
             LENGTH(CAST(COALESCE(payload_json, '') AS BLOB))
           ), 0) AS bytes
         FROM session_activities
         WHERE session_id NOT IN (SELECT id FROM sessions)`
      )
      .get() as { rows: number; bytes: number }

    const orphanedBytes = orphanedMessages.bytes + orphanedActivities.bytes
    const estimatedSavedBytes = storage.freeBytes + storage.walFileBytes + orphanedBytes

    return {
      storage,
      reclaimableFreeBytes: storage.freeBytes,
      reclaimableWalBytes: storage.walFileBytes,
      orphaned: {
        rows: {
          messages: orphanedMessages.rows,
          activities: orphanedActivities.rows
        },
        bytes: orphanedBytes
      },
      estimatedSavedBytes
    }
  }

  async compactDatabase(): Promise<CompactionResult> {
    if (this.compactionInProgress) {
      throw new Error('Database compaction is already in progress.')
    }

    this.compactionInProgress = true
    const beforeBytes = this.getTotalDatabaseFileBytes()

    try {
      const db = this.getDb()
      db.pragma('wal_checkpoint(TRUNCATE)')
      this.maintenanceMode = true
      this.close()

      return await runCompactionWorker(this.dbPath, beforeBytes)
    } finally {
      this.maintenanceMode = false
      try {
        this.init()
      } finally {
        this.compactionInProgress = false
      }
    }
  }

  getSchemaVersion(): number {
    const version = this.getSetting('schema_version')
    return version ? parseInt(version, 10) : 0
  }

  // Kanban ticket operations

  /**
   * Inserts the ticket and allocates its running number in one immediate transaction: the
   * `ticket_counters` upsert is a single statement serialised by SQLite's write lock, so two
   * processes creating tickets at once never share a number, and a rolled-back insert does
   * not leave a gap behind (numbers are never reused, gaps from deletes are fine). The prefix
   * is whatever the settings table holds at that moment, null before the first sign-in
   * (stamped later by ensureTicketKeyPrefix).
   */
  createKanbanTicket(data: KanbanTicketCreate): KanbanTicket {
    const ticket = this.transaction(() => this.insertKanbanTicket(data))
    if (this.kanbanBatchDepth === 0) {
      emitDbChanged({ entity: 'ticket', op: 'create', id: ticket.id, projectId: data.project_id })
    }
    return ticket
  }

  private insertKanbanTicket(data: KanbanTicketCreate): KanbanTicket {
    const db = this.getDb()
    const now = new Date().toISOString()

    const id = data.id ?? randomUUID()
    const column = data.column ?? 'todo'
    let sortOrder: number
    if (data.sort_order != null) {
      sortOrder = data.sort_order
    } else {
      const maxRow = db
        .prepare(
          'SELECT MAX(sort_order) as max_sort FROM kanban_tickets WHERE project_id = ? AND "column" = ? AND archived_at IS NULL'
        )
        .get(data.project_id, column) as { max_sort: number | null } | undefined
      sortOrder = (maxRow?.max_sort ?? -1) + 1
    }
    const description = data.description ?? null
    const attachmentsJson = data.attachments ? JSON.stringify(data.attachments) : '[]'
    const currentSessionId = data.current_session_id ?? null
    const worktreeId = data.worktree_id ?? null
    const mode = data.mode ?? null
    const planReady = data.plan_ready ? 1 : 0
    const externalProvider = data.external_provider ?? null
    const externalId = data.external_id ?? null
    const externalUrl = data.external_url ?? null
    const githubPrNumber = data.github_pr_number ?? null
    const githubPrUrl = data.github_pr_url ?? null
    const mark = data.mark ?? null
    const createdFromSession = data.created_from_session ? 1 : 0
    const note = data.note ?? null
    const labelsJson = JSON.stringify(parseTicketLabels(data.labels ?? []))
    const modelProviderId = data.model_provider_id ?? null
    const modelId = data.model_id ?? null
    const modelVariant = data.model_variant ?? null
    const variantGroupId = data.variant_group_id ?? null
    const parentTicketId = data.parent_ticket_id ?? null

    const ticketNumber = this.allocateTicketNumber()
    const ticketPrefix = this.getTicketKeyPrefix()
    const parent = parentTicketId
      ? (db
          .prepare('SELECT ticket_prefix, ticket_number FROM kanban_tickets WHERE id = ?')
          .get(parentTicketId) as
          | { ticket_prefix: string | null; ticket_number: number | null }
          | undefined)
      : undefined

    db.prepare(
      `INSERT INTO kanban_tickets (id, project_id, title, description, attachments, "column", sort_order, current_session_id, worktree_id, mode, plan_ready, external_provider, external_id, external_url, github_pr_number, github_pr_url, mark, created_from_session, note, labels, model_provider_id, model_id, model_variant, variant_group_id, ticket_prefix, ticket_number, parent_ticket_id, created_at, updated_at, column_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.project_id,
      data.title,
      description,
      attachmentsJson,
      column,
      sortOrder,
      currentSessionId,
      worktreeId,
      mode,
      planReady,
      externalProvider,
      externalId,
      externalUrl,
      githubPrNumber,
      githubPrUrl,
      mark,
      createdFromSession,
      note,
      labelsJson,
      modelProviderId,
      modelId,
      modelVariant,
      variantGroupId,
      ticketPrefix,
      ticketNumber,
      parentTicketId,
      now,
      now,
      now
    )

    return this.mapKanbanTicketRow({
      id,
      project_id: data.project_id,
      title: data.title,
      description,
      attachments: attachmentsJson,
      column,
      sort_order: sortOrder,
      current_session_id: currentSessionId,
      worktree_id: worktreeId,
      mode,
      plan_ready: planReady,
      external_provider: externalProvider,
      external_id: externalId,
      external_url: externalUrl,
      github_pr_number: githubPrNumber,
      github_pr_url: githubPrUrl,
      mark,
      created_from_session: createdFromSession,
      note,
      labels: labelsJson,
      model_provider_id: modelProviderId,
      model_id: modelId,
      model_variant: modelVariant,
      variant_group_id: variantGroupId,
      ticket_prefix: ticketPrefix,
      ticket_number: ticketNumber,
      parent_ticket_id: parentTicketId,
      parent_ticket_prefix: parent?.ticket_prefix ?? null,
      parent_ticket_number: parent?.ticket_number ?? null,
      total_tokens: 0,
      created_at: now,
      updated_at: now,
      column_changed_at: now
    })
  }

  // ── Ticket keys (TD-12): prefix, running number, parent link ─────────────

  /** The next running number: one upsert, atomic under the write lock, never reused. */
  private allocateTicketNumber(): number {
    const row = this.getDb()
      .prepare(
        `INSERT INTO ticket_counters (scope, last) VALUES (?, 1)
         ON CONFLICT(scope) DO UPDATE SET last = last + 1
         RETURNING last`
      )
      .get(TICKET_COUNTER_SCOPE) as { last: number }
    return row.last
  }

  /** The organisation prefix stored for this database, null before the first sign-in. */
  getTicketKeyPrefix(): string | null {
    return this.getSetting(TICKET_KEY_PREFIX_SETTING)
  }

  /**
   * Records the prefix derived from the signed-in session, once: the first organisation to
   * sign in on this machine names the keys and a later one does not rename them (the local
   * boards are shared across organisations). Then stamps the prefix on every ticket that has
   * none (created before the first sign-in, or by an older build) and tells the boards.
   * Idempotent and cheap on every later call. Returns the prefix in force.
   */
  ensureTicketKeyPrefix(prefix: string): string {
    const db = this.getDb()
    const affected = this.transaction(() => {
      const existing = this.getSetting(TICKET_KEY_PREFIX_SETTING)
      const effective = existing ?? prefix
      if (!existing) this.setSetting(TICKET_KEY_PREFIX_SETTING, effective)
      const projects = db
        .prepare('SELECT DISTINCT project_id FROM kanban_tickets WHERE ticket_prefix IS NULL')
        .all() as { project_id: string }[]
      if (projects.length > 0) {
        db.prepare('UPDATE kanban_tickets SET ticket_prefix = ? WHERE ticket_prefix IS NULL').run(
          effective
        )
      }
      return { effective, projectIds: projects.map((row) => row.project_id) }
    })
    for (const projectId of affected.projectIds) {
      emitDbChanged({ entity: 'ticket', op: 'batch', id: null, projectId })
    }
    return affected.effective
  }

  /**
   * Idempotent repair for the key columns (v62) and the one-time backfill of existing rows.
   * Runs on every init in every process: a second process that starts at the same time waits
   * on the write lock and then finds nothing left to number.
   */
  private ensureTicketKeys(): void {
    const db = this.getDb()
    this.safeAddColumn('kanban_tickets', 'ticket_prefix', 'TEXT DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'ticket_number', 'INTEGER DEFAULT NULL')
    this.safeAddColumn('kanban_tickets', 'parent_ticket_id', 'TEXT DEFAULT NULL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_counters (
        scope TEXT PRIMARY KEY,
        last INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kanban_tickets_number ON kanban_tickets(ticket_number);
      CREATE INDEX IF NOT EXISTS idx_kanban_tickets_parent ON kanban_tickets(parent_ticket_id);
      CREATE INDEX IF NOT EXISTS idx_document_run_items_ticket ON document_run_items(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_document_run_items_fix_ticket ON document_run_items(fix_ticket_id);
    `)
    try {
      this.backfillTicketKeys()
    } catch (err) {
      console.error(
        '[db] Ticket key backfill failed:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  /**
   * Numbers every ticket that has no number yet and links orchestrator children to their
   * run's ticket. Order: creation order, except that the tickets of one document run stay
   * together at the position of the run's earliest ticket — the run's own ticket first, then
   * its task tickets by document position, then fix tickets — because a launch used to create
   * the children before the parent (and runs from before v57 got their parent much later).
   * Already-numbered rows are untouched, so the sequence continues after the current maximum.
   */
  backfillTicketKeys(): number {
    const db = this.getDb()
    const pending = db
      .prepare('SELECT 1 FROM kanban_tickets WHERE ticket_number IS NULL LIMIT 1')
      .get()
    const unlinked = db
      .prepare(
        `SELECT 1 FROM document_run_items i
         JOIN document_runs r ON r.id = i.run_id
         JOIN kanban_tickets t ON t.id = i.ticket_id OR t.id = i.fix_ticket_id
         WHERE r.ticket_id IS NOT NULL AND t.parent_ticket_id IS NULL AND t.id <> r.ticket_id
         LIMIT 1`
      )
      .get()
    if (!pending && !unlinked) return 0

    return this.transaction(() => {
      // Parent links first: a child created by an older build has none.
      db.prepare(
        `UPDATE kanban_tickets SET parent_ticket_id = (
           SELECT r.ticket_id FROM document_run_items i
           JOIN document_runs r ON r.id = i.run_id
           WHERE (i.ticket_id = kanban_tickets.id OR i.fix_ticket_id = kanban_tickets.id)
             AND r.ticket_id IS NOT NULL AND r.ticket_id <> kanban_tickets.id
           ORDER BY i.position LIMIT 1
         )
         WHERE parent_ticket_id IS NULL AND EXISTS (
           SELECT 1 FROM document_run_items i
           JOIN document_runs r ON r.id = i.run_id
           WHERE (i.ticket_id = kanban_tickets.id OR i.fix_ticket_id = kanban_tickets.id)
             AND r.ticket_id IS NOT NULL AND r.ticket_id <> kanban_tickets.id
         )`
      ).run()

      const rows = db
        .prepare(
          'SELECT id, created_at, rowid AS rid FROM kanban_tickets WHERE ticket_number IS NULL'
        )
        .all() as { id: string; created_at: string; rid: number }[]
      if (rows.length === 0) return 0

      type Membership = { run_id: string; rank: number; pos: number }
      const membership = new Map<string, Membership>()
      const memberRows = db
        .prepare(
          `SELECT r.ticket_id AS ticket_id, r.id AS run_id, 0 AS rank, 0 AS pos
             FROM document_runs r WHERE r.ticket_id IS NOT NULL
           UNION ALL
           SELECT i.ticket_id, i.run_id, 1, i.position
             FROM document_run_items i WHERE i.ticket_id IS NOT NULL
           UNION ALL
           SELECT i.fix_ticket_id, i.run_id, 2, i.position
             FROM document_run_items i WHERE i.fix_ticket_id IS NOT NULL
           ORDER BY rank, pos`
        )
        .all() as { ticket_id: string; run_id: string; rank: number; pos: number }[]
      for (const member of memberRows) {
        if (!membership.has(member.ticket_id)) {
          membership.set(member.ticket_id, {
            run_id: member.run_id,
            rank: member.rank,
            pos: member.pos
          })
        }
      }
      // A run's tickets sit where its earliest (unnumbered) ticket was created.
      const anchors = new Map<string, string>()
      for (const row of rows) {
        const member = membership.get(row.id)
        if (!member) continue
        const anchor = anchors.get(member.run_id)
        if (!anchor || row.created_at < anchor) anchors.set(member.run_id, row.created_at)
      }
      const sortKey = (row: { id: string; created_at: string; rid: number }) => {
        const member = membership.get(row.id)
        return {
          anchor: member ? (anchors.get(member.run_id) ?? row.created_at) : row.created_at,
          group: member ? member.run_id : row.id,
          rank: member?.rank ?? 0,
          pos: member?.pos ?? 0,
          created_at: row.created_at,
          rid: row.rid
        }
      }
      const compare = (a: string | number, b: string | number): number =>
        a < b ? -1 : a > b ? 1 : 0
      const ordered = rows
        .map((row) => ({ row, key: sortKey(row) }))
        .sort(
          (a, b) =>
            compare(a.key.anchor, b.key.anchor) ||
            compare(a.key.group, b.key.group) ||
            compare(a.key.rank, b.key.rank) ||
            compare(a.key.pos, b.key.pos) ||
            compare(a.key.created_at, b.key.created_at) ||
            compare(a.key.rid, b.key.rid)
        )

      // Continue after the counter, not just the highest surviving number: the highest
      // tickets may have been deleted and their keys must not come back on other tickets.
      const { max } = db
        .prepare('SELECT COALESCE(MAX(ticket_number), 0) AS max FROM kanban_tickets')
        .get() as { max: number }
      const counter = db
        .prepare('SELECT last FROM ticket_counters WHERE scope = ?')
        .get(TICKET_COUNTER_SCOPE) as { last: number } | undefined
      const prefix = this.getTicketKeyPrefix()
      const assign = db.prepare(
        'UPDATE kanban_tickets SET ticket_number = ?, ticket_prefix = COALESCE(ticket_prefix, ?) WHERE id = ?'
      )
      let next = Math.max(max, counter?.last ?? 0)
      for (const { row } of ordered) {
        next += 1
        assign.run(next, prefix, row.id)
      }
      db.prepare(
        `INSERT INTO ticket_counters (scope, last) VALUES (?, ?)
         ON CONFLICT(scope) DO UPDATE SET last = MAX(last, excluded.last)`
      ).run(TICKET_COUNTER_SCOPE, next)
      return ordered.length
    })
  }

  createKanbanTicketBatch(data: KanbanTicketBatchCreate): KanbanTicketBatchCreateResult {
    return this.transaction(() => {
      const db = this.getDb()
      const drafts = this.normalizeBatchDrafts(data.drafts)
      const createdTickets: KanbanTicket[] = []
      const createdByDraftKey = new Map<string, KanbanTicket>()

      for (const draft of drafts) {
        const ticket = this.createKanbanTicket({
          project_id: draft.project_id,
          title: draft.title,
          description: draft.description ?? null,
          attachments: draft.attachments ?? [],
          column: draft.column,
          sort_order: draft.sort_order,
          current_session_id: draft.current_session_id,
          worktree_id: draft.worktree_id,
          mode: draft.mode,
          plan_ready: draft.plan_ready,
          external_provider: draft.external_provider,
          external_id: draft.external_id,
          external_url: draft.external_url,
          github_pr_number: draft.github_pr_number,
          github_pr_url: draft.github_pr_url,
          mark: draft.mark,
          note: draft.note,
          labels: draft.labels,
          model_provider_id: draft.model_provider_id,
          model_id: draft.model_id,
          model_variant: draft.model_variant,
          variant_group_id: draft.variant_group_id,
          parent_ticket_id: draft.parent_ticket_id
        })
        createdTickets.push(ticket)
        createdByDraftKey.set(draft.draft_key, ticket)
      }

      const dependencies: TicketDependency[] = []
      for (const draft of drafts) {
        const dependentTicket = createdByDraftKey.get(draft.draft_key)
        if (!dependentTicket) continue

        for (const blockerDraftKey of draft.depends_on) {
          const blockerTicket = createdByDraftKey.get(blockerDraftKey)
          if (!blockerTicket) continue

          const createdAt = new Date().toISOString()
          db.prepare(
            'INSERT INTO ticket_dependencies (dependent_id, blocker_id, created_at) VALUES (?, ?, ?)'
          ).run(dependentTicket.id, blockerTicket.id, createdAt)
          dependencies.push({
            dependent_id: dependentTicket.id,
            blocker_id: blockerTicket.id,
            created_at: createdAt
          })
        }
      }

      return {
        tickets: createdTickets,
        dependencies
      }
    })
  }

  getKanbanTicket(id: string): KanbanTicket | null {
    const db = this.getDb()
    const row = db.prepare(`${KANBAN_TICKET_SELECT} WHERE kt.id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapKanbanTicketRow(row) : null
  }

  getKanbanTicketByExternalId(
    externalProvider: string,
    externalId: string,
    projectId: string
  ): KanbanTicket | null {
    const db = this.getDb()
    const row = db
      .prepare(
        `${KANBAN_TICKET_SELECT} WHERE kt.external_provider = ? AND kt.external_id = ? AND kt.project_id = ?`
      )
      .get(externalProvider, externalId, projectId) as Record<string, unknown> | undefined
    return row ? this.mapKanbanTicketRow(row) : null
  }

  getKanbanTicketsByProject(projectId: string, includeArchived: boolean = false): KanbanTicket[] {
    const db = this.getDb()
    const query = includeArchived
      ? `${KANBAN_TICKET_SELECT} WHERE kt.project_id = ? ORDER BY kt."column" ASC, kt.sort_order ASC`
      : `${KANBAN_TICKET_SELECT} WHERE kt.project_id = ? AND kt.archived_at IS NULL ORDER BY kt."column" ASC, kt.sort_order ASC`
    const rows = db.prepare(query).all(projectId) as Record<string, unknown>[]
    return rows.map((row) => this.mapKanbanTicketRow(row))
  }

  /**
   * Cheap change marker for the ticket autocomplete corpus: moves whenever a
   * ticket is added, removed or edited (`updated_at` is bumped on every write).
   */
  getTicketAutocompleteFingerprint(): string {
    const row = this.getDb()
      .prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM kanban_tickets')
      .get() as { n: number; u: string | null }
    return `${row.n}:${row.u ?? ''}`
  }

  /**
   * Text the user typed themselves, oldest first, for the ticket autocomplete
   * model: titles and descriptions. Imported tickets (Jira, GitHub), tickets
   * generated from a session and mega-plan tickets were not typed by the user
   * and would teach someone else's phrasing, so they are left out. `note` is
   * private and never leaves the ticket, so it is left out too, and so are
   * `labels` (display-only tags that must never reach a model).
   */
  getTicketAutocompleteCorpus(): string[] {
    const rows = this.getDb()
      .prepare(
        `SELECT title, description FROM kanban_tickets
         WHERE external_provider IS NULL AND created_from_session = 0 AND mega_plan_id IS NULL
         ORDER BY created_at ASC`
      )
      .all() as { title: string; description: string | null }[]
    const documents: string[] = []
    for (const row of rows) {
      if (row.title.trim()) documents.push(row.title)
      if (row.description?.trim()) documents.push(row.description)
    }
    return documents
  }

  updateKanbanTicket(id: string, data: KanbanTicketUpdate): KanbanTicket | null {
    const db = this.getDb()
    const existing = this.getKanbanTicket(id)
    if (!existing) return null

    const updates: string[] = ['updated_at = ?']
    const values: (string | number | null)[] = [new Date().toISOString()]

    if (data.title !== undefined) {
      updates.push('title = ?')
      values.push(data.title)
    }
    if (data.description !== undefined) {
      updates.push('description = ?')
      values.push(data.description)
    }
    if (data.attachments !== undefined) {
      updates.push('attachments = ?')
      values.push(JSON.stringify(data.attachments))
    }
    if (data.column !== undefined) {
      updates.push('"column" = ?')
      values.push(data.column)
      if (data.column !== existing.column) {
        updates.push('column_changed_at = ?')
        values.push(values[0]) // same timestamp as updated_at
      }
    }
    if (data.sort_order !== undefined) {
      updates.push('sort_order = ?')
      values.push(data.sort_order)
    }
    if (data.current_session_id !== undefined) {
      updates.push('current_session_id = ?')
      values.push(data.current_session_id)
    }
    if (data.worktree_id !== undefined) {
      updates.push('worktree_id = ?')
      values.push(data.worktree_id)
    }
    if (data.mode !== undefined) {
      updates.push('mode = ?')
      values.push(data.mode)
    }
    if (data.plan_ready !== undefined) {
      updates.push('plan_ready = ?')
      values.push(data.plan_ready ? 1 : 0)
    }
    if (data.github_pr_number !== undefined) {
      updates.push('github_pr_number = ?')
      values.push(data.github_pr_number)
    }
    if (data.github_pr_url !== undefined) {
      updates.push('github_pr_url = ?')
      values.push(data.github_pr_url)
    }
    if (data.mark !== undefined) {
      updates.push('mark = ?')
      values.push(data.mark)
    }
    if (data.archived_at !== undefined) {
      updates.push('archived_at = ?')
      values.push(data.archived_at)
    }
    if (data.pending_launch_config !== undefined) {
      updates.push('pending_launch_config = ?')
      values.push(data.pending_launch_config)
    }
    if (data.goal_mode !== undefined) {
      updates.push('goal_mode = ?')
      values.push(data.goal_mode ? 1 : 0)
    }
    if (data.goal_success_criteria !== undefined) {
      updates.push('goal_success_criteria = ?')
      values.push(data.goal_success_criteria)
    }
    if (data.note !== undefined) {
      updates.push('note = ?')
      values.push(data.note)
    }
    if (data.labels !== undefined) {
      updates.push('labels = ?')
      values.push(JSON.stringify(parseTicketLabels(data.labels)))
    }
    if (data.auto_approve_plan !== undefined) {
      updates.push('auto_approve_plan = ?')
      values.push(data.auto_approve_plan ? 1 : 0)
    }
    // Entering review marks the ticket unread; leaving review clears it. An
    // explicit unread in the update (opening the ticket clears it) wins.
    const derivedUnread =
      data.column !== undefined && data.column !== existing.column
        ? data.column === 'review'
        : undefined
    const unreadValue = data.unread ?? derivedUnread
    if (unreadValue !== undefined) {
      updates.push('unread = ?')
      values.push(unreadValue ? 1 : 0)
    }
    // Awaiting-completion never survives a column change on its own: only the
    // session-sync path sets it explicitly, on an in-progress ticket whose
    // Claude CLI session paused without a detected completion.
    const awaitingValue =
      data.awaiting_completion ?? (derivedUnread !== undefined ? false : undefined)
    if (awaitingValue !== undefined) {
      updates.push('awaiting_completion = ?')
      values.push(awaitingValue ? 1 : 0)
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
    if (data.parent_ticket_id !== undefined) {
      updates.push('parent_ticket_id = ?')
      values.push(data.parent_ticket_id)
    }

    if (updates.length === 1) return existing // Only updated_at, nothing meaningful changed

    values.push(id)
    db.prepare(`UPDATE kanban_tickets SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getKanbanTicket(id)
  }

  deleteKanbanTicket(id: string): boolean {
    const db = this.getDb()

    // Clean up image attachment files from disk
    const ticket = this.getKanbanTicket(id)
    if (ticket) {
      for (const attachment of ticket.attachments) {
        const a = attachment as { type?: string; url?: string }
        if (a.type === 'image' && a.url) {
          deleteAttachment(a.url) // Best-effort, don't fail the delete
        }
      }
    }

    const result = db.prepare('DELETE FROM kanban_tickets WHERE id = ?').run(id)
    return result.changes > 0
  }

  archiveKanbanTicket(id: string): KanbanTicket | null {
    const db = this.getDb()
    const existing = this.getKanbanTicket(id)
    if (!existing) return null
    const now = new Date().toISOString()
    db.prepare('UPDATE kanban_tickets SET archived_at = ?, updated_at = ? WHERE id = ?').run(
      now,
      now,
      id
    )
    return this.getKanbanTicket(id)
  }

  // Favorite ticket template operations (global, cross-project)

  private mapFavoriteTicketRow(row: Record<string, unknown>): FavoriteTicket {
    return {
      id: row.id as string,
      title: row.title as string,
      description: (row.description as string) ?? null,
      goal_mode: row.goal_mode === 1,
      goal_success_criteria: (row.goal_success_criteria as string) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string
    }
  }

  getFavoriteTickets(): FavoriteTicket[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM favorite_tickets ORDER BY created_at DESC')
      .all() as Record<string, unknown>[]
    return rows.map((row) => this.mapFavoriteTicketRow(row))
  }

  getFavoriteTicket(id: string): FavoriteTicket | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM favorite_tickets WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapFavoriteTicketRow(row) : null
  }

  createFavoriteTicket(data: FavoriteTicketCreate): FavoriteTicket {
    const db = this.getDb()
    const now = new Date().toISOString()
    const id = data.id ?? randomUUID()
    const description = data.description ?? null
    const goalMode = data.goal_mode ? 1 : 0
    const goalSuccessCriteria = data.goal_success_criteria ?? null

    db.prepare(
      `INSERT INTO favorite_tickets (id, title, description, goal_mode, goal_success_criteria, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, data.title, description, goalMode, goalSuccessCriteria, now, now)

    return this.mapFavoriteTicketRow({
      id,
      title: data.title,
      description,
      goal_mode: goalMode,
      goal_success_criteria: goalSuccessCriteria,
      created_at: now,
      updated_at: now
    })
  }

  updateFavoriteTicket(id: string, data: FavoriteTicketUpdate): FavoriteTicket | null {
    const db = this.getDb()
    const existing = this.getFavoriteTicket(id)
    if (!existing) return null

    const updates: string[] = ['updated_at = ?']
    const values: (string | number | null)[] = [new Date().toISOString()]

    if (data.title !== undefined) {
      updates.push('title = ?')
      values.push(data.title)
    }
    if (data.description !== undefined) {
      updates.push('description = ?')
      values.push(data.description)
    }
    if (data.goal_mode !== undefined) {
      updates.push('goal_mode = ?')
      values.push(data.goal_mode ? 1 : 0)
    }
    if (data.goal_success_criteria !== undefined) {
      updates.push('goal_success_criteria = ?')
      values.push(data.goal_success_criteria)
    }

    if (updates.length === 1) return existing // Only updated_at, nothing meaningful changed

    values.push(id)
    db.prepare(`UPDATE favorite_tickets SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getFavoriteTicket(id)
  }

  deleteFavoriteTicket(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM favorite_tickets WHERE id = ?').run(id)
    return result.changes > 0
  }

  // Saved ticket labels (global, cross-project catalog; shared/lib/ticket-labels.ts)
  //
  // Tickets carry snapshots of their labels (kanban_tickets.labels and, on markdown boards,
  // markdown_kanban_card_state.labels), so renaming, recolouring, reordering or deleting a
  // catalog entry rewrites every snapshot of it in the same transaction. Those rewrites leave
  // the tickets' updated_at alone: a catalog edit is not an edit of the ticket. One-off labels
  // never get a row here.

  private mapSavedTicketLabelRow(row: Record<string, unknown>): SavedTicketLabel {
    return {
      id: row.id as string,
      name: row.name as string,
      color: row.color as string,
      sort_order: row.sort_order as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string
    }
  }

  /** The catalog in display order (the order a ticket's saved labels are drawn in). */
  getSavedTicketLabels(): SavedTicketLabel[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM ticket_labels ORDER BY sort_order ASC, created_at ASC, id ASC')
      .all() as Record<string, unknown>[]
    return rows.map((row) => this.mapSavedTicketLabelRow(row))
  }

  getSavedTicketLabel(id: string): SavedTicketLabel | null {
    const row = this.getDb().prepare('SELECT * FROM ticket_labels WHERE id = ?').get(id) as
      Record<string, unknown> | undefined
    return row ? this.mapSavedTicketLabelRow(row) : null
  }

  /**
   * Adds a label at the end of the catalog. The name is normalised and must be unique
   * case-insensitively; a colour outside the palette is stored as gray. Throws a user-facing
   * Error on an empty name, a name clash or a full catalog.
   */
  createSavedTicketLabel(data: SavedTicketLabelCreate): SavedTicketLabel {
    const label = this.transaction(() => this.insertSavedTicketLabel(data.name, data.color))
    emitDbChanged({ entity: 'ticketLabel', op: 'create', id: label.id, projectId: null })
    return label
  }

  /**
   * Renames and/or recolours a catalog label and rewrites every ticket snapshot of it, in one
   * transaction. `label` is null when the id is unknown; nothing is written (and no event is
   * emitted) when neither the name nor the colour changes. Throws the same name errors as
   * createSavedTicketLabel.
   */
  updateSavedTicketLabel(id: string, data: SavedTicketLabelUpdate): SavedTicketLabelMutationResult {
    const outcome = withDbChangeBatch(() =>
      this.transaction(() => {
        const existing = this.getSavedTicketLabel(id)
        if (!existing) return { changed: false, label: null, affectedProjectIds: [] }
        const name =
          data.name !== undefined ? this.requireTicketLabelName(data.name) : existing.name
        const color = data.color !== undefined ? ticketLabelColorOrGray(data.color) : existing.color
        if (name === existing.name && color === existing.color) {
          return { changed: false, label: existing, affectedProjectIds: [] }
        }
        const nameKey = ticketLabelNameKey(name)
        this.assertTicketLabelNameFree(nameKey, id)

        const now = new Date().toISOString()
        this.getDb()
          .prepare(
            'UPDATE ticket_labels SET name = ?, name_key = ?, color = ?, updated_at = ? WHERE id = ?'
          )
          .run(name, nameKey, color, now, id)
        const affectedProjectIds = this.rewriteTicketLabelSnapshots(
          { type: 'update', label: { id, name, color } },
          ticketLabelIdPattern(id)
        )
        const label: SavedTicketLabel = { ...existing, name, color, updated_at: now }
        return { changed: true, label, affectedProjectIds }
      })
    )
    if (outcome.changed) {
      this.emitTicketLabelChange('update', id, outcome.affectedProjectIds)
    }
    return { label: outcome.label, affectedProjectIds: outcome.affectedProjectIds }
  }

  /**
   * Puts the catalog in the given order: unknown ids are ignored, and catalog labels missing
   * from the list keep their relative order after the listed ones. Every ticket carrying saved
   * labels has them re-sorted to the new order, in the same transaction.
   */
  reorderSavedTicketLabels(ids: string[]): SavedTicketLabelMutationResult {
    const outcome = withDbChangeBatch(() =>
      this.transaction(() => {
        const catalog = this.getSavedTicketLabels()
        const sortOrderById = new Map(catalog.map((label) => [label.id, label.sort_order]))
        const listed = [...new Set(ids)].filter((id) => sortOrderById.has(id))
        const listedSet = new Set(listed)
        const order = [
          ...listed,
          ...catalog.map((label) => label.id).filter((id) => !listedSet.has(id))
        ]

        // Positions are renumbered 0..n-1; rows already in place are not written.
        const now = new Date().toISOString()
        const setOrder = this.getDb().prepare(
          'UPDATE ticket_labels SET sort_order = ?, updated_at = ? WHERE id = ?'
        )
        let changed = false
        order.forEach((id, index) => {
          if (sortOrderById.get(id) === index) return
          setOrder.run(index, now, id)
          changed = true
        })
        if (!changed) return { changed: false, affectedProjectIds: [] as string[] }

        const affectedProjectIds = this.rewriteTicketLabelSnapshots(
          { type: 'reorder', ids: order },
          '%"saved"%'
        )
        return { changed: true, affectedProjectIds }
      })
    )
    if (outcome.changed) {
      this.emitTicketLabelChange('reorder', null, outcome.affectedProjectIds)
    }
    return { label: null, affectedProjectIds: outcome.affectedProjectIds }
  }

  /**
   * Deletes a catalog label and removes it from every ticket, in one transaction. `label` is
   * the deleted row, or null when the id was not in the catalog; snapshots of the id are swept
   * either way (one may outlive its row by a moment when another window deletes it).
   */
  deleteSavedTicketLabel(id: string): SavedTicketLabelMutationResult {
    const result = withDbChangeBatch(() =>
      this.transaction((): SavedTicketLabelMutationResult => {
        const existing = this.getSavedTicketLabel(id)
        if (existing) this.getDb().prepare('DELETE FROM ticket_labels WHERE id = ?').run(id)
        const affectedProjectIds = this.rewriteTicketLabelSnapshots(
          { type: 'delete', id },
          ticketLabelIdPattern(id)
        )
        return { label: existing, affectedProjectIds }
      })
    )
    this.emitTicketLabelChange(result.label ? 'delete' : null, id, result.affectedProjectIds)
    return result
  }

  /**
   * Saved label id -> number of tickets carrying it, across every project: board tickets
   * (archived included) and markdown cards (runtime rows of cards whose file has vanished are
   * not counted). Only `kind: 'saved'` entries count; a malformed `labels` value counts as none.
   */
  getSavedTicketLabelUsage(): Record<string, number> {
    const rows = this.getDb()
      .prepare(
        `SELECT json_extract(src.labels, je.fullkey || '.id') AS label_id,
                COUNT(DISTINCT src.ticket) AS tickets
         FROM (
           SELECT 'kanban:' || id AS ticket, labels
             FROM kanban_tickets
             WHERE labels LIKE '%"saved"%'
           UNION ALL
           SELECT 'markdown:' || project_id || ':' || card_id AS ticket, labels
             FROM markdown_kanban_card_state
             WHERE labels LIKE '%"saved"%' AND orphaned_at IS NULL
         ) src,
         json_each(
           CASE WHEN json_valid(src.labels) THEN
             CASE json_type(src.labels) WHEN 'array' THEN src.labels END
           END
         ) je
         WHERE json_extract(src.labels, je.fullkey || '.kind') = 'saved'
         GROUP BY label_id`
      )
      .all() as { label_id: unknown; tickets: number }[]
    const usage: Record<string, number> = {}
    for (const row of rows) {
      if (typeof row.label_id === 'string' && row.label_id.length > 0) {
        usage[row.label_id] = row.tickets
      }
    }
    return usage
  }

  /**
   * The catalog label with this name (case-insensitively), created with `color` (gray when it
   * is not a palette colour) when there is none. Used when labels arrive from elsewhere (a
   * ticket moved from another Mac, a backup). Throws like createSavedTicketLabel on an empty
   * name or a full catalog.
   */
  resolveOrCreateSavedTicketLabel(name: string, color: string): SavedTicketLabel {
    const outcome = this.transaction(() => {
      const existing = this.getDb()
        .prepare('SELECT * FROM ticket_labels WHERE name_key = ?')
        .get(ticketLabelNameKey(name)) as Record<string, unknown> | undefined
      if (existing) return { created: false, label: this.mapSavedTicketLabelRow(existing) }
      return { created: true, label: this.insertSavedTicketLabel(name, color) }
    })
    if (outcome.created) {
      emitDbChanged({ entity: 'ticketLabel', op: 'create', id: outcome.label.id, projectId: null })
    }
    return outcome.label
  }

  /** Inserts a catalog row after every existing one. Call inside a transaction. */
  private insertSavedTicketLabel(rawName: string, rawColor: string): SavedTicketLabel {
    const db = this.getDb()
    const name = this.requireTicketLabelName(rawName)
    const nameKey = ticketLabelNameKey(name)
    this.assertTicketLabelNameFree(nameKey, null)
    const stats = db
      .prepare('SELECT COUNT(*) AS count, MAX(sort_order) AS max_sort FROM ticket_labels')
      .get() as { count: number; max_sort: number | null }
    if (stats.count >= SAVED_TICKET_LABELS_MAX) throw new Error('Too many labels')

    const now = new Date().toISOString()
    const label: SavedTicketLabel = {
      id: randomUUID(),
      name,
      color: ticketLabelColorOrGray(rawColor),
      sort_order: (stats.max_sort ?? -1) + 1,
      created_at: now,
      updated_at: now
    }
    db.prepare(
      `INSERT INTO ticket_labels (id, name, name_key, color, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      label.id,
      label.name,
      nameKey,
      label.color,
      label.sort_order,
      label.created_at,
      label.updated_at
    )
    return label
  }

  /** The normalised name; throws the user-facing error when nothing is left of it. */
  private requireTicketLabelName(rawName: string): string {
    const name = normalizeTicketLabelName(rawName)
    if (name.length === 0) throw new Error('Label name is required')
    return name
  }

  /** Throws the user-facing clash error when another catalog label has this name key. */
  private assertTicketLabelNameFree(nameKey: string, exceptId: string | null): void {
    const clash = this.getDb()
      .prepare('SELECT name FROM ticket_labels WHERE name_key = ? AND id IS NOT ?')
      .get(nameKey, exceptId) as { name: string } | undefined
    if (clash) throw new Error(`A label named "${clash.name}" already exists`)
  }

  /**
   * Applies a catalog edit to every ticket snapshot: board tickets and markdown runtime rows
   * of every project, archived and orphaned ones included. `candidatePattern` is a LIKE
   * pattern that pre-selects rows (a superset); each candidate is parsed and only rewritten
   * when the edit changes it. updated_at is left alone. Call inside a transaction. Returns the
   * ids of the projects whose tickets changed, sorted.
   */
  private rewriteTicketLabelSnapshots(
    change: SavedTicketLabelChange,
    candidatePattern: string
  ): string[] {
    const db = this.getDb()
    const affected = new Set<string>()

    const tickets = db
      .prepare(`SELECT id, project_id, labels FROM kanban_tickets WHERE labels LIKE ? ESCAPE '\\'`)
      .all(candidatePattern) as { id: string; project_id: string; labels: string | null }[]
    const setTicketLabels = db.prepare('UPDATE kanban_tickets SET labels = ? WHERE id = ?')
    for (const row of tickets) {
      const current = parseTicketLabels(row.labels)
      const next = applySavedTicketLabelChange(current, change)
      if (next === current) continue
      setTicketLabels.run(JSON.stringify(next), row.id)
      affected.add(row.project_id)
    }

    const cards = db
      .prepare(
        `SELECT project_id, card_id, labels FROM markdown_kanban_card_state WHERE labels LIKE ? ESCAPE '\\'`
      )
      .all(candidatePattern) as { project_id: string; card_id: string; labels: string | null }[]
    const setCardLabels = db.prepare(
      'UPDATE markdown_kanban_card_state SET labels = ? WHERE project_id = ? AND card_id = ?'
    )
    let cardsRewritten = false
    for (const row of cards) {
      const current = parseTicketLabels(row.labels)
      const next = applySavedTicketLabelChange(current, change)
      if (next === current) continue
      setCardLabels.run(JSON.stringify(next), row.project_id, row.card_id)
      affected.add(row.project_id)
      cardsRewritten = true
    }
    if (cardsRewritten) this.markdownLabelSnapshotGeneration += 1

    return [...affected].sort()
  }

  /**
   * Moves (in this process) whenever a catalog edit rewrote label snapshots in
   * markdown_kanban_card_state. The markdown kanban backend caches each board's runtime rows
   * and reloads a cached board whose generation is older, so it never serves stale labels.
   */
  get ticketLabelSnapshotGeneration(): number {
    return this.markdownLabelSnapshotGeneration
  }

  private markdownLabelSnapshotGeneration = 0

  /**
   * After a catalog edit has committed: the catalog event (skipped when `op` is null) and one
   * coarse ticket `batch` event per project whose ticket snapshots were rewritten.
   */
  private emitTicketLabelChange(
    op: 'update' | 'reorder' | 'delete' | null,
    id: string | null,
    affectedProjectIds: readonly string[]
  ): void {
    if (op) emitDbChanged({ entity: 'ticketLabel', op, id, projectId: null })
    for (const projectId of affectedProjectIds) {
      emitDbChanged({ entity: 'ticket', op: 'batch', id: null, projectId })
    }
  }

  archiveAllDoneKanbanTickets(projectId: string, includeMerged = false): number {
    const db = this.getDb()
    const now = new Date().toISOString()
    // includeMerged: when the Merged board column is hidden, merged tickets
    // display inside Done, so "Archive all" must cover them too
    const result = includeMerged
      ? db
          .prepare(
            'UPDATE kanban_tickets SET archived_at = ?, updated_at = ? WHERE project_id = ? AND "column" IN (?, ?) AND archived_at IS NULL'
          )
          .run(now, now, projectId, 'done', 'merged')
      : db
          .prepare(
            'UPDATE kanban_tickets SET archived_at = ?, updated_at = ? WHERE project_id = ? AND "column" = ? AND archived_at IS NULL'
          )
          .run(now, now, projectId, 'done')
    return result.changes
  }

  unarchiveKanbanTicket(id: string): KanbanTicket | null {
    const db = this.getDb()
    const existing = this.getKanbanTicket(id)
    if (!existing) return null
    const now = new Date().toISOString()
    db.prepare('UPDATE kanban_tickets SET archived_at = NULL, updated_at = ? WHERE id = ?').run(
      now,
      id
    )
    return this.getKanbanTicket(id)
  }

  moveKanbanTicket(id: string, column: KanbanTicketColumn, sortOrder: number): KanbanTicket | null {
    const db = this.getDb()
    const existing = this.getKanbanTicket(id)
    if (!existing) return null

    const now = new Date().toISOString()
    if (column !== existing.column) {
      // Entering review marks the ticket unread. awaiting_completion (a Claude
      // CLI session that paused on an in-progress ticket) never survives a
      // column change — a real completion moves the ticket out of in_progress.
      db.prepare(
        'UPDATE kanban_tickets SET "column" = ?, sort_order = ?, updated_at = ?, column_changed_at = ?, unread = ?, awaiting_completion = 0 WHERE id = ?'
      ).run(column, sortOrder, now, now, column === 'review' ? 1 : 0, id)
    } else {
      db.prepare(
        'UPDATE kanban_tickets SET "column" = ?, sort_order = ?, updated_at = ? WHERE id = ?'
      ).run(column, sortOrder, now, id)
    }

    return this.getKanbanTicket(id)
  }

  moveKanbanTicketToProject(id: string, targetProjectId: string): KanbanTicket | null {
    const db = this.getDb()
    const existing = this.getKanbanTicket(id)
    if (!existing) return null

    const targetProject = this.getProject(targetProjectId)
    if (!targetProject) {
      throw new Error(`Target project not found: ${targetProjectId}`)
    }

    // No-op if already in the target project
    if (existing.project_id === targetProjectId) return existing

    // Place at the bottom of the same column in the target project
    const maxRow = db
      .prepare(
        'SELECT MAX(sort_order) as max_sort FROM kanban_tickets WHERE project_id = ? AND "column" = ? AND archived_at IS NULL'
      )
      .get(targetProjectId, existing.column) as { max_sort: number | null } | undefined
    const sortOrder = (maxRow?.max_sort ?? -1) + 1

    const now = new Date().toISOString()
    // Detach worktree/session/PR references that belong to the source project
    db.prepare(
      `UPDATE kanban_tickets
       SET project_id = ?, worktree_id = NULL, current_session_id = NULL,
           github_pr_number = NULL, github_pr_url = NULL, sort_order = ?, updated_at = ?
       WHERE id = ?`
    ).run(targetProjectId, sortOrder, now, id)

    return this.getKanbanTicket(id)
  }

  reorderKanbanTicket(id: string, sortOrder: number): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare('UPDATE kanban_tickets SET sort_order = ?, updated_at = ? WHERE id = ?').run(
      sortOrder,
      now,
      id
    )
  }

  addTicketTokens(ticketId: string, tokens: number): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE kanban_tickets SET total_tokens = total_tokens + ?, updated_at = ? WHERE id = ?'
    ).run(tokens, now, ticketId)
  }

  getKanbanTicketsBySession(sessionId: string): KanbanTicket[] {
    const db = this.getDb()
    const rows = db
      .prepare(`${KANBAN_TICKET_SELECT} WHERE kt.current_session_id = ? ORDER BY kt.sort_order ASC`)
      .all(sessionId) as Record<string, unknown>[]
    return rows.map((row) => this.mapKanbanTicketRow(row))
  }

  syncPRToTickets(worktreeId: string, prNumber: number, prUrl: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE kanban_tickets SET github_pr_number = ?, github_pr_url = ?, updated_at = ? WHERE worktree_id = ?'
    ).run(prNumber, prUrl, now, worktreeId)
  }

  clearPRFromTickets(worktreeId: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE kanban_tickets SET github_pr_number = NULL, github_pr_url = NULL, updated_at = ? WHERE worktree_id = ?'
    ).run(now, worktreeId)
  }

  attachPRToTicket(ticketId: string, projectId: string, prNumber: number, prUrl: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE kanban_tickets SET github_pr_number = ?, github_pr_url = ?, updated_at = ? WHERE id = ? AND project_id = ?'
    ).run(prNumber, prUrl, now, ticketId, projectId)
  }

  detachPRFromTicket(ticketId: string, projectId: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare(
      'UPDATE kanban_tickets SET github_pr_number = NULL, github_pr_url = NULL, updated_at = ? WHERE id = ? AND project_id = ?'
    ).run(now, ticketId, projectId)
  }

  detachWorktreeFromTickets(worktreeId: string): number {
    const db = this.getDb()
    const now = new Date().toISOString()
    const result = db
      .prepare('UPDATE kanban_tickets SET worktree_id = NULL, updated_at = ? WHERE worktree_id = ?')
      .run(now, worktreeId)
    return result.changes
  }

  addTicketDependency(
    dependentId: string,
    blockerId: string
  ): { success: boolean; error?: string } {
    // Fix 1: Self-dependency check (CRITICAL)
    if (dependentId === blockerId) {
      return { success: false, error: 'A ticket cannot depend on itself' }
    }

    return this.transaction(() => {
      const db = this.getDb()

      // Validate same project
      const dependentTicket = db
        .prepare('SELECT project_id FROM kanban_tickets WHERE id = ?')
        .get(dependentId) as { project_id: string } | undefined
      const blockerTicket = db
        .prepare('SELECT project_id FROM kanban_tickets WHERE id = ?')
        .get(blockerId) as { project_id: string } | undefined

      // Fix 3: Separate error messages for non-existent tickets vs same project
      if (!dependentTicket || !blockerTicket) {
        return { success: false, error: 'One or both tickets do not exist' }
      }
      if (dependentTicket.project_id !== blockerTicket.project_id) {
        return { success: false, error: 'Tickets must be in the same project' }
      }

      if (this.wouldCreateTicketDependencyCycle(db, dependentId, blockerId)) {
        return {
          success: false,
          error: 'Adding this dependency would create a circular dependency'
        }
      }

      // Fix 2: Check for existing dependency
      const existing = db
        .prepare('SELECT 1 FROM ticket_dependencies WHERE dependent_id = ? AND blocker_id = ?')
        .get(dependentId, blockerId)
      if (existing) {
        return { success: true } // Idempotent - already exists
      }

      // Safe to insert
      const now = new Date().toISOString()
      db.prepare(
        'INSERT INTO ticket_dependencies (dependent_id, blocker_id, created_at) VALUES (?, ?, ?)'
      ).run(dependentId, blockerId, now)

      return { success: true }
    })
  }

  removeTicketDependency(dependentId: string, blockerId: string): boolean {
    const db = this.getDb()
    const result = db
      .prepare('DELETE FROM ticket_dependencies WHERE dependent_id = ? AND blocker_id = ?')
      .run(dependentId, blockerId)
    return result.changes > 0
  }

  getBlockersForTicket(ticketId: string): KanbanTicket[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        `${KANBAN_TICKET_SELECT}
         JOIN ticket_dependencies td ON td.blocker_id = kt.id
         WHERE td.dependent_id = ?`
      )
      .all(ticketId) as Record<string, unknown>[]
    return rows.map((row) => this.mapKanbanTicketRow(row))
  }

  getDependentsOfTicket(ticketId: string): KanbanTicket[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        `${KANBAN_TICKET_SELECT}
         JOIN ticket_dependencies td ON td.dependent_id = kt.id
         WHERE td.blocker_id = ?`
      )
      .all(ticketId) as Record<string, unknown>[]
    return rows.map((row) => this.mapKanbanTicketRow(row))
  }

  getDependenciesForProject(projectId: string): TicketDependency[] {
    const db = this.getDb()
    return db
      .prepare(
        `SELECT td.* FROM ticket_dependencies td
         JOIN kanban_tickets kt1 ON kt1.id = td.dependent_id
         JOIN kanban_tickets kt2 ON kt2.id = td.blocker_id
         WHERE kt1.project_id = ? AND kt2.project_id = ?`
      )
      .all(projectId, projectId) as TicketDependency[]
  }

  removeAllDependenciesForTicket(ticketId: string): number {
    const db = this.getDb()
    const result = db
      .prepare('DELETE FROM ticket_dependencies WHERE dependent_id = ? OR blocker_id = ?')
      .run(ticketId, ticketId)
    return result.changes
  }

  updateProjectSimpleMode(projectId: string, enabled: boolean): void {
    const db = this.getDb()
    db.prepare('UPDATE projects SET kanban_simple_mode = ? WHERE id = ?').run(
      enabled ? 1 : 0,
      projectId
    )
  }

  updateProjectTrustCheck(projectId: string, done: boolean): void {
    const db = this.getDb()
    db.prepare('UPDATE projects SET trust_check_done = ? WHERE id = ?').run(done ? 1 : 0, projectId)
  }

  // Ticket followup message operations

  createTicketFollowupMessage(data: TicketFollowupMessageCreate): TicketFollowupMessage {
    const db = this.getDb()
    const id = randomUUID()
    const now = new Date().toISOString()
    const sessionId = data.session_id ?? null
    const source = data.source ?? 'direct'
    const role = data.role ?? 'user'

    db.prepare(
      `INSERT INTO ticket_followup_messages (id, ticket_id, content, role, mode, session_id, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, data.ticket_id, data.content, role, data.mode, sessionId, source, now)

    return {
      id,
      ticket_id: data.ticket_id,
      content: data.content,
      role: role as 'user' | 'assistant',
      mode: data.mode as 'build' | 'plan' | 'super-plan' | 'super-build',
      session_id: sessionId,
      source: source as 'direct' | 'supercharge' | 'error_retry',
      created_at: now
    }
  }

  getTicketFollowupMessages(ticketId: string): TicketFollowupMessage[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM ticket_followup_messages WHERE ticket_id = ? ORDER BY created_at ASC')
      .all(ticketId) as TicketFollowupMessage[]
    return rows
  }

  // Diff comment operations

  createDiffComment(data: DiffCommentCreate): DiffComment {
    const db = this.getDb()
    const id = randomUUID()
    const now = new Date().toISOString()
    const lineEnd = data.line_end ?? null
    const anchorText = data.anchor_text ?? null
    const anchorContextBefore = data.anchor_context_before ?? null
    const anchorContextAfter = data.anchor_context_after ?? null

    db.prepare(
      `INSERT INTO diff_comments (id, worktree_id, file_path, line_start, line_end, anchor_text, anchor_context_before, anchor_context_after, body, is_outdated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      id,
      data.worktree_id,
      data.file_path,
      data.line_start,
      lineEnd,
      anchorText,
      anchorContextBefore,
      anchorContextAfter,
      data.body,
      now,
      now
    )

    return {
      id,
      worktree_id: data.worktree_id,
      file_path: data.file_path,
      line_start: data.line_start,
      line_end: lineEnd,
      anchor_text: anchorText,
      anchor_context_before: anchorContextBefore,
      anchor_context_after: anchorContextAfter,
      body: data.body,
      is_outdated: false,
      created_at: now,
      updated_at: now
    }
  }

  getDiffComment(id: string): DiffComment | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM diff_comments WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    return this.mapDiffCommentRow(row)
  }

  getDiffCommentsByWorktree(worktreeId: string): DiffComment[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM diff_comments WHERE worktree_id = ? ORDER BY file_path, line_start')
      .all(worktreeId) as Record<string, unknown>[]
    return rows.map((row) => this.mapDiffCommentRow(row))
  }

  updateDiffComment(id: string, data: DiffCommentUpdate): DiffComment | null {
    const db = this.getDb()
    const existing = this.getDiffComment(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (data.body !== undefined) {
      updates.push('body = ?')
      values.push(data.body)
    }
    if (data.line_start !== undefined) {
      updates.push('line_start = ?')
      values.push(data.line_start)
    }
    if (data.line_end !== undefined) {
      updates.push('line_end = ?')
      values.push(data.line_end)
    }
    if (data.anchor_text !== undefined) {
      updates.push('anchor_text = ?')
      values.push(data.anchor_text)
    }
    if (data.anchor_context_before !== undefined) {
      updates.push('anchor_context_before = ?')
      values.push(data.anchor_context_before)
    }
    if (data.anchor_context_after !== undefined) {
      updates.push('anchor_context_after = ?')
      values.push(data.anchor_context_after)
    }
    if (data.is_outdated !== undefined) {
      updates.push('is_outdated = ?')
      values.push(data.is_outdated ? 1 : 0)
    }

    if (updates.length === 0) return existing

    const now = new Date().toISOString()
    updates.push('updated_at = ?')
    values.push(now)

    values.push(id)
    db.prepare(`UPDATE diff_comments SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getDiffComment(id)
  }

  setDiffCommentOutdated(id: string, isOutdated: boolean): DiffComment | null {
    const db = this.getDb()
    const existing = this.getDiffComment(id)
    if (!existing) return null

    const now = new Date().toISOString()
    db.prepare('UPDATE diff_comments SET is_outdated = ?, updated_at = ? WHERE id = ?').run(
      isOutdated ? 1 : 0,
      now,
      id
    )

    return this.getDiffComment(id)
  }

  deleteDiffComment(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM diff_comments WHERE id = ?').run(id)
    return result.changes > 0
  }

  clearAllDiffComments(worktreeId: string): number {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM diff_comments WHERE worktree_id = ?').run(worktreeId)
    return result.changes
  }

  // Check if tables exist
  tableExists(tableName: string): boolean {
    const db = this.getDb()
    const result = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as { name: string } | undefined
    return !!result
  }

  // Get all indexes
  getIndexes(): { name: string; tbl_name: string }[] {
    const db = this.getDb()
    return db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string; tbl_name: string }[]
  }

  /**
   * Transaction wrapper: BEGIN IMMEDIATE, so the write lock is taken up front. Several
   * processes (this one, the server child, other app instances) write to one WAL database;
   * a deferred transaction that reads first and writes after another process committed fails
   * at once with SQLITE_BUSY_SNAPSHOT, whereas an immediate one waits for busy_timeout. Nested
   * calls become savepoints of the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    const db = this.getDb()
    return db.transaction(fn).immediate()
  }
}

// Singleton instance
let dbService: DatabaseService | null = null

export function getDatabase(): DatabaseService {
  if (!dbService) {
    dbService = new DatabaseService()
    dbService.init()
  }
  return dbService
}

export function closeDatabase(): void {
  if (dbService) {
    dbService.close()
    dbService = null
  }
}
