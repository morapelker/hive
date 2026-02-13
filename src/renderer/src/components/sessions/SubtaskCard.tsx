import { useState } from 'react'
import { ChevronRight, Loader2, Check, AlertCircle, Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolCard } from './ToolCard'
import type { StreamingPart } from './SessionView'

interface SubtaskCardProps {
  subtask: NonNullable<StreamingPart['subtask']>
}

function StatusIcon({ status }: { status: 'running' | 'completed' | 'error' }) {
  switch (status) {
    case 'running':
      return (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" data-testid="subtask-spinner" />
      )
    case 'completed':
      return <Check className="h-3.5 w-3.5 text-green-500" data-testid="subtask-check" />
    case 'error':
      return <AlertCircle className="h-3.5 w-3.5 text-red-500" data-testid="subtask-error" />
  }
}

export function SubtaskCard({ subtask }: SubtaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const preview = subtask.description || subtask.prompt
  const truncatedPreview = preview.length > 80 ? preview.slice(0, 80) + '...' : preview

  return (
    <div
      className="my-1.5 rounded-md border border-border/60 bg-muted/15 overflow-hidden"
      data-testid="subtask-card"
      data-subtask-status={subtask.status}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/30 transition-colors"
        aria-expanded={isExpanded}
        data-testid="subtask-card-header"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150',
            isExpanded && 'rotate-90'
          )}
        />
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground shrink-0">{subtask.agent}</span>
        <span className="text-xs text-muted-foreground truncate min-w-0">{truncatedPreview}</span>
        <span className="flex-1" />
        <StatusIcon status={subtask.status} />
      </button>

      {/* Expanded nested content */}
      {isExpanded && (
        <div
          className="border-t border-border/50 pl-6 pr-3 py-2 border-l-2 border-l-blue-500/30 ml-3"
          data-testid="subtask-content"
        >
          {subtask.parts.length > 0 ? (
            subtask.parts.map((part, i) => {
              if (part.type === 'text' && part.text) {
                return (
                  <div
                    key={`subtask-part-${i}`}
                    className="text-xs text-foreground leading-relaxed"
                  >
                    <MarkdownRenderer content={part.text} />
                  </div>
                )
              }
              if (part.type === 'tool_use' && part.toolUse) {
                return (
                  <ToolCard
                    key={`subtask-tool-${part.toolUse.id}`}
                    toolUse={part.toolUse}
                    compact
                  />
                )
              }
              return null
            })
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {subtask.status === 'running' ? 'Processing...' : 'No output'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
