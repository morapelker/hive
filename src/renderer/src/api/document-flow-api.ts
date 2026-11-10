import type { ServerEvent } from '@shared/rpc/protocol'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import {
  DOCUMENT_FLOW_UPDATED_CHANNEL,
  isDocumentFlowUpdatedEvent,
  type DocumentFlowUpdatedEvent
} from '@shared/document-flow-events'
import type {
  DocumentCommitResult,
  DocumentMergeCheckResult,
  DocumentMergeResult,
  DocumentMigrationOutcome,
  DocumentRun,
  DocumentRunDetail,
  DocumentRunGeneration,
  DocumentRunItem,
  DocumentRunItemPatch,
  DocumentRunPatch,
  DocumentRunAddTicketsParams,
  DocumentRunRemoveItemParams,
  DocumentRunSetDependenciesParams,
  DocumentRunVerdict,
  DocumentTicketRunCreateParams,
  DocumentRunnerClaim,
  DocumentSimpleResult,
  DocumentSourceFile,
  DocumentSourceState,
  DocumentVerifyResult,
  SessionFinalMessage
} from '@shared/types/document-flow'
import { getRendererRpcClient } from './rpc-client'

const request = <T>(method: string, params: object): Promise<T> =>
  getRendererRpcClient().request<T>(`documentFlow.${method}`, params)

/**
 * RPC surface of the "Implement document" flow (server: src/server/rpc/domains/document-flow.ts).
 * Every write publishes `documentFlow:updated`, so callers may either apply the returned row or
 * wait for the push.
 */
