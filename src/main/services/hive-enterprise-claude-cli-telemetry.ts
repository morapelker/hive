import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_SETTINGS_DB_KEY, DEFAULT_HIVE_ENTERPRISE_SERVER_URL } from '@shared/types/settings'
import type { DatabaseService } from '../db/database'
import { getDatabase } from '../db'
import type { Project } from '../db/types'
import { getClaudeAccountEmail } from './account-service'
import { GitService } from './git-service'
import { createLogger } from './logger'
import { isTaskNotificationPrompt } from './claude-cli-subagent-tracker'

const RecordPromptStartDocument = /* GraphQL */ `
  mutation HiveEnterpriseRecordPromptStart($input: PromptStartInput!) {
    recordPromptStart(input: $input) {
      recorded
      promptId
      storePrompts
    }
  }
`

const RecordPromptIdleDocument = /* GraphQL */ `
  mutation HiveEnterpriseRecordPromptIdle($input: PromptIdleInput!) {
    recordPromptIdle(input: $input) {
      recorded
      storePrompts
    }
  }
`

interface ClaudeCliTelemetryHook {
  hook_event_name?: string
  prompt?: unknown
  transcript_path?: unknown
}

interface HiveEnterpriseSettings {
  hiveEnterpriseServerUrl?: unknown
  hiveAuthToken?: unknown
  hiveOrganizationId?: unknown
  hiveOrganizationStorePrompts?: unknown
}

interface TokenCounters {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface ActivePrompt {
  promptId: string
  transcriptPath: string | null
  baseline: TokenCounters
}

interface PromptStartInput {
  prompt: string
  sessionId: string
  worktreeId: string | null
  worktreeBranch: string | null
  worktreePath: string | null
  projectName: string | null
  projectPath: string | null
  gitRemoteUrl: string | null
  contextLength: number | null
  providerId: string | null
  modelProviderId: string | null
  modelId: string | null
  modelVariant: string | null
  mode: string | null
  isGoalPrompt: boolean
  handoffSessionId: string | null
  loggedAt: string
  connectionProjects: string | null
  // Stamp only — the server-side touch on this mutation refreshes the
  // matching member_active_accounts row's last_seen_at. This hook is Claude
  // CLI-only, so a resolved email always means the 'anthropic' provider.
  accountEmail: string | null
  accountProvider: string | null
}

interface PromptIdleInput {
  promptId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

type RequestGraphql = (
  endpoint: string,
  token: string,
  document: string,
  variables: Record<string, unknown>
) => Promise<unknown>

export interface ClaudeCliHiveTelemetryDeps {
  db?: DatabaseService
  requestGraphql?: RequestGraphql
  now?: () => Date
}

const log = createLogger({ component: 'HiveEnterpriseClaudeCliTelemetry' })
const activePromptBySession = new Map<string, ActivePrompt>()
const TRANSCRIPT_USAGE_FLUSH_POLL_MS = 50
const TRANSCRIPT_USAGE_FLUSH_TIMEOUT_MS = 2000

function zeroCounters(): TokenCounters {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function addCounters(a: TokenCounters, b: TokenCounters): TokenCounters {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  }
}

function subtractCounters(current: TokenCounters, baseline: TokenCounters): TokenCounters {
  return {
    input: Math.max(0, current.input - baseline.input),
    output: Math.max(0, current.output - baseline.output),
    cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite)
  }
}

function tokenTotal(counters: TokenCounters): number {
  return counters.input + counters.output + counters.cacheRead + counters.cacheWrite
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assistantUsage(value: unknown): TokenCounters | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.type !== 'assistant') return null
  const message = record.message
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null
  const usage = (message as Record<string, unknown>).usage
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return null
  const usageRecord = usage as Record<string, unknown>
  const field = (name: string): number => {
    const value = usageRecord[name]
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  }

  return {
    input: field('input_tokens'),
    output: field('output_tokens'),
    cacheRead: field('cache_read_input_tokens'),
    cacheWrite: field('cache_creation_input_tokens')
  }
}

