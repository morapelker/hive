import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path, { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { Effect } from 'effect'
import { z } from 'zod'
import { RPC_ERROR_CODES, RpcRouteError } from '@shared/rpc/errors'
import {
  isDesktopCommandResult,
  makeDesktopCommandRequest,
  type RemoteLaunchClaudeTmuxPayload,
  type RemoteLaunchClaudeTmuxResult
} from '@shared/desktop-command'
import { parseSetupScriptPlan } from '@shared/lib/setup-script-transfers'
import { canonicalizeTicketTitle } from '@shared/types/branch-utils'
import {
  parseRemoteLaunch,
  remoteLaunchProgressChannel,
  type RemoteLaunchAttachParams,
  type RemoteLaunchAttachResult,
  type RemoteLaunchApplySetupPlanParams,
  type RemoteLaunchApplySetupPlanResult,
  type RemoteLaunchClientInfo,
  type RemoteLaunchHostInfo,
  type RemoteLaunchKillResult,
  type RemoteLaunchKillTmuxParams,
  type RemoteLaunchLaunchParams,
  type RemoteLaunchLaunchResult,
  type RemoteLaunchPingResult,
  type RemoteLaunchPreflightParams,
  type RemoteLaunchPreflightResult,
  type RemoteLaunchPrepareParams,
  type RemoteLaunchPrepareResult,
  type RemoteLaunchProgressEvent,
  type RemoteLaunchStartParams,
  type RemoteLaunchStartResult,
  type RemoteLaunchStep,
  type RemoteLaunchStopParams,
  type SetupPlanStep
} from '@shared/types/remote-launch'
import type { Project, Session, SessionCreate, Worktree } from '../../../main/db'
import type { EventBus } from '../../events/event-bus'
import type { RpcHandler } from '../router'
import { slug } from './teleport-ops'

const execFileAsync = promisify(execFile)

// -- Deps ---------------------------------------------------------------

interface RemoteLaunchDb {
  getProject: (id: string) => Project | null
  getWorktree: (id: string) => Worktree | null
  getSession: (id: string) => Session | null
  createSession: (data: SessionCreate) => Session
  updateSession: (id: string, data: { remote_launch?: string | null }) => Session | null
  updateProject: (id: string, data: { worktree_create_script?: string | null }) => Project | null
  findSessionByRemoteLaunchId: (launchId: string, role: 'client' | 'host') => Session | null
}

interface RemoteLaunchGit {
  getRemoteUrl: (
    repoPath: string
  ) => Promise<{ success: boolean; url?: string | null; error?: string }>
  branchExistsOnOrigin: (repoPath: string, branch: string) => Promise<boolean>
  fetchOrigin: (repoPath: string, branch?: string) => Promise<void>
  aheadBehind: (repoPath: string, branch: string) => Promise<{ ahead: number; behind: number }>
  revParse: (repoPath: string, ref: string) => Promise<string>
}

interface RemoteLaunchRemote {
  /** Whether a Teleport remote target is configured (tolerant, never throws). */
  isConfigured: () => boolean
  /** The configured remote's base URL, used to stamp `RemoteLaunchClientInfo.url`. */
  getUrl: () => string
  request: <T>(method: string, params: unknown, timeoutMs: number) => Promise<T>
  /**
   * Like `request`, but targets `url` (a previously-stored
   * `RemoteLaunchClientInfo.url`) instead of whatever Teleport remote is
   * CURRENTLY configured. Used by `stop` so killing a session always hits the
   * host it was launched on, even if the user re-points Teleport at a
   * different remote afterwards. Auth still uses the current settings'
   * bootstrapToken.
   */
  requestAt: <T>(url: string, method: string, params: unknown, timeoutMs: number) => Promise<T>
}

interface StatResult {
  isFile: boolean
  isDirectory: boolean
}

interface RemoteLaunchFs {
  stat: (path: string) => Promise<StatResult | null>
  readFileBase64: (path: string) => Promise<string>
  mkdirp: (dirPath: string) => Promise<void>
  writeFileBase64: (path: string, contentBase64: string) => Promise<void>
}

interface RemoteLaunchTmux {
  hasSession: (name: string) => Promise<boolean>
  killSession: (name: string) => Promise<RemoteLaunchKillResult>
}

interface RemoteLaunchPty {
  create: (
    terminalId: string,
    opts: {
      cwd: string
      command: string
      args: string[]
      cols?: number
      rows?: number
    }
  ) => void
  attachListeners: (terminalId: string) => void
}

interface RemoteLaunchPing {
  gitAvailable: () => Promise<boolean>
  tmuxAvailable: () => Promise<boolean>
  claudeBinary: () => string | null
}

interface RemoteLaunchPaths {
  remoteLaunchPromptFile: (sessionId: string) => string
}

/** `createWorktreeFromBranchOp`'s params/result shape (see worktree-ops.ts), inlined here to
 * avoid a hard type import cycle risk between the two RPC-adjacent service modules. */
interface RemoteLaunchCreateWorktreeParams {
  projectId: string
  projectPath: string
  projectName: string
  branchName: string
  nameHint?: string
  autoPull?: boolean
}
interface RemoteLaunchCreateWorktreeResult {
  success: boolean
  worktree?: Worktree
  error?: string
}

export interface RemoteLaunchOpsDeps {
  readonly db: RemoteLaunchDb
  readonly git: RemoteLaunchGit
  readonly remote: RemoteLaunchRemote
  readonly publishProgress: (launchId: string, event: RemoteLaunchProgressEvent) => void
  readonly fs: RemoteLaunchFs
  readonly ensureRemoteProject: (gitUrl: string, projectName: string) => Promise<Project>
  readonly createWorktreeFromBranch: (
    params: RemoteLaunchCreateWorktreeParams
  ) => Promise<RemoteLaunchCreateWorktreeResult>
  readonly runSetupCommand: (
    command: string,
    cwd: string,
    channel: string
  ) => Promise<{ success: boolean; error?: string }>
  readonly tmux: RemoteLaunchTmux
  readonly desktopLaunchTmux: (
    payload: RemoteLaunchClaudeTmuxPayload
  ) => Promise<RemoteLaunchClaudeTmuxResult>
  readonly pty: RemoteLaunchPty
  readonly ping: RemoteLaunchPing
  readonly paths: RemoteLaunchPaths
}

// -- Service surface ------------------------------------------------------

export interface RemoteLaunchOpsRpcService {
  readonly preflight: (
    params: RemoteLaunchPreflightParams
  ) => Effect.Effect<RemoteLaunchPreflightResult, unknown, never>
  readonly start: (
    params: RemoteLaunchStartParams
  ) => Effect.Effect<RemoteLaunchStartResult, unknown, never>
  readonly stop: (
    params: RemoteLaunchStopParams
  ) => Effect.Effect<RemoteLaunchKillResult, unknown, never>
  readonly ping: () => Effect.Effect<RemoteLaunchPingResult, unknown, never>
  readonly prepare: (
    params: RemoteLaunchPrepareParams
  ) => Effect.Effect<RemoteLaunchPrepareResult, unknown, never>
  readonly applySetupPlan: (
    params: RemoteLaunchApplySetupPlanParams
  ) => Effect.Effect<RemoteLaunchApplySetupPlanResult, unknown, never>
  readonly launch: (
    params: RemoteLaunchLaunchParams
  ) => Effect.Effect<RemoteLaunchLaunchResult, unknown, never>
  readonly attachTerminal: (
    params: RemoteLaunchAttachParams
  ) => Effect.Effect<RemoteLaunchAttachResult, unknown, never>
  readonly killTmux: (
    params: RemoteLaunchKillTmuxParams
  ) => Effect.Effect<RemoteLaunchKillResult, unknown, never>
}

// -- Helpers ----------------------------------------------------------------

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

interface RemoteStepError {
  step?: string
  message: string
}

/**
 * A remote RPC failure (from `deps.remote.request`) surfaces on the client as
 * an `Error` whose `.details` mirrors whatever the remote's `RpcRouteError`
 * carried (see `toRpcError` in shared/rpc/errors.ts and `requestRemote` in
 * teleport-remote-client.ts). `remoteLaunch.prepare` uses this to tell the
 * caller whether a failure belongs to the `clone` or `worktree` step.
 */
function extractRemoteStepError(error: unknown): RemoteStepError {
  if (error instanceof Error) {
    const details = (error as Error & { details?: unknown }).details
    if (details && typeof details === 'object' && 'message' in details) {
      const step = 'step' in details && typeof details.step === 'string' ? details.step : undefined
      const message =
        typeof (details as { message?: unknown }).message === 'string'
          ? (details as { message: string }).message
          : error.message
      return { step, message }
    }
    return { message: error.message }
  }
  return { message: String(error) }
}

function stepError(step: 'clone' | 'worktree', error: unknown): RpcRouteError {
  const message = errorMessage(error)
  return new RpcRouteError(RPC_ERROR_CODES.internalError, message, { step, message })
}

/**
 * tmux resolves a `-t` target by exact match, then falls back to a unique
 * PREFIX match (see `tmux(1)` TARGET SPECIFICATION). Our collision-avoidance
 * naming scheme for launch sessions (`hive-<slug>`, `hive-<slug>-2`, ...)
 * creates prefix-siblings, so a bare `-t hive-husky` risks prefix-matching
 * `hive-husky-2` once `hive-husky` itself is gone — killing or attaching to a
 * different ticket's live session. Force exact match with the `=` prefix.
 * (Only applies to `-t` lookups; `new-session -s` takes a plain name and is
 * unaffected.)
 */
export function exactTmuxTarget(name: string): string {
  return `=${name}`
}

/**
 * The branch picker names remote-only branches `origin/<branch>` (see
 * `normalizeBranchDisplayName` in effect/git/layers.ts). Origin-side checks
 * (`ls-remote --heads origin <branch>`, `rev-parse origin/<branch>`) need the
 * bare branch name — passing `origin/foo` through would look for a head
 * literally named `origin/foo` and block valid remote-only branches.
 */
export function stripOriginPrefix(branch: string): string {
  return branch.startsWith('origin/') ? branch.slice('origin/'.length) : branch
}

/**
 * Classify a rejected `tmux kill-session` exec into a `RemoteLaunchKillResult`,
 * or rethrow for failures that are not "the session was already gone" (e.g.
 * permission errors). Extracted as a pure function (vs. inlined in the exec
 * try/catch) so the stderr-sniffing logic is unit-testable without spawning
 * real tmux — see the `classifyTmuxKillError` tests.
 */
export function classifyTmuxKillError(error: unknown): RemoteLaunchKillResult {
  const err = error as NodeJS.ErrnoException & { stderr?: string }
  if (err.code === 'ENOENT') {
    throw new Error('tmux is not installed on the remote machine')
  }
  const stderr = err.stderr ?? ''
  if (/session not found|no server running/i.test(stderr)) {
    return { killed: false, alreadyDead: true }
  }
  throw new Error(stderr.trim() || err.message)
}

/**
 * Resolve `relPath` against `worktreePath`, rejecting absolute paths and any
 * path that escapes the worktree via `..`. Returns null when disallowed.
 */
function resolveWorktreeRelativePath(worktreePath: string, relPath: string): string | null {
  if (path.isAbsolute(relPath)) return null
  const base = path.resolve(worktreePath)
  const resolved = path.resolve(base, relPath)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null
  return resolved
}

// -- Local orchestrator methods --------------------------------------------

async function preflightRemoteLaunch(
  deps: RemoteLaunchOpsDeps,
  params: RemoteLaunchPreflightParams
): Promise<RemoteLaunchPreflightResult> {
  const result: RemoteLaunchPreflightResult = {
    remoteConfigured: false,
    branchOnOrigin: false,
    localAhead: 0,
    localBehind: 0,
    diverged: false,
    transfers: [],
    transferErrors: []
  }

  try {
    result.remoteConfigured = deps.remote.isConfigured()
  } catch (error) {
    result.error = errorMessage(error)
  }

  const project = deps.db.getProject(params.projectId)
  if (!project) {
    result.error = result.error ?? 'Project not found'
    return result
  }

  const branch = stripOriginPrefix(params.branch)
  try {
    const remoteUrl = await deps.git.getRemoteUrl(project.path)
    if (!remoteUrl.success || !remoteUrl.url) {
      result.error = remoteUrl.error || 'Git remote "origin" is required for remote launch'
    } else {
      result.branchOnOrigin = await deps.git.branchExistsOnOrigin(project.path, branch)
      if (result.branchOnOrigin) {
        // Remote-only selections (picker names them `origin/<branch>`) have
        // no local ref, so the ahead/behind comparison is meaningless — and
        // `rev-list origin/x...x` would error and wrongly block the launch.
        let localBranchExists = true
        try {
          await deps.git.revParse(project.path, `refs/heads/${branch}`)
        } catch {
          localBranchExists = false
        }
        if (localBranchExists) {
          await deps.git.fetchOrigin(project.path, branch)
          const { ahead, behind } = await deps.git.aheadBehind(project.path, branch)
          result.localAhead = ahead
          result.localBehind = behind
          result.diverged = ahead > 0 && behind > 0
        }
      }
    }
  } catch (error) {
    result.error = result.error ?? errorMessage(error)
  }

  const plan = parseSetupScriptPlan(project.setup_script)
  for (const entry of plan.entries) {
    if (entry.kind === 'error') {
      result.transferErrors.push(entry.reason)
      continue
    }
    if (entry.kind !== 'transfer-candidate') continue

    try {
      const stat = await deps.fs.stat(entry.sourcePath)
      if (!stat) {
        result.transferErrors.push(`${entry.sourcePath} does not exist`)
      } else if (stat.isDirectory) {
        result.transferErrors.push(
          `${entry.sourcePath} is a directory (directories are not supported for remote launch)`
        )
      } else {
        result.transfers.push(entry.sourcePath)
      }
    } catch (error) {
      result.transferErrors.push(`${entry.sourcePath}: ${errorMessage(error)}`)
    }
  }

  return result
}

/** Build the ordered `SetupPlanStep[]` for a project's setup script, or a list of
 * human-readable problems that should hard-fail the `file-transfer` step. */
async function buildSetupPlanSteps(
  deps: RemoteLaunchOpsDeps,
  project: Project
): Promise<{ steps: SetupPlanStep[]; problems: string[] }> {
  const plan = parseSetupScriptPlan(project.setup_script)
  const steps: SetupPlanStep[] = []
  const problems: string[] = []

  for (const entry of plan.entries) {
    if (entry.kind === 'error') {
      problems.push(entry.reason)
      continue
    }
    if (entry.kind === 'command') {
      steps.push({ type: 'run', command: entry.line })
      continue
    }

    try {
      const stat = await deps.fs.stat(entry.sourcePath)
      if (!stat) {
        problems.push(`${entry.sourcePath} does not exist`)
        continue
      }
      if (stat.isDirectory) {
        problems.push(`${entry.sourcePath} is a directory (directories are not supported)`)
        continue
      }
      const contentBase64 = await deps.fs.readFileBase64(entry.sourcePath)
      steps.push({ type: 'write', destRelPath: entry.dest, contentBase64 })
    } catch (error) {
      problems.push(`${entry.sourcePath}: ${errorMessage(error)}`)
    }
  }

  return { steps, problems }
}

async function startRemoteLaunch(
  deps: RemoteLaunchOpsDeps,
  params: RemoteLaunchStartParams
): Promise<RemoteLaunchStartResult> {
  const { launchId } = params
  const publish = (step: RemoteLaunchStep, event: Omit<RemoteLaunchProgressEvent, 'step'>): void =>
    deps.publishProgress(launchId, { step, ...event })
  const fail = (step: RemoteLaunchStep, error: unknown): RemoteLaunchStartResult => {
    const message = errorMessage(error)
    publish(step, { status: 'error', error: message })
    return { success: false, step, error: message }
  }

  // Step 1: connect
  publish('connect', { status: 'running' })
  let ping: RemoteLaunchPingResult
  try {
    ping = await deps.remote.request<RemoteLaunchPingResult>('remoteLaunchOps.ping', {}, 15_000)
    if (!ping.ok) {
      const missing: string[] = []
      if (!ping.git) missing.push('git is not installed on the remote machine')
      if (!ping.tmux) missing.push('tmux is not installed on the remote machine')
      if (!ping.claude) missing.push('the claude binary was not found on the remote machine')
      throw new Error(missing.join('; ') || 'Remote preflight check failed')
    }
  } catch (error) {
    return fail('connect', error)
  }
  publish('connect', { status: 'done' })

  // Step 2: branch-check
  publish('branch-check', { status: 'running' })
  const branch = stripOriginPrefix(params.branch)
  let project: Project
  try {
    const found = deps.db.getProject(params.projectId)
    if (!found) throw new Error('Project not found')
    project = found
    const onOrigin = await deps.git.branchExistsOnOrigin(project.path, branch)
    if (!onOrigin) {
      throw new Error(`Branch "${branch}" was not found on origin`)
    }
  } catch (error) {
    return fail('branch-check', error)
  }
  publish('branch-check', { status: 'done' })

  // Steps 3 + 4: clone + worktree, via one remote call (`prepare`)
  publish('clone', { status: 'running' })
  let prepareResult: RemoteLaunchPrepareResult
  try {
    const remoteUrl = await deps.git.getRemoteUrl(project.path)
    if (!remoteUrl.success || !remoteUrl.url) {
      throw new Error(remoteUrl.error || 'Git remote "origin" is required for remote launch')
    }
    // Same worktree-naming hint local launches pass (see WorktreePickerModal's
    // createWorktreeAndWait call) so the remote worktree is named after the
    // ticket instead of falling back to branch-based naming.
    const nameHint = canonicalizeTicketTitle(params.ticketTitle)
    prepareResult = await deps.remote.request<RemoteLaunchPrepareResult>(
      'remoteLaunchOps.prepare',
      {
        launchId,
        gitUrl: remoteUrl.url,
        projectName: project.name,
        branch,
        ...(nameHint ? { nameHint } : {}),
        worktreeCreateScript: project.worktree_create_script ?? null,
        mode: params.mode,
        model: params.model
      } satisfies RemoteLaunchPrepareParams,
      600_000
    )
  } catch (error) {
    const info = extractRemoteStepError(error)
    if (info.step === 'worktree') {
      publish('clone', { status: 'done' })
      publish('worktree', { status: 'running' })
      publish('worktree', { status: 'error', error: info.message })
      return { success: false, step: 'worktree', error: info.message }
    }
    publish('clone', { status: 'error', error: info.message })
    return { success: false, step: 'clone', error: info.message }
  }
  publish('clone', { status: 'done' })
  publish('worktree', { status: 'running' })
  publish('worktree', { status: 'done' })

  // Steps 5 + 6: file-transfer + setup-script
  publish('file-transfer', { status: 'running' })
  const { steps, problems } = await buildSetupPlanSteps(deps, project)
  if (problems.length > 0) {
    return fail('file-transfer', new Error(problems.join('; ')))
  }

  if (steps.length === 0) {
    publish('file-transfer', { status: 'done' })
    publish('setup-script', { status: 'running' })
    publish('setup-script', { status: 'done' })
  } else {
    let applyResult: RemoteLaunchApplySetupPlanResult
    try {
      applyResult = await deps.remote.request<RemoteLaunchApplySetupPlanResult>(
        'remoteLaunchOps.applySetupPlan',
        {
          launchId,
          remoteWorktreeId: prepareResult.remoteWorktreeId,
          steps
        } satisfies RemoteLaunchApplySetupPlanParams,
        900_000
      )
    } catch (error) {
      return fail('file-transfer', error)
    }

    if (!applyResult.success) {
      const message =
        applyResult.error ||
        `Setup step ${applyResult.failedStepIndex ?? '?'} failed (${applyResult.failedKind ?? 'unknown'})`
      if (applyResult.failedKind === 'run') {
        publish('file-transfer', { status: 'done' })
        publish('setup-script', { status: 'running' })
        publish('setup-script', { status: 'error', error: message })
        return { success: false, step: 'setup-script', error: message }
      }
      publish('file-transfer', { status: 'error', error: message })
      return { success: false, step: 'file-transfer', error: message }
    }

    publish('file-transfer', { status: 'done' })
    publish('setup-script', { status: 'running' })
    publish('setup-script', { status: 'done' })
  }

  // Step 7: launch
  publish('launch', { status: 'running' })
  let launchResult: RemoteLaunchLaunchResult
  try {
    launchResult = await deps.remote.request<RemoteLaunchLaunchResult>(
      'remoteLaunchOps.launch',
      {
        launchId,
        remoteSessionId: prepareResult.remoteSessionId,
        prompt: params.prompt
      } satisfies RemoteLaunchLaunchParams,
      60_000
    )
  } catch (error) {
    return fail('launch', error)
  }
  publish('launch', { status: 'done' })

  // Local session bookkeeping happens after the remote launch already
  // succeeded and `launch:done` was published, so a failure here must not
  // reject the RPC raw and — since `launch:done` already went out — must not
  // publish a second progress event for the same step (no `fail()` here).
  // A retry with the same launchId must not double-create a local session
  // row, and reuses the running tmux session via `prepare`'s reuse path.
  try {
    const existing = deps.db.findSessionByRemoteLaunchId(launchId, 'client')
    if (existing && parseRemoteLaunch(existing.remote_launch)?.role === 'client') {
      return { success: true, localSessionId: existing.id, tmuxSession: launchResult.tmuxSession }
    }

    const clientInfo: RemoteLaunchClientInfo = {
      role: 'client',
      launchId,
      url: deps.remote.getUrl(),
      remoteSessionId: prepareResult.remoteSessionId,
      remoteWorktreeId: prepareResult.remoteWorktreeId,
      remoteProjectId: prepareResult.remoteProjectId,
      tmuxSession: launchResult.tmuxSession,
      branch: prepareResult.remoteBranch,
      worktreePath: prepareResult.remoteWorktreePath,
      launchedAt: new Date().toISOString()
    }

    const localSession = deps.db.createSession({
      worktree_id: null,
      project_id: params.projectId,
      agent_sdk: 'claude-code-cli',
      mode: params.mode,
      model_provider_id: params.model?.providerId ?? null,
      model_id: params.model?.id ?? null,
      model_variant: params.model?.variant ?? null,
      remote_launch: JSON.stringify(clientInfo)
    })

    return { success: true, localSessionId: localSession.id, tmuxSession: launchResult.tmuxSession }
  } catch (error) {
    return {
      success: false,
      step: 'launch',
      error: `Remote session "${launchResult.tmuxSession}" is running, but recording it locally failed: ${errorMessage(error)}. Retry to relink it.`,
      tmuxSession: launchResult.tmuxSession
    }
  }
}

async function stopRemoteLaunch(
  deps: RemoteLaunchOpsDeps,
  params: RemoteLaunchStopParams
): Promise<RemoteLaunchKillResult> {
  const session = deps.db.getSession(params.sessionId)
  if (!session) throw new Error('Session not found')

  const info = parseRemoteLaunch(session.remote_launch)
  if (!info || info.role !== 'client') {
    throw new Error('Session is not a remote-launched client session')
  }

  const result = await deps.remote.requestAt<RemoteLaunchKillResult>(
    info.url,
    'remoteLaunchOps.killTmux',
    { remoteSessionId: info.remoteSessionId, tmuxSession: info.tmuxSession } satisfies RemoteLaunchKillTmuxParams,
    15_000
  )

  // Stamp the local row so the ticket's remote badge/actions don't survive a
  // successful stop (the renderer store maps a stopped client info to null).
  if (result.killed || result.alreadyDead) {
    const stopped: RemoteLaunchClientInfo = { ...info, stoppedAt: new Date().toISOString() }
    deps.db.updateSession(params.sessionId, { remote_launch: JSON.stringify(stopped) })
  }

  return result
}

// -- Remote methods -----------------------------------------------------

async function pingRemoteLaunch(deps: RemoteLaunchOpsDeps): Promise<RemoteLaunchPingResult> {
  const [git, tmux] = await Promise.all([deps.ping.gitAvailable(), deps.ping.tmuxAvailable()])
  const claudeBinary = deps.ping.claudeBinary()
  const claude = claudeBinary !== null
  return { ok: git && tmux && claude, git, tmux, claude }
}

async function prepareRemoteLaunch(
  deps: RemoteLaunchOpsDeps,
  params: RemoteLaunchPrepareParams
): Promise<RemoteLaunchPrepareResult> {
  // Host-role lookup (the query is role-qualified; the parse re-check is a
  // cheap belt against a stale/garbled remote_launch column). A client-role
  // row with the same launchId (possible when host and client share a DB,
  // e.g. self-launch) has no worktree and would wrongly fail the retry.
  const existing = deps.db.findSessionByRemoteLaunchId(params.launchId, 'host')
  if (existing && parseRemoteLaunch(existing.remote_launch)?.role === 'host') {
    const worktree = existing.worktree_id ? deps.db.getWorktree(existing.worktree_id) : null
    if (!worktree) {
      throw stepError('worktree', new Error('Reused remote-launch session has no worktree'))
    }
    return {
      remoteProjectId: worktree.project_id,
      remoteWorktreeId: worktree.id,
      remoteSessionId: existing.id,
      remoteWorktreePath: worktree.path,
      remoteBranch: worktree.branch_name,
      reused: true
    }
  }

  let project: Project
  try {
    project = await deps.ensureRemoteProject(params.gitUrl, params.projectName)
  } catch (error) {
    throw stepError('clone', error)
  }

  // Sync the local project's worktree-create script onto the remote project
  // row: createWorktreeFromBranchOp reads it from there, and a freshly cloned
  // remote project has none — silently skipping the project's custom worktree
  // bootstrap (submodules, symlinks, ...).
  if (
    params.worktreeCreateScript !== undefined &&
    (project.worktree_create_script ?? null) !== params.worktreeCreateScript
  ) {
    const updated = deps.db.updateProject(project.id, {
      worktree_create_script: params.worktreeCreateScript
    })
    if (updated) project = updated
  }

  try {
    await deps.git.fetchOrigin(project.path)
    await deps.git.revParse(project.path, `origin/${params.branch}`)
  } catch (error) {
    throw stepError(
      'clone',
      new Error(
        `Branch "${params.branch}" is not visible from the remote machine (check remote git credentials): ${errorMessage(error)}`
      )
    )
  }

  let worktree: Worktree
  try {
    const worktreeResult = await deps.createWorktreeFromBranch({
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      branchName: params.branch,
      nameHint: params.nameHint,
      // The fetch + revParse above already validated origin/<branch>. The
      // op's auto-pull would run `git pull origin <branch> --ff-only` in the
      // shared base clone's checkout and could fast-forward ITS branch (e.g.
      // main) onto the feature branch, corrupting the clone for later
      // launches.
      autoPull: false
    })
    if (!worktreeResult.success || !worktreeResult.worktree) {
      throw new Error(worktreeResult.error || 'Failed to create remote worktree')
    }
    worktree = worktreeResult.worktree
  } catch (error) {
    throw stepError('worktree', error)
  }

  let session: Session
  try {
    const hostInfo: RemoteLaunchHostInfo = {
      role: 'host',
      launchId: params.launchId,
      tmuxSession: null,
      promptFile: null
    }
    session = deps.db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      agent_sdk: 'claude-code-cli',
      mode: params.mode,
      model_provider_id: params.model?.providerId ?? null,
      model_id: params.model?.id ?? null,
      model_variant: params.model?.variant ?? null,
      remote_launch: JSON.stringify(hostInfo)
    })
  } catch (error) {
    throw stepError('worktree', error)
  }

  return {
    remoteProjectId: project.id,
    remoteWorktreeId: worktree.id,
    remoteSessionId: session.id,
    remoteWorktreePath: worktree.path,
    remoteBranch: worktree.branch_name,
    reused: false
  }
}

