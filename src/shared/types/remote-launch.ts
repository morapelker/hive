/**
 * Shared types for "launch on cloud": launching a kanban ticket's claude-cli
 * session on a remote headless Hive server over the existing Teleport
 * WS-RPC channel. See src/main/services/teleport-remote-client.ts for the
 * transport this rides on.
 */

/** Ordered steps of a remote launch, surfaced to the UI as progress. */
export const REMOTE_LAUNCH_STEPS = [
  'connect',
  'branch-check',
  'clone',
  'worktree',
  'file-transfer',
  'setup-script',
  'launch'
] as const

export type RemoteLaunchStep = (typeof REMOTE_LAUNCH_STEPS)[number]

export interface RemoteLaunchProgressEvent {
  step: RemoteLaunchStep
  status: 'running' | 'done' | 'error'
  error?: string
  detail?: string
}

/** Event-bus channel name for progress events of a given launch, mirrors `script:setup:<id>`. */
export function remoteLaunchProgressChannel(launchId: string): string {
  return `remote-launch:progress:${launchId}`
}

/** Stored (JSON.stringified) in the LOCAL session row's `remote_launch` column. */
export interface RemoteLaunchClientInfo {
  role: 'client'
  url: string
  remoteSessionId: string
  remoteWorktreeId: string
  remoteProjectId: string
  tmuxSession: string
  branch: string
  worktreePath: string
  launchedAt: string
  /**
   * The RPC-level `launchId` this session was created for, when known.
   * Optional (rather than required) so existing fixtures/callers that don't
   * care about idempotency don't need updating — `startRemoteLaunch` always
   * stamps it so `findSessionByRemoteLaunchId` can detect a retry of the same
   * launch and reuse the local session instead of creating a duplicate.
   */
  launchId?: string
  /**
   * Stamped by `remoteLaunchOps.stop` once the remote tmux session was killed
   * (or found already dead). A stopped launch no longer renders the remote
   * badge/actions — `useRemoteLaunchStore` maps it to null.
   */
  stoppedAt?: string
}

/** Stored (JSON.stringified) in the REMOTE session row's `remote_launch` column. */
export interface RemoteLaunchHostInfo {
  role: 'host'
  launchId: string
  tmuxSession: string | null
  promptFile: string | null
  /**
   * Stamped once `applySetupPlan` completes for this launchId. A retry of the
   * same launch (which reuses the prepared worktree) must NOT re-run the
   * setup plan — non-idempotent setup commands would execute twice on the
   * same worktree after a late-step (launch/bookkeeping) failure.
   */
  setupAppliedAt?: string
}

export type RemoteLaunchInfo = RemoteLaunchClientInfo | RemoteLaunchHostInfo

/**
 * Tolerant parse of a `remote_launch` DB column value. Never throws: returns
 * null on null/empty input, invalid JSON, or JSON missing a recognized
 * `role`. Mirrors the tolerant-parsing precedent of `parseTeleportSettings`
 * in src/main/services/teleport-remote-client.ts.
 */
export function parseRemoteLaunch(raw: string | null | undefined): RemoteLaunchInfo | null {
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const role = (parsed as { role?: unknown }).role
  if (role !== 'client' && role !== 'host') return null

  return parsed as RemoteLaunchInfo
}

// -- RPC param/result types for the upcoming `remoteLaunchOps` domain --

export interface RemoteLaunchPingResult {
  ok: boolean
  git: boolean
  tmux: boolean
  claude: boolean
  version?: string
}

export type SetupPlanStep =
  | {
      type: 'write'
      destRelPath: string
      contentBase64: string
      /** Source file had an execute bit — written 0700 instead of 0600 so transferred helpers stay runnable. */
      executable?: boolean
    }
  | { type: 'run'; command: string }

/** Mirrors the model shape teleport ships, see `TeleportRemoteReceiveParams` in teleport-remote-client.ts. */
export interface RemoteLaunchModelSelection {
  providerId: string
  id: string
  variant?: string | null
}

export type RemoteLaunchMode = 'build' | 'plan'

export interface RemoteLaunchPrepareParams {
  launchId: string
  gitUrl: string
  projectName: string
  branch: string
  nameHint?: string
  /**
   * The local project's `worktree_create_script`, synced onto the remote
   * project row before worktree creation so `createWorktreeFromBranchOp`
   * (which reads it from the project row) runs the project's custom worktree
   * bootstrap on the remote too. Null clears a stale remote value.
   */
  worktreeCreateScript?: string | null
  /**
   * The local project's auto-assign-port flag, synced onto the remote
   * project row so remote setup scripts get the same `PORT` injection as
   * local `scriptOps.runSetup`.
   */
  autoAssignPort?: boolean
  mode: RemoteLaunchMode
  model: RemoteLaunchModelSelection | null
}

export interface RemoteLaunchPrepareResult {
  remoteProjectId: string
  remoteWorktreeId: string
  remoteSessionId: string
  remoteWorktreePath: string
  remoteBranch: string
  reused: boolean
}

export interface RemoteLaunchStartParams {
  launchId: string
  ticketId: string
  projectId: string
  branch: string
  prompt: string
  mode: RemoteLaunchMode
  model: RemoteLaunchModelSelection | null
  ticketTitle: string
}

export interface RemoteLaunchStartResult {
  success: boolean
  step?: RemoteLaunchStep
  error?: string
  localSessionId?: string
  tmuxSession?: string
}

export interface RemoteLaunchPreflightParams {
  projectId: string
  branch: string
}

export interface RemoteLaunchPreflightResult {
  remoteConfigured: boolean
  branchOnOrigin: boolean
  localAhead: number
  localBehind: number
  diverged: boolean
  /** Source paths that will be shipped. */
  transfers: string[]
  /** Human-readable per-line errors. */
  transferErrors: string[]
  /** Set when a git operation failed unexpectedly; other fields still reflect best-effort defaults. */
  error?: string
}

export interface RemoteLaunchStopParams {
  sessionId: string
}

export interface RemoteLaunchApplySetupPlanParams {
  launchId: string
  remoteWorktreeId: string
  steps: SetupPlanStep[]
}

export interface RemoteLaunchApplySetupPlanResult {
  success: boolean
  failedStepIndex?: number
  failedKind?: 'write' | 'run'
  error?: string
}

export interface RemoteLaunchLaunchParams {
  launchId: string
  remoteSessionId: string
  prompt: string
}

export interface RemoteLaunchLaunchResult {
  tmuxSession: string
}

export interface RemoteLaunchKillTmuxParams {
  remoteSessionId: string
  tmuxSession: string
}

export interface RemoteLaunchAttachParams {
  remoteSessionId: string
  /**
   * Client-generated PTY id (must match `remote-attach-...`). Supplying it
   * lets the client subscribe to `terminal:data:<id>` before the attach RPC
   * creates the PTY, so the initial tmux screen dump isn't published before
   * the subscription exists (the event bus does not replay). The server
   * generates one when absent.
   */
  terminalId?: string
  cols?: number
  rows?: number
}

export interface RemoteLaunchAttachResult {
  terminalId: string
}

export interface RemoteLaunchKillResult {
  killed: boolean
  alreadyDead: boolean
}
