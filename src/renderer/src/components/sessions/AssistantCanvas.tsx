import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ToolCard, type ToolUseInfo } from './ToolCard'
import { StreamingCursor } from './StreamingCursor'
import { MarkdownRenderer } from './MarkdownRenderer'
import { SubtaskCard } from './SubtaskCard'
import { ReasoningBlock } from './ReasoningBlock'
import { CompactionPill } from './CompactionPill'
import { cn } from '@/lib/utils'
import type { StreamingPart } from './SessionView'

interface AssistantCanvasProps {
  content: string
  timestamp: string
  isStreaming?: boolean
  /** Interleaved parts (text + tool uses) for rich rendering */
  parts?: StreamingPart[]
  /** Working directory for relative path display */
  cwd?: string | null
}

const TOOL_GROUP_THRESHOLD = 3

function hasMeaningfulText(text: string | undefined): boolean {
  if (!text) return false
  // Treat zero-width separators as whitespace so invisible deltas don't create "text" spacing blocks.
  return text.replace(/[\s\u200B-\u200D\uFEFF]/g, '').length > 0
}

function hasToolParts(parts: StreamingPart[] | undefined): boolean {
  if (!parts || parts.length === 0) return false

  for (const part of parts) {
    if (part.type === 'tool_use' && part.toolUse) {
      return true
    }
  }
  return false
}

function formatToolSummary(toolUses: ToolUseInfo[]): string {
  const counts = new Map<string, number>()
  for (const toolUse of toolUses) {
    const name = toolUse.name.trim() || 'Tool'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const summary = Array.from(counts.entries())
    .slice(0, 3)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ')
  return summary || `${toolUses.length} tool calls`
}

function groupStatus(toolUses: ToolUseInfo[]): 'pending' | 'running' | 'success' | 'error' {
  if (toolUses.some((toolUse) => toolUse.status === 'error')) return 'error'
  if (toolUses.some((toolUse) => toolUse.status === 'running')) return 'running'
  if (toolUses.some((toolUse) => toolUse.status === 'pending')) return 'pending'
  return 'success'
}

function statusChipClass(status: 'pending' | 'running' | 'success' | 'error'): string {
  switch (status) {
    case 'pending':
      return 'border-muted-foreground/20 text-muted-foreground'
    case 'running':
      return 'border-blue-500/30 text-blue-500'
    case 'success':
      return 'border-green-500/30 text-green-500'
    case 'error':
      return 'border-red-500/30 text-red-500'
  }
}

function statusChipLabel(status: 'pending' | 'running' | 'success' | 'error'): string {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'running':
      return 'Running'
    case 'success':
      return 'Done'
    case 'error':
      return 'Error'
  }
}