async function applySetupPlanRemoteLaunch(
  deps: RemoteLaunchOpsDeps,
  params: RemoteLaunchApplySetupPlanParams
): Promise<RemoteLaunchApplySetupPlanResult> {
  const worktree = deps.db.getWorktree(params.remoteWorktreeId)
  if (!worktree) throw new Error('Remote worktree not found')
  const worktreePath = worktree.path

  // Idempotency: a retry of the same launchId reuses the prepared worktree
  // (see prepareRemoteLaunch), so a plan that already ran to completion must
  // not run again — non-idempotent setup commands would execute twice.
  const hostSession = deps.db.findSessionByRemoteLaunchId(params.launchId, 'host')
  const parsed = hostSession ? parseRemoteLaunch(hostSession.remote_launch) : null
  const hostInfo = parsed?.role === 'host' ? parsed : null
  if (hostInfo?.setupAppliedAt) {
    return { success: true }
  }

  for (let i = 0; i < params.steps.length; i += 1) {
    const step = params.steps[i]

    if (step.type === 'write') {
      const resolved = resolveWorktreeRelativePath(worktreePath, step.destRelPath)
      if (!resolved) {
        return {
          success: false,
          failedStepIndex: i,
          failedKind: 'write',
          error: `Destination path "${step.destRelPath}" is not allowed`
        }
      }
      try {
        // Guard against a destination that names an existing directory (the
        // parser normalizes `.`/trailing-slash dests, but `cp x dir` with no
        // slash still reaches here) — writing file bytes there would EISDIR
        // with a much less actionable message.
        const destStat = await deps.fs.stat(resolved)
        if (destStat?.isDirectory) {
          return {
            success: false,
            failedStepIndex: i,
            failedKind: 'write',
            error: `Destination "${step.destRelPath}" is a directory on the remote; use a trailing slash (e.g. "${step.destRelPath}/") to copy into it`
          }
        }
        await deps.fs.mkdirp(dirname(resolved))
        await deps.fs.writeFileBase64(resolved, step.contentBase64)
      } catch (error) {
        return { success: false, failedStepIndex: i, failedKind: 'write', error: errorMessage(error) }
      }
      continue
    }

    const result = await deps.runSetupCommand(
      step.command,
      worktreePath,
      `script:setup:${params.remoteWorktreeId}`
    )
    if (!result.success) {
      return {
        success: false,
        failedStepIndex: i,
        failedKind: 'run',
        error: result.error || `Command failed: ${step.command}`
      }
    }
  }

  if (hostSession && hostInfo) {
    const stamped: RemoteLaunchHostInfo = {
      ...hostInfo,
      setupAppliedAt: new Date().toISOString()
    }
    deps.db.updateSession(hostSession.id, { remote_launch: JSON.stringify(stamped) })
  }

  return { success: true }
}

