import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import {
  Bot,
  CheckSquare,
  Loader2,
  Minimize2,
  Send,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { AssistantCanvas } from '@/components/sessions/AssistantCanvas'
import { UserBubble } from '@/components/sessions/UserBubble'
import { QuestionPrompt } from '@/components/sessions/QuestionPrompt'
import { PermissionPrompt } from '@/components/sessions/PermissionPrompt'
import { CommandApprovalPrompt } from '@/components/sessions/CommandApprovalPrompt'
import { MarkdownRenderer } from '@/components/sessions/MarkdownRenderer'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { useSessionStream } from '@/hooks/useSessionStream'
import { parseBoardAssistantDraftSet } from '@/lib/board-assistant-drafts'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useBoardChatStore, type BoardChatMessage, type BoardChatScope, type TicketDraft, stripBoardAssistantScaffolding, stripBoardDraftBlocks, resolveBoardChatAgentSdk, resolveBoardChatDefaultModel } from '@/stores/useBoardChatStore'
import { useCommandApprovalStore } from '@/stores/useCommandApprovalStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePermissionStore } from '@/stores/usePermissionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useQuestionStore, type QuestionAnswer } from '@/stores/useQuestionStore'
import { useSettingsStore, type SelectedModel } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { BOARD_ASSISTANT_SESSION_NAME_PREFIX } from '@/stores/useSessionStore'
import type { StreamingPart } from '@/components/sessions/SessionView'
import type { QuestionRequest } from '@/stores/useQuestionStore'
import type { CommandApprovalRequest } from '@/stores/useCommandApprovalStore'

interface BoardChatDrawerProps {
  projectId?: string
  projectPath?: string
  connectionId?: string
  isPinnedMode?: boolean
}

const BOARD_ASSISTANT_RULES = [
  'You are Hive Board Assistant.',
  'Stay focused on helping the user create local kanban tickets for the current board scope.',
  'Do not claim tickets are created. The UI will create them only after explicit confirmation.',
  'Ask concise clarifying questions when needed.',
  'When you are ready to propose tickets, append exactly one fenced code block tagged board-ticket-drafts.',
  'For project boards, the JSON schema is {"drafts":[{"draftKey":"string","title":"string","description":"string|null","projectId":"string","dependsOn":["draftKey"],"warnings":["string"]}]}.',
  'For other board scopes, the JSON schema is {"drafts":[{"title":"string","description":"string|null","warnings":["string"]}]}.',
  'When revising drafts, output a full replacement draft set in that code block.',
  'Keep titles short, specific, and implementation-ready.'
].join('\n')

function buildScopeKey(scope: BoardChatScope | null): string {
  if (!scope) return 'none'
  if (scope.kind === 'project') return `project:${scope.projectId}`
  if (scope.kind === 'connection') return `connection:${scope.connectionId}`
  return 'pinned'
}

function sanitizeBoardMessageContent(message: BoardChatMessage): string {
  const withoutScaffolding = stripBoardAssistantScaffolding(message.content)
  if (message.role === 'assistant') {
    const withoutDrafts = stripBoardDraftBlocks(withoutScaffolding)
    const parsedDrafts = parseBoardAssistantDraftSet(message.content)
    return withoutDrafts || (parsedDrafts ? 'Proposed ticket drafts below.' : withoutDrafts)
  }
  return withoutScaffolding
}

function sanitizeStreamingParts(parts: StreamingPart[] | undefined, role: BoardChatMessage['role']): StreamingPart[] | undefined {
  if (!parts?.length) return parts

  return parts.map((part) => {
    if (part.type !== 'text') return part
    const baseText = part.text ?? ''
    const nextText =
      role === 'assistant'
        ? stripBoardDraftBlocks(stripBoardAssistantScaffolding(baseText))
        : stripBoardAssistantScaffolding(baseText)
    return { ...part, text: nextText }
  })
}

function getStatusLabel(status: ReturnType<typeof useBoardChatStore.getState>['status']): string {
  switch (status) {
    case 'starting':
      return 'Starting'
    case 'thinking':
      return 'Thinking'
    case 'awaiting_confirmation':
      return 'Drafts ready'
    case 'error':
      return 'Needs attention'
    default:
      return 'Ready'
  }
}

function getAgentSdkLabel(agentSdk: 'opencode' | 'claude-code' | 'codex'): string {
  switch (agentSdk) {
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    default:
      return 'OpenCode'
  }
}

function truncateDescription(description: string | null | undefined): string | null {
  if (!description) return null
  return description.length > 240 ? `${description.slice(0, 237)}...` : description
}

async function resolveProjectRuntime(projectId: string): Promise<{ worktreeId: string; path: string } | null> {
  const worktreeStore = useWorktreeStore.getState()
  const selectedWorktreeId = worktreeStore.selectedWorktreeId
  const projectWorktrees = worktreeStore.getWorktreesForProject(projectId)
  const selectedProjectWorktree = projectWorktrees.find((worktree) => worktree.id === selectedWorktreeId)
  const chosenWorktree =
    selectedProjectWorktree ??
    worktreeStore.getDefaultWorktree(projectId) ??
    projectWorktrees[0] ??
    null

  if (chosenWorktree?.path) {
    return { worktreeId: chosenWorktree.id, path: chosenWorktree.path }
  }

  const fallbackWorktrees = await window.db.worktree.getActiveByProject(projectId)
  const fallback = fallbackWorktrees.find((worktree) => worktree.is_default) ?? fallbackWorktrees[0] ?? null

  return fallback?.path ? { worktreeId: fallback.id, path: fallback.path } : null
}

