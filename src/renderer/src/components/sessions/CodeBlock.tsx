import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

interface CodeBlockProps {
  code: string
  language?: string
}

export function CodeBlock({ code, language = 'typescript' }: CodeBlockProps): React.JSX.Element {
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