async function launchRemoteLaunch(
  deps: RemoteLaunchOpsDeps,
  params: RemoteLaunchLaunchParams
): Promise<RemoteLaunchLaunchResult> {
  const session = deps.db.getSession(params.remoteSessionId)
  if (!session) throw new Error('Remote session not found')

  const hostInfo = parseRemoteLaunch(session.remote_launch)
  if (hostInfo?.role === 'host' && hostInfo.tmuxSession) {
    const alive = await deps.tmux.hasSession(hostInfo.tmuxSession)
    if (alive) return { tmuxSession: hostInfo.tmuxSession }
  }

  const worktree = session.worktree_id ? deps.db.getWorktree(session.worktree_id) : null
  if (!worktree) throw new Error('Remote session has no worktree')

  const baseName = `hive-${slug(worktree.branch_name)}`
  let name = baseName
  let suffix = 2
  while (await deps.tmux.hasSession(name)) {
    if (suffix > 100) {
      throw new Error(
        `All tmux session names "${baseName}" through "${baseName}-100" are taken; kill stale hive sessions on the remote machine`
      )
    }
    name = `${baseName}-${suffix}`
    suffix += 1
  }

  const bridgeResult = await deps.desktopLaunchTmux({
    sessionId: params.remoteSessionId,
    worktreePath: worktree.path,
    prompt: params.prompt,
    tmuxSessionName: name
  })
  if (!bridgeResult.success || !bridgeResult.tmuxSession) {
    throw new Error(bridgeResult.error || 'Failed to launch remote Claude CLI tmux session')
  }

  // Spread the existing host info so fields stamped by earlier steps (e.g.
  // applySetupPlan's setupAppliedAt) survive this rewrite — dropping them
  // would make a post-launch retry re-run the setup plan.
  const updatedHostInfo: RemoteLaunchHostInfo = {
    ...(hostInfo?.role === 'host' ? hostInfo : {}),
    role: 'host',
    launchId: params.launchId,
    tmuxSession: bridgeResult.tmuxSession,
    promptFile: deps.paths.remoteLaunchPromptFile(session.id)
  }
  deps.db.updateSession(session.id, { remote_launch: JSON.stringify(updatedHostInfo) })

  return { tmuxSession: bridgeResult.tmuxSession }
}

