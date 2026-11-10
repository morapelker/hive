import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DocumentFlowUpdatedEvent } from '@shared/document-flow-events'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  type DocumentRun,
  type DocumentRunEvent,
  type DocumentRunItem,
  type DocumentRunItemDraft,
  type SessionFinalMessage
} from '@shared/types/document-flow'
import type { KanbanTicketBatchCreateItem, KanbanTicketColumn } from '../../db/types'
import type { CreateFromBranchParams, WorktreeResult } from '../worktree-ops'
import type { DocumentFlowDb, DocumentRunItemRowPatch, DocumentRunRowPatch } from './db-port'
import {
  DocumentFlowService,
  type DocumentFlowConnection,
  type DocumentFlowGenerate,
  type DocumentFlowProject,
  type DocumentFlowServiceDeps,
  type DocumentFlowTicket,
  type DocumentFlowTicketDependency,
  type DocumentFlowTicketPatch,
  type DocumentFlowWorktree
} from './document-flow-service'

// Test support for the document-flow suites: an in-memory DocumentFlowDb that behaves like the
// SQLite one where the service can tell the difference, throwaway git repositories, and a
// service wired to fakes. Suites that import this must mock '../logger' themselves.

export interface FakeDocumentFlowDb extends DocumentFlowDb {
  readonly runs: Map<string, DocumentRun>
  readonly items: Map<string, DocumentRunItem>
  readonly events: DocumentRunEvent[]
  readonly finalMessages: Map<string, SessionFinalMessage>
}

const copy = <T>(value: T): T => structuredClone(value)

/** `undefined` means "absent", like the real patch methods. */
const definedEntries = (patch: object): [string, unknown][] =>
  Object.entries(patch).filter(([, value]) => value !== undefined)

