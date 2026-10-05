import { vi } from 'vitest'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  type DocumentMergeCheckResult,
  type DocumentRun,
  type DocumentRunConfig,
  type DocumentRunDetail,
  type DocumentRunItem,
  type DocumentRunItemPatch,
  type DocumentRunVerdict,
  type DocumentVerifyResult,
  type SessionFinalMessage
} from '@shared/types/document-flow'
import type { TicketLaunchResult, TicketLaunchSpec } from '@/lib/ticket-launch'
import type {
  RunnerNotice,
  RunnerPorts,
  RunnerTicket,
  RunnerTimer,
  RunnerWorktree
} from './runner-ports'
import type { SessionSignal } from './session-signal'

// Test support for the runner: an in-memory stand-in for everything behind its ports. Runs
// and items live in a map like the server's rows, every write notifies the subscribers the
// way the store does, and sessions are whatever signal a test scripts for them. Meant to be
// used with `vi.useFakeTimers()`; time is `Date.now()`.

export const RUN_ID = 'run-1'
export const PROJECT_ID = 'project-1'
export const INTEGRATION_BRANCH = 'doc-checkout'
export const INTEGRATION_WORKTREE = 'wt-integration'
/** The fake server "started" at this time; tests start the clock an hour later. */
export const SERVER_STARTED_AT = '2026-05-04T09:00:00.000Z'
export const TEST_NOW = '2026-05-04T10:00:00.000Z'

export function makeRun(overrides: Partial<DocumentRun> = {}): DocumentRun {
  return {
    id: RUN_ID,
    project_id: PROJECT_ID,
    title: 'Checkout redesign',
    source_path: '/docs/checkout.html',
    run_dir: '/tmp/document-runs/run-1',
    document_path: '/tmp/document-runs/run-1/document.md',
    status: 'running',
    error: null,
    config: { ...DEFAULT_DOCUMENT_RUN_CONFIG },
    extraction: null,
    base_branch: 'main',
    base_sha: 'base000',
    integration_branch: INTEGRATION_BRANCH,
    integration_worktree_id: INTEGRATION_WORKTREE,
    integration_worktree_path: '/worktrees/shop--doc-checkout',
    report: null,
    runner_client_id: null,
    runner_heartbeat_at: null,
    created_at: TEST_NOW,
    updated_at: TEST_NOW,
    started_at: TEST_NOW,
    finished_at: null,
    ...overrides
  }
}

export function makeItem(overrides: Partial<DocumentRunItem> = {}): DocumentRunItem {
  const key = overrides.key ?? 'A'
  return {
    id: `item-${key}`,
    run_id: RUN_ID,
    key,
    position: 0,
    title: `Task ${key}`,
    summary: '',
    description: `Build ${key}.`,
    kind: 'feature',
    depends_on: [],
    has_migration: false,
    size: 'M',
    conflict_risk: 'low',
    doc_status: 'open',
    selected: true,
    figures: [],
    open_questions: [],
    launch_config: null,
    status: 'pending',
    status_detail: null,
    ticket_id: `ticket-${key}`,
    worktree_id: null,
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
    created_at: TEST_NOW,
    updated_at: TEST_NOW,
    started_at: null,
    finished_at: null,
    ...overrides
  }
}

export function makeVerdict(overrides: Partial<DocumentRunVerdict> = {}): DocumentRunVerdict {
  return {
    status: 'done',
    reason: 'The agent says the task is implemented and committed.',
    question: null,
    summary: 'Implemented.',
    migrations: [],
    manualSteps: [],
    confidence: 'high',
    source: 'model',
    classifiedAt: TEST_NOW,
    ...overrides
  }
}

/** An error the fake ports treat as "the server could not be reached". */
export class FakeTransportError extends Error {}

export interface WorldOptions {
  run?: Partial<DocumentRun>
  config?: Partial<DocumentRunConfig>
  items?: Partial<DocumentRunItem>[]
}

