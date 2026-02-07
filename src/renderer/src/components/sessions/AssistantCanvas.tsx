import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface AssistantCanvasProps {
  content: string
  timestamp: string
  isStreaming?: boolean
}

interface CodeBlockProps {
  code: string
  language?: string
}

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
      className="relative group my-4 rounded-lg overflow-hidden border border-border bg-zinc-900 dark:bg-zinc-950"
      data-testid="code-block"
    >
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
      <pre className="p-4 overflow-x-auto text-sm font-mono text-zinc-100">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function parseContent(content: string): React.JSX.Element {
  const parts: React.JSX.Element[] = []
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  let keyIndex = 0
  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index)
      parts.push(
        <span key={`text-${keyIndex++}`} className="whitespace-pre-wrap">
          {textBefore}
        </span>
      )
    }

    const language = match[1] || 'text'
    const code = match[2].trim()
    parts.push(<CodeBlock key={`code-${keyIndex++}`} code={code} language={language} />)

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < content.length) {
    parts.push(
      <span key={`text-${keyIndex++}`} className="whitespace-pre-wrap">
        {content.slice(lastIndex)}
      </span>
    )
  }

  return <>{parts}</>
}

export function AssistantCanvas({
  content,
  timestamp,
  isStreaming = false
}: AssistantCanvasProps): React.JSX.Element {
  return (
    <div className="px-6 py-5" data-testid="message-assistant">
      <div className="text-sm text-foreground leading-relaxed">
        {parseContent(content)}
        {isStreaming && (
          <span className="inline-block w-2 h-4 bg-foreground/70 animate-pulse ml-0.5 rounded-sm" />
        )}
      </div>
      <span className="block text-[10px] text-muted-foreground mt-2">
        {new Date(timestamp).toLocaleTimeString()}
        {isStreaming && <span className="ml-2 text-blue-500 animate-pulse">Streaming...</span>}
      </span>
    </div>
  )
}
