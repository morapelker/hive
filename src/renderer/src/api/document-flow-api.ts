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
  DocumentRun,
  DocumentRunDetail,
  DocumentRunGeneration,
  DocumentRunItem,
  DocumentRunItemPatch,
  DocumentRunPatch,
  DocumentRunVerdict,
  DocumentRunnerClaim,
  DocumentSimpleResult,
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

  /** Re-run extraction for a run in `extract_failed` or `preview` (replaces its items). */
  retryExtraction: (params: {
    runId: string
    generation?: DocumentRunGeneration | null
  }): Promise<DocumentRunDetail> => request('retryExtraction', params),

  get: (runId: string): Promise<DocumentRunDetail | null> => request('get', { runId }),

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

  /** Delete a run that is not `running` (rows and the run directory; never git state). */
  delete: (runId: string): Promise<boolean> => request('delete', { runId }),

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
