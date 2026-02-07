import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { MessageRenderer } from './MessageRenderer'

// Types for OpenCode SDK integration
export interface OpenCodeMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
}

export interface SessionViewState {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  errorMessage?: string
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

  // OpenCode state
  const [worktreePath, setWorktreePath] = useState<string | null>(null)
  const [opencodeSessionId, setOpencodeSessionId] = useState<string | null>(null)
  const [streamingContent, setStreamingContent] = useState<string>('')
  const [isStreaming, setIsStreaming] = useState(false)

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const streamingContentRef = useRef<string>('')

  // Auto-scroll to bottom when new messages arrive or streaming updates
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingContent, scrollToBottom])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [inputValue])

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

          // Handle different event types
          if (event.type === 'message.part.updated') {
            const part = event.data?.part
            if (part?.type === 'text') {
              // Update streaming content with delta or full text
              const delta = event.data?.delta
              if (delta) {
                streamingContentRef.current += delta
                setStreamingContent(streamingContentRef.current)
              } else if (part.text) {
                streamingContentRef.current = part.text
                setStreamingContent(part.text)
              }
              setIsStreaming(true)
            }
          } else if (event.type === 'message.updated') {
            const info = event.data?.info
            if (info?.role === 'assistant' && info.time?.completed) {
              // Message complete - save to database and update UI
              const finalContent = streamingContentRef.current || ''
              if (finalContent) {
                saveAssistantMessage(finalContent)
              }
              // Reset streaming state
              streamingContentRef.current = ''
              setStreamingContent('')
              setIsStreaming(false)
              setIsSending(false)
            }
          } else if (event.type === 'session.idle') {
            // Session finished processing
            setIsSending(false)
            // If there's remaining streaming content, save it
            if (streamingContentRef.current) {
              saveAssistantMessage(streamingContentRef.current)
              streamingContentRef.current = ''
              setStreamingContent('')
              setIsStreaming(false)
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
    const saveAssistantMessage = async (content: string): Promise<void> => {
      try {
        const savedMessage = (await window.db.message.create({
          session_id: sessionId,
          role: 'assistant' as const,
          content
        })) as DbMessage

        const message = dbMessageToOpenCode(savedMessage)
        setMessages((prev) => [...prev, message])
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

      // Send to OpenCode if connected
      if (worktreePath && opencodeSessionId) {
        const result = await window.opencodeOps.prompt(worktreePath, opencodeSessionId, trimmedValue)
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
        {messages.length === 0 && !streamingContent ? (
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
              <MessageRenderer key={message.id} message={message} />
            ))}
            {/* Streaming message */}
            {streamingContent && (
              <MessageRenderer
                message={{
                  id: 'streaming',
                  role: 'assistant',
                  content: streamingContent,
                  timestamp: new Date().toISOString()
                }}
                isStreaming={isStreaming}
              />
            )}
            {/* Typing indicator when waiting for response */}
            {isSending && !streamingContent && (
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
      <div className="border-t border-border p-4 bg-background" data-testid="input-area">
        <div className="flex gap-2 items-end max-w-3xl mx-auto">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
            className={cn(
              'flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2',
              'text-sm placeholder:text-muted-foreground',
              'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'min-h-[40px] max-h-[200px]'
            )}
            rows={1}
            disabled={isSending}
            data-testid="message-input"
          />
          <Button
            onClick={handleSend}
            disabled={!inputValue.trim() || isSending}
            className="h-10"
            data-testid="send-button"
          >
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2 max-w-3xl mx-auto">
          Press Enter to send, Shift+Enter for new line
          {opencodeSessionId && (
            <span className="ml-2 text-green-500">Connected to OpenCode</span>
          )}
        </p>
      </div>
    </div>
  )
}