export const documentFlowApi = {
  /**
   * Pre-process the document and start extracting tickets in the background. Resolves as soon
   * as the run row exists (`status: 'extracting'`); the result arrives through `onUpdated`.
   * `notes` tell the extraction model which tickets to make and how.
   */
  createRun: (params: {
    projectId: string
    documentPath: string
    generation?: DocumentRunGeneration | null
    notes?: string
  }): Promise<DocumentRunDetail> => request('createRun', params),

  /**
   * An orchestrator made from board tickets the user already created: the run is created
   * straight in `preview` with one item per ticket (in the given order), linked to the ticket,
   * its dependencies read from the board, and its own ticket in To Do. Refuses tickets that
   * cannot be adopted (see `ticketRunRefusal`).
   */
  createTicketRun: (params: DocumentTicketRunCreateParams): Promise<DocumentRunDetail> =>
    request('createTicketRun', params),

  /**
   * Adopt more board tickets into a run made from tickets: before launch, while it runs (they
   * launch when their dependencies and a slot allow), or once it finished (it resumes).
   */
  addTickets: (params: DocumentRunAddTicketsParams): Promise<DocumentRunDetail> =>
    request('addTickets', params),

  /**
   * Take a ticket out of a run made from tickets, while it has not launched: the item goes, the
   * ticket stays on the board, free again.
   */
  removeItem: (params: DocumentRunRemoveItemParams): Promise<DocumentRunDetail> =>
    request('removeItem', params),

  /**
   * Set what an item of a run made from tickets starts after (keys of other items): written as
   * the board's dependencies between their tickets, which the run follows. Refused once the
   * item launched, and for a change that would make a cycle.
   */
  setItemDependencies: (params: DocumentRunSetDependenciesParams): Promise<DocumentRunDetail> =>
    request('setItemDependencies', params),

  /** Re-run extraction for a run in `extract_failed` or `preview` (replaces its items). */
  retryExtraction: (params: {
    runId: string
    generation?: DocumentRunGeneration | null
  }): Promise<DocumentRunDetail> => request('retryExtraction', params),

  get: (runId: string): Promise<DocumentRunDetail | null> => request('get', { runId }),

  /** The run's source document and whether the file is still on disk. */
  sourceFile: (runId: string): Promise<DocumentSourceFile> => request('sourceFile', { runId }),

  /**
   * The source document as the post-merge document update sees it (exists, writable, format,
   * encoding, hash, assets directory). With `backupKey` (an item key) the file is first backed
   * up into the run directory.
   */
  inspectSource: (runId: string, backupKey?: string): Promise<DocumentSourceState> =>
    request('inspectSource', backupKey === undefined ? { runId } : { runId, backupKey }),

  /** Newest first, without events. */
  list: (projectId?: string): Promise<DocumentRunDetail[]> =>
    request('list', projectId === undefined ? {} : { projectId }),

  updateRun: (runId: string, patch: DocumentRunPatch): Promise<DocumentRun> =>
    request('updateRun', { runId, patch }),

  updateItem: (
    runId: string,
    itemId: string,
    patch: DocumentRunItemPatch
  ): Promise<DocumentRunItem> => request('updateItem', { runId, itemId, patch }),

  /**
   * Launch a previewed run: cut the integration branch + worktree from the base branch, create
   * the selected items' tickets on the board, and move the run to `running`.
   */
  /** `defaultSdk`: the app's default agent, which words the brief of tickets without a launch config. */
  start: (runId: string, defaultSdk?: HandoffAgentSdk): Promise<DocumentRunDetail> =>
    request('start', { runId, defaultSdk }),

  /**
   * Connect one more repository to a launched connection run: it joins the connection project,
   * gets an integration worktree linked into the run's instance, and a worktree in every
   * ticket instance already at work. `baseBranch` null = the run's pick, else its current branch.
   */
  addMember: (params: {
    runId: string
    projectId: string
    baseBranch?: string | null
  }): Promise<DocumentRunDetail> => request('addMember', params),

  /** Take (or renew) the single-owner lease on driving the run. */
  claimRunner: (runId: string, clientId: string): Promise<DocumentRunnerClaim> =>
    request('claimRunner', { runId, clientId }),

  /** The last main-agent turn end recorded for a CLI session; null when none was recorded. */
  sessionTurn: (sessionId: string): Promise<SessionFinalMessage | null> =>
    request('sessionTurn', { sessionId }),

  /**
   * Judge the item's session's final message with the generation model and store the verdict.
   * `finalMessage` is supplied by the renderer for SDK sessions; CLI sessions are read
   * server-side (Stop-hook capture, then the transcript).
   */
  classify: (params: {
    runId: string
    itemId: string
    finalMessage?: string | null
  }): Promise<DocumentRunVerdict> => request('classify', params),

  /**
   * Commit any uncommitted work in the ticket worktree, then dry-run the merge into the
   * integration branch.
   */
  prepareMerge: (runId: string, itemId: string): Promise<DocumentMergeCheckResult> =>
    request('prepareMerge', { runId, itemId }),

  /** `git merge --no-ff` the ticket branch into the integration worktree. Idempotent. */
  merge: (runId: string, itemId: string): Promise<DocumentMergeResult> =>
    request('merge', { runId, itemId }),

  /** Run the run's verify command in the integration worktree. */
  verify: (runId: string): Promise<DocumentVerifyResult> => request('verify', { runId }),

  /** Commit whatever a fix session left uncommitted in the integration worktree. */
  commitIntegration: (runId: string, message: string): Promise<DocumentCommitResult> =>
    request('commitIntegration', { runId, message }),

  /** Reset the integration branch to the item's pre-merge commit. */
  rollbackMerge: (runId: string, itemId: string): Promise<DocumentSimpleResult> =>
    request('rollbackMerge', { runId, itemId }),

  /** Build the final report and move the run to `completed` / `completed_with_issues`. */
  finalize: (runId: string): Promise<DocumentRunDetail> => request('finalize', { runId }),

  /** Stop driving the run. Sessions, branches and worktrees are left as they are. */
  cancel: (runId: string): Promise<DocumentRunDetail> => request('cancel', { runId }),

  /**
   * Record the session executing a finished run's migrations in its integration worktree; the
   * run's ticket returns to In Progress. Rejects while another session is at it.
   */
  startMigrations: (runId: string, sessionId: string): Promise<DocumentRunDetail> =>
    request('startMigrations', { runId, sessionId }),

  /** That session is over; a no-op unless it is still the run's migration session. */
  endMigrations: (
    runId: string,
    sessionId: string,
    outcome: DocumentMigrationOutcome
  ): Promise<DocumentRunDetail> => request('endMigrations', { runId, sessionId, outcome }),

  /** Delete a run that is not `running` (rows and the run directory; never git state). */
  delete: (runId: string): Promise<boolean> => request('delete', { runId }),

  /**
   * A fresh copy of the run, in the preview with its own ticket in To Do: the title, the config
   * (models included) and each ticket's model, verification and selection come along; nothing
   * of what the original did does. An orchestrator's tickets are copied on the board too.
   * Refused while the run's tickets are still being extracted.
   */
  duplicate: (runId: string): Promise<DocumentRunDetail> => request('duplicate', { runId }),

  logEvent: (params: {
    runId: string
    itemId?: string | null
    type: string
    message: string
    data?: unknown
  }): Promise<void> => request('logEvent', params),

  /** A verify command guessed from the project's package manager and scripts; null if none. */
  suggestVerifyCommand: (projectId: string): Promise<string | null> =>
    request('suggestVerifyCommand', { projectId }),

  onUpdated: (callback: (event: DocumentFlowUpdatedEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(DOCUMENT_FLOW_UPDATED_CHANNEL, (event: ServerEvent) => {
      if (isDocumentFlowUpdatedEvent(event.payload)) callback(event.payload)
    })
}

export type DocumentFlowApi = typeof documentFlowApi
