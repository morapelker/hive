// The assistant conversation: user bubbles, assistant replies with the tools they used
// (`describe_table(orders)` chips), proposal cards, system notes ("Stopped."), the run in flight
// (its tool trace, streamed text and a thinking line with elapsed time) and a trailing error
// chip with Retry. An empty conversation shows three example prompts for the engine.
import { useEffect, useRef } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/sessions/MarkdownRenderer'
import { cn } from '@/lib/utils'
import {
  selectAssistantConversation,
  useDataAssistantStore,
  type AssistantMessage,
  type AssistantToolStep
} from '@/stores/useDataAssistantStore'
import { DATA_ENGINE_INFO, sqlDialectOf, type DataProject } from '@shared/data-projects/types'
import { assistantExamplePrompts, ELAPSED_AFTER_SECONDS } from './assistant-ui'
import { QueryProposalCard } from './QueryProposalCard'

interface AssistantMessageListProps {
  project: DataProject
  /** Seconds the run in flight has taken (the panel owns the timer). */
  elapsedSeconds: number
  /** An example prompt was picked. */
  onExample: (prompt: string) => void
}

function SystemChip({
  children,
  className,
  testId
}: {
  children: React.ReactNode
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md border border-border bg-secondary/50 px-3 py-2 text-[11px] text-muted-foreground',
        className
      )}
      data-testid={testId}
    >
      {children}
    </div>
  )
}

function ToolTrace({ steps }: { steps: AssistantToolStep[] }): React.JSX.Element | null {
  const shown = steps.filter((step) => step.name !== 'propose_query')
  if (!shown.length) return null
  return (
    <div className="flex flex-wrap gap-1" data-testid="data-assistant-tool-trace">
      {shown.map((step) => (
        <span
          key={step.callId}
          className={cn(
            'max-w-full truncate rounded-full bg-secondary px-[7px] text-[10px] font-medium text-muted-foreground',
            step.status === 'error' && 'bg-destructive/10 text-destructive',
            step.status === 'running' && 'animate-pulse'
          )}
          title={[step.label, step.summary, step.ms !== undefined ? `${step.ms} ms` : null]
            .filter(Boolean)
            .join(' · ')}
          data-testid="data-assistant-tool-chip"
          data-tool-status={step.status}
        >
          {step.label}
          {step.summary && step.status !== 'running' ? ` · ${step.summary}` : ''}
        </span>
      ))}
    </div>
  )
}

function UserMessage({ message }: { message: AssistantMessage }): React.JSX.Element {
  return (
    <div className="flex justify-end" data-testid="data-assistant-message-user">
      <div className="max-w-[85%] rounded-[10px] border border-border bg-secondary px-3 py-2 text-[13px] leading-[1.55] whitespace-pre-wrap break-words">
        {message.text}
      </div>
    </div>
  )
}

function AssistantReply({
  project,
  message,
  latestProposal
}: {
  project: DataProject
  message: AssistantMessage
  latestProposal: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-1.5" data-testid="data-assistant-message-assistant">
      {message.tools && <ToolTrace steps={message.tools} />}
      {message.proposal ? (
        <QueryProposalCard
          projectId={project.id}
          messageId={message.id}
          proposal={message.proposal}
          dialect={sqlDialectOf(project.engine)}
          latest={latestProposal}
        />
      ) : (
        <div className="text-[13px] leading-[1.55] break-words [&_p]:my-1">
          <MarkdownRenderer content={message.text} />
        </div>
      )}
    </div>
  )
}

function EmptyState({
  project,
  onExample
}: {
  project: DataProject
  onExample: (prompt: string) => void
}): React.JSX.Element {
  return (
    <div
      className="flex flex-col items-center gap-3 px-2 py-8 text-center"
      data-testid="data-assistant-empty"
    >
      <Sparkles className="h-8 w-8 text-muted-foreground opacity-50" />
      <div className="space-y-1">
        <div className="text-sm text-foreground">
          Ask for a {DATA_ENGINE_INFO[project.engine].label} query
        </div>
        <div className="text-xs text-muted-foreground">
          The assistant reads the schema and puts the query in the editor. It never runs anything.
        </div>
      </div>
      <div className="flex w-full flex-col gap-1.5">
        {assistantExamplePrompts(project.engine).map((prompt, i) => (
          <button
            key={prompt}
            type="button"
            className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            onClick={() => onExample(prompt)}
            data-testid={`data-assistant-example-${i}`}
          >
            {prompt}
          </button>
        ))}
      </div>
      <div className="text-[11px] text-muted-foreground" data-testid="data-assistant-data-access">
        {project.allowAiDataAccess
          ? 'May look at up to 5 sample rows per table when value formats matter.'
          : 'Schema only: no row data is shared with the model.'}
      </div>
    </div>
  )
}

export function AssistantMessageList({
  project,
  elapsedSeconds,
  onExample
}: AssistantMessageListProps): React.JSX.Element {
  const conversation = useDataAssistantStore(selectAssistantConversation(project.id))
  const retry = useDataAssistantStore((s) => s.retry)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { messages, status, tools, draft, activity, error } = conversation
  const running = status !== 'idle'
  const latestProposalId = [...messages].reverse().find((m) => m.proposal)?.id ?? null

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages, tools, draft, status, error])

  return (
    <div
      ref={scrollRef}
      className="flex-1 space-y-3 overflow-y-auto px-3 py-3 scrollbar-sleek"
      data-testid="data-assistant-message-list"
    >
      {messages.length === 0 && !running && !error && (
        <EmptyState project={project} onExample={onExample} />
      )}
      {messages.map((message) => {
        if (message.role === 'user') return <UserMessage key={message.id} message={message} />
        if (message.role === 'assistant') {
          return (
            <AssistantReply
              key={message.id}
              project={project}
              message={message}
              latestProposal={message.id === latestProposalId}
            />
          )
        }
        return (
          <SystemChip key={message.id} testId="data-assistant-message-system">
            {message.text}
          </SystemChip>
        )
      })}
      {running && (
        <div className="space-y-1.5" data-testid="data-assistant-running">
          <ToolTrace steps={tools} />
          {draft.trim() && (
            <div className="text-[13px] leading-[1.55] whitespace-pre-wrap break-words text-muted-foreground">
              {draft}
            </div>
          )}
          <div
            className="flex items-center gap-2 text-[11px] text-muted-foreground"
            data-testid="data-assistant-thinking"
          >
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            <span className="truncate">
              {status === 'cancelling' ? 'Stopping…' : (activity ?? 'Thinking…')}
              {elapsedSeconds >= ELAPSED_AFTER_SECONDS ? ` · ${elapsedSeconds}s` : ''}
            </span>
          </div>
        </div>
      )}
      {error && (
        <SystemChip className="border-destructive/30 bg-destructive/10 text-destructive">
          <div className="flex items-center gap-2" data-testid="data-assistant-error">
            <span className="min-w-0 flex-1 break-words">{error.message}</span>
            {error.retryable && conversation.lastQuestion && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 shrink-0 px-2 text-[11px]"
                onClick={() => void retry(project)}
                data-testid="data-assistant-error-retry"
              >
                Retry
              </Button>
            )}
          </div>
        </SystemChip>
      )}
    </div>
  )
}
