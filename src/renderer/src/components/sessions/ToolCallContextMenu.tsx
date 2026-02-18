import { useState } from 'react'
import { Bug } from 'lucide-react'
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

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
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