function buildBoardPrompt(input: string, scope: BoardChatScope, targetProjectId: string): string {
  const projectStore = useProjectStore.getState()
  const kanbanStore = useKanbanStore.getState()
  const targetProject = projectStore.projects.find((project) => project.id === targetProjectId)
  const visibleTickets = kanbanStore
    .getTicketsForProject(targetProjectId)
    .filter((ticket) => !ticket.archived_at)
    .map((ticket) => ({
      title: ticket.title,
      description: truncateDescription(ticket.description),
      column: ticket.column
    }))
    .slice(0, 80)

  const context = {
    scope:
      scope.kind === 'project'
        ? { kind: 'project', projectName: scope.projectName }
        : scope.kind === 'connection'
          ? { kind: 'connection', connectionName: scope.connectionName }
          : { kind: 'pinned' },
    targetProject: targetProject
      ? {
          id: targetProject.id,
          name: targetProject.name,
          path: targetProject.path,
          description: targetProject.description
        }
      : { id: targetProjectId },
    existingTickets: visibleTickets
  }

  return [
    '<board-assistant-rules>',
    BOARD_ASSISTANT_RULES,
    ...(scope.kind === 'project'
      ? [
          `Every proposed draft must use projectId=${targetProjectId}.`,
          'Every proposed draft must include a unique draftKey.',
          'Use dependsOn to reference other drafts by their draftKey when there is a dependency.'
        ]
      : []),
    '</board-assistant-rules>',
    '<board-assistant-context>',
    JSON.stringify(context, null, 2),
    '</board-assistant-context>',
    '',
    'User request:',
    input
  ].join('\n')
}

async function ensureRuntimeSession(scope: BoardChatScope, targetProjectId: string): Promise<{
  sessionId: string
  opencodeSessionId: string
  runtimePath: string
} | null> {
  const currentState = useBoardChatStore.getState()
  if (currentState.sessionId && currentState.opencodeSessionId && currentState.runtimePath) {
    return {
      sessionId: currentState.sessionId,
      opencodeSessionId: currentState.opencodeSessionId,
      runtimePath: currentState.runtimePath
    }
  }

  const settings = useSettingsStore.getState()
  const agentSdk = currentState.selectedAgentSdkOverride ?? resolveBoardChatAgentSdk(settings.defaultAgentSdk)
  const selectedModel = currentState.selectedModelOverride ?? resolveBoardChatDefaultModel(settings, agentSdk)

  let runtimePath: string | null = null
  let worktreeId: string | null = null
  let connectionId: string | null = null

  if (scope.kind === 'project') {
    const runtime = await resolveProjectRuntime(scope.projectId)
    if (!runtime) return null
    runtimePath = runtime.path
    worktreeId = runtime.worktreeId
  } else if (scope.kind === 'connection') {
    const connection = useConnectionStore
      .getState()
      .connections.find((candidate) => candidate.id === scope.connectionId)
    if (!connection?.path) return null
    runtimePath = connection.path
    connectionId = connection.id
  } else {
    return null
  }

  const session = await window.db.session.create({
    worktree_id: worktreeId,
    connection_id: connectionId,
    project_id: targetProjectId,
    name: `${BOARD_ASSISTANT_SESSION_NAME_PREFIX} Board Assistant`,
    agent_sdk: agentSdk,
    mode: 'build',
    ...(selectedModel
      ? {
          model_provider_id: selectedModel.providerID,
          model_id: selectedModel.modelID,
          model_variant: selectedModel.variant ?? null
        }
      : {})
  })

  const connectResult = await window.opencodeOps.connect(runtimePath, session.id)
  if (!connectResult.success || !connectResult.sessionId) {
    await window.db.session.delete(session.id).catch(() => {})
    return null
  }

  await window.db.session.update(session.id, {
    opencode_session_id: connectResult.sessionId
  })

  useBoardChatStore.getState().setRuntimeSession({
    sessionId: session.id,
    opencodeSessionId: connectResult.sessionId,
    runtimePath
  })

  return {
    sessionId: session.id,
    opencodeSessionId: connectResult.sessionId,
    runtimePath
  }
}

async function cleanupBoardChatRuntime(): Promise<void> {
  const state = useBoardChatStore.getState()
  const sessionId = state.sessionId
  const opencodeSessionId = state.opencodeSessionId
  const runtimePath = state.runtimePath

  if (sessionId) {
    useQuestionStore.getState().clearSession(sessionId)
    usePermissionStore.getState().clearSession(sessionId)
    useCommandApprovalStore.getState().clearSession(sessionId)
  }

  if (runtimePath && opencodeSessionId) {
    try {
      await window.opencodeOps.abort(runtimePath, opencodeSessionId)
    } catch {
      // Best effort cleanup.
    }

    try {
      await window.opencodeOps.disconnect(runtimePath, opencodeSessionId)
    } catch {
      // Best effort cleanup.
    }
  }

  if (sessionId) {
    try {
      await window.db.session.delete(sessionId)
    } catch {
      // Best effort cleanup.
    }
  }
}

