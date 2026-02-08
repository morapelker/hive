import { ToolCard } from './ToolCard'
import { StreamingCursor } from './StreamingCursor'
import { MarkdownRenderer } from './MarkdownRenderer'
import type { StreamingPart } from './SessionView'

interface AssistantCanvasProps {
  content: string
  timestamp: string
  isStreaming?: boolean
  /** Interleaved parts (text + tool uses) for rich rendering */
  parts?: StreamingPart[]
}

/** Render interleaved parts (text + tool cards) */
function renderParts(parts: StreamingPart[], isStreaming: boolean): React.JSX.Element {
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === 'text' && part.text) {
          const isLastPart = index === parts.length - 1
          return (
            <span key={`part-${index}`}>
              <MarkdownRenderer content={part.text} />
              {isStreaming && isLastPart && <StreamingCursor />}
            </span>
          )
        }

        if (part.type === 'tool_use' && part.toolUse) {
          return (
            <ToolCard key={`tool-${part.toolUse.id}`} toolUse={part.toolUse} />
          )
        }

        return null
      })}
      {/* Show streaming cursor at end if last part is a tool (text will come after) */}
      {isStreaming && parts.length > 0 && parts[parts.length - 1].type === 'tool_use' && (
        <StreamingCursor />
      )}
    </>
  )
}

export function AssistantCanvas({
  content,
  timestamp,
  isStreaming = false,
  parts
}: AssistantCanvasProps): React.JSX.Element {
  const hasParts = parts && parts.length > 0

  return (
    <div className="px-6 py-5" data-testid="message-assistant">
      <div className="text-sm text-foreground leading-relaxed">
        {hasParts ? (
          renderParts(parts, isStreaming)
        ) : (
          <>
            <MarkdownRenderer content={content} />
            {isStreaming && <StreamingCursor />}
          </>
        )}
      </div>
      <span className="block text-[10px] text-muted-foreground mt-2">
        {new Date(timestamp).toLocaleTimeString()}
        {isStreaming && <span className="ml-2 text-blue-500 animate-pulse">Streaming...</span>}
      </span>
    </div>
  )
}