async function attachTerminalRemoteLaunch(
  deps: RemoteLaunchOpsDeps,
  params: RemoteLaunchAttachParams
): Promise<RemoteLaunchAttachResult> {
  const session = deps.db.getSession(params.remoteSessionId)
  if (!session) throw new Error('Remote session not found')

  const hostInfo = parseRemoteLaunch(session.remote_launch)
  const tmuxSession = hostInfo?.role === 'host' ? hostInfo.tmuxSession : null
  if (!tmuxSession) throw new Error('Remote session has exited')

  const alive = await deps.tmux.hasSession(tmuxSession)
  if (!alive) throw new Error('Remote session has exited')

  const worktree = session.worktree_id ? deps.db.getWorktree(session.worktree_id) : null
  if (!worktree) throw new Error('Remote session has no worktree')

  // Prefer the client-generated id: it lets the client subscribe to
  // `terminal:data:<id>` BEFORE this RPC creates the PTY, so the initial tmux
  // screen dump (published as soon as listeners attach) isn't emitted before
  // the subscription exists. The schema constrains it to the
  // `remote-attach-` namespace so a client can't collide with other terminals.
  const terminalId =
    params.terminalId ??
    `remote-attach-${params.remoteSessionId}-${Math.random().toString(36).slice(2)}`
  deps.pty.create(terminalId, {
    cwd: worktree.path,
    command: 'tmux',
    args: ['attach-session', '-t', exactTmuxTarget(tmuxSession)],
    cols: params.cols,
    rows: params.rows
  })
  deps.pty.attachListeners(terminalId)

  return { terminalId }
}