function readTranscript(path: string | null): string {
  if (!path) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Task subagents write their usage to separate transcripts under
 * `<sessionDir>/subagents/agent-*.jsonl` (nested subagents included, flat),
 * never to the main transcript — for a main transcript at
 * `<dir>/<sessionId>.jsonl` the session dir is `<dir>/<sessionId>/`.
 */
function subagentTranscriptPaths(transcriptPath: string | null): string[] {
  if (!transcriptPath || !transcriptPath.endsWith('.jsonl')) return []
  const subagentsDir = join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents')
  try {
    return readdirSync(subagentsDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(subagentsDir, name))
  } catch {
    return []
  }
}

/** Sum assistant usage across the main transcript and all subagent transcripts. */
export function tokenCountersFromTranscriptFiles(transcriptPath: string | null): TokenCounters {
  let total = tokenCountersFromClaudeTranscript(readTranscript(transcriptPath))
  for (const subagentPath of subagentTranscriptPaths(transcriptPath)) {
    total = addCounters(total, tokenCountersFromClaudeTranscript(readTranscript(subagentPath)))
  }
  return total
}

async function waitForTranscriptUsageDelta(
  transcriptPath: string | null,
  baseline: TokenCounters
): Promise<TokenCounters> {
  const attempts = Math.ceil(TRANSCRIPT_USAGE_FLUSH_TIMEOUT_MS / TRANSCRIPT_USAGE_FLUSH_POLL_MS)
  let delta = zeroCounters()

  for (let attempt = 0; attempt <= attempts; attempt++) {
    delta = subtractCounters(tokenCountersFromTranscriptFiles(transcriptPath), baseline)
    if (tokenTotal(delta) > 0 || !transcriptPath || attempt === attempts) {
      return delta
    }
    await sleep(TRANSCRIPT_USAGE_FLUSH_POLL_MS)
  }

  return delta
}

export function tokenCountersFromClaudeTranscript(text: string): TokenCounters {
  let total = zeroCounters()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const usage = assistantUsage(JSON.parse(line))
      if (usage) total = addCounters(total, usage)
    } catch {
      // Ignore malformed transcript lines; Claude writes JSONL incrementally.
    }
  }
  return total
}

export function lastAssistantContextLengthFromClaudeTranscript(text: string): number | null {
  let latest: number | null = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const usage = assistantUsage(JSON.parse(line))
      if (usage) latest = usage.input + usage.cacheRead + usage.cacheWrite
    } catch {
      // Ignore malformed transcript lines; Claude writes JSONL incrementally.
    }
  }
  return latest
}

function parseSettings(db: DatabaseService): HiveEnterpriseSettings {
  const raw = db.getSetting(APP_SETTINGS_DB_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as HiveEnterpriseSettings
  } catch {
    return {}
  }
}

function reconcileStorePrompts(db: DatabaseService, value: unknown): void {
  if (typeof value !== 'boolean') return
  const settings = parseSettings(db)
  if (settings.hiveOrganizationStorePrompts === value) return
  db.setSetting(
    APP_SETTINGS_DB_KEY,
    JSON.stringify({ ...settings, hiveOrganizationStorePrompts: value })
  )
}

function resolveEndpoint(settings: HiveEnterpriseSettings): string | null {
  const serverUrl =
    typeof settings.hiveEnterpriseServerUrl === 'string' && settings.hiveEnterpriseServerUrl.trim()
      ? settings.hiveEnterpriseServerUrl.trim()
      : DEFAULT_HIVE_ENTERPRISE_SERVER_URL
  return `${serverUrl.replace(/\/+$/, '')}/api/graphql`
}

function resolveToken(settings: HiveEnterpriseSettings): string | null {
  return typeof settings.hiveAuthToken === 'string' && settings.hiveAuthToken
    ? settings.hiveAuthToken
    : null
}

function telemetryEnabled(settings: HiveEnterpriseSettings): boolean {
  return Boolean(resolveToken(settings) && settings.hiveOrganizationId)
}

