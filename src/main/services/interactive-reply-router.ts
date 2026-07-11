import type { PermissionRequest } from '@shared/types/opencode'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import type { AgentSdk } from '@shared/types/agent-sdk'
import { getSubPatterns } from '@shared/permission-utils'
import type { AgentSdkManager } from './agent-sdk-manager'
import { openCodeService } from './opencode-service'
import { getDatabase } from '../db'
import type { DatabaseService } from '../db/database'
import { claudeCliDiscordBridge } from './claude-cli-discord-bridge'
import { requestDiscordClaudeCliCommand } from './discord-claude-cli-command'

type PermissionDecision = 'once' | 'always' | 'reject'

interface QuestionImplementer {
  hasPendingQuestion?: (requestId: string) => boolean
  questionReply?: (requestId: string, answers: string[][], worktreePath?: string) => Promise<void>
  questionReject?: (requestId: string, worktreePath?: string) => Promise<void>
}

interface PermissionImplementer {
  hasPendingApproval?: (requestId: string) => boolean
  permissionReply?: (
    requestId: string,
    decision: PermissionDecision,
    worktreePath?: string
  ) => Promise<void>
}

interface ClaudePlanImplementer extends QuestionImplementer {
  hasPendingPlan?: (requestId: string) => boolean
  hasPendingPlanForSession?: (sessionId: string) => boolean
  planApprove?: (worktreePath: string, sessionId: string, requestId?: string) => Promise<void>
  planReject?: (
    worktreePath: string,
    sessionId: string,
    feedback?: string,
    requestId?: string
  ) => Promise<void>
  handleApprovalReply?: (
    requestId: string,
    approved: boolean,
    remember?: 'allow' | 'block',
    pattern?: string,
    patterns?: string[]
  ) => void
}

interface CliBridge {
  hasPendingQuestion(requestId: string): boolean
  hasPendingPlan(requestId: string): boolean
  resolveQuestion(requestId: string, answers: string[][]): void
  rejectQuestion(requestId: string): void
  resolvePlan(requestId: string, approve: boolean, feedback?: string): void
}

interface OpenCodeReplyService {
  questionReply(requestId: string, answers: string[][], worktreePath?: string): Promise<void>
  questionReject(requestId: string, worktreePath?: string): Promise<void>
  permissionReply(
    requestId: string,
    decision: PermissionDecision,
    worktreePath?: string
  ): Promise<void>
}

export interface InteractiveReplyRouterDependencies {
  sdkManager?: AgentSdkManager | null
  openCodeService?: OpenCodeReplyService
  cliBridge?: CliBridge
  db?: DatabaseService
}

export interface ReplyQuestionInput {
  requestId: string
  answers: string[][]
  worktreePath?: string
  agentSdk?: AgentSdk | null
}

export interface ReplyPermissionInput {
  requestId: string
  decision: PermissionDecision
  worktreePath?: string
  agentSdk?: AgentSdk | null
  permissionRequest?: PermissionRequest
}

export interface ReplyCommandApprovalInput {
  requestId: string
  approved: boolean
  patternSuggestions?: string[]
}

export interface RejectQuestionInput {
  requestId: string
  worktreePath?: string
  agentSdk?: AgentSdk | null
}

export interface ReplyPlanInput {
  requestId: string
  sessionId: string
  approve: boolean
  worktreePath?: string
  feedback?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function getImplementer<T>(sdkManager: AgentSdkManager | null | undefined, sdk: string): T | null {
  if (!sdkManager) return null
  try {
    return sdkManager.getImplementer(sdk as never) as T
  } catch {
    return null
  }
}

export class InteractiveReplyRouter {
  private sdkManager: AgentSdkManager | null
  private readonly openCode: OpenCodeReplyService
  private readonly cliBridge: CliBridge
  private db: DatabaseService | null

  constructor(dependencies: InteractiveReplyRouterDependencies = {}) {
    this.sdkManager = dependencies.sdkManager ?? null
    this.openCode = dependencies.openCodeService ?? openCodeService
    this.cliBridge = dependencies.cliBridge ?? claudeCliDiscordBridge
    this.db = dependencies.db ?? null
  }

  setAgentSdkManager(manager: AgentSdkManager | null): void {
    this.sdkManager = manager
  }

  async replyQuestion(input: ReplyQuestionInput): Promise<void> {
    if (this.cliBridge.hasPendingQuestion(input.requestId)) {
      this.cliBridge.resolveQuestion(input.requestId, input.answers)
      return
    }

    // Claude CLI hooks are held in the Electron main process (where the PTY
    // lives); reach them over the desktop IPC channel.
    if (input.agentSdk === 'claude-code-cli') {
      const forwarded = await requestDiscordClaudeCliCommand('discordClaudeCliQuestionReply', {
        requestId: input.requestId,
        answers: input.answers
      }).catch(() => null)
      if (forwarded?.success) return
    }

    const claudeImpl = getImplementer<QuestionImplementer>(this.sdkManager, 'claude-code')
    if (claudeImpl?.hasPendingQuestion?.(input.requestId)) {
      await claudeImpl.questionReply?.(input.requestId, input.answers, input.worktreePath)
      return
    }

    const codexImpl = getImplementer<QuestionImplementer>(this.sdkManager, 'codex')
    if (codexImpl?.hasPendingQuestion?.(input.requestId)) {
      await codexImpl.questionReply?.(input.requestId, input.answers, input.worktreePath)
      return
    }

    await this.openCode.questionReply(input.requestId, input.answers, input.worktreePath)
  }

