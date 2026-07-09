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
}

/** Stored (JSON.stringified) in the REMOTE session row's `remote_launch` column. */
export interface RemoteLaunchHostInfo {
  role: 'host'
  launchId: string
  tmuxSession: string | null
  promptFile: string | null
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
  | { type: 'write'; destRelPath: string; contentBase64: string }
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
}

export interface RemoteLaunchAttachParams {
  remoteSessionId: string
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