function ToolCallGroup({
  toolUses,
  cwd
}: {
  toolUses: ToolUseInfo[]
  cwd?: string | null
}): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const status = useMemo(() => groupStatus(toolUses), [toolUses])
  const summary = useMemo(() => formatToolSummary(toolUses), [toolUses])

  return (
    <div
      className="my-1 overflow-hidden rounded-md border border-border/60 bg-muted/20"
      data-testid="tool-call-group"
    >
      <button
        type="button"
        onClick={() => setIsExpanded((expanded) => !expanded)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/35 transition-colors"
        aria-expanded={isExpanded}
        data-testid="tool-call-group-header"
      >
        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150',
            !isExpanded && '-rotate-90'
          )}
        />
        <span className="text-xs font-medium text-foreground">{toolUses.length} tool calls</span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{summary}</span>
        <span className="flex-1" />
        <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', statusChipClass(status))}>
          {statusChipLabel(status)}
        </span>
      </button>

      {isExpanded && (
        <div className="border-t border-border/70 px-1.5 py-1">
          {toolUses.map((toolUse) => (
            <ToolCard key={`tool-${toolUse.id}`} toolUse={toolUse} cwd={cwd} compact={true} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Render interleaved parts (text + tool cards) */
function renderParts(
  parts: StreamingPart[],
  isStreaming: boolean,
  cwd?: string | null,
  forceCompactTools = false
): React.JSX.Element {
  const renderedParts: React.JSX.Element[] = []
  let index = 0

  while (index < parts.length) {
    const part = parts[index]

    if (part.type === 'text') {
      const text = part.text ?? ''
      const isLastPart = index === parts.length - 1
      if (!hasMeaningfulText(text)) {
        if (isStreaming && isLastPart) {
          renderedParts.push(<StreamingCursor key={`cursor-${index}`} />)
        }
        index += 1
        continue
      }
      renderedParts.push(
        <span key={`part-${index}`}>
          <MarkdownRenderer content={text} />
          {isStreaming && isLastPart && <StreamingCursor />}
        </span>
      )
      index += 1
      continue
    }

    if (part.type === 'tool_use') {
      const startIndex = index
      const toolUses: ToolUseInfo[] = []

      while (index < parts.length) {
        const currentPart = parts[index]
        if (currentPart.type === 'tool_use') {
          if (currentPart.toolUse) {
            toolUses.push(currentPart.toolUse)
          }
          index += 1
          continue
        }
        if (currentPart.type === 'text' && !hasMeaningfulText(currentPart.text)) {
          index += 1
          continue
        }
        break
      }

      if (toolUses.length >= TOOL_GROUP_THRESHOLD) {
        renderedParts.push(
          <ToolCallGroup key={`tool-group-${startIndex}`} toolUses={toolUses} cwd={cwd} />
        )
      } else if (toolUses.length > 1) {
        renderedParts.push(
          <div
            key={`tool-inline-group-${startIndex}`}
            className="my-0.5 flex flex-col gap-2"
            data-testid="tool-call-inline-group"
          >
            {toolUses.map((toolUse) => (
              <ToolCard key={`tool-${toolUse.id}`} toolUse={toolUse} cwd={cwd} compact={true} />
            ))}
          </div>
        )
      } else {
        toolUses.forEach((toolUse) => {
          renderedParts.push(
            <ToolCard
              key={`tool-${toolUse.id}`}
              toolUse={toolUse}
              cwd={cwd}
              compact={forceCompactTools || toolUses.length > 1}
            />
          )
        })
      }
      continue
    }

    if (part.type === 'subtask' && part.subtask) {
      renderedParts.push(<SubtaskCard key={`subtask-${index}`} subtask={part.subtask} />)
      index += 1
      continue
    }

    if (part.type === 'reasoning' && part.reasoning) {
      renderedParts.push(<ReasoningBlock key={`reasoning-${index}`} text={part.reasoning} />)
      index += 1
      continue
    }

    if (part.type === 'compaction') {
      renderedParts.push(
        <CompactionPill key={`compaction-${index}`} auto={part.compactionAuto ?? false} />
      )
      index += 1
      continue
    }

    // step_start and step_finish are boundary markers — skip rendering
    if (part.type === 'step_start' || part.type === 'step_finish') {
      index += 1
      continue
    }

    index += 1
  }

  return (
    <>
      {renderedParts}
      {/* Show streaming cursor at end if last part is a tool (text will come after) */}
      {isStreaming && parts.length > 0 && parts[parts.length - 1].type === 'tool_use' && (
        <StreamingCursor />
      )}
    </>
  )
}

export function AssistantCanvas({
  content,
  timestamp: _timestamp,
  isStreaming = false,
  parts,
  cwd
}: AssistantCanvasProps): React.JSX.Element {
  const hasParts = parts && parts.length > 0
  const shouldUseCompactToolSpacing = hasToolParts(parts)

  return (
    <div
      className={cn('px-6', shouldUseCompactToolSpacing ? 'py-1' : 'py-5')}
      data-testid="message-assistant"
    >
      <div className="text-sm text-foreground leading-relaxed">
        {hasParts ? (
          renderParts(parts, isStreaming, cwd, shouldUseCompactToolSpacing)
        ) : (
          <>
            <MarkdownRenderer content={content} />
            {isStreaming && <StreamingCursor />}
          </>
        )}
      </div>
    </div>
  )
}
