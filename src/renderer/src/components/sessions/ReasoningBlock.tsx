import { useState, useEffect, useRef } from 'react'
import { ChevronRight, Brain } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ReasoningBlockProps {
  text: string
  isStreaming?: boolean
}

export function ReasoningBlock({ text, isStreaming = false }: ReasoningBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const userOverrideRef = useRef(false)

  // Auto-expand when streaming starts (if user hasn't overridden)
  useEffect(() => {
    if (isStreaming && !userOverrideRef.current) {
      setIsExpanded(true)
    }
  }, [isStreaming])

  // Auto-collapse when streaming ends (if user hasn't overridden)
  useEffect(() => {
    if (!isStreaming && !userOverrideRef.current) {
      setIsExpanded(false)
    }
  }, [isStreaming])

  // Reset user override when a new streaming session starts
  useEffect(() => {
    if (isStreaming) {
      userOverrideRef.current = false
    }
  }, [isStreaming])

  const handleToggle = () => {
    userOverrideRef.current = true
    setIsExpanded((prev) => !prev)
  }

  const lines = text.split('\n')
  const firstLine = lines[0]?.slice(0, 100) || 'Thinking...'
  const preview = firstLine.length < (lines[0]?.length ?? 0) ? firstLine + '...' : firstLine

  return (
    <div className="my-1 rounded-md bg-muted/30 overflow-hidden" data-testid="reasoning-block">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left hover:bg-muted/50 transition-colors"
        aria-expanded={isExpanded}
        data-testid="reasoning-block-header"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150',
            isExpanded && 'rotate-90'
          )}
        />
        <Brain className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        <span className="text-xs text-muted-foreground italic">
          {isExpanded ? 'Thinking...' : preview}
        </span>
      </button>

      {isExpanded && (
        <div className="border-t border-border/30 px-3 py-2" data-testid="reasoning-block-content">
          <p className="text-xs text-muted-foreground/80 italic whitespace-pre-wrap leading-relaxed font-mono">
            {text}
          </p>
        </div>
      )}
    </div>
  )
}
