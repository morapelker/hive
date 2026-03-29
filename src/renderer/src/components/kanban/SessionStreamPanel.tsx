import { useRef, useState, useCallback, useEffect } from 'react'
import { useSessionStream } from '@/hooks/useSessionStream'
import { MessageRenderer } from '@/components/sessions/MessageRenderer'
import { ScrollToBottomFab } from '@/components/sessions/ScrollToBottomFab'
import type { OpenCodeMessage } from '@/components/sessions/SessionView'

export interface SessionStreamPanelProps {
  sessionId: string
  worktreePath: string
  opencodeSessionId: string
  /** Optional title override for the header (defaults to "Session") */
  title?: string
  /** When true, hides the left border (used in full-width layout) */
  fullWidth?: boolean
}

export function SessionStreamPanel({
  sessionId,
  worktreePath,
  opencodeSessionId,
  title,
  fullWidth = false
}: SessionStreamPanelProps): React.JSX.Element {
  const { messages, streamingParts, streamingContent, isStreaming, isLoading } = useSessionStream({
    sessionId,
    worktreePath,
    opencodeSessionId
  })

  // Auto-scroll logic
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isAutoScrollEnabledRef = useRef(true)
  const isProgrammaticScrollRef = useRef(false)
  const programmaticScrollResetRef = useRef<number | null>(null)
  const manualScrollIntentRef = useRef(false)
  const pointerDownInScrollerRef = useRef(false)
  const userHasScrolledUpRef = useRef(false)
  const [showScrollFab, setShowScrollFab] = useState(false)

  const markProgrammaticScroll = useCallback(() => {
    isProgrammaticScrollRef.current = true
    if (programmaticScrollResetRef.current !== null) {
      cancelAnimationFrame(programmaticScrollResetRef.current)
    }
    programmaticScrollResetRef.current = requestAnimationFrame(() => {
      programmaticScrollResetRef.current = requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false
        programmaticScrollResetRef.current = null
      })
    })
  }, [])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = isStreaming ? 'instant' : 'smooth') => {
      if (!messagesEndRef.current) return
      markProgrammaticScroll()
      messagesEndRef.current.scrollIntoView({ behavior })
    },
    [isStreaming, markProgrammaticScroll]
  )

  const resetAutoScrollState = useCallback(() => {
    if (programmaticScrollResetRef.current !== null) {
      cancelAnimationFrame(programmaticScrollResetRef.current)
      programmaticScrollResetRef.current = null
    }
    isProgrammaticScrollRef.current = false
    manualScrollIntentRef.current = false
    pointerDownInScrollerRef.current = false
    isAutoScrollEnabledRef.current = true
    userHasScrolledUpRef.current = false
    setShowScrollFab(false)
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const isNearBottom = distanceFromBottom < 80
    const hasManualIntent = manualScrollIntentRef.current || pointerDownInScrollerRef.current

    if (isProgrammaticScrollRef.current) {
      manualScrollIntentRef.current = false
      return
    }

    if (isNearBottom && hasManualIntent) {
      isAutoScrollEnabledRef.current = true
      setShowScrollFab(false)
      userHasScrolledUpRef.current = false
      return
    }

    if (!isNearBottom && isStreaming) {
      userHasScrolledUpRef.current = true
      isAutoScrollEnabledRef.current = false
      setShowScrollFab(true)
    }
    manualScrollIntentRef.current = false
  }, [isStreaming])

  const handleScrollWheel = useCallback(() => {
    manualScrollIntentRef.current = true
  }, [])

  const handleScrollPointerDown = useCallback(() => {
    pointerDownInScrollerRef.current = true
  }, [])

  const handleScrollPointerUp = useCallback(() => {
    pointerDownInScrollerRef.current = false
  }, [])

  const handleScrollToBottomClick = useCallback(() => {
    resetAutoScrollState()
    scrollToBottom('smooth')
  }, [resetAutoScrollState, scrollToBottom])

  // Auto-scroll on content changes
  useEffect(() => {
    if (isAutoScrollEnabledRef.current) {
      scrollToBottom()
    }
  }, [messages, streamingContent, streamingParts, scrollToBottom])

  // Reset auto-scroll state on session change
  useEffect(() => {
    resetAutoScrollState()
  }, [sessionId, resetAutoScrollState])

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!isLoading && messages.length > 0) {
      requestAnimationFrame(() => {
        scrollToBottom('instant')
      })
    }
  }, [isLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup programmatic scroll reset on unmount
  useEffect(() => {
    return () => {
      if (programmaticScrollResetRef.current !== null) {
        cancelAnimationFrame(programmaticScrollResetRef.current)
      }
    }
  }, [])

  const hasStreamingContent = streamingParts.length > 0 || streamingContent.length > 0

  return (
    <div className={`flex flex-col h-full bg-background flex-1 min-w-0${fullWidth ? '' : ' border-l border-border/60'}`}>
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-border/60 flex items-center gap-2">
        <span className="text-sm font-medium text-foreground truncate">{title || 'Session'}</span>
        {isStreaming && (
          <span role="status" aria-label="Streaming active" className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
        )}
      </div>

      {/* Scrollable message list */}
      <div className="flex-1 overflow-hidden relative">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span className="text-xs">Loading session...</span>
            </div>
          </div>
        ) : messages.length === 0 && !hasStreamingContent ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm text-muted-foreground">No messages yet</span>
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            className="h-full overflow-y-auto px-4 py-3 space-y-4"
            onScroll={handleScroll}
            onWheel={handleScrollWheel}
            onPointerDown={handleScrollPointerDown}
            onPointerUp={handleScrollPointerUp}
            onPointerCancel={handleScrollPointerUp}
            data-testid="session-stream-message-list"
          >
            {messages.map((message) => (
              <MessageRenderer
                key={message.id}
                message={message}
                cwd={worktreePath}
              />
            ))}

            {/* Streaming message rendered separately */}
            {hasStreamingContent && (
              <MessageRenderer
                message={
                  {
                    id: 'streaming',
                    role: 'assistant',
                    content: streamingContent,
                    timestamp: new Date().toISOString(),
                    parts: streamingParts
                  } as OpenCodeMessage
                }
                isStreaming={isStreaming}
                cwd={worktreePath}
              />
            )}

            <div ref={messagesEndRef} />
          </div>
        )}

        <ScrollToBottomFab
          onClick={handleScrollToBottomClick}
          visible={showScrollFab}
        />
      </div>
    </div>
  )
}