export function createFakeDocumentFlowDb(): FakeDocumentFlowDb {
  const runs = new Map<string, DocumentRun>()
  const items = new Map<string, DocumentRunItem>()
  const events: DocumentRunEvent[] = []
  const finalMessages = new Map<string, SessionFinalMessage>()
  let nextEventId = 1
  const nowIso = (): string => new Date().toISOString()

  const itemsOf = (runId: string): DocumentRunItem[] =>
    [...items.values()]
      .filter((item) => item.run_id === runId)
      .sort((a, b) => a.position - b.position)

  const newItem = (
    runId: string,
    draft: DocumentRunItemDraft,
    position: number,
    ticketId: string | null
  ): DocumentRunItem => {
    const now = nowIso()
    const item: DocumentRunItem = {
      id: randomUUID(),
      run_id: runId,
      key: draft.key,
      position,
      title: draft.title,
      summary: draft.summary,
      description: draft.description,
      kind: draft.kind,
      depends_on: [...draft.depends_on],
      has_migration: draft.has_migration,
      size: draft.size,
      conflict_risk: draft.conflict_risk,
      doc_status: draft.doc_status,
      selected: draft.selected,
      figures: copy(draft.figures),
      open_questions: [...draft.open_questions],
      verification_suggested: [...draft.verification_suggested],
      verification: [...draft.verification],
      verification_reason: draft.verification_reason,
      launch_config: draft.launch_config ? copy(draft.launch_config) : null,
      status: 'pending',
      status_detail: null,
      ticket_id: ticketId,
      worktree_id: null,
      connection_id: null,
      members: null,
      session_id: null,
      fix_ticket_id: null,
      fix_session_id: null,
      branch_name: null,
      verdict: null,
      nudge_count: 0,
      conflict_attempts: 0,
      conflict_head: null,
      fix_attempts: 0,
      continue_attempts: 0,
      pre_merge_sha: null,
      merge_sha: null,
      last_prompt_at: null,
      last_checked_at: null,
      retry_at: null,
      wait_until: null,
      wait_timeouts: 0,
      document_update_status: null,
      document_update_detail: null,
      document_update_queued_at: null,
      document_update_attempts: 0,
      document_update_hash: null,
      document_update_report: null,
      document_update_finished_at: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null
    }
    return item
  }

  return {
    runs,
    items,
    events,
    finalMessages,

    createDocumentRun(data) {
      const now = nowIso()
      const run: DocumentRun = {
        id: data.id,
        project_id: data.project_id,
        title: data.title,
        source_kind: data.source_kind ?? 'document',
        source_path: data.source_path,
        run_dir: data.run_dir,
        document_path: data.document_path ?? null,
        status: data.status,
        error: null,
        config: copy(data.config),
        extraction: null,
        base_branch: null,
        base_sha: null,
        integration_branch: null,
        integration_worktree_id: null,
        integration_worktree_path: null,
        integration_connection_id: null,
        integration_connection_path: null,
        members: null,
        ticket_id: null,
        report: null,
        migration_session_id: null,
        migration_started_at: null,
        migration_owner_pid: null,
        runner_client_id: null,
        runner_heartbeat_at: null,
        created_at: now,
        updated_at: now,
        started_at: null,
        finished_at: null
      }
      runs.set(run.id, run)
      return copy(run)
    },

    getDocumentRun(id) {
      const run = runs.get(id)
      return run ? copy(run) : null
    },

    listDocumentRuns(projectId, limit = 50) {
      return [...runs.values()]
        .filter((run) => !projectId || run.project_id === projectId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map(copy)
    },

    updateDocumentRun(id, patch) {
      const run = runs.get(id)
      if (!run) return null
      const entries = definedEntries(patch)
      if (entries.length > 0) {
        Object.assign(run, copy(Object.fromEntries(entries)), { updated_at: nowIso() })
      }
      return copy(run)
    },

    deleteDocumentRun(id) {
      for (const item of itemsOf(id)) items.delete(item.id)
      for (let index = events.length - 1; index >= 0; index--) {
        if (events[index].run_id === id) events.splice(index, 1)
      }
      return runs.delete(id)
    },

    replaceDocumentRunItems(runId, drafts) {
      if (drafts.length > 0 && !runs.has(runId)) throw new Error('FOREIGN KEY constraint failed')
      for (const item of itemsOf(runId)) items.delete(item.id)
      drafts.forEach((draft, position) => {
        const item = newItem(runId, draft, position, null)
        items.set(item.id, item)
      })
      return itemsOf(runId).map(copy)
    },

    insertDocumentRunItems(runId, drafts) {
      if (drafts.length > 0 && !runs.has(runId)) throw new Error('FOREIGN KEY constraint failed')
      const existing = itemsOf(runId)
      const start = existing.length > 0 ? Math.max(...existing.map((item) => item.position)) + 1 : 0
      return drafts.map((draft, index) => {
        const item = newItem(runId, draft, start + index, draft.ticket_id ?? null)
        items.set(item.id, item)
        return copy(item)
      })
    },

    deleteDocumentRunItem(id) {
      return items.delete(id)
    },

    findDocumentRunItemsByTicketId(ticketId) {
      return [...items.values()]
        .filter((item) => item.ticket_id === ticketId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(copy)
    },

    getDocumentRunItems(runId) {
      return itemsOf(runId).map(copy)
    },

    getDocumentRunItem(id) {
      const item = items.get(id)
      return item ? copy(item) : null
    },

    updateDocumentRunItem(id, patch) {
      const item = items.get(id)
      if (!item) return null
      const entries = definedEntries(patch)
      if (entries.length > 0) {
        Object.assign(item, copy(Object.fromEntries(entries)), { updated_at: nowIso() })
      }
      return copy(item)
    },

    appendDocumentRunEvent(data) {
      if (!runs.has(data.run_id)) throw new Error('FOREIGN KEY constraint failed')
      const event: DocumentRunEvent = {
        id: nextEventId++,
        run_id: data.run_id,
        item_id: data.item_id ?? null,
        at: nowIso(),
        type: data.type,
        message: data.message,
        // Stored as JSON: what comes back is the round trip.
        data: data.data === undefined ? null : (JSON.parse(JSON.stringify(data.data)) ?? null)
      }
      events.push(event)
      return copy(event)
    },

    listDocumentRunEvents(runId, limit = 200, type) {
      return events
        .filter((event) => event.run_id === runId && (type === undefined || event.type === type))
        .slice(-limit)
        .map(copy)
    },

    claimDocumentRunRunner(runId, clientId, nowIsoValue, staleBeforeIso) {
      const run = runs.get(runId)
      if (!run) return { owned: false, ownerClientId: null }
      const free =
        run.runner_client_id === null ||
        run.runner_client_id === clientId ||
        run.runner_heartbeat_at === null ||
        run.runner_heartbeat_at < staleBeforeIso
      if (free) {
        run.runner_client_id = clientId
        run.runner_heartbeat_at = nowIsoValue
      }
      return { owned: run.runner_client_id === clientId, ownerClientId: run.runner_client_id }
    },

    upsertSessionFinalMessage(data) {
      const previous = finalMessages.get(data.session_id)
      finalMessages.set(data.session_id, {
        session_id: data.session_id,
        state: data.state ?? 'ended',
        text: data.text ?? previous?.text ?? '',
        completion: data.completion ?? null,
        api_error: data.api_error ?? null,
        hook_event: data.hook_event,
        detail: data.detail ?? null,
        background_work: data.background_work ?? null,
        updated_at: nowIso()
      })
    },

    getSessionFinalMessage(sessionId) {
      const message = finalMessages.get(sessionId)
      return message ? copy(message) : null
    },

    deleteSessionFinalMessage(sessionId) {
      finalMessages.delete(sessionId)
    }
  }
}

/**
 * Point git at an empty global config for the calling process (and so for every git the code
 * under test spawns): a developer's signing, hooks or default-branch settings must not decide
 * whether a test passes. Returns the undo.
 */
export function isolateGitConfig(): () => void {
  const overrides: Record<string, string> = {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Document Flow Test',
    GIT_AUTHOR_EMAIL: 'document-flow@example.test',
    GIT_COMMITTER_NAME: 'Document Flow Test',
    GIT_COMMITTER_EMAIL: 'document-flow@example.test'
  }
  const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const)
  Object.assign(process.env, overrides)
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export interface TestRepo {
  /** Temp directory holding the project and its worktrees. */
  root: string
  /** The main checkout, on `main`, with one base commit. */
  projectPath: string
  baseSha: string
  git: (cwd: string, ...args: string[]) => string
  /** Write `files` (path → content) under `cwd` without committing. */
  write: (cwd: string, files: Record<string, string>) => void
  /** Write `files` and commit them; returns the commit. */
  commit: (cwd: string, message: string, files: Record<string, string>) => string
  /** `git worktree add -b <branch> <root>/worktrees/<branch> <from>`; returns the path. */
  addWorktree: (branch: string, from: string) => string
  cleanup: () => void
}

/** A throwaway repository under the OS temp directory. Call `isolateGitConfig()` first. */
export function createTestRepo(): TestRepo {
  // macOS hands out a symlinked temp path, and git reports real ones.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'docflow-repo-')))
  const projectPath = join(root, 'project')
  mkdirSync(projectPath)

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  const write = (cwd: string, files: Record<string, string>): void => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, file)), { recursive: true })
      writeFileSync(join(cwd, file), content)
    }
  }

  const commit = (cwd: string, message: string, files: Record<string, string>): string => {
    write(cwd, files)
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-m', message)
    return git(cwd, 'rev-parse', 'HEAD')
  }

  git(projectPath, 'init', '-b', 'main')
  const baseSha = commit(projectPath, 'base', {
    'README.md': '# project\n',
    'src/app.ts': 'export const app = 1\n',
    'src/shared.ts': 'export const shared = "base"\n'
  })

  return {
    root,
    projectPath,
    baseSha,
    git,
    write,
    commit,
    addWorktree: (branch, from) => {
      const path = join(root, 'worktrees', branch)
      git(projectPath, 'worktree', 'add', '-b', branch, path, from)
      return path
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

export const TEST_PROJECT_ID = 'project-1'

/** The connection project of a harness created with `members`. */
export const TEST_CONNECTION_PROJECT_ID = 'connection-1'
/** Its member projects, in the order of the `members` repositories; `web` and `api` by name. */
export const TEST_MEMBER_PROJECTS: readonly { id: string; name: string }[] = [
  { id: 'member-web', name: 'web' },
  { id: 'member-api', name: 'api' }
]

/** A worktree row as the harness keeps it: with the project it belongs to, like the real one. */
export interface TestWorktree extends DocumentFlowWorktree {
  project_id?: string
}

/**
 * A ticket on the fake board: where it sits and, for the tickets a run made from board tickets
 * adopts, what the real `KanbanTicket` would say about it. `getTicket` answers every field,
 * unset ones as the board would (null, '').
 */
export interface FakeBoardTicket {
  id: string
  projectId: string
  column: KanbanTicketColumn
  title?: string
  description?: string | null
  archived_at?: string | null
  current_session_id?: string | null
  worktree_id?: string | null
  external_provider?: string | null
  external_id?: string | null
  ticket_prefix?: string | null
  ticket_number?: number | null
  pending_launch_config?: string | null
  parent_ticket_id?: string | null
}

/** A connection instance the fake `createConnection` made. */
export interface FakeConnection extends DocumentFlowConnection {
  name: string
  saved_project_id: string
  status: 'active' | 'archived'
}

export interface ServiceHarness {
  service: DocumentFlowService
  db: FakeDocumentFlowDb
  /** Every event handed to `publish`, in order. */
  published: DocumentFlowUpdatedEvent[]
  /** Replies the fake model gives, first in first out; an Error is thrown instead. */
  replies: (string | null | Error)[]
  generateCalls: {
    prompt: string
    systemPrompt: string
    provider: Parameters<DocumentFlowGenerate>[2]
    options: Parameters<DocumentFlowGenerate>[3]
  }[]
  projects: Map<string, DocumentFlowProject>
  worktrees: Map<string, TestWorktree>
  worktreeRequests: CreateFromBranchParams[]
  /** Every instance the fake `createConnection` made (a directory of symlinks under `scratch`). */
  connections: Map<string, FakeConnection>
  connectionRequests: { worktreeIds: string[]; savedProjectId: string }[]
  /** Every worktree the fake `addConnectionMember` linked into an instance, in order. */
  connectionMemberAdds: { connectionId: string; worktreeId: string }[]
  /** Every member the fake `addConnectionProjectMember` gave a connection project, in order. */
  projectMemberAdds: { projectId: string; memberProjectId: string }[]
  /**
   * Register one more git project backed by `repo`, so worktree requests for it are honoured.
   * Not a member of the connection project until the service makes it one.
   */
  addProject: (project: { id: string; name: string }, repo: TestRepo) => DocumentFlowProject
  connectionRenames: { connectionId: string; name: string }[]
  ticketBatches: { projectId: string; drafts: KanbanTicketBatchCreateItem[] }[]
  /** Every `addTicketDependency` call, in order, whether the board took it or not. */
  ticketLinks: { projectId: string; dependent: string; blocker: string }[]
  /**
   * The board's dependency edges (what `getTicketDependencies` answers): those `addTicketDependency`
   * took, those a ticket batch made from `depends_on`, and any a test puts here itself.
   */
  boardDependencies: (DocumentFlowTicketDependency & { projectId: string })[]
  /** Every `removeTicketDependency` call, in order. */
  ticketUnlinks: { projectId: string; dependent: string; blocker: string }[]
  /** The board: every created ticket that was not deleted, with the column it sits in. */
  boardTickets: Map<string, FakeBoardTicket>
  /**
   * A ticket the user made on the board (for runs made from board tickets): in To Do on the
   * test project, keyed `TD-<n>` in creation order unless `ticket_prefix` / `ticket_number` say
   * otherwise. Returns its id.
   */
  addBoardTicket: (ticket?: Partial<FakeBoardTicket>) => string
  ticketMoves: { projectId: string; ticketId: string; column: KanbanTicketColumn }[]
  /** Every model badge or parent link the service wrote on a board ticket, in order. */
  ticketUpdates: { projectId: string; ticketId: string; patch: DocumentFlowTicketPatch }[]
  deletedTickets: string[]
  /** Every `duplicateTicket` call, in order: the ticket copied and the copy the board made. */
  ticketDuplicates: { projectId: string; ticketId: string; copyId: string }[]
  /** Worktree id → base branch, as the service re-pointed them. */
  baseBranchWrites: { worktreeId: string; baseBranch: string }[]
  /** Scratch directory: holds the run directories and stands in for the home directory. */
  scratch: string
  runsRoot: string
  /** How many tasks were handed to `detach`. */
  detachCount: () => number
  /** Replace a collaborator for the rest of the test; the harness's own fake is used otherwise. */
  overrides: Partial<OverridableDeps> & UnsetDeps
  /** The harness's own fakes, for an override that does something and then what the fake does. */
  fakes: OverridableDeps
  cleanup: () => void
}

type OverridableDeps = Required<
  Pick<
    DocumentFlowServiceDeps,
    | 'generate'
    | 'getWorktree'
    | 'getDefaultBranch'
    | 'getAppStartedAt'
    | 'createWorktreeFromBranch'
    | 'createConnection'
    | 'getConnection'
    | 'addConnectionMember'
    | 'addConnectionProjectMember'
    | 'renameConnection'
    | 'createTickets'
    | 'addTicketDependency'
    | 'removeTicketDependency'
    | 'getTicketDependencies'
    | 'getTicket'
    | 'moveTicket'
    | 'updateTicket'
    | 'deleteTicket'
    | 'duplicateTicket'
    | 'unarchiveTicket'
    | 'setWorktreeBaseBranch'
    | 'resolveFinalMessage'
    | 'runVerify'
    | 'detach'
    | 'now'
  >
>

/** A fake board ticket as `getTicket` answers it: every field, unset ones as the board has them. */
function toFlowTicket(ticket: FakeBoardTicket): DocumentFlowTicket {
  return {
    id: ticket.id,
    column: ticket.column,
    project_id: ticket.projectId,
    title: ticket.title ?? '',
    description: ticket.description ?? null,
    archived_at: ticket.archived_at ?? null,
    current_session_id: ticket.current_session_id ?? null,
    worktree_id: ticket.worktree_id ?? null,
    external_provider: ticket.external_provider ?? null,
    external_id: ticket.external_id ?? null,
    ticket_prefix: ticket.ticket_prefix ?? null,
    ticket_number: ticket.ticket_number ?? null,
    pending_launch_config: ticket.pending_launch_config ?? null,
    parent_ticket_id: ticket.parent_ticket_id ?? null
  }
}

/** Collaborators the service is not given at all, unless a test supplies one. */
type UnsetDeps = Pick<
  DocumentFlowServiceDeps,
  'getAppPid' | 'isProcessAlive' | 'boardHasUnreadableCards' | 'isSessionActive'
>

/**
 * A service wired to fakes. With `repo`, the project is that repository and integration
 * worktrees are really created in it (`git worktree add -b <hint> … <baseRef>`). With
 * `members`, those repositories are the member projects (TEST_MEMBER_PROJECTS, in order) of the
 * connection project TEST_CONNECTION_PROJECT_ID, and `createConnection` really links member
 * worktrees into a directory under `scratch`. A test swaps a collaborator through `overrides`.
 */
export function createServiceHarness(
  options: { repo?: TestRepo; members?: readonly TestRepo[] } = {}
): ServiceHarness {
  const { repo, members = [] } = options
  const db = createFakeDocumentFlowDb()
  const overrides: ServiceHarness['overrides'] = {}
  const published: DocumentFlowUpdatedEvent[] = []
  const replies: ServiceHarness['replies'] = []
  const generateCalls: ServiceHarness['generateCalls'] = []
  const projects = new Map<string, DocumentFlowProject>()
  const worktrees = new Map<string, TestWorktree>()
  const worktreeRequests: CreateFromBranchParams[] = []
  const connections = new Map<string, FakeConnection>()
  const connectionRequests: ServiceHarness['connectionRequests'] = []
  const connectionMemberAdds: ServiceHarness['connectionMemberAdds'] = []
  const projectMemberAdds: ServiceHarness['projectMemberAdds'] = []
  const connectionRenames: ServiceHarness['connectionRenames'] = []
  const ticketBatches: ServiceHarness['ticketBatches'] = []
  const ticketLinks: ServiceHarness['ticketLinks'] = []
  const boardDependencies: ServiceHarness['boardDependencies'] = []
  const ticketUnlinks: ServiceHarness['ticketUnlinks'] = []
  const boardTickets: ServiceHarness['boardTickets'] = new Map()
  const ticketMoves: ServiceHarness['ticketMoves'] = []
  const ticketUpdates: ServiceHarness['ticketUpdates'] = []
  const deletedTickets: string[] = []
  const ticketDuplicates: ServiceHarness['ticketDuplicates'] = []
  const baseBranchWrites: ServiceHarness['baseBranchWrites'] = []
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'docflow-service-')))
  const runsRoot = join(scratch, 'document-runs')
  let detached = 0
  let ticketCount = 0
  let connectionCount = 0
  let boardTicketCount = 0

  const addBoardTicket = (ticket: Partial<FakeBoardTicket> = {}): string => {
    const number = ++boardTicketCount
    const id = ticket.id ?? `board-${number}`
    boardTickets.set(id, {
      projectId: TEST_PROJECT_ID,
      column: 'todo',
      title: `Board ticket ${number}`,
      description: `Do the thing of ticket ${number}.`,
      ticket_prefix: 'TD',
      ticket_number: number,
      ...ticket,
      id
    })
    return id
  }
  /** Whether `from` waits on `to` through the board's edges (the board's cycle rule). */
  const waitsOn = (from: string, to: string): boolean => {
    const seen = new Set([from])
    const queue = [from]
    while (queue.length > 0) {
      const node = queue.shift() as string
      for (const edge of boardDependencies) {
        if (edge.dependent_id !== node || seen.has(edge.blocker_id)) continue
        if (edge.blocker_id === to) return true
        seen.add(edge.blocker_id)
        queue.push(edge.blocker_id)
      }
    }
    return false
  }
  const dropEdges = (keep: (edge: (typeof boardDependencies)[number]) => boolean): void => {
    const kept = boardDependencies.filter(keep)
    boardDependencies.splice(0, boardDependencies.length, ...kept)
  }

  projects.set(TEST_PROJECT_ID, {
    id: TEST_PROJECT_ID,
    name: 'project',
    path: repo?.projectPath ?? join(scratch, 'project'),
    kind: 'git'
  })
  /** Repositories by project root, so a worktree request finds the one it is for. */
  const repos = new Map<string, TestRepo>()
  if (repo) repos.set(repo.projectPath, repo)
  if (members.length > 0) {
    if (members.length > TEST_MEMBER_PROJECTS.length) {
      throw new Error(`createServiceHarness: at most ${TEST_MEMBER_PROJECTS.length} members`)
    }
    const memberIds: string[] = []
    const connectionPath = join(scratch, 'connection-project')
    mkdirSync(connectionPath)
    members.forEach((memberRepo, index) => {
      const { id, name } = TEST_MEMBER_PROJECTS[index]
      projects.set(id, { id, name, path: memberRepo.projectPath, kind: 'git' })
      repos.set(memberRepo.projectPath, memberRepo)
      // The project directory links every member root, as the real one does.
      symlinkSync(memberRepo.projectPath, join(connectionPath, name))
      memberIds.push(id)
    })
    projects.set(TEST_CONNECTION_PROJECT_ID, {
      id: TEST_CONNECTION_PROJECT_ID,
      name: 'Both apps',
      path: connectionPath,
      kind: 'connection',
      member_project_ids: JSON.stringify(memberIds)
    })
  }

  const fakes: OverridableDeps = {
    generate: async (prompt, systemPrompt, provider, generateOptions) => {
      generateCalls.push({ prompt, systemPrompt, provider, options: generateOptions })
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return reply ?? null
    },
    getWorktree: (worktreeId) => worktrees.get(worktreeId) ?? null,
    getDefaultBranch: async () => 'main',
    getAppStartedAt: () => null,
    createWorktreeFromBranch: async (params): Promise<WorktreeResult> => {
      worktreeRequests.push(params)
      const target = repos.get(params.projectPath)
      if (!target) return { success: false, error: 'This test has no repository.' }
      // A member's worktree ids carry the member's name: `wt-web-doc-factory`.
      const prefix =
        target === repo ? 'wt' : `wt-${projects.get(params.projectId)?.name ?? 'member'}`
      let branch = params.nameHint ?? 'worktree'
      for (let suffix = 2; worktrees.has(`${prefix}-${branch}`); suffix++) {
        branch = `${params.nameHint}-${suffix}`
      }
      const path = target.addWorktree(branch, params.baseRef ?? params.branchName)
      const worktree: TestWorktree = {
        id: `${prefix}-${branch}`,
        path,
        branch_name: branch,
        project_id: params.projectId
      }
      worktrees.set(worktree.id, worktree)
      return { success: true, worktree: worktree as unknown as WorktreeResult['worktree'] }
    },
    createConnection: async (worktreeIds, savedProjectId) => {
      connectionRequests.push({ worktreeIds, savedProjectId })
      const id = `connection-${++connectionCount}`
      const path = join(scratch, 'connections', id)
      mkdirSync(path, { recursive: true })
      const linked: FakeConnection['members'] = []
      for (const worktreeId of worktreeIds) {
        const worktree = worktrees.get(worktreeId)
        if (!worktree) return { success: false, error: `Worktree ${worktreeId} was not found.` }
        const project = worktree.project_id ? projects.get(worktree.project_id) : null
        if (!project) return { success: false, error: `Worktree ${worktreeId} has no project.` }
        // Same rule as the live `deriveSymlinkName`: the project name, suffixed when taken.
        const base = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
        let symlinkName = base
        for (let n = 2; linked.some((member) => member.symlink_name === symlinkName); n++) {
          symlinkName = `${base}-${n}`
        }
        symlinkSync(worktree.path, join(path, symlinkName))
        linked.push({ project_id: project.id, worktree_id: worktreeId, symlink_name: symlinkName })
      }
      const connection: FakeConnection = {
        id,
        name: id,
        path,
        status: 'active',
        saved_project_id: savedProjectId,
        members: linked
      }
      connections.set(id, connection)
      return { success: true, connection: structuredClone(connection) }
    },
    getConnection: (connectionId) => {
      const connection = connections.get(connectionId)
      return connection ? structuredClone(connection) : null
    },
    addConnectionMember: async (connectionId, worktreeId) => {
      connectionMemberAdds.push({ connectionId, worktreeId })
      const connection = connections.get(connectionId)
      if (!connection) return { success: false, error: 'Connection not found' }
      const worktree = worktrees.get(worktreeId)
      if (!worktree) return { success: false, error: 'Worktree not found' }
      const project = worktree.project_id ? projects.get(worktree.project_id) : null
      if (!project) return { success: false, error: 'Project not found' }
      const base = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      let symlinkName = base
      for (
        let n = 2;
        connection.members.some((member) => member.symlink_name === symlinkName);
        n++
      ) {
        symlinkName = `${base}-${n}`
      }
      symlinkSync(worktree.path, join(connection.path, symlinkName))
      const member = { project_id: project.id, worktree_id: worktreeId, symlink_name: symlinkName }
      connection.members.push(member)
      return { success: true, member: { ...member } }
    },
    addConnectionProjectMember: async (projectId, memberProjectId) => {
      projectMemberAdds.push({ projectId, memberProjectId })
      const project = projects.get(projectId)
      if (!project || project.kind !== 'connection') {
        return { success: false, error: 'Connection project not found' }
      }
      const ids: string[] = JSON.parse(project.member_project_ids ?? '[]')
      if (!ids.includes(memberProjectId)) {
        projects.set(projectId, {
          ...project,
          member_project_ids: JSON.stringify([...ids, memberProjectId])
        })
      }
      return { success: true }
    },
    renameConnection: async (connectionId, name) => {
      connectionRenames.push({ connectionId, name })
      const connection = connections.get(connectionId)
      if (connection) connection.name = name
    },
    createTickets: async (projectId, drafts) => {
      ticketBatches.push({ projectId, drafts })
      const created = drafts.map((draft) => {
        const ticket: FakeBoardTicket = {
          id: `ticket-${++ticketCount}`,
          projectId,
          column: draft.column ?? 'todo',
          title: draft.title,
          description: draft.description ?? null,
          worktree_id: draft.worktree_id ?? null,
          external_provider: draft.external_provider ?? null,
          external_id: draft.external_id ?? null,
          parent_ticket_id: draft.parent_ticket_id ?? null
        }
        boardTickets.set(ticket.id, ticket)
        return ticket
      })
      // A batch links its own drafts, as both board backends do.
      const idOfDraft = new Map(drafts.map((draft, index) => [draft.draft_key, created[index].id]))
      drafts.forEach((draft, index) => {
        for (const key of draft.depends_on ?? []) {
          const blocker = idOfDraft.get(key)
          if (!blocker || blocker === created[index].id) continue
          boardDependencies.push({
            projectId,
            dependent_id: created[index].id,
            blocker_id: blocker
          })
        }
      })
      return { tickets: created.map((ticket) => ({ id: ticket.id })) }
    },
    // The board's own answers: a self-dependency or a loop is refused, an edge it has is fine.
    addTicketDependency: async (projectId, dependent, blocker) => {
      ticketLinks.push({ projectId, dependent, blocker })
      if (dependent === blocker)
        return { success: false, error: 'A ticket cannot depend on itself' }
      const has = boardDependencies.some(
        (edge) => edge.dependent_id === dependent && edge.blocker_id === blocker
      )
      if (has) return { success: true }
      if (waitsOn(blocker, dependent)) {
        return {
          success: false,
          error: 'Adding this dependency would create a circular dependency'
        }
      }
      boardDependencies.push({ projectId, dependent_id: dependent, blocker_id: blocker })
      return { success: true }
    },
    removeTicketDependency: async (projectId, dependent, blocker) => {
      ticketUnlinks.push({ projectId, dependent, blocker })
      const before = boardDependencies.length
      dropEdges((edge) => !(edge.dependent_id === dependent && edge.blocker_id === blocker))
      return boardDependencies.length < before
    },
    getTicketDependencies: async (projectId) =>
      boardDependencies
        .filter((edge) => edge.projectId === projectId)
        .map((edge) => ({ dependent_id: edge.dependent_id, blocker_id: edge.blocker_id })),
    getTicket: async (projectId, ticketId) => {
      const ticket = boardTickets.get(ticketId)
      return ticket && ticket.projectId === projectId ? toFlowTicket(ticket) : null
    },
    moveTicket: async (projectId, ticketId, column) => {
      ticketMoves.push({ projectId, ticketId, column })
      const ticket = boardTickets.get(ticketId)
      if (ticket) ticket.column = column
    },
    updateTicket: async (projectId, ticketId, patch) => {
      ticketUpdates.push({ projectId, ticketId, patch })
      const ticket = boardTickets.get(ticketId)
      if (ticket && ticket.projectId === projectId) {
        Object.assign(ticket, Object.fromEntries(definedEntries(patch)))
      }
    },
    deleteTicket: async (_projectId, ticketId) => {
      deletedTickets.push(ticketId)
      // Its edges go with it, as on the board.
      dropEdges((edge) => edge.dependent_id !== ticketId && edge.blocker_id !== ticketId)
      return boardTickets.delete(ticketId)
    },
    // The board's Duplicate: a new ticket in To Do with the title and description, a key of its
    // own, and nothing of the original's session, worktree, parent, archive or run marks.
    duplicateTicket: async (projectId, ticketId) => {
      const source = boardTickets.get(ticketId)
      if (!source || source.projectId !== projectId) throw new Error('Ticket does not exist')
      const copyId = addBoardTicket({
        projectId,
        title: source.title,
        description: source.description ?? null
      })
      ticketDuplicates.push({ projectId, ticketId, copyId })
      return { id: copyId }
    },
    unarchiveTicket: async (_projectId, ticketId) => {
      const ticket = boardTickets.get(ticketId)
      if (ticket) ticket.archived_at = null
    },
    setWorktreeBaseBranch: (worktreeId, baseBranch) => {
      baseBranchWrites.push({ worktreeId, baseBranch })
      const worktree = worktrees.get(worktreeId)
      if (worktree) worktree.base_branch = baseBranch
    },
    resolveFinalMessage: async () => null,
    runVerify: async () => ({ exitCode: 0, timedOut: false, output: '', durationMs: 1 }),
    detach: (task) => task(),
    now: () => new Date()
  }
  const service = new DocumentFlowService({
    db,
    publish: (event) => published.push(event),
    generate: (...args) => (overrides.generate ?? fakes.generate)(...args),
    getProject: (projectId) => projects.get(projectId) ?? null,
    getWorktree: (...args) => (overrides.getWorktree ?? fakes.getWorktree)(...args),
    getDefaultBranch: (...args) => (overrides.getDefaultBranch ?? fakes.getDefaultBranch)(...args),
    getAppStartedAt: () => (overrides.getAppStartedAt ?? fakes.getAppStartedAt)(),
    get getAppPid() {
      return overrides.getAppPid
    },
    get isProcessAlive() {
      return overrides.isProcessAlive
    },
    get boardHasUnreadableCards() {
      return overrides.boardHasUnreadableCards
    },
    get isSessionActive() {
      return overrides.isSessionActive
    },
    createWorktreeFromBranch: (...args) =>
      (overrides.createWorktreeFromBranch ?? fakes.createWorktreeFromBranch)(...args),
    createConnection: (...args) => (overrides.createConnection ?? fakes.createConnection)(...args),
    getConnection: (...args) => (overrides.getConnection ?? fakes.getConnection)(...args),
    addConnectionMember: (...args) =>
      (overrides.addConnectionMember ?? fakes.addConnectionMember)(...args),
    addConnectionProjectMember: (...args) =>
      (overrides.addConnectionProjectMember ?? fakes.addConnectionProjectMember)(...args),
    renameConnection: (...args) => (overrides.renameConnection ?? fakes.renameConnection)(...args),
    createTickets: (...args) => (overrides.createTickets ?? fakes.createTickets)(...args),
    addTicketDependency: (...args) =>
      (overrides.addTicketDependency ?? fakes.addTicketDependency)(...args),
    removeTicketDependency: (...args) =>
      (overrides.removeTicketDependency ?? fakes.removeTicketDependency)(...args),
    getTicketDependencies: (...args) =>
      (overrides.getTicketDependencies ?? fakes.getTicketDependencies)(...args),
    getTicket: (...args) => (overrides.getTicket ?? fakes.getTicket)(...args),
    moveTicket: (...args) => (overrides.moveTicket ?? fakes.moveTicket)(...args),
    updateTicket: (...args) => (overrides.updateTicket ?? fakes.updateTicket)(...args),
    deleteTicket: (...args) => (overrides.deleteTicket ?? fakes.deleteTicket)(...args),
    duplicateTicket: (...args) => (overrides.duplicateTicket ?? fakes.duplicateTicket)(...args),
    unarchiveTicket: (...args) => (overrides.unarchiveTicket ?? fakes.unarchiveTicket)(...args),
    setWorktreeBaseBranch: (...args) =>
      (overrides.setWorktreeBaseBranch ?? fakes.setWorktreeBaseBranch)(...args),
    resolveFinalMessage: (...args) =>
      (overrides.resolveFinalMessage ?? fakes.resolveFinalMessage)(...args),
    runVerify: (...args) => (overrides.runVerify ?? fakes.runVerify)(...args),
    detach: (task) => {
      detached++
      return (overrides.detach ?? fakes.detach)(task)
    },
    now: () => (overrides.now ?? fakes.now)(),
    runsRoot,
    homeDir: scratch
  })

  return {
    service,
    db,
    published,
    replies,
    generateCalls,
    projects,
    worktrees,
    worktreeRequests,
    connections,
    connectionRequests,
    connectionMemberAdds,
    projectMemberAdds,
    addProject: (project, projectRepo) => {
      const row: DocumentFlowProject = { ...project, path: projectRepo.projectPath, kind: 'git' }
      projects.set(project.id, row)
      repos.set(projectRepo.projectPath, projectRepo)
      return row
    },
    connectionRenames,
    ticketBatches,
    ticketLinks,
    boardDependencies,
    ticketUnlinks,
    boardTickets,
    addBoardTicket,
    ticketMoves,
    ticketUpdates,
    deletedTickets,
    ticketDuplicates,
    baseBranchWrites,
    scratch,
    runsRoot,
    detachCount: () => detached,
    overrides,
    fakes,
    cleanup: () => rmSync(scratch, { recursive: true, force: true })
  }
}