export type RunnerWorld = ReturnType<typeof createWorld>

export function createWorld(options: WorldOptions = {}) {
  const items = (options.items ?? [{ key: 'A' }]).map((item, position) =>
    makeItem({ position, ...item })
  )
  const runs = new Map<string, DocumentRunDetail>([
    [
      RUN_ID,
      {
        run: makeRun({
          ...options.run,
          config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, ...options.run?.config, ...options.config }
        }),
        items,
        events: []
      }
    ]
  ])
  const listeners = new Set<() => void>()
  const signals = new Map<string, SessionSignal>()
  const turns = new Map<string, SessionFinalMessage>()
  const tickets = new Map<string, RunnerTicket>()
  const worktrees = new Map<string, RunnerWorktree>([
    [
      INTEGRATION_WORKTREE,
      {
        id: INTEGRATION_WORKTREE,
        branch_name: INTEGRATION_BRANCH,
        path: '/worktrees/shop--doc-checkout'
      }
    ]
  ])
  const setupRunning = new Set<string>()
  /** Sessions whose row was closed (tab closed, ticket moved back). */
  const closedSessions = new Set<string>()
  /** Sessions that exist as rows but whose agent never started. */
  const unstartedSessions = new Set<string>()
  const notices: RunnerNotice[] = []
  const events: { itemId: string | null; type: string; message: string }[] = []
  const followups: { sessionId: string; ticketId: string; prompt: string }[] = []
  const launches: TicketLaunchSpec[] = []
  let counter = 0

  for (const item of items) {
    if (!item.ticket_id) continue
    tickets.set(item.ticket_id, {
      id: item.ticket_id,
      project_id: PROJECT_ID,
      title: item.title,
      description: item.description,
      attachments: [],
      column: 'todo',
      current_session_id: null,
      worktree_id: null
    })
  }

  const notifyListeners = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const detail = (): DocumentRunDetail => runs.get(RUN_ID) as DocumentRunDetail

  const item = (key: string): DocumentRunItem => {
    const found = detail().items.find((candidate) => candidate.key === key)
    if (!found) throw new Error(`no item ${key}`)
    return found
  }

  /** Write an item row the way the server would, bypassing the runner (a user action). */
  const setItem = (key: string, patch: Partial<DocumentRunItem>): DocumentRunItem => {
    const current = detail()
    const updated = {
      ...item(key),
      ...patch,
      updated_at: new Date(Date.now()).toISOString()
    }
    runs.set(RUN_ID, {
      ...current,
      items: current.items.map((candidate) => (candidate.key === key ? updated : candidate))
    })
    notifyListeners()
    return updated
  }

  const setRun = (patch: Partial<DocumentRun>): void => {
    const current = detail()
    runs.set(RUN_ID, { ...current, run: { ...current.run, ...patch } })
    notifyListeners()
  }

  const setSignal = (sessionId: string, signal: SessionSignal): void => {
    // Like the status store: a working status knows when it was written.
    signals.set(
      sessionId,
      signal.kind === 'working' && signal.since === undefined
        ? { ...signal, since: Date.now() }
        : signal
    )
    notifyListeners()
  }

  /** The session's turn ends now; `overrides` scripts an API error, a pause, an interrupt. */
  const endTurn = (
    sessionId: string,
    overrides: Partial<Extract<SessionSignal, { kind: 'ended' }>> = {}
  ): void =>
    setSignal(sessionId, {
      kind: 'ended',
      at: Date.now(),
      completion: 'completed',
      apiError: null,
      reason: null,
      hookEvent: null,
      hasBackgroundWork: false,
      ...overrides
    })

  const launchOk = (spec: TicketLaunchSpec): TicketLaunchResult => {
    counter += 1
    const sessionId = `session-${counter}`
    const worktreeId =
      spec.worktree.type === 'existing' ? spec.worktree.worktreeId : `wt-${counter}`
    if (spec.worktree.type === 'new') {
      worktrees.set(worktreeId, {
        id: worktreeId,
        branch_name: spec.worktree.nameHint ?? `branch-${counter}`,
        path: `/worktrees/${worktreeId}`
      })
    }
    const ticket = tickets.get(spec.ticketId)
    if (ticket) {
      tickets.set(ticket.id, {
        ...ticket,
        column: 'in_progress',
        current_session_id: sessionId,
        worktree_id: worktreeId
      })
    }
    signals.set(sessionId, { kind: 'working', since: Date.now() })
    return { success: true, sessionId, worktreeId }
  }

  const cleanMerge: DocumentMergeCheckResult = {
    state: 'clean',
    conflictedFiles: [],
    committed: false,
    commitsAhead: 1
  }
  const verifyOk: DocumentVerifyResult = {
    skipped: false,
    ok: true,
    exitCode: 0,
    timedOut: false,
    output: '',
    durationMs: 10
  }

  const api = {
    claimRunner: vi.fn(async () => ({
      owned: true,
      ownerClientId: 'client-1' as string | null,
      serverStartedAt: SERVER_STARTED_AT
    })),
    sessionTurn: vi.fn(async (sessionId: string) => turns.get(sessionId) ?? null),
    classify: vi.fn(
      async (_params: { runId: string; itemId: string; finalMessage?: string | null }) =>
        makeVerdict()
    ),
    prepareMerge: vi.fn(async (_runId: string, _itemId: string) => cleanMerge),
    merge: vi.fn(async (_runId: string, itemId: string) => {
      const merged = detail().items.find((candidate) => candidate.id === itemId)
      if (merged)
        setItem(merged.key, { pre_merge_sha: 'pre-sha', merge_sha: `merge-${merged.key}` })
      return { success: true, mergeSha: `merge-${itemId}` } as {
        success: boolean
        mergeSha?: string
        conflictedFiles?: string[]
        error?: string
      }
    }),
    verify: vi.fn(async (_runId: string) => verifyOk),
    commitIntegration: vi.fn(async (_runId: string, _message: string) => ({
      success: true,
      committed: true
    })),
    rollbackMerge: vi.fn(async (_runId: string, itemId: string) => {
      const rolledBack = detail().items.find((candidate) => candidate.id === itemId)
      if (rolledBack) setItem(rolledBack.key, { pre_merge_sha: null, merge_sha: null })
      return { success: true } as { success: boolean; error?: string }
    }),
    finalize: vi.fn(async (_runId: string) => {
      const current = detail()
      const allMerged = current.items
        .filter((candidate) => candidate.selected)
        .every((candidate) => candidate.status === 'merged')
      const finished: DocumentRunDetail = {
        ...current,
        run: { ...current.run, status: allMerged ? 'completed' : 'completed_with_issues' }
      }
      return finished
    }),
    logEvent: vi.fn(
      async (event: { runId: string; itemId?: string | null; type: string; message: string }) => {
        events.push({ itemId: event.itemId ?? null, type: event.type, message: event.message })
      }
    )
  }

  const ports = {
    api,
    clientId: 'client-1',

    getRuns: () => [...runs.values()],
    getRun: (runId: string) => runs.get(runId) ?? null,
    applyDetail: vi.fn((applied: DocumentRunDetail) => {
      runs.set(applied.run.id, applied)
      notifyListeners()
    }),
    updateItem: vi.fn(async (_runId: string, itemId: string, patch: DocumentRunItemPatch) => {
      const target = detail().items.find((candidate) => candidate.id === itemId)
      if (!target) throw new Error(`Unknown item ${itemId}`)
      return setItem(target.key, patch)
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    loadProject: vi.fn(async (_projectId: string) => {}),
    getTicket: (_projectId: string, ticketId: string) => tickets.get(ticketId) ?? null,
    reloadTickets: vi.fn(async (_projectId: string) => {}),
    createTicket: vi.fn(
      async (projectId: string, draft: { title: string; description: string }) => {
        counter += 1
        const ticket: RunnerTicket = {
          id: `fix-ticket-${counter}`,
          project_id: projectId,
          title: draft.title,
          description: draft.description,
          attachments: [],
          column: 'todo',
          current_session_id: null,
          worktree_id: null
        }
        tickets.set(ticket.id, ticket)
        return ticket
      }
    ),
    moveTicket: vi.fn(
      async (
        _projectId: string,
        ticketId: string,
        column: RunnerTicket['column'],
        _options: { skipCompletionEffects: boolean }
      ) => {
        const ticket = tickets.get(ticketId)
        if (ticket) tickets.set(ticketId, { ...ticket, column })
      }
    ),
    topSortOrder: () => -1,
    buildTicketPrompt: (ticket: RunnerTicket) =>
      `<ticket title="${ticket.title}">${ticket.description ?? ''}</ticket>`,
    getWorktree: (worktreeId: string) => worktrees.get(worktreeId) ?? null,
    reloadWorktrees: vi.fn(async (_projectId: string) => {}),

    resolveDefaultLaunch: vi.fn(() => ({
      sdk: 'claude-code-cli' as const,
      model: { providerID: 'anthropic', modelID: 'app-default' },
      codexFastMode: false,
      customProviderId: null
    })),
    launchTicket: vi.fn(async (spec: TicketLaunchSpec): Promise<TicketLaunchResult> => {
      launches.push(spec)
      return launchOk(spec)
    }),
    completeOrphanSession: vi.fn(async (_sessionId: string) => {}),
    resetTicketToTodo: vi.fn(async (_projectId: string, ticketId: string) => {
      const ticket = tickets.get(ticketId)
      if (ticket) {
        tickets.set(ticketId, {
          ...ticket,
          column: 'todo',
          current_session_id: null,
          worktree_id: null
        })
      }
    }),
    sendFollowup: vi.fn(async (target: { sessionId: string; ticketId: string; prompt: string }) => {
      followups.push(target)
      // Like the real send: the session shows as working from the moment it is prompted.
      setSignal(target.sessionId, { kind: 'working' })
    }),
    getSessionSignal: (sessionId: string): SessionSignal =>
      signals.get(sessionId) ?? { kind: 'unknown' },
    readFinalMessage: vi.fn(async (_sessionId: string): Promise<string | null> => null),
    isSessionClosed: vi.fn(async (sessionId: string) => closedSessions.has(sessionId)),
    isSessionStarted: vi.fn(async (sessionId: string) => !unstartedSessions.has(sessionId)),

    fireSetupScript: vi.fn((_projectId: string, _worktreeId: string, _cwd: string) => {}),
    isSetupScriptRunning: (worktreeId: string) => setupRunning.has(worktreeId),

    notify: (notice: RunnerNotice) => {
      notices.push(notice)
    },
    isTransportError: (error: unknown) => error instanceof FakeTransportError,
    now: () => Date.now(),
    setTimeout: (callback: () => void, ms: number): RunnerTimer => setTimeout(callback, ms),
    clearTimeout: (timer: RunnerTimer) => clearTimeout(timer),
    warn: vi.fn((_message: string, _error?: unknown) => {})
  } satisfies RunnerPorts

  return {
    ports,
    api,
    runs,
    tickets,
    worktrees,
    turns,
    setupRunning,
    closedSessions,
    unstartedSessions,
    notices,
    events,
    followups,
    launches,
    detail,
    item,
    setItem,
    setRun,
    setSignal,
    endTurn,
    launchOk,
    /** The session the runner recorded for an item; fails the test when there is none. */
    sessionOf: (key: string): string => {
      const sessionId = item(key).session_id
      if (!sessionId) throw new Error(`${key} has no session`)
      return sessionId
    },
    statuses: (): Record<string, string> =>
      Object.fromEntries(detail().items.map((candidate) => [candidate.key, candidate.status]))
  }
}

/** Let the runner work for `ms` of fake time (timers and the promise chains between them). */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}
