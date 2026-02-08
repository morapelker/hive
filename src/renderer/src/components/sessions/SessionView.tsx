import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { MessageRenderer } from './MessageRenderer'
import { ModeToggle } from './ModeToggle'
import { ModelSelector } from './ModelSelector'
import { useSessionStore } from '@/stores/useSessionStore'
import type { ToolStatus, ToolUseInfo } from './ToolCard'

// Types for OpenCode SDK integration
export interface OpenCodeMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  /** Interleaved parts for assistant messages with tool calls */
  parts?: StreamingPart[]
}

export interface SessionViewState {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  errorMessage?: string
}

/** A single part of a streaming assistant message */
export interface StreamingPart {
  type: 'text' | 'tool_use'
  /** Accumulated text for text parts */
  text?: string
  /** Tool info for tool_use parts */
  toolUse?: ToolUseInfo
}

interface SessionViewProps {
  sessionId: string
}

// Database message type from window.db.message
interface DbMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
}

// Session type from database
interface DbSession {
  id: string
  worktree_id: string | null
  project_id: string
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

// Worktree type from database
interface DbWorktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  created_at: string
  last_accessed_at: string
}

// Convert database message to OpenCodeMessage
function dbMessageToOpenCode(msg: DbMessage): OpenCodeMessage {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    timestamp: msg.created_at
  }
}

// Loading state component
function LoadingState(): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4" data-testid="loading-state">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-medium">Connecting to session...</p>
        <p className="text-xs text-muted-foreground mt-1">This may take a moment</p>
      </div>
    </div>
  )
}

// Error state component
interface ErrorStateProps {
  message: string
  onRetry: () => void
}

function ErrorState({ message, onRetry }: ErrorStateProps): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4" data-testid="error-state">
      <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
        <AlertCircle className="h-6 w-6 text-destructive" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">Connection Error</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry} className="mt-2" data-testid="retry-button">
        <RefreshCw className="h-4 w-4 mr-2" />
        Retry Connection
      </Button>
    </div>
  )
}