let seededRuns = 0

/** A stored run with items, without going through extraction. Items default to `A1`, `A2`, … */
export function seedRun(
  harness: Pick<ServiceHarness, 'db' | 'runsRoot'>,
  options: {
    run?: DocumentRunRowPatch & {
      project_id?: string
      source_path?: string
      source_kind?: DocumentRun['source_kind']
    }
    items?: (Partial<DocumentRunItemDraft> & DocumentRunItemRowPatch)[]
  } = {}
): { run: DocumentRun; items: DocumentRunItem[] } {
  const { db } = harness
  const id = `run-${++seededRuns}`
  const { project_id, source_path, source_kind, ...runPatch } = options.run ?? {}
  db.createDocumentRun({
    id,
    project_id: project_id ?? TEST_PROJECT_ID,
    title: 'Factory spec',
    source_kind: source_kind ?? 'document',
    source_path: source_path ?? (source_kind === 'tickets' ? '' : '/specs/factory.html'),
    run_dir: join(harness.runsRoot, id),
    status: 'preview',
    config: { ...DEFAULT_DOCUMENT_RUN_CONFIG }
  })
  db.updateDocumentRun(id, runPatch)

  const drafts = (options.items ?? []).map((item, index): DocumentRunItemDraft => ({
    key: item.key ?? `A${index + 1}`,
    title: item.title ?? `Task ${index + 1}`,
    summary: item.summary ?? `Summary ${index + 1}`,
    description: item.description ?? `Implement task ${index + 1}.`,
    kind: item.kind ?? 'feature',
    depends_on: item.depends_on ?? [],
    has_migration: item.has_migration ?? false,
    size: item.size ?? 'M',
    conflict_risk: item.conflict_risk ?? 'low',
    doc_status: item.doc_status ?? 'open',
    selected: item.selected ?? true,
    figures: item.figures ?? [],
    open_questions: item.open_questions ?? [],
    verification_suggested: item.verification_suggested ?? item.verification ?? [],
    verification: item.verification ?? [],
    verification_reason: item.verification_reason ?? '',
    launch_config: item.launch_config ?? null
  }))
  const created = db.replaceDocumentRunItems(id, drafts)
  // Whatever is not part of a draft (status, session, merge bookkeeping) is patched on top.
  created.forEach((item, index) => db.updateDocumentRunItem(item.id, options.items?.[index] ?? {}))

  const run = db.getDocumentRun(id)
  if (!run) throw new Error('seedRun: the run was not stored')
  return { run, items: db.getDocumentRunItems(id) }
}
