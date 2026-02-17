import { ToolCard } from './ToolCard'
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
      if (part.toolUse) {
        renderedParts.push(
          <ToolCard
            key={`tool-${part.toolUse.id}`}
            toolUse={part.toolUse}
            cwd={cwd}
            compact={forceCompactTools}
          />
        )
      }
      index += 1
      continue
    }

    if (part.type === 'subtask' && part.subtask) {
      renderedParts.push(<SubtaskCard key={`subtask-${index}`} subtask={part.subtask} />)
      index += 1
      continue
    }

    if (part.type === 'reasoning' && part.reasoning) {
      // Reasoning is still streaming only if the overall message is streaming
      // AND there are no meaningful parts after this one (text with content, tool_use, etc.)
      const hasContentAfter = parts.slice(index + 1).some((p) => {
        if (p.type === 'tool_use') return true
        if (p.type === 'text' && hasMeaningfulText(p.text)) return true
        if (p.type === 'reasoning') return true
        return false
      })
      const isReasoningStreaming = isStreaming && !hasContentAfter

      renderedParts.push(
        <ReasoningBlock
          key={`reasoning-${index}`}
          text={part.reasoning}
          isStreaming={isReasoningStreaming}
        />
      )
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