// Main SessionView component
export function SessionView({ sessionId }: SessionViewProps): React.JSX.Element {
  // State
  const [messages, setMessages] = useState<OpenCodeMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [viewState, setViewState] = useState<SessionViewState>({ status: 'connecting' })
  const [isSending, setIsSending] = useState(false)

  // Mode state for input border color
  const mode = useSessionStore((state) => state.modeBySession.get(sessionId) || 'build')

  // OpenCode state
  const [worktreePath, setWorktreePath] = useState<string | null>(null)
  const [opencodeSessionId, setOpencodeSessionId] = useState<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)

  // Streaming parts - tracks interleaved text and tool use during streaming
  const [streamingParts, setStreamingParts] = useState<StreamingPart[]>([])
  const streamingPartsRef = useRef<StreamingPart[]>([])

  // Legacy streaming content for backward compatibility
  const [streamingContent, setStreamingContent] = useState<string>('')
  const streamingContentRef = useRef<string>('')

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Streaming throttle ref (~100ms batching for text updates)
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Response logging refs
  const isLogModeRef = useRef<boolean>(false)
  const logFilePathRef = useRef<string | null>(null)

  // Auto-scroll to bottom when new messages arrive or streaming updates
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingContent, streamingParts, scrollToBottom])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [inputValue])

  // Clean up throttle timer on unmount
  useEffect(() => {
    return () => {
      if (throttleRef.current !== null) {
        clearTimeout(throttleRef.current)
      }
    }
  }, [])

  // Check if response logging is enabled on mount
  useEffect(() => {
    window.systemOps.isLogMode().then((enabled) => {
      isLogModeRef.current = enabled
    }).catch(() => {
      // Ignore — logging not available
    })
  }, [])

  // Flush streaming refs to state (used by throttle and immediate flush)
  const flushStreamingState = useCallback(() => {
    setStreamingParts([...streamingPartsRef.current])
    setStreamingContent(streamingContentRef.current)
  }, [])

  // Schedule a throttled flush (~100ms batching for text updates)
  const scheduleFlush = useCallback(() => {
    if (throttleRef.current === null) {
      throttleRef.current = setTimeout(() => {
        throttleRef.current = null
        flushStreamingState()
      }, 100)
    }
  }, [flushStreamingState])

  // Immediate flush — cancels pending throttle and flushes now (for tool updates and stream end)
  const immediateFlush = useCallback(() => {
    if (throttleRef.current !== null) {
      clearTimeout(throttleRef.current)
      throttleRef.current = null
    }
    flushStreamingState()
  }, [flushStreamingState])

  // Helper to update streaming parts ref only (no state update — caller decides flush strategy)
  const updateStreamingPartsRef = useCallback((updater: (parts: StreamingPart[]) => StreamingPart[]) => {
    streamingPartsRef.current = updater(streamingPartsRef.current)
  }, [])

  // Helper: ensure the last part is a text part, or add one (throttled)
  const appendTextDelta = useCallback((delta: string) => {
    updateStreamingPartsRef((parts) => {
      const lastPart = parts[parts.length - 1]
      if (lastPart && lastPart.type === 'text') {
        // Append to existing text part
        return [
          ...parts.slice(0, -1),
          { ...lastPart, text: (lastPart.text || '') + delta }
        ]
      }
      // Create new text part
      return [...parts, { type: 'text' as const, text: delta }]
    })
    // Also update legacy streamingContent for backward compat
    streamingContentRef.current += delta
    // Throttled: batch text updates at ~100ms intervals
    scheduleFlush()
  }, [updateStreamingPartsRef, scheduleFlush])

  // Helper: set full text on the last text part (throttled)
  const setTextContent = useCallback((text: string) => {
    updateStreamingPartsRef((parts) => {
      const lastPart = parts[parts.length - 1]
      if (lastPart && lastPart.type === 'text') {
        return [
          ...parts.slice(0, -1),
          { ...lastPart, text }
        ]
      }
      return [...parts, { type: 'text' as const, text }]
    })
    streamingContentRef.current = text
    // Throttled: batch text updates at ~100ms intervals
    scheduleFlush()
  }, [updateStreamingPartsRef, scheduleFlush])

  // Helper: add or update a tool use part (immediate flush — tools should appear instantly)
  const upsertToolUse = useCallback((toolId: string, update: Partial<ToolUseInfo> & { name?: string; input?: Record<string, unknown> }) => {
    updateStreamingPartsRef((parts) => {
      const existingIndex = parts.findIndex(
        (p) => p.type === 'tool_use' && p.toolUse?.id === toolId
      )

      if (existingIndex >= 0) {
        // Update existing
        const existing = parts[existingIndex]
        const updatedParts = [...parts]
        updatedParts[existingIndex] = {
          ...existing,
          toolUse: { ...existing.toolUse!, ...update }
        }
        return updatedParts
      }

      // Add new tool use part
      const newToolUse: ToolUseInfo = {
        id: toolId,
        name: update.name || 'Unknown',
        input: update.input || {},
        status: update.status || ('pending' as ToolStatus),
        startTime: update.startTime || Date.now(),
        ...update
      }
      return [...parts, { type: 'tool_use' as const, toolUse: newToolUse }]
    })
    // Immediate flush for tool updates — tool cards should appear instantly
    immediateFlush()
  }, [updateStreamingPartsRef, immediateFlush])

  // Reset streaming state
  const resetStreamingState = useCallback(() => {
    if (throttleRef.current !== null) {
      clearTimeout(throttleRef.current)
      throttleRef.current = null
    }
    streamingPartsRef.current = []
    setStreamingParts([])
    streamingContentRef.current = ''
    setStreamingContent('')
    setIsStreaming(false)
  }, [])

  // Load session info and connect to OpenCode
  useEffect(() => {
    let unsubscribe: (() => void) | null = null

    const initializeSession = async (): Promise<void> => {
      setViewState({ status: 'connecting' })

      try {
        // 1. Load messages from database
        const dbMessages = (await window.db.message.getBySession(sessionId)) as DbMessage[]
        const loadedMessages = dbMessages.map(dbMessageToOpenCode)
        setMessages(loadedMessages)

        // 2. Get session info to find worktree
        const session = (await window.db.session.get(sessionId)) as DbSession | null
        if (!session) {
          throw new Error('Session not found')
        }

        // 3. Get worktree path
        let wtPath: string | null = null
        if (session.worktree_id) {
          const worktree = (await window.db.worktree.get(session.worktree_id)) as DbWorktree | null
          if (worktree) {
            wtPath = worktree.path
            setWorktreePath(wtPath)
          }
        }

        if (!wtPath) {
          // No worktree - just show messages without OpenCode
          console.warn('No worktree path for session, OpenCode disabled')
          setViewState({ status: 'connected' })
          return
        }

        // 4. Subscribe to OpenCode stream events
        unsubscribe = window.opencodeOps.onStream((event) => {
          // Only handle events for this session
          if (event.sessionId !== sessionId) return

          console.log('OpenCode stream event:', event.type, event.data)

          // Log event if response logging is active
          if (isLogModeRef.current && logFilePathRef.current) {
            try {
              if (event.type === 'message.part.updated') {
                window.loggingOps.appendResponseLog(logFilePathRef.current, {
                  type: 'part_updated',
                  event: event.data
                })
              } else if (event.type === 'message.updated') {
                window.loggingOps.appendResponseLog(logFilePathRef.current, {
                  type: 'message_updated',
                  event: event.data
                })
              } else if (event.type === 'session.idle') {
                window.loggingOps.appendResponseLog(logFilePathRef.current, {
                  type: 'session_idle'
                })
              }
            } catch {
              // Never let logging failures break the UI
            }
          }

          // Handle different event types
          if (event.type === 'message.part.updated') {
            const part = event.data?.part
            if (!part) return

            if (part.type === 'text') {
              // Update streaming text content with delta or full text
              const delta = event.data?.delta
              if (delta) {
                appendTextDelta(delta)
              } else if (part.text) {
                setTextContent(part.text)
              }
              setIsStreaming(true)
            } else if (part.type === 'tool') {
              // Tool part from OpenCode SDK - has callID, tool (name), state
              const toolId = part.callID || part.id || `tool-${Date.now()}`
              const toolName = part.tool || 'Unknown'
              const state = part.state || {}

              const statusMap: Record<string, ToolStatus> = {
                pending: 'pending',
                running: 'running',
                completed: 'success',
                error: 'error'
              }

              upsertToolUse(toolId, {
                name: toolName,
                input: state.input || {},
                status: statusMap[state.status] || 'running',
                startTime: state.time?.start || Date.now(),
                endTime: state.time?.end,
                output: state.status === 'completed' ? state.output : undefined,
                error: state.status === 'error' ? state.error : undefined
              })
              setIsStreaming(true)
            }
          } else if (event.type === 'message.updated') {
            const info = event.data?.info
            if (info?.role === 'assistant' && info.time?.completed) {
              // Message complete — flush any pending throttled updates, then save
              immediateFlush()
              const finalContent = streamingContentRef.current || ''
              const finalParts = [...streamingPartsRef.current]
              if (finalContent || finalParts.length > 0) {
                saveAssistantMessage(finalContent, finalParts)
              }
              setIsSending(false)
            }
          } else if (event.type === 'session.idle') {
            // Session finished processing — flush any pending throttled updates
            immediateFlush()
            setIsSending(false)
            // If there's remaining streaming content, save it
            if (streamingContentRef.current || streamingPartsRef.current.length > 0) {
              saveAssistantMessage(
                streamingContentRef.current,
                [...streamingPartsRef.current]
              )
            }
          }
        })

        // 5. Connect to OpenCode
        const existingOpcSessionId = session.opencode_session_id

        if (existingOpcSessionId) {
          // Try to reconnect to existing session
          const reconnectResult = await window.opencodeOps.reconnect(
            wtPath,
            existingOpcSessionId,
            sessionId
          )
          if (reconnectResult.success) {
            setOpencodeSessionId(existingOpcSessionId)
            // Create response log file if logging is enabled
            if (isLogModeRef.current) {
              try {
                const logPath = await window.loggingOps.createResponseLog(sessionId)
                logFilePathRef.current = logPath
              } catch (e) {
                console.warn('Failed to create response log:', e)
              }
            }
            setViewState({ status: 'connected' })
            return
          }
        }

        // Create new OpenCode session
        const connectResult = await window.opencodeOps.connect(wtPath, sessionId)
        if (connectResult.success && connectResult.sessionId) {
          setOpencodeSessionId(connectResult.sessionId)
          // Store the OpenCode session ID in database for future reconnection
          await window.db.session.update(sessionId, {
            opencode_session_id: connectResult.sessionId
          })
          // Create response log file if logging is enabled
          if (isLogModeRef.current) {
            try {
              const logPath = await window.loggingOps.createResponseLog(sessionId)
              logFilePathRef.current = logPath
            } catch (e) {
              console.warn('Failed to create response log:', e)
            }
          }
          setViewState({ status: 'connected' })
        } else {
          throw new Error(connectResult.error || 'Failed to connect to OpenCode')
        }
      } catch (error) {
        console.error('Failed to initialize session:', error)
        setViewState({
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Failed to connect to session'
        })
      }
    }

    // Helper to save assistant message to database
    // Resets streaming state AFTER the message is saved and added to messages[],
    // ensuring the streaming content stays visible until the saved message replaces it.
    const saveAssistantMessage = async (content: string, parts?: StreamingPart[]): Promise<void> => {
      try {
        const savedMessage = (await window.db.message.create({
          session_id: sessionId,
          role: 'assistant' as const,
          content
        })) as DbMessage

        const message: OpenCodeMessage = {
          ...dbMessageToOpenCode(savedMessage),
          parts
        }
        setMessages((prev) => [...prev, message])
        resetStreamingState()
      } catch (error) {
        console.error('Failed to save assistant message:', error)
        toast.error('Failed to save response')
      }
    }

    initializeSession()

    // Cleanup on unmount or session change
    return () => {
      if (unsubscribe) {
        unsubscribe()
      }
      // Disconnect from OpenCode if connected
      if (worktreePath && opencodeSessionId) {
        window.opencodeOps.disconnect(worktreePath, opencodeSessionId).catch(console.error)
      }
    }
    // Note: We intentionally don't include worktreePath and opencodeSessionId
    // in deps to avoid reconnection loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Handle retry connection
  const handleRetry = useCallback(async () => {
    setViewState({ status: 'connecting' })
    setOpencodeSessionId(null)
    setWorktreePath(null)

    try {
      const dbMessages = (await window.db.message.getBySession(sessionId)) as DbMessage[]
      const loadedMessages = dbMessages.map(dbMessageToOpenCode)
      setMessages(loadedMessages)

      const session = (await window.db.session.get(sessionId)) as DbSession | null
      if (!session?.worktree_id) {
        setViewState({ status: 'connected' })
        return
      }

      const worktree = (await window.db.worktree.get(session.worktree_id)) as DbWorktree | null
      if (!worktree) {
        setViewState({ status: 'connected' })
        return
      }

      setWorktreePath(worktree.path)

      const connectResult = await window.opencodeOps.connect(worktree.path, sessionId)
      if (connectResult.success && connectResult.sessionId) {
        setOpencodeSessionId(connectResult.sessionId)
        await window.db.session.update(sessionId, {
          opencode_session_id: connectResult.sessionId
        })
        setViewState({ status: 'connected' })
      } else {
        throw new Error(connectResult.error || 'Failed to connect')
      }
    } catch (error) {
      console.error('Retry failed:', error)
      setViewState({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to connect'
      })
    }
  }, [sessionId])

  // Handle send message
  const handleSend = useCallback(async () => {
    const trimmedValue = inputValue.trim()
    if (!trimmedValue || isSending) return

    setIsSending(true)
    setInputValue('')

    try {
      // Save user message to database
      const savedUserMessage = (await window.db.message.create({
        session_id: sessionId,
        role: 'user' as const,
        content: trimmedValue
      })) as DbMessage

      const userMessage = dbMessageToOpenCode(savedUserMessage)
      setMessages((prev) => [...prev, userMessage])

      // Log user prompt if response logging is active
      if (isLogModeRef.current && logFilePathRef.current) {
        try {
          const currentMode = useSessionStore.getState().getSessionMode(sessionId)
          window.loggingOps.appendResponseLog(logFilePathRef.current, {
            type: 'user_prompt',
            content: trimmedValue,
            mode: currentMode
          })
        } catch {
          // Never let logging failures break the UI
        }
      }

      // Send to OpenCode if connected
      if (worktreePath && opencodeSessionId) {
        // Prepend mode context to the prompt
        const currentMode = useSessionStore.getState().getSessionMode(sessionId)
        const modePrefix = currentMode === 'plan'
          ? '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'
          : ''
        const promptMessage = modePrefix + trimmedValue
        const result = await window.opencodeOps.prompt(worktreePath, opencodeSessionId, promptMessage)
        if (!result.success) {
          console.error('Failed to send prompt to OpenCode:', result.error)
          toast.error('Failed to send message to AI')
          setIsSending(false)
        }
        // Don't set isSending to false here - wait for streaming to complete
      } else {
        // No OpenCode connection - show placeholder
        console.warn('No OpenCode connection, showing placeholder response')
        setTimeout(async () => {
          try {
            const placeholderContent =
              'OpenCode is not connected. Please ensure a worktree is selected and the connection is established.'
            const savedAssistantMessage = (await window.db.message.create({
              session_id: sessionId,
              role: 'assistant' as const,
              content: placeholderContent
            })) as DbMessage

            const assistantMessage = dbMessageToOpenCode(savedAssistantMessage)
            setMessages((prev) => [...prev, assistantMessage])
          } catch (error) {
            console.error('Failed to save placeholder message:', error)
          }
          setIsSending(false)
        }, 500)
      }
    } catch (error) {
      console.error('Failed to send message:', error)
      toast.error('Failed to send message')
      setIsSending(false)
    }
  }, [inputValue, isSending, sessionId, worktreePath, opencodeSessionId])

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  // Determine if there's streaming content to show
  const hasStreamingContent = streamingParts.length > 0 || streamingContent.length > 0

  // Render based on view state
  if (viewState.status === 'connecting') {
    return (
      <div className="flex-1 flex flex-col" data-testid="session-view" data-session-id={sessionId}>
        <LoadingState />
      </div>
    )
  }

  if (viewState.status === 'error') {
    return (
      <div className="flex-1 flex flex-col" data-testid="session-view" data-session-id={sessionId}>
        <ErrorState
          message={viewState.errorMessage || 'Failed to connect to session'}
          onRetry={handleRetry}
        />
      </div>
    )
  }

  return (
    <div
      className="flex-1 flex flex-col min-h-0"
      data-testid="session-view"
      data-session-id={sessionId}
    >
      {/* Message list */}
      <div className="flex-1 overflow-y-auto" data-testid="message-list">
        {messages.length === 0 && !hasStreamingContent ? (
          <div className="flex-1 flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <p className="text-lg font-medium">Start a conversation</p>
              <p className="text-sm mt-1">Type a message below to begin</p>
              {!opencodeSessionId && worktreePath && (
                <p className="text-xs mt-2 text-yellow-500">Connecting to OpenCode...</p>
              )}
              {!worktreePath && (
                <p className="text-xs mt-2 text-yellow-500">No worktree selected</p>
              )}
            </div>
          </div>
        ) : (
          <div className="py-4">
            {messages.map((message) => (
              <MessageRenderer
                key={message.id}
                message={message}
              />
            ))}
            {/* Streaming message */}
            {hasStreamingContent && (
              <MessageRenderer
                message={{
                  id: 'streaming',
                  role: 'assistant',
                  content: streamingContent,
                  timestamp: new Date().toISOString(),
                  parts: streamingParts
                }}
                isStreaming={isStreaming}
              />
            )}
            {/* Typing indicator when waiting for response */}
            {isSending && !hasStreamingContent && (
              <div className="px-6 py-5" data-testid="typing-indicator">
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
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="p-4 bg-background" data-testid="input-area" role="form" aria-label="Message input">
        <div
          className={cn(
            'max-w-3xl mx-auto rounded-xl border-2 transition-colors duration-200 overflow-hidden',
            mode === 'build'
              ? 'border-blue-500/50 bg-blue-500/5'
              : 'border-violet-500/50 bg-violet-500/5'
          )}
        >
          {/* Top row: mode toggle */}
          <div className="px-3 pt-2.5 pb-1">
            <ModeToggle sessionId={sessionId} />
          </div>

          {/* Middle: textarea */}
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message..."
            aria-label="Message input"
            className={cn(
              'w-full resize-none bg-transparent px-3 py-2',
              'text-sm placeholder:text-muted-foreground',
              'focus:outline-none border-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'min-h-[40px] max-h-[200px]'
            )}
            rows={1}
            disabled={isSending}
            data-testid="message-input"
          />

          {/* Bottom row: model selector + hint text + send button */}
          <div className="flex items-center justify-between px-3 pb-2.5">
            <div className="flex items-center gap-2">
              <ModelSelector />
              <span className="text-xs text-muted-foreground">
                Enter to send, Shift+Enter for new line
              </span>
            </div>
            <Button
              onClick={handleSend}
              disabled={!inputValue.trim() || isSending}
              size="sm"
              className="h-7 w-7 p-0"
              aria-label={isSending ? 'Sending message' : 'Send message'}
              data-testid="send-button"
            >
              {isSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