async function killTmuxRemoteLaunch(
  deps: RemoteLaunchOpsDeps,
  params: RemoteLaunchKillTmuxParams
): Promise<RemoteLaunchKillResult> {
  return deps.tmux.killSession(params.tmuxSession)
}

// -- Live deps --------------------------------------------------------------

function isRemoteLaunchClaudeTmuxResult(value: unknown): value is RemoteLaunchClaudeTmuxResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as { success: unknown }).success === 'boolean' &&
    (!('error' in value) || typeof (value as { error?: unknown }).error === 'string') &&
    (!('tmuxSession' in value) || typeof (value as { tmuxSession?: unknown }).tmuxSession === 'string')
  )
}

/**
 * Bridge helper mirroring `requestDesktopTerminalCreateClaudeCli` in
 * terminal-ops.ts (process.send + pending-request map + timeout), kept local
 * to this domain rather than reused: that machinery is hardcoded per-command
 * (own listener/timeout per function, not a shared generic), so extracting it
 * would mean exporting several terminal-ops internals for a single call site.
 * A 60s timeout is used (vs. the 5s used by most terminal-ops bridges) since
 * this spawns a claude-cli process and waits for tmux + hook-server setup.
 */
function requestDesktopRemoteLaunchClaudeTmux(
  payload: RemoteLaunchClaudeTmuxPayload
): Promise<RemoteLaunchClaudeTmuxResult> {
  const send = process.send
  if (!send) {
    return Promise.resolve({ success: false, error: 'Desktop command transport is not available' })
  }

  const id = `remote-launch-claude-tmux-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'remoteLaunchClaudeTmux'

  return new Promise<RemoteLaunchClaudeTmuxResult>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value: RemoteLaunchClaudeTmuxResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timeout = setTimeout(() => {
      finish({
        success: false,
        error: `Timed out waiting for desktop command response: ${command}`
      })
    }, 60_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish({ success: false, error: message.error ?? `Desktop command failed: ${command}` })
        return
      }
      if (isRemoteLaunchClaudeTmuxResult(message.value)) {
        finish(message.value)
        return
      }
      finish({ success: false, error: `Invalid desktop command response for ${command}` })
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, payload), (error) => {
      if (!error) return
      finish({ success: false, error: error.message })
    })
  })
}

/**
 * Live `RemoteLaunchTmux` implementation (real `tmux` exec calls). Extracted
 * out of `createLiveDeps` — rather than inlined — so it can be unit tested by
 * mocking `node:child_process` without dragging in `createLiveDeps`'s other
 * dynamic imports (db, git facade, etc.). See `exactTmuxTarget` for why
 * targets are `=`-prefixed.
 */
export function createLiveTmuxDeps(): RemoteLaunchTmux {
  return {
    hasSession: async (name) => {
      try {
        await execFileAsync('tmux', ['has-session', '-t', exactTmuxTarget(name)])
        return true
      } catch {
        return false
      }
    },
    killSession: async (name) => {
      try {
        await execFileAsync('tmux', ['kill-session', '-t', exactTmuxTarget(name)])
        return { killed: true, alreadyDead: false }
      } catch (error) {
        return classifyTmuxKillError(error)
      }
    }
  }
}

async function createLiveDeps(eventBus?: EventBus): Promise<RemoteLaunchOpsDeps> {
  const [
    { getDatabase },
    { gitService },
    { execGit },
    { ensureRemoteProject },
    { createWorktreeFromBranchOp },
    { scriptRunner },
    { ptyService },
    { attachBackendPtyListeners },
    { resolveClaudeBinaryPath },
    { getTeleportSettings, targetFromSettings, requestRemote }
  ] = await Promise.all([
    import('../../../main/db'),
    import('../../../main/effect/git/facade'),
    import('../../../main/services/git-exec'),
    import('../../../main/services/remote-project-ensure'),
    import('../../../main/services/worktree-ops'),
    import('../../../main/services/script-runner'),
    import('../../../main/services/pty-service'),
    import('./terminal-ops'),
    import('../../../main/services/claude-binary-resolver'),
    import('../../../main/services/teleport-remote-client')
  ])

  const db = getDatabase()

  return {
    db: {
      getProject: (id) => db.getProject(id),
      getWorktree: (id) => db.getWorktree(id),
      getSession: (id) => db.getSession(id),
      createSession: (data) => db.createSession(data),
      updateSession: (id, data) => db.updateSession(id, data),
      findSessionByRemoteLaunchId: (launchId, role) =>
        db.findSessionByRemoteLaunchId(launchId, role),
      updateProject: (id, data) => db.updateProject(id, data)
    },
    git: {
      getRemoteUrl: (repoPath) => gitService.getRemoteUrl(repoPath, 'origin'),
      branchExistsOnOrigin: async (repoPath, branch) => {
        const output = await execGit(repoPath, ['ls-remote', '--heads', 'origin', branch])
        return output.trim().length > 0
      },
      fetchOrigin: async (repoPath, branch) => {
        await execGit(repoPath, branch ? ['fetch', 'origin', branch] : ['fetch', 'origin'])
      },
      aheadBehind: async (repoPath, branch) => {
        const output = await execGit(repoPath, [
          'rev-list',
          '--left-right',
          '--count',
          `origin/${branch}...${branch}`
        ])
        const [behindStr, aheadStr] = output.trim().split(/\s+/)
        return { ahead: Number(aheadStr) || 0, behind: Number(behindStr) || 0 }
      },
      revParse: (repoPath, ref) => execGit(repoPath, ['rev-parse', ref])
    },
    remote: {
      isConfigured: () => {
        try {
          getTeleportSettings()
          return true
        } catch {
          return false
        }
      },
      getUrl: () => getTeleportSettings().url,
      request: (method, params, timeoutMs) =>
        requestRemote(targetFromSettings(getTeleportSettings()), method, params, timeoutMs),
      requestAt: (url, method, params, timeoutMs) =>
        requestRemote(
          targetFromSettings({ url, bootstrapToken: getTeleportSettings().bootstrapToken }),
          method,
          params,
          timeoutMs
        )
    },
    publishProgress: (launchId, event) => {
      if (!eventBus) return
      void Effect.runPromise(
        eventBus.publish({ channel: remoteLaunchProgressChannel(launchId), payload: event })
      ).catch(() => undefined)
    },
    fs: {
      stat: async (targetPath) => {
        const { stat } = await import('node:fs/promises')
        try {
          const info = await stat(targetPath)
          return { isFile: info.isFile(), isDirectory: info.isDirectory() }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      },
      readFileBase64: async (targetPath) => {
        const { readFile } = await import('node:fs/promises')
        return (await readFile(targetPath)).toString('base64')
      },
      mkdirp: async (dirPath) => {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(dirPath, { recursive: true })
      },
      writeFileBase64: async (targetPath, contentBase64) => {
        const { writeFile, chmod } = await import('node:fs/promises')
        // Transferred files are typically secrets (.env, credentials) shipped
        // to a possibly multi-user remote host — write them owner-only, same
        // 0600 treatment as writeSecretFile in remote-tmux-launcher.ts
        // (writeFile's mode only applies on creation and is subject to the
        // umask, hence the explicit chmod after).
        await writeFile(targetPath, Buffer.from(contentBase64, 'base64'), { mode: 0o600 })
        await chmod(targetPath, 0o600)
      }
    },
    ensureRemoteProject,
    createWorktreeFromBranch: (params) => createWorktreeFromBranchOp(params),
    runSetupCommand: (command, cwd, channel) => scriptRunner.runSequential([command], cwd, channel),
    tmux: createLiveTmuxDeps(),
    desktopLaunchTmux: (payload) => requestDesktopRemoteLaunchClaudeTmux(payload),
    pty: {
      create: (terminalId, opts) => {
        ptyService.create(terminalId, opts)
      },
      attachListeners: (terminalId) => attachBackendPtyListeners(eventBus, terminalId)
    },
    ping: {
      gitAvailable: async () => {
        try {
          await execFileAsync('git', ['--version'])
          return true
        } catch {
          return false
        }
      },
      tmuxAvailable: async () => {
        try {
          await execFileAsync('tmux', ['-V'])
          return true
        } catch {
          return false
        }
      },
      claudeBinary: () => resolveClaudeBinaryPath()
    },
    paths: {
      remoteLaunchPromptFile: (sessionId) =>
        join(homedir(), '.hive', 'remote-launch', `${sessionId}.prompt.txt`)
    }
  }
}

// -- Service wiring -----------------------------------------------------

export const makeRemoteLaunchOpsRpcService = (deps: RemoteLaunchOpsDeps): RemoteLaunchOpsRpcService => ({
  preflight: (params) =>
    Effect.tryPromise({ try: () => preflightRemoteLaunch(deps, params), catch: (cause) => cause }),
  start: (params) =>
    Effect.tryPromise({ try: () => startRemoteLaunch(deps, params), catch: (cause) => cause }),
  stop: (params) =>
    Effect.tryPromise({ try: () => stopRemoteLaunch(deps, params), catch: (cause) => cause }),
  ping: () => Effect.tryPromise({ try: () => pingRemoteLaunch(deps), catch: (cause) => cause }),
  prepare: (params) =>
    Effect.tryPromise({ try: () => prepareRemoteLaunch(deps, params), catch: (cause) => cause }),
  applySetupPlan: (params) =>
    Effect.tryPromise({
      try: () => applySetupPlanRemoteLaunch(deps, params),
      catch: (cause) => cause
    }),
  launch: (params) =>
    Effect.tryPromise({ try: () => launchRemoteLaunch(deps, params), catch: (cause) => cause }),
  attachTerminal: (params) =>
    Effect.tryPromise({
      try: () => attachTerminalRemoteLaunch(deps, params),
      catch: (cause) => cause
    }),
  killTmux: (params) =>
    Effect.tryPromise({ try: () => killTmuxRemoteLaunch(deps, params), catch: (cause) => cause })
})

export const makeLiveRemoteLaunchOpsRpcService = (eventBus?: EventBus): RemoteLaunchOpsRpcService => ({
  preflight: (params) =>
    Effect.tryPromise({
      try: async () => preflightRemoteLaunch(await createLiveDeps(eventBus), params),
      catch: (cause) => cause
    }),
  start: (params) =>
    Effect.tryPromise({
      try: async () => startRemoteLaunch(await createLiveDeps(eventBus), params),
      catch: (cause) => cause
    }),
  stop: (params) =>
    Effect.tryPromise({
      try: async () => stopRemoteLaunch(await createLiveDeps(eventBus), params),
      catch: (cause) => cause
    }),
  ping: () =>
    Effect.tryPromise({
      try: async () => pingRemoteLaunch(await createLiveDeps(eventBus)),
      catch: (cause) => cause
    }),
  prepare: (params) =>
    Effect.tryPromise({
      try: async () => prepareRemoteLaunch(await createLiveDeps(eventBus), params),
      catch: (cause) => cause
    }),
  applySetupPlan: (params) =>
    Effect.tryPromise({
      try: async () => applySetupPlanRemoteLaunch(await createLiveDeps(eventBus), params),
      catch: (cause) => cause
    }),
  launch: (params) =>
    Effect.tryPromise({
      try: async () => launchRemoteLaunch(await createLiveDeps(eventBus), params),
      catch: (cause) => cause
    }),
  attachTerminal: (params) =>
    Effect.tryPromise({
      try: async () => attachTerminalRemoteLaunch(await createLiveDeps(eventBus), params),
      catch: (cause) => cause
    }),
  killTmux: (params) =>
    Effect.tryPromise({
      try: async () => killTmuxRemoteLaunch(await createLiveDeps(eventBus), params),
      catch: (cause) => cause
    })
})

// -- Zod param schemas + handlers ----------------------------------------

const modeSchema = z.enum(['build', 'plan'])

const modelSelectionSchema = z
  .object({
    providerId: z.string().min(1),
    id: z.string().min(1),
    variant: z.string().nullable().optional()
  })
  .strict()

const setupPlanStepSchema = z.union([
  z
    .object({
      type: z.literal('write'),
      destRelPath: z.string().min(1),
      contentBase64: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal('run'),
      command: z.string().min(1)
    })
    .strict()
])

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])

const preflightParamsSchema = z
  .object({
    projectId: z.string().min(1),
    branch: z.string().min(1)
  })
  .strict() satisfies z.ZodType<RemoteLaunchPreflightParams>

const startParamsSchema = z
  .object({
    launchId: z.string().min(1),
    ticketId: z.string().min(1),
    projectId: z.string().min(1),
    branch: z.string().min(1),
    prompt: z.string(),
    mode: modeSchema,
    model: modelSelectionSchema.nullable(),
    ticketTitle: z.string()
  })
  .strict() satisfies z.ZodType<RemoteLaunchStartParams>

const stopParamsSchema = z
  .object({ sessionId: z.string().min(1) })
  .strict() satisfies z.ZodType<RemoteLaunchStopParams>

const prepareParamsSchema = z
  .object({
    launchId: z.string().min(1),
    gitUrl: z.string().min(1),
    projectName: z.string().min(1),
    branch: z.string().min(1),
    nameHint: z.string().optional(),
    worktreeCreateScript: z.string().nullable().optional(),
    mode: modeSchema,
    model: modelSelectionSchema.nullable()
  })
  .strict() satisfies z.ZodType<RemoteLaunchPrepareParams>

const applySetupPlanParamsSchema = z
  .object({
    launchId: z.string().min(1),
    remoteWorktreeId: z.string().min(1),
    steps: z.array(setupPlanStepSchema)
  })
  .strict() satisfies z.ZodType<RemoteLaunchApplySetupPlanParams>

const launchParamsSchema = z
  .object({
    launchId: z.string().min(1),
    remoteSessionId: z.string().min(1),
    prompt: z.string()
  })
  .strict() satisfies z.ZodType<RemoteLaunchLaunchParams>

const attachTerminalParamsSchema = z
  .object({
    remoteSessionId: z.string().min(1),
    terminalId: z
      .string()
      .regex(/^remote-attach-[A-Za-z0-9_-]{1,200}$/)
      .optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional()
  })
  .strict() satisfies z.ZodType<RemoteLaunchAttachParams>

const killTmuxParamsSchema = z
  .object({
    remoteSessionId: z.string().min(1),
    tmuxSession: z.string().min(1)
  })
  .strict() satisfies z.ZodType<RemoteLaunchKillTmuxParams>

export const makeRemoteLaunchOpsRpcHandlers = (
  service: RemoteLaunchOpsRpcService = makeLiveRemoteLaunchOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'remoteLaunchOps.preflight',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => preflightParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.preflight(parsed)
        })
    ],
    [
      'remoteLaunchOps.start',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => startParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.start(parsed)
        })
    ],
    [
      'remoteLaunchOps.stop',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => stopParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.stop(parsed)
        })
    ],
    [
      'remoteLaunchOps.ping',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.ping()
        })
    ],
    [
      'remoteLaunchOps.prepare',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => prepareParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.prepare(parsed)
        })
    ],
    [
      'remoteLaunchOps.applySetupPlan',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => applySetupPlanParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.applySetupPlan(parsed)
        })
    ],
    [
      'remoteLaunchOps.launch',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => launchParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.launch(parsed)
        })
    ],
    [
      'remoteLaunchOps.attachTerminal',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => attachTerminalParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.attachTerminal(parsed)
        })
    ],
    [
      'remoteLaunchOps.killTmux',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => killTmuxParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.killTmux(parsed)
        })
    ]
  ])
