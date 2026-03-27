import { useState } from 'react'
import { Bug, Copy } from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem
} from '@/components/ui/context-menu'
import { ToolCallDebugModal } from './ToolCallDebugModal'
import type { ToolUseInfo } from './ToolCard'

interface ToolCallContextMenuProps {
  children: React.ReactNode
  toolUse: ToolUseInfo
}

export function ToolCallContextMenu({ children, toolUse }: ToolCallContextMenuProps) {
  const [debugOpen, setDebugOpen] = useState(false)

  const handleCopyCommand = async () => {
    let textToCopy = ''

    // Extract command/pattern based on tool type
    const lowerName = toolUse.name.toLowerCase()
    const isTodoWrite = lowerName.includes('todowrite') || lowerName.includes('todo_write')

    if (lowerName.includes('bash') || lowerName.includes('shell') || lowerName.includes('exec')) {
      textToCopy = (toolUse.input.command || toolUse.input.cmd || '') as string
    } else if (lowerName.includes('grep') || lowerName.includes('search')) {
      textToCopy = (toolUse.input.pattern ||
        toolUse.input.query ||
        toolUse.input.regex ||
        '') as string
    } else if (lowerName.includes('glob') || lowerName.includes('find')) {
      textToCopy = (toolUse.input.pattern || toolUse.input.glob || '') as string
    } else if (
      !isTodoWrite &&
      (lowerName.includes('read') || lowerName.includes('write') || lowerName.includes('edit'))
    ) {
      textToCopy = (toolUse.input.filePath ||
        toolUse.input.file_path ||
        toolUse.input.path ||
        '') as string
    } else if (lowerName === 'webfetch' || lowerName === 'web_fetch') {
      textToCopy = (toolUse.input.url || '') as string
    } else {
      // Fallback: copy entire input as JSON
      textToCopy = JSON.stringify(toolUse.input, null, 2)
    }

    if (!textToCopy.trim()) {
      toast.error('Nothing to copy')
      return
    }

    try {
      await navigator.clipboard.writeText(textToCopy)
      toast.success('Copied to clipboard')
    } catch {
      toast.error('Failed to copy')
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleCopyCommand} className="gap-2">
            <Copy className="h-3.5 w-3.5" />
            Copy Details
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setDebugOpen(true)} className="gap-2">
            <Bug className="h-3.5 w-3.5" />
            Inspect Tool Call
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ToolCallDebugModal open={debugOpen} onOpenChange={setDebugOpen} toolUse={toolUse} />
    </>
  )
}
