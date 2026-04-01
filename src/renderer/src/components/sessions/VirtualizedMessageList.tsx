import { useMemo, memo, forwardRef, useImperativeHandle } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertCircle, RefreshCw, Minimize2 } from 'lucide-react'
import { MessageRenderer } from './MessageRenderer'
import { QueuedMessageBubble } from './QueuedMessageBubble'
import type { OpenCodeMessage } from './SessionView'
import { formatCompletionDuration } from '@/lib/format-utils'
import beeIcon from '@/assets/bee.png'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VirtualItem =
  | { type: 'message'; message: OpenCodeMessage }
  | { type: 'revert-banner' }
  | { type: 'error-banner' }
  | { type: 'retry-banner' }
  | { type: 'streaming'; message: OpenCodeMessage }
  | { type: 'typing-indicator' }
  | { type: 'queued'; queuedMessage: { id: string; content: string } }
  | { type: 'completion' }

export interface VirtualizedMessageListProps {
  messages: OpenCodeMessage[]
  streamingMessage: OpenCodeMessage | null
  isStreaming: boolean
  isSending: boolean
  isCompacting: boolean
  cwd: string | null
  onForkAssistantMessage: (message: OpenCodeMessage) => void | Promise<void>
  forkingMessageId: string | null
  revertMessageID: string | null
  revertedUserCount: number
  onRedoRevert: () => void
  sessionErrorMessage: string | null
  sessionErrorStderr: string | null
  sessionRetry: { attempt?: number; message?: string } | null
  retrySecondsRemaining: number | null
  hasVisibleWritingCursor: boolean
  queuedMessages: { id: string; content: string }[]
  completionEntry: { word?: string; durationMs?: number } | null
  scrollElement: HTMLDivElement | null
}

export interface VirtualizedMessageListHandle {
  scrollToEnd: (behavior?: ScrollBehavior) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const VirtualizedMessageList = memo(
  forwardRef<VirtualizedMessageListHandle, VirtualizedMessageListProps>(function VirtualizedMessageList({
  messages,
  streamingMessage,
  isStreaming,
  isSending,
  isCompacting,
  cwd,
  onForkAssistantMessage,
  forkingMessageId,
  revertMessageID,
  revertedUserCount,
  onRedoRevert,
  sessionErrorMessage,
  sessionErrorStderr,
  sessionRetry,
  retrySecondsRemaining,
  hasVisibleWritingCursor,
  queuedMessages,
  completionEntry,
  scrollElement
}: VirtualizedMessageListProps, ref): React.JSX.Element {
  // Build the flat item array that drives the virtualizer
  const items = useMemo(() => {
    const result: VirtualItem[] = []

    // Messages
    for (const msg of messages) {
      result.push({ type: 'message' as const, message: msg })
    }

    // Revert banner
    if (revertMessageID && revertedUserCount > 0) {
      result.push({ type: 'revert-banner' as const })
    }

    // Error banner
    if (sessionErrorMessage) {
      result.push({ type: 'error-banner' as const })
    }

    // Retry banner
    if (sessionRetry) {
      result.push({ type: 'retry-banner' as const })
    }

    // Streaming message
    if (streamingMessage) {
      result.push({ type: 'streaming' as const, message: streamingMessage })
    }

    // Typing indicator
    if (isSending && !hasVisibleWritingCursor) {
      result.push({ type: 'typing-indicator' as const })
    }

    // Queued messages
    for (const msg of queuedMessages) {
      result.push({ type: 'queued' as const, queuedMessage: msg })
    }

    // Completion badge
    if (completionEntry && !isSending) {
      result.push({ type: 'completion' as const })
    }

    return result
  }, [
    messages,
    revertMessageID,
    revertedUserCount,
    sessionErrorMessage,
    sessionRetry,
    streamingMessage,
    isSending,
    hasVisibleWritingCursor,
    queuedMessages,
    completionEntry
  ])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 150,
    overscan: 5
  })

  useImperativeHandle(ref, () => ({
    scrollToEnd: (behavior?: ScrollBehavior) => {
      if (items.length > 0) {
        virtualizer.scrollToIndex(items.length - 1, { align: 'end', behavior: behavior ?? 'instant' })
      }
    }
  }), [virtualizer, items.length])

  // Render a single virtual item
  const renderItem = (item: VirtualItem) => {
      switch (item.type) {
        case 'message':
          return (
            <MessageRenderer
              key={item.message.id}
              message={item.message}
              cwd={cwd}
              onForkAssistantMessage={onForkAssistantMessage}
              forkDisabled={forkingMessageId !== null && forkingMessageId !== item.message.id}
              isForking={forkingMessageId === item.message.id}
            />
          )

        case 'revert-banner':
          return (
            <div
              className="mx-6 my-3 rounded-lg border border-border/50 bg-muted/30 px-4 py-3"
              data-testid="revert-banner"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {revertedUserCount} {revertedUserCount === 1 ? 'message' : 'messages'} reverted
                </span>
                <button
                  className="text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                  onClick={onRedoRevert}
                >
                  /redo to restore
                </button>
              </div>
            </div>
          )

        case 'error-banner':
          return (
            <div
              className="mx-6 my-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
              data-testid="session-error-banner"
            >
              <div className="flex items-start gap-2 text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Session error</p>
                  <p className="mt-0.5 text-sm text-destructive/90">{sessionErrorMessage}</p>
                  {sessionErrorStderr && (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-destructive/10 px-2 py-1.5 font-mono text-xs text-destructive/80">
                      {sessionErrorStderr}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          )

        case 'retry-banner':
          return (
            <div
              className="mx-6 my-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
              data-testid="session-retry-banner"
            >
              <div className="flex items-start gap-2 text-destructive">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                <div>
                  <p className="text-sm font-medium">
                    Retrying
                    {retrySecondsRemaining !== null ? ` in ${retrySecondsRemaining}s` : ''}{' '}
                    (attempt {sessionRetry?.attempt ?? 1})
                  </p>
                  {sessionRetry?.message && (
                    <p className="mt-0.5 text-sm text-destructive/90">{sessionRetry.message}</p>
                  )}
                </div>
              </div>
            </div>
          )

        case 'streaming':
          return (
            <MessageRenderer
              message={item.message}
              isStreaming={isStreaming}
              cwd={cwd}
              onForkAssistantMessage={onForkAssistantMessage}
              forkDisabled={true}
            />
          )

        case 'typing-indicator':
          return (
            <div className="px-6 py-5" data-testid="typing-indicator">
              {isCompacting ? (
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <Minimize2 className="h-3.5 w-3.5 animate-pulse" />
                  <span>Compacting conversation...</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" />
                  <span
                    className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"
                    style={{ animationDelay: '0.1s' }}
                  />
                  <span
                    className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"
                    style={{ animationDelay: '0.2s' }}
                  />
                </div>
              )}
            </div>
          )

        case 'queued':
          return <QueuedMessageBubble key={item.queuedMessage.id} content={item.queuedMessage.content} />

        case 'completion':
          return (
            <div
              className="flex items-center gap-1.5 px-6 py-2 text-xs"
              style={{ color: '#C15F3C' }}
              data-testid="completion-badge"
            >
              <img src={beeIcon} alt="bee" className="h-7 w-7" />
              <span className="font-medium">
                {completionEntry?.word ?? 'Worked'} for{' '}
                {formatCompletionDuration(completionEntry?.durationMs ?? 0)}
              </span>
            </div>
          )

        default:
          return null
      }
  }

  return (
    <div className="py-4">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative'
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index]
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              {renderItem(item)}
            </div>
          )
        })}
      </div>
    </div>
  )
}))