function BoardChatHeader({
  scope,
  selectedTargetProjectId,
  status,
  selectedModel,
  agentSdk,
  availableAgentSdks,
  modelResetVisible,
  onSelectAgentSdk,
  onSelectModel,
  onResetModel,
  onSelectTargetProject,
  onClear,
  onMinimize,
  onClose
}: {
  scope: BoardChatScope
  selectedTargetProjectId: string | null
  status: ReturnType<typeof useBoardChatStore.getState>['status']
  selectedModel: SelectedModel | null
  agentSdk: 'opencode' | 'claude-code' | 'codex'
  availableAgentSdks: Array<'opencode' | 'claude-code' | 'codex'>
  modelResetVisible: boolean
  onSelectAgentSdk: (agentSdk: 'opencode' | 'claude-code' | 'codex') => void
  onSelectModel: (model: SelectedModel) => void
  onResetModel: () => void
  onSelectTargetProject: (projectId: string) => void
  onClear: () => void
  onMinimize: () => void
  onClose: () => void
}): React.JSX.Element {
  const selectedTargetProject =
    scope.kind === 'connection'
      ? scope.availableProjects.find((project) => project.id === selectedTargetProjectId)
      : null

  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/12 text-primary">
            <Bot className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">Board Assistant</p>
            <p className="text-xs text-muted-foreground">{getStatusLabel(status)}</p>
          </div>
        </div>

        {scope.kind === 'project' && (
          <div className="inline-flex rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
            {scope.projectName}
          </div>
        )}

        {scope.kind === 'connection' && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
              {scope.connectionName}
            </div>
            <select
              value={selectedTargetProjectId ?? ''}
              onChange={(event) => onSelectTargetProject(event.target.value)}
              className="h-8 rounded-full border border-border/70 bg-background px-3 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            >
              {scope.availableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {selectedTargetProject && (
              <span className="text-xs text-muted-foreground">
                Targeting {selectedTargetProject.name}
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/70"
              >
                <span>{getAgentSdkLabel(agentSdk)}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              {availableAgentSdks.map((sdkOption) => (
                <DropdownMenuItem
                  key={sdkOption}
                  onClick={() => onSelectAgentSdk(sdkOption)}
                  className="cursor-pointer"
                >
                  {getAgentSdkLabel(sdkOption)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <ModelSelector
            value={selectedModel}
            onChange={onSelectModel}
            agentSdkOverride={agentSdk}
            disableTitleTooltip={true}
            hideProviderPrefix={true}
          />
          {modelResetVisible && (
            <button
              type="button"
              onClick={onResetModel}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Use Default
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon" onClick={onClear} aria-label="Clear chat">
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" onClick={onMinimize} aria-label="Minimize assistant">
          <Minimize2 className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close assistant">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function BoardChatDraftProposalCard({
  draft,
  onToggle
}: {
  draft: TicketDraft
  onToggle: (draftId: string) => void
}): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/80 p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <Checkbox
          checked={draft.selected || Boolean(draft.createdAt)}
          onCheckedChange={() => onToggle(draft.id)}
          className="mt-1"
          disabled={Boolean(draft.createdAt)}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{draft.title}</p>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              {draft.projectName}
            </span>
            {draft.createdAt && (
              <span className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Created
              </span>
            )}
          </div>
          {draft.description && (
            <div className="text-sm text-muted-foreground">
              <MarkdownRenderer content={draft.description} />
            </div>
          )}
          {draft.resolvedDependsOnTitles.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium uppercase tracking-[0.14em]">Depends on</span>
              {draft.resolvedDependsOnTitles.map((dependency) => (
                <span
                  key={`${draft.id}-${dependency}`}
                  className="rounded-full border border-border/70 bg-muted/30 px-2 py-0.5"
                >
                  {dependency}
                </span>
              ))}
            </div>
          )}
          {draft.warnings.length > 0 && (
            <div className="space-y-1 rounded-xl border border-border/70 bg-muted/30 px-3 py-2">
              {draft.warnings.map((warning) => (
                <p key={warning} className="text-xs text-muted-foreground">
                  {warning}
                </p>
              ))}
            </div>
          )}
          {draft.validationIssues.length > 0 && (
            <div className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2">
              {draft.validationIssues.map((issue) => (
                <p key={issue} className="text-xs text-destructive">
                  {issue}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BoardChatMessageList({
  messages,
  drafts,
  draftSourceMessageId,
  streamingMessage,
  activeQuestion,
  activePermission,
  activeApproval,
  sessionId,
  onToggleDraft,
  onCreateAll,
  onCreateSelected,
  onRevise,
  onCancelDrafts,
  hasInvalidDrafts,
  onQuestionReply,
  onQuestionReject,
  onPermissionReply,
  onCommandApprovalReply
}: {
  messages: BoardChatMessage[]
  drafts: TicketDraft[]
  draftSourceMessageId: string | null
  streamingMessage: BoardChatMessage | null
  activeQuestion: QuestionRequest | null
  activePermission: PermissionRequest | null
  activeApproval: CommandApprovalRequest | null
  sessionId: string | null
  onToggleDraft: (draftId: string) => void
  onCreateAll: () => void
  onCreateSelected: () => void
  onRevise: () => void
  onCancelDrafts: () => void
  hasInvalidDrafts: boolean
  onQuestionReply: (requestId: string, answers: QuestionAnswer[]) => void
  onQuestionReject: (requestId: string) => void
  onPermissionReply: (requestId: string, reply: 'once' | 'always' | 'reject', message?: string) => void
  onCommandApprovalReply: (
    requestId: string,
    approved: boolean,
    remember?: 'allow' | 'block',
    pattern?: string,
    patterns?: string[]
  ) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectedCount = drafts.filter((draft) => draft.selected).length
  const creatableSelectedCount = drafts.filter((draft) => draft.selected && !draft.createdAt).length
  const dependencyCount = drafts.reduce((count, draft) => count + draft.dependsOn.length, 0)
  const invalidDraftCount = drafts.filter((draft) => draft.validationIssues.length > 0).length

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [messages, drafts, draftSourceMessageId, streamingMessage, activeQuestion, activePermission, activeApproval])

  return (
    <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {messages.map((message) => {
        if (message.role === 'system') {
          return (
            <div
              key={message.id}
              className="rounded-2xl border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground"
            >
              {message.content}
            </div>
          )
        }

        const parsedDrafts = message.role === 'assistant' ? parseBoardAssistantDraftSet(message.content) : null
        const sanitizedContent = sanitizeBoardMessageContent(message)
        const sanitizedParts = sanitizeStreamingParts(message.parts, message.role)

        return (
          <div key={message.id} className="space-y-3">
            {message.role === 'user' ? (
              <UserBubble content={sanitizedContent} timestamp={message.timestamp} />
            ) : (
              <AssistantCanvas
                content={sanitizedContent}
                timestamp={message.timestamp}
                parts={sanitizedParts}
              />
            )}

            {message.id === draftSourceMessageId && drafts.length > 0 && parsedDrafts && (
              <div className="space-y-3 rounded-3xl border border-border/70 bg-muted/20 p-3">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                  Draft proposals
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{drafts.length} drafts</span>
                  <span>{dependencyCount} dependenc{dependencyCount === 1 ? 'y' : 'ies'}</span>
                  {invalidDraftCount > 0 && (
                    <span className="text-destructive">
                      {invalidDraftCount} invalid
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {drafts.map((draft) => (
                    <BoardChatDraftProposalCard key={draft.id} draft={draft} onToggle={onToggleDraft} />
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
                  <Button type="button" size="sm" onClick={onCreateAll} disabled={hasInvalidDrafts}>
                    Create all
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onCreateSelected}
                    disabled={hasInvalidDrafts}
                  >
                    <CheckSquare className="h-4 w-4" />
                    Create selected
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={onRevise}>
                    Revise with AI
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={onCancelDrafts}>
                    Cancel
                  </Button>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {hasInvalidDrafts
                      ? 'Fix validation issues first'
                      : `${creatableSelectedCount}/${selectedCount} ready`}
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {streamingMessage && (
        <AssistantCanvas
          content={sanitizeBoardMessageContent(streamingMessage)}
          timestamp={streamingMessage.timestamp}
          parts={sanitizeStreamingParts(streamingMessage.parts, streamingMessage.role)}
          isStreaming={true}
        />
      )}

      {activePermission && (
        <PermissionPrompt request={activePermission} onReply={onPermissionReply} />
      )}

      {activeApproval && (
        <CommandApprovalPrompt
          request={activeApproval}
          sessionId={sessionId ?? undefined}
          onReply={onCommandApprovalReply}
        />
      )}

      {activeQuestion && (
        <QuestionPrompt
          request={activeQuestion}
          onReply={onQuestionReply}
          onReject={onQuestionReject}
        />
      )}
    </div>
  )
}

function BoardChatComposer({
  value,
  disabled,
  sending,
  canSend,
  textareaRef,
  onChange,
  onSend
}: {
  value: string
  disabled: boolean
  sending: boolean
  canSend: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  onSend: () => void
}): React.JSX.Element {
  return (
    <div className="border-t border-border/70 px-4 py-3">
      <div className="rounded-3xl border border-border/70 bg-muted/20 p-2 shadow-sm">
        <Textarea
          ref={textareaRef}
          value={value}
          disabled={disabled}
          placeholder={
            disabled
              ? 'Select a target project to start.'
              : 'Can create local tickets. Ask for breakdowns, revisions, or smaller tasks.'
          }
          className="min-h-[84px] resize-none border-0 bg-transparent p-2 shadow-none focus-visible:ring-0"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSend()
            }
          }}
        />
        <div className="flex items-center justify-between gap-3 px-2 pb-1">
          <span className="text-xs text-muted-foreground">Enter to send. Shift+Enter for a new line.</span>
          <Button type="button" size="sm" onClick={onSend} disabled={!canSend}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}

export function BoardChatDrawer({
  projectId,
  projectPath,
  connectionId,
  isPinnedMode = false
}: BoardChatDrawerProps): React.JSX.Element | null {
  const projects = useProjectStore((state) => state.projects)
  const connections = useConnectionStore((state) => state.connections)
  const scope = useMemo<BoardChatScope | null>(() => {
    if (isPinnedMode) return { kind: 'pinned' }

    if (connectionId) {
      const connection = connections.find((candidate) => candidate.id === connectionId)
      if (!connection) return null

      const seen = new Set<string>()
      const availableProjects = connection.members.reduce<Array<{ id: string; name: string }>>((acc, member) => {
        if (seen.has(member.project_id)) return acc
        seen.add(member.project_id)
        acc.push({ id: member.project_id, name: member.project_name })
        return acc
      }, [])

      return {
        kind: 'connection',
        connectionId: connection.id,
        connectionName: connection.custom_name || connection.name,
        connectionPath: connection.path,
        availableProjects
      }
    }

    if (projectId) {
      const project = projects.find((candidate) => candidate.id === projectId)
      if (!project) return null
      return {
        kind: 'project',
        projectId: project.id,
        projectName: project.name,
        projectPath: projectPath ?? project.path
      }
    }

    return null
  }, [connectionId, connections, isPinnedMode, projectId, projectPath, projects])

  const isOpen = useBoardChatStore((state) => state.isOpen)
  const isMinimized = useBoardChatStore((state) => state.isMinimized)
  const storedScope = useBoardChatStore((state) => state.scope)
  const messages = useBoardChatStore((state) => state.messages)
  const drafts = useBoardChatStore((state) => state.drafts)
  const draftSourceMessageId = useBoardChatStore((state) => state.draftSourceMessageId)
  const status = useBoardChatStore((state) => state.status)
  const selectedTargetProjectId = useBoardChatStore((state) => state.selectedTargetProjectId)
  const error = useBoardChatStore((state) => state.error)
  const sessionId = useBoardChatStore((state) => state.sessionId)
  const opencodeSessionId = useBoardChatStore((state) => state.opencodeSessionId)
  const runtimePath = useBoardChatStore((state) => state.runtimePath)
  const selectedAgentSdkOverride = useBoardChatStore((state) => state.selectedAgentSdkOverride)
  const selectedModelOverride = useBoardChatStore((state) => state.selectedModelOverride)
  const composerValue = useBoardChatStore((state) => state.composerValue)

  const setTranscriptMessages = useBoardChatStore((state) => state.setTranscriptMessages)
  const addLocalUserMessage = useBoardChatStore((state) => state.addLocalUserMessage)
  const addLocalSystemMessage = useBoardChatStore((state) => state.addLocalSystemMessage)
  const setDrafts = useBoardChatStore((state) => state.setDrafts)
  const clearDrafts = useBoardChatStore((state) => state.clearDrafts)
  const markDraftsCreated = useBoardChatStore((state) => state.markDraftsCreated)
  const toggleDraftSelection = useBoardChatStore((state) => state.toggleDraftSelection)
  const setStatus = useBoardChatStore((state) => state.setStatus)
  const setSelectedTargetProjectId = useBoardChatStore((state) => state.setSelectedTargetProjectId)
  const setSelectedAgentSdkOverride = useBoardChatStore((state) => state.setSelectedAgentSdkOverride)
  const setSelectedModelOverride = useBoardChatStore((state) => state.setSelectedModelOverride)
  const setError = useBoardChatStore((state) => state.setError)
  const updateOpencodeSessionId = useBoardChatStore((state) => state.updateOpencodeSessionId)
  const setComposerValue = useBoardChatStore((state) => state.setComposerValue)
  const minimizeDrawer = useBoardChatStore((state) => state.minimizeDrawer)
  const restoreDrawer = useBoardChatStore((state) => state.restoreDrawer)
  const resetState = useBoardChatStore((state) => state.resetState)

  const latestScopeKey = buildScopeKey(scope)
  const scopeSyncKeyRef = useRef<string>('')
  const composerFocusRef = useRef<HTMLTextAreaElement | null>(null)
  const availableAgentSdks = useSettingsStore((state) => state.availableAgentSdks)
  const defaultBoardAgentSdk = useSettingsStore((state) => resolveBoardChatAgentSdk(state.defaultAgentSdk))
  const effectiveAgentSdk = selectedAgentSdkOverride ?? defaultBoardAgentSdk
  const resolvedDefaultModel = useSettingsStore((state) => resolveBoardChatDefaultModel(state, effectiveAgentSdk))
  const effectiveSelectedModel = selectedModelOverride ?? resolvedDefaultModel
  const agentSdkOptions = useMemo(() => {
    const options: Array<'opencode' | 'claude-code' | 'codex'> = []
    if (!availableAgentSdks) return [effectiveAgentSdk]
    if (availableAgentSdks.opencode) options.push('opencode')
    if (availableAgentSdks.claude) options.push('claude-code')
    if (availableAgentSdks.codex) options.push('codex')
    return options.length > 0 ? options : [effectiveAgentSdk]
  }, [availableAgentSdks, effectiveAgentSdk])
  const handleMaterializedSessionId = useCallback((nextOpencodeSessionId: string) => {
    updateOpencodeSessionId(nextOpencodeSessionId)
    if (sessionId) {
      void window.db.session.update(sessionId, {
        opencode_session_id: nextOpencodeSessionId
      }).catch(() => {})
    }
  }, [sessionId, updateOpencodeSessionId])

  useEffect(() => {
    let cancelled = false

    const syncScope = async (): Promise<void> => {
      if (scopeSyncKeyRef.current === latestScopeKey) return
      scopeSyncKeyRef.current = latestScopeKey

      const preserveOpen = useBoardChatStore.getState().isOpen
      await cleanupBoardChatRuntime()
      if (cancelled) return

      resetState({
        preserveOpen,
        scope,
        selectedTargetProjectId:
          scope?.kind === 'project'
            ? scope.projectId
            : scope?.kind === 'connection'
              ? scope.availableProjects[0]?.id ?? null
              : null
      })

      if (preserveOpen && scope && scope.kind !== 'pinned') {
        addLocalSystemMessage(
          scope.kind === 'project'
            ? `Assistant scope set to ${scope.projectName}.`
            : `Assistant scope set to ${scope.connectionName}.`
        )
      }
    }

    void syncScope()

    return () => {
      cancelled = true
    }
  }, [addLocalSystemMessage, latestScopeKey, resetState, scope])

  useEffect(() => {
    return () => {
      void cleanupBoardChatRuntime()
      useBoardChatStore.getState().resetState()
      scopeSyncKeyRef.current = ''
    }
  }, [])

  const { messages: transcriptMessages, streamingParts, streamingContent, isStreaming } = useSessionStream({
    sessionId: sessionId ?? '',
    worktreePath: runtimePath ?? '',
    opencodeSessionId: opencodeSessionId ?? '',
    enabled: Boolean(sessionId && opencodeSessionId && runtimePath),
    onMaterializedSessionId: handleMaterializedSessionId
  })

  useEffect(() => {
    if (!sessionId || !opencodeSessionId || !runtimePath) return
    setTranscriptMessages(transcriptMessages)
  }, [opencodeSessionId, runtimePath, sessionId, setTranscriptMessages, transcriptMessages])

  const latestDraftResult = useMemo(() => {
    const strictProjectId = scope?.kind === 'project' ? scope.projectId : undefined
    const fallbackProjectId =
      scope?.kind === 'project'
        ? scope.projectId
        : selectedTargetProjectId

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'assistant') continue
      const parsed = parseBoardAssistantDraftSet(message.content, {
        fallbackProjectId,
        strictProjectId,
        requireExplicitDraftKeys: scope?.kind === 'project'
      })
      if (parsed) {
        return {
          messageId: message.id,
          drafts: parsed.drafts
        }
      }
    }
    return null
  }, [messages, scope, selectedTargetProjectId])

  useEffect(() => {
    if (!latestDraftResult || !scope) return
    if (draftSourceMessageId === latestDraftResult.messageId) return

    const targetProjectId =
      scope.kind === 'project'
        ? scope.projectId
        : scope.kind === 'connection'
          ? selectedTargetProjectId
          : null

    if (!targetProjectId) return

    const titleByDraftKey = new Map(
      latestDraftResult.drafts.map((draft) => [draft.draftKey, draft.title])
    )

    setDrafts(
      latestDraftResult.drafts.map((draft) => ({
        id: `${latestDraftResult.messageId}:${draft.draftKey}:${scope.kind === 'project' ? targetProjectId : (draft.projectId || targetProjectId)}`,
        draftKey: draft.draftKey,
        title: draft.title,
        description: draft.description,
        dependsOn: draft.dependsOn,
        resolvedDependsOnTitles: draft.dependsOn.map(
          (dependency) => titleByDraftKey.get(dependency) ?? dependency
        ),
        warnings: draft.warnings,
        validationIssues: draft.validationIssues,
        projectId: scope.kind === 'project' ? targetProjectId : (draft.projectId || targetProjectId),
        projectName:
          projects.find((project) =>
            project.id === (scope.kind === 'project' ? targetProjectId : (draft.projectId || targetProjectId))
          )?.name ??
          'Unknown project',
        selected: true
      })),
      latestDraftResult.messageId
    )
  }, [draftSourceMessageId, latestDraftResult, projects, scope, selectedTargetProjectId, setDrafts])

  useEffect(() => {
    if (error) {
      setStatus('error')
      return
    }

    if (isStreaming) {
      setStatus('thinking')
      return
    }

    if (drafts.length > 0) {
      setStatus('awaiting_confirmation')
      return
    }

    setStatus('idle')
  }, [drafts.length, error, isStreaming, setStatus])

  const activeQuestion = useQuestionStore((state) =>
    sessionId ? state.getActiveQuestion(sessionId) : null
  )
  const activePermission = usePermissionStore((state) =>
    sessionId ? state.getActivePermission(sessionId) : null
  )
  const activeApproval = useCommandApprovalStore((state) =>
    sessionId ? state.getActiveApproval(sessionId) : null
  )

  const streamingMessage = useMemo<BoardChatMessage | null>(() => {
    if (!isStreaming && streamingParts.length === 0 && !streamingContent) return null
    return {
      id: 'board-chat-streaming',
      role: 'assistant',
      content: streamingContent,
      timestamp: new Date().toISOString(),
      parts: streamingParts,
      kind: 'local'
    }
  }, [isStreaming, streamingContent, streamingParts])

  const canInteract = scope !== null && scope.kind !== 'pinned'
  const hasInvalidDrafts = drafts.some((draft) => draft.validationIssues.length > 0)
  const canSend =
    canInteract &&
    Boolean((scope?.kind === 'project' ? scope.projectId : selectedTargetProjectId) && composerValue.trim()) &&
    status !== 'starting' &&
    status !== 'thinking'

  const handleDiscardConversation = useCallback(
    async (options?: {
      preserveOpen?: boolean
      nextTargetProjectId?: string | null
      nextSelectedAgentSdkOverride?: 'opencode' | 'claude-code' | 'codex' | null
      nextSelectedModelOverride?: SelectedModel | null
    }) => {
      await cleanupBoardChatRuntime()

      const activeScope = useBoardChatStore.getState().scope
      resetState({
        preserveOpen: options?.preserveOpen ?? false,
        scope: activeScope,
        selectedTargetProjectId:
          options?.nextTargetProjectId ??
          (activeScope?.kind === 'project'
            ? activeScope.projectId
            : activeScope?.kind === 'connection'
              ? activeScope.availableProjects[0]?.id ?? null
              : null),
        selectedAgentSdkOverride:
          options?.nextSelectedAgentSdkOverride ??
          useBoardChatStore.getState().selectedAgentSdkOverride,
        selectedModelOverride:
          options?.nextSelectedModelOverride ??
          useBoardChatStore.getState().selectedModelOverride
      })
    },
    [resetState]
  )

  const handleSend = useCallback(async () => {
    if (!scope || scope.kind === 'pinned') return

    const input = composerValue.trim()
    if (!input) return

    const targetProjectId =
      scope.kind === 'project' ? scope.projectId : selectedTargetProjectId

    if (!targetProjectId) {
      setError('Select a target project before starting the assistant.')
      addLocalSystemMessage('Select a target project before starting the assistant.')
      return
    }

    try {
      setError(null)
      setStatus(sessionId ? 'thinking' : 'starting')
      addLocalUserMessage(input)
      setComposerValue('')

      const runtime = await ensureRuntimeSession(scope, targetProjectId)
      if (!runtime) {
        throw new Error('Unable to start a board assistant session for this board scope.')
      }

      const prompt = buildBoardPrompt(input, scope, targetProjectId)
      const result = await window.opencodeOps.prompt(runtime.runtimePath, runtime.opencodeSessionId, prompt)
      if (!result.success) {
        throw new Error(result.error || 'The assistant could not send your message.')
      }
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : 'Failed to send assistant message.'
      setError(message)
      setStatus('error')
      addLocalSystemMessage(message)
      toast.error(message)
    }
  }, [addLocalSystemMessage, addLocalUserMessage, composerValue, scope, selectedTargetProjectId, sessionId, setComposerValue, setError, setStatus])

  const handleCreateDrafts = useCallback(async (onlySelected: boolean) => {
    const draftsToCreate = drafts.filter(
      (draft) => !draft.createdAt && (!onlySelected || draft.selected)
    )
    if (draftsToCreate.length === 0) {
      return
    }

    try {
      const invalidDrafts = draftsToCreate.filter((draft) => draft.validationIssues.length > 0)
      if (invalidDrafts.length > 0) {
        throw new Error('Fix draft validation issues before creating tickets.')
      }

      const draftKeysInBatch = new Set(draftsToCreate.map((draft) => draft.draftKey))
      const result = await window.kanban.ticket.createBatch({
        drafts: draftsToCreate.map((draft) => ({
          draft_key: draft.draftKey,
          project_id: draft.projectId,
          title: draft.title,
          description: draft.description,
          column: 'todo',
          depends_on: draft.dependsOn.filter((key) => draftKeysInBatch.has(key))
        }))
      })

      await useKanbanStore.getState().loadTickets(draftsToCreate[0].projectId)
      await useKanbanStore.getState().loadDependencies(draftsToCreate[0].projectId)

      markDraftsCreated(draftsToCreate.map((draft) => draft.id))
      addLocalSystemMessage(
        `Created ${result.tickets.length} ticket${result.tickets.length === 1 ? '' : 's'} and ${result.dependencies.length} dependenc${result.dependencies.length === 1 ? 'y' : 'ies'} in ${draftsToCreate[0].projectName}.`
      )
      toast.success(
        `Created ${result.tickets.length} ticket${result.tickets.length === 1 ? '' : 's'}.`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create one or more tickets.'
      toast.error(message)
    }
  }, [addLocalSystemMessage, drafts, markDraftsCreated])

  const handleClear = useCallback(async () => {
    await handleDiscardConversation({ preserveOpen: true })
    if (storedScope && storedScope.kind !== 'pinned') {
      addLocalSystemMessage('Conversation cleared.')
    }
  }, [addLocalSystemMessage, handleDiscardConversation, storedScope])

  const handleClose = useCallback(async () => {
    await handleDiscardConversation()
  }, [handleDiscardConversation])

  const handleSelectModel = useCallback(async (model: SelectedModel) => {
    setSelectedModelOverride(model)
    await handleDiscardConversation({
      preserveOpen: true,
      nextSelectedModelOverride: model
    })
    addLocalSystemMessage(`Board assistant model changed to ${model.providerID}/${model.modelID}.`)
  }, [addLocalSystemMessage, handleDiscardConversation, setSelectedModelOverride])

  const handleResetModel = useCallback(async () => {
    setSelectedModelOverride(null)
    await handleDiscardConversation({
      preserveOpen: true,
      nextSelectedModelOverride: null
    })
    addLocalSystemMessage('Board assistant model reset to the app default.')
  }, [addLocalSystemMessage, handleDiscardConversation, setSelectedModelOverride])

  const handleSelectAgentSdk = useCallback(async (nextAgentSdk: 'opencode' | 'claude-code' | 'codex') => {
    const nextOverride = nextAgentSdk === defaultBoardAgentSdk ? null : nextAgentSdk
    setSelectedAgentSdkOverride(nextOverride)
    setSelectedModelOverride(null)
    await handleDiscardConversation({
      preserveOpen: true,
      nextSelectedAgentSdkOverride: nextOverride,
      nextSelectedModelOverride: null
    })
    addLocalSystemMessage(`Board assistant provider changed to ${getAgentSdkLabel(nextAgentSdk)}.`)
  }, [addLocalSystemMessage, defaultBoardAgentSdk, handleDiscardConversation, setSelectedAgentSdkOverride, setSelectedModelOverride])

  const handleRevise = useCallback(() => {
    setComposerValue('Revise the current draft tickets. Keep them small, specific, and implementation-ready.')
    composerFocusRef.current?.focus()
  }, [setComposerValue])

  const handleCancelDrafts = useCallback(() => {
    clearDrafts()
    addLocalSystemMessage('Draft proposals discarded.')
  }, [addLocalSystemMessage, clearDrafts])

  const handleSelectTargetProject = useCallback(async (nextProjectId: string) => {
    await setSelectedTargetProjectId(nextProjectId)
    await handleDiscardConversation({ preserveOpen: true, nextTargetProjectId: nextProjectId })
    const projectName = projects.find((project) => project.id === nextProjectId)?.name ?? 'the selected project'
    addLocalSystemMessage(`Target project changed to ${projectName}.`)
  }, [addLocalSystemMessage, handleDiscardConversation, projects, setSelectedTargetProjectId])

  const handleQuestionReply = useCallback(
    async (requestId: string, answers: QuestionAnswer[]) => {
      try {
        await window.opencodeOps.questionReply(requestId, answers, runtimePath || undefined)
        if (sessionId) {
          useQuestionStore.getState().removeQuestion(sessionId, requestId)
        }
      } catch {
        toast.error('Failed to answer assistant question.')
      }
    },
    [runtimePath, sessionId]
  )

  const handleQuestionReject = useCallback(
    async (requestId: string) => {
      try {
        await window.opencodeOps.questionReject(requestId, runtimePath || undefined)
        if (sessionId) {
          useQuestionStore.getState().removeQuestion(sessionId, requestId)
        }
      } catch {
        toast.error('Failed to dismiss assistant question.')
      }
    },
    [runtimePath, sessionId]
  )

  const handlePermissionReply = useCallback(
    async (requestId: string, reply: 'once' | 'always' | 'reject', message?: string) => {
      try {
        await window.opencodeOps.permissionReply(requestId, reply, runtimePath || undefined, message)
        if (sessionId) {
          usePermissionStore.getState().removePermission(sessionId, requestId)
        }
      } catch {
        toast.error('Failed to respond to permission request.')
      }
    },
    [runtimePath, sessionId]
  )

  const handleCommandApprovalReply = useCallback(
    async (
      requestId: string,
      approved: boolean,
      remember?: 'allow' | 'block',
      pattern?: string,
      patterns?: string[]
    ) => {
      try {
        await window.opencodeOps.commandApprovalReply(
          requestId,
          approved,
          remember,
          pattern,
          runtimePath || undefined,
          patterns
        )
        if (sessionId) {
          useCommandApprovalStore.getState().removeApproval(sessionId, requestId)
        }
      } catch {
        toast.error('Failed to respond to command approval request.')
      }
    },
    [runtimePath, sessionId]
  )

  if (!scope) return null

  if (!isOpen) return null

  if (isMinimized) {
    return (
      <div className="pointer-events-auto absolute bottom-4 right-4 z-30 w-[min(28rem,calc(100%-1.5rem))]">
        <button
          type="button"
          onClick={restoreDrawer}
          className="flex h-14 w-full items-center justify-between rounded-t-2xl rounded-b-xl border border-border/70 bg-muted/30 px-4 shadow-sm transition-colors hover:bg-muted/50"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/12 text-primary">
              <Bot className="h-4 w-4" />
            </div>
            <div className="text-left">
              <p className="text-sm font-semibold text-foreground">Board Assistant</p>
              <p className="text-xs text-muted-foreground">{getStatusLabel(status)}</p>
            </div>
          </div>
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground">
            <Minimize2 className="h-4 w-4 rotate-180" />
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-end p-3">
      <div
        className={cn(
          'pointer-events-auto flex max-h-[min(72vh,42rem)] w-full flex-col overflow-hidden rounded-t-[28px] rounded-b-2xl border border-border/70 bg-card shadow-xl',
          'sm:w-[28rem] lg:w-[32rem]'
        )}
      >
        <BoardChatHeader
          scope={scope}
          selectedTargetProjectId={selectedTargetProjectId}
          status={status}
          selectedModel={effectiveSelectedModel}
          agentSdk={effectiveAgentSdk}
          availableAgentSdks={agentSdkOptions}
          modelResetVisible={Boolean(selectedModelOverride)}
          onSelectAgentSdk={(agentSdk) => {
            void handleSelectAgentSdk(agentSdk)
          }}
          onSelectModel={(model) => {
            void handleSelectModel(model)
          }}
          onResetModel={() => {
            void handleResetModel()
          }}
          onSelectTargetProject={handleSelectTargetProject}
          onClear={() => {
            void handleClear()
          }}
          onMinimize={minimizeDrawer}
          onClose={() => {
            void handleClose()
          }}
        />

        {error && (
          <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <BoardChatMessageList
          messages={messages}
          drafts={drafts}
          draftSourceMessageId={draftSourceMessageId}
          streamingMessage={streamingMessage}
          activeQuestion={activeQuestion}
          activePermission={activePermission}
          activeApproval={activeApproval}
          sessionId={sessionId}
          onToggleDraft={toggleDraftSelection}
          onCreateAll={() => {
            void handleCreateDrafts(false)
          }}
          onCreateSelected={() => {
            void handleCreateDrafts(true)
          }}
          onRevise={handleRevise}
          onCancelDrafts={handleCancelDrafts}
          hasInvalidDrafts={hasInvalidDrafts}
          onQuestionReply={(requestId, answers) => {
            void handleQuestionReply(requestId, answers)
          }}
          onQuestionReject={(requestId) => {
            void handleQuestionReject(requestId)
          }}
          onPermissionReply={(requestId, reply, message) => {
            void handlePermissionReply(requestId, reply, message)
          }}
          onCommandApprovalReply={(requestId, approved, remember, pattern, patterns) => {
            void handleCommandApprovalReply(requestId, approved, remember, pattern, patterns)
          }}
        />

        <BoardChatComposer
          value={composerValue}
          disabled={!canInteract || (scope.kind === 'connection' && !selectedTargetProjectId)}
          sending={status === 'starting' || status === 'thinking'}
          canSend={canSend}
          textareaRef={composerFocusRef}
          onChange={setComposerValue}
          onSend={() => {
            void handleSend()
          }}
        />
      </div>
    </div>
  )
}