async function requestGraphql(
  endpoint: string,
  token: string,
  document: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ query: document, variables })
  })

  if (!response.ok) {
    throw new Error(`Hive Enterprise request failed with HTTP ${response.status}`)
  }

  const payload = (await response.json().catch(() => null)) as
    | { errors?: unknown; data?: unknown }
    | null
  if (payload?.errors) {
    throw new Error('Hive Enterprise GraphQL request failed')
  }
  return payload?.data ?? null
}

/** Pull the server-generated prompt id out of a recordPromptStart response. */
function recordedPromptId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const result = (data as { recordPromptStart?: unknown }).recordPromptStart
  if (!result || typeof result !== 'object') return null
  const promptId = (result as { promptId?: unknown }).promptId
  return typeof promptId === 'string' && promptId.length > 0 ? promptId : null
}

function responseStorePrompts(data: unknown, field: 'recordPromptStart' | 'recordPromptIdle'): unknown {
  if (!data || typeof data !== 'object') return undefined
  const result = (data as Record<string, unknown>)[field]
  if (!result || typeof result !== 'object') return undefined
  return (result as { storePrompts?: unknown }).storePrompts
}

function connectionProjects(db: DatabaseService, connectionId: string | null): string | null {
  if (!connectionId) return null
  const connection = db.getConnection(connectionId)
  if (!connection?.members?.length) return null

  const projects = new Map<string, { name: string; path: string }>()
  for (const member of connection.members) {
    const project = db.getProject(member.project_id)
    const name = project?.name ?? member.project_name
    const path = project?.path ?? member.worktree_path
    projects.set(member.project_id, { name, path })
  }

  return projects.size > 0 ? JSON.stringify([...projects.values()]) : null
}

async function getRemoteUrl(worktreePath: string | null): Promise<string | null> {
  if (!worktreePath) return null
  try {
    const remote = await new GitService(worktreePath).getRemoteUrl('origin')
    return remote.success ? (remote.url ?? null) : null
  } catch {
    return null
  }
}

async function buildPromptStartInput(
  db: DatabaseService,
  sessionId: string,
  prompt: string,
  transcriptPath: string | null,
  now: Date
): Promise<{ input: PromptStartInput; baseline: TokenCounters }> {
  const session = db.getSession(sessionId)
  const worktree = session?.worktree_id ? db.getWorktree(session.worktree_id) : null
  const project: Project | null =
    (worktree?.project_id ? db.getProject(worktree.project_id) : null) ??
    (session?.project_id ? db.getProject(session.project_id) : null)
  const transcript = readTranscript(transcriptPath)
  const accountEmail = await getClaudeAccountEmail().catch(() => null)

  return {
    baseline: tokenCountersFromTranscriptFiles(transcriptPath),
    input: {
      prompt,
      sessionId,
      worktreeId: worktree?.id ?? null,
      worktreeBranch: worktree?.branch_name ?? null,
      worktreePath: worktree?.path ?? null,
      projectName: project?.name ?? null,
      projectPath: project?.path ?? null,
      gitRemoteUrl: await getRemoteUrl(worktree?.path ?? null),
      contextLength: lastAssistantContextLengthFromClaudeTranscript(transcript) ?? 0,
      providerId: session?.agent_sdk ?? null,
      modelProviderId: session?.model_provider_id ?? null,
      modelId: session?.model_id ?? null,
      modelVariant: session?.model_variant ?? null,
      mode: session?.mode ?? null,
      isGoalPrompt: prompt.trimStart().startsWith('/goal'),
      handoffSessionId: null,
      loggedAt: now.toISOString(),
      connectionProjects: connectionProjects(db, session?.connection_id ?? null),
      accountEmail,
      accountProvider: accountEmail ? 'anthropic' : null
    }
  }
}