  async rejectQuestion(input: RejectQuestionInput): Promise<void> {
    if (this.cliBridge.hasPendingQuestion(input.requestId)) {
      this.cliBridge.rejectQuestion(input.requestId)
      return
    }

    if (input.agentSdk === 'claude-code-cli') {
      const forwarded = await requestDiscordClaudeCliCommand('discordClaudeCliQuestionReject', {
        requestId: input.requestId
      }).catch(() => null)
      if (forwarded?.success) return
    }

    const claudeImpl = getImplementer<QuestionImplementer>(this.sdkManager, 'claude-code')
    if (claudeImpl?.hasPendingQuestion?.(input.requestId)) {
      await claudeImpl.questionReject?.(input.requestId, input.worktreePath)
      return
    }

    const codexImpl = getImplementer<QuestionImplementer>(this.sdkManager, 'codex')
    if (codexImpl?.hasPendingQuestion?.(input.requestId)) {
      await codexImpl.questionReject?.(input.requestId, input.worktreePath)
      return
    }

    await this.openCode.questionReject(input.requestId, input.worktreePath)
  }

  async replyPermission(input: ReplyPermissionInput): Promise<void> {
    if (input.decision === 'always' && input.permissionRequest) {
      this.persistAllowAlways(input.permissionRequest)
    }

    const codexImpl = getImplementer<PermissionImplementer>(this.sdkManager, 'codex')
    if (codexImpl?.hasPendingApproval?.(input.requestId)) {
      await codexImpl.permissionReply?.(input.requestId, input.decision, input.worktreePath)
      return
    }

    await this.openCode.permissionReply(input.requestId, input.decision, input.worktreePath)
  }

  async replyCommandApproval(input: ReplyCommandApprovalInput): Promise<void> {
    const claudeImpl = getImplementer<ClaudePlanImplementer>(this.sdkManager, 'claude-code')
    if (!claudeImpl?.handleApprovalReply) {
      throw new Error('Claude Code implementer not available')
    }

    if (input.approved) {
      claudeImpl.handleApprovalReply(
        input.requestId,
        true,
        'allow',
        undefined,
        input.patternSuggestions
      )
      return
    }

    claudeImpl.handleApprovalReply(input.requestId, false)
  }

  async replyPlan(input: ReplyPlanInput): Promise<void> {
    if (this.cliBridge.hasPendingPlan(input.requestId)) {
      this.cliBridge.resolvePlan(input.requestId, input.approve, input.feedback)
      return
    }

    const forwarded = await requestDiscordClaudeCliCommand('discordClaudeCliPlanReply', {
      requestId: input.requestId,
      approve: input.approve,
      ...(input.feedback !== undefined ? { feedback: input.feedback } : {})
    }).catch(() => null)
    if (forwarded?.success) return

    const claudeImpl = getImplementer<ClaudePlanImplementer>(this.sdkManager, 'claude-code')
    const hasPending =
      claudeImpl?.hasPendingPlan?.(input.requestId) ||
      claudeImpl?.hasPendingPlanForSession?.(input.sessionId)
    if (!claudeImpl || !hasPending) {
      throw new Error('Plan is no longer pending')
    }

    if (input.approve) {
      await claudeImpl.planApprove?.(input.worktreePath ?? '', input.sessionId, input.requestId)
    } else {
      await claudeImpl.planReject?.(
        input.worktreePath ?? '',
        input.sessionId,
        input.feedback,
        input.requestId
      )
    }
  }

  private persistAllowAlways(request: PermissionRequest): void {
    const subPatterns = getSubPatterns(request)
    if (subPatterns.length === 0) return

    const db = this.getDb()
    const settings = asRecord(JSON.parse(db.getSetting(APP_SETTINGS_DB_KEY) || '{}'))
    const commandFilter = asRecord(settings.commandFilter)
    const allowlist = Array.isArray(commandFilter.allowlist)
      ? commandFilter.allowlist.filter((value): value is string => typeof value === 'string')
      : []

    const nextAllowlist = [...allowlist]
    for (const pattern of subPatterns) {
      if (!nextAllowlist.includes(pattern)) nextAllowlist.push(pattern)
    }

    db.setSetting(
      APP_SETTINGS_DB_KEY,
      JSON.stringify({
        ...settings,
        commandFilter: {
          ...commandFilter,
          allowlist: nextAllowlist
        }
      })
    )
  }

  private getDb(): DatabaseService {
    if (!this.db) this.db = getDatabase()
    return this.db
  }
}

export function createInteractiveReplyRouter(
  dependencies: InteractiveReplyRouterDependencies = {}
): InteractiveReplyRouter {
  return new InteractiveReplyRouter(dependencies)
}
