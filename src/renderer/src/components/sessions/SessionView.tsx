import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Loader2, AlertCircle, RefreshCw, Copy, Check, Bot, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

// Types for OpenCode SDK integration (Session 11)
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

interface MessageItemProps {
  message: OpenCodeMessage
}

interface CodeBlockProps {
  code: string
  language?: string
}

// Placeholder demo messages to demonstrate the layout
const DEMO_MESSAGES: OpenCodeMessage[] = [
  {
    id: 'demo-1',
    role: 'user',
    content: 'Can you help me create a function that calculates the factorial of a number?',
    timestamp: new Date(Date.now() - 60000).toISOString()
  },
  {
    id: 'demo-2',
    role: 'assistant',
    content: `I'll help you create a factorial function. Here's an implementation in TypeScript:

\`\`\`typescript
function factorial(n: number): number {
  if (n < 0) {
    throw new Error('Factorial is not defined for negative numbers')
  }
  if (n === 0 || n === 1) {
    return 1
  }
  return n * factorial(n - 1)
}

// Example usage:
console.log(factorial(5)) // Output: 120
console.log(factorial(0)) // Output: 1
\`\`\`

This function uses recursion to calculate the factorial. It handles edge cases like:
- Negative numbers (throws an error)
- Zero and one (returns 1)

Would you like me to also create an iterative version?`,
    timestamp: new Date(Date.now() - 30000).toISOString()
  },
  {
    id: 'demo-3',
    role: 'user',
    content: 'Yes, please show me the iterative version too.',
    timestamp: new Date(Date.now() - 15000).toISOString()
  },
  {
    id: 'demo-4',
    role: 'assistant',
    content: `Here's the iterative version:

\`\`\`typescript
function factorialIterative(n: number): number {
  if (n < 0) {
    throw new Error('Factorial is not defined for negative numbers')
  }

  let result = 1
  for (let i = 2; i <= n; i++) {
    result *= i
  }
  return result
}
\`\`\`

The iterative version is often preferred because:
1. It avoids the risk of stack overflow for large numbers
2. It's slightly more memory-efficient
3. It's easier to understand for some developers

Both versions have the same time complexity of O(n).`,
    timestamp: new Date().toISOString()
  }
]

// Code block component with copy functionality and syntax highlighting placeholder
function CodeBlock({ code, language = 'typescript' }: CodeBlockProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      toast.success('Code copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy code')
    }
  }

  return (
    <div
      className="relative group my-3 rounded-lg overflow-hidden border border-border bg-zinc-900 dark:bg-zinc-950"
      data-testid="code-block"
    >
      {/* Header with language label and copy button */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-zinc-800 dark:bg-zinc-900">
        <span className="text-xs font-medium text-muted-foreground uppercase">{language}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-7 px-2 opacity-0 group-hover:opacity-100 transition-opacity"
          data-testid="copy-code-button"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {/* Code content - placeholder for syntax highlighting (Session 11) */}
      <pre className="p-4 overflow-x-auto text-sm font-mono text-zinc-100">
        <code>{code}</code>
      </pre>
    </div>
  )
}

// Parse message content for code blocks
function parseContent(content: string): React.JSX.Element {
  const parts: React.JSX.Element[] = []
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  let keyIndex = 0
  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Add text before code block
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index)
      parts.push(
        <span key={`text-${keyIndex++}`} className="whitespace-pre-wrap">
          {textBefore}
        </span>
      )
    }

    // Add code block
    const language = match[1] || 'text'
    const code = match[2].trim()
    parts.push(<CodeBlock key={`code-${keyIndex++}`} code={code} language={language} />)

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < content.length) {
    parts.push(
      <span key={`text-${keyIndex++}`} className="whitespace-pre-wrap">
        {content.slice(lastIndex)}
      </span>
    )
  }

  return <>{parts}</>
}

// Individual message component
function MessageItem({ message }: MessageItemProps): React.JSX.Element {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  return (
    <div
      className={cn(
        'flex gap-3 px-4 py-4',
        isUser && 'bg-muted/30',
        isSystem && 'bg-yellow-500/10'
      )}
      data-testid={`message-${message.role}`}
      data-message-id={message.id}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'
        )}
      >
        {isUser ? (
          <User className="h-4 w-4" />
        ) : (
          <Bot className="h-4 w-4" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium">
            {isUser ? 'You' : isSystem ? 'System' : 'Assistant'}
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>
        <div className="text-sm text-foreground leading-relaxed">
          {parseContent(message.content)}
        </div>
      </div>
    </div>
  )
}

// Loading state component
function LoadingState(): React.JSX.Element {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-4"
      data-testid="loading-state"
    >
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
    <div
      className="flex-1 flex flex-col items-center justify-center gap-4"
      data-testid="error-state"
    >
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
  const [messages, setMessages] = useState<OpenCodeMessage[]>(DEMO_MESSAGES)
  const [inputValue, setInputValue] = useState('')
  const [viewState, setViewState] = useState<SessionViewState>({ status: 'connected' })
  const [isSending, setIsSending] = useState(false)

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [inputValue])

  // Load messages when session changes (placeholder - will be implemented in Session 11)
  useEffect(() => {
    // Reset to demo messages for now
    // In Session 11, this will load actual messages from OpenCode
    setMessages(DEMO_MESSAGES)
    setViewState({ status: 'connected' })
  }, [sessionId])

  // Handle retry connection
  const handleRetry = useCallback(() => {
    setViewState({ status: 'connecting' })
    // Simulate connection attempt (will be real in Session 11)
    setTimeout(() => {
      setViewState({ status: 'connected' })
      setMessages(DEMO_MESSAGES)
    }, 1500)
  }, [])

  // Handle send message (placeholder for Session 11)
  const handleSend = useCallback(async () => {
    const trimmedValue = inputValue.trim()
    if (!trimmedValue || isSending) return

    setIsSending(true)

    // Create a new user message
    const newMessage: OpenCodeMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmedValue,
      timestamp: new Date().toISOString()
    }

    setMessages((prev) => [...prev, newMessage])
    setInputValue('')

    // Simulate assistant response (placeholder for Session 11)
    setTimeout(() => {
      const assistantMessage: OpenCodeMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content:
          'This is a placeholder response. In Session 11, this will be replaced with real OpenCode integration.',
        timestamp: new Date().toISOString()
      }
      setMessages((prev) => [...prev, assistantMessage])
      setIsSending(false)
    }, 1000)
  }, [inputValue, isSending])

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Send on Enter (without Shift)
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
      {/* Message list - scrollable */}
      <div className="flex-1 overflow-y-auto" data-testid="message-list">
        {messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <Bot className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-sm font-medium">Start a conversation</p>
              <p className="text-xs mt-1">Type a message below to begin</p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <MessageItem key={message.id} message={message} />
            ))}
            {isSending && (
              <div className="flex gap-3 px-4 py-4" data-testid="typing-indicator">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" />
                  <span
                    className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"
                    style={{ animationDelay: '0.1s' }}
                  />
                  <span
                    className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"
                    style={{ animationDelay: '0.2s' }}
                  />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-border p-4 bg-background" data-testid="input-area">
        <div className="flex gap-2 items-end">
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
            {isSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