async function recordStart(
  sessionId: string,
  hook: ClaudeCliTelemetryHook,
  deps: Required<Pick<ClaudeCliHiveTelemetryDeps, 'db' | 'requestGraphql' | 'now'>>
): Promise<void> {
  if (typeof hook.prompt !== 'string' || hook.prompt.trim().length === 0) return
  const transcriptPath = typeof hook.transcript_path === 'string' ? hook.transcript_path : null
  const settings = parseSettings(deps.db)
  if (!telemetryEnabled(settings)) return
  const endpoint = resolveEndpoint(settings)
  const token = resolveToken(settings)
  if (!endpoint || !token) return

  const { input, baseline } = await buildPromptStartInput(
    deps.db,
    sessionId,
    hook.prompt,
    transcriptPath,
    deps.now()
  )
  if (settings.hiveOrganizationStorePrompts === false) {
    input.prompt = ''
  }
  // The server owns the prompt id now: send the start, then track the id it
  // returns so the matching idle event updates the right row.
  const data = await deps.requestGraphql(endpoint, token, RecordPromptStartDocument, { input })
  reconcileStorePrompts(deps.db, responseStorePrompts(data, 'recordPromptStart'))
  const promptId = recordedPromptId(data)
  if (!promptId) return
  activePromptBySession.set(sessionId, { promptId, transcriptPath, baseline })
}

async function recordIdle(
  sessionId: string,
  hook: ClaudeCliTelemetryHook,
  deps: Required<Pick<ClaudeCliHiveTelemetryDeps, 'db' | 'requestGraphql' | 'now'>>
): Promise<void> {
  const active = activePromptBySession.get(sessionId)
  if (!active) return
  activePromptBySession.delete(sessionId)

  const settings = parseSettings(deps.db)
  if (!telemetryEnabled(settings)) return
  const endpoint = resolveEndpoint(settings)
  const token = resolveToken(settings)
  if (!endpoint || !token) return

  const transcriptPath =
    typeof hook.transcript_path === 'string' ? hook.transcript_path : active.transcriptPath
  const delta = await waitForTranscriptUsageDelta(transcriptPath, active.baseline)
  const input: PromptIdleInput = {
    promptId: active.promptId,
    inputTokens: delta.input,
    outputTokens: delta.output,
    cacheReadTokens: delta.cacheRead,
    cacheWriteTokens: delta.cacheWrite
  }

  const data = await deps.requestGraphql(endpoint, token, RecordPromptIdleDocument, { input })
  reconcileStorePrompts(deps.db, responseStorePrompts(data, 'recordPromptIdle'))
}

export async function handleClaudeCliHiveTelemetryHook(
  sessionId: string,
  hook: ClaudeCliTelemetryHook,
  deps: ClaudeCliHiveTelemetryDeps = {}
): Promise<void> {
  try {
    if (hook.hook_event_name !== 'UserPromptSubmit' && hook.hook_event_name !== 'Stop') return

    const resolvedDeps = {
      db: deps.db ?? getDatabase(),
      requestGraphql: deps.requestGraphql ?? requestGraphql,
      now: deps.now ?? (() => new Date())
    }

    if (hook.hook_event_name === 'UserPromptSubmit') {
      // A background-subagent task-notification resume is an auto-generated
      // continuation turn, not a real user prompt. Since a deferred Stop
      // already skips telemetry for the turn that triggered it, treating this
      // resume as a new prompt start would overwrite (clobber) the real
      // prompt's still-active record in `activePromptBySession`, orphaning it
      // and mis-attributing the eventual recordIdle to a phantom
      // `<task-notification>…` prompt. Skip it so the real prompt's record
      // survives through to the final passing Stop.
      if (isTaskNotificationPrompt(hook.prompt)) return
      await recordStart(sessionId, hook, resolvedDeps)
      return
    }

    await recordIdle(sessionId, hook, resolvedDeps)
  } catch (error) {
    log.warn('Failed to record Claude CLI Hive Enterprise telemetry', {
      sessionId,
      event: hook.hook_event_name,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function __resetClaudeCliHiveTelemetryForTests(): void {
  activePromptBySession.clear()
}
