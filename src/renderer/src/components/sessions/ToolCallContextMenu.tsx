import { useState } from 'react'
import { Bug, Copy } from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem
} from '@/components/ui/context-menu'
import { useSessionStore } from '@/stores/useSessionStore'
import { ToolCallDebugModal } from './ToolCallDebugModal'
import type { ToolUseInfo } from './ToolCard'

interface ToolCallContextMenuProps {
  children: React.ReactNode
  toolUse: ToolUseInfo
}

export function ToolCallContextMenu({ children, toolUse }: ToolCallContextMenuProps) {
  const [debugOpen, setDebugOpen] = useState(false)

  const isExitPlanMode = toolUse.name.toLowerCase() === 'exitplanmode'

  // Mirror the fallback in ToolCard.tsx: when the ExitPlanMode tool's input.plan
  // hasn't streamed in yet, the plan content may live in the pendingPlans store
  // (set by the plan.ready event). Only subscribe when this is an ExitPlanMode
  // card to avoid re-rendering every other tool card on store changes.
  const pendingPlanContent = useSessionStore((state) => {
    if (!isExitPlanMode) return ''
    const inputPlan = (toolUse.input?.plan as string | undefined) ?? ''
    if (inputPlan) return ''
    for (const [, plan] of state.pendingPlans) {
      if (plan.toolUseID === toolUse.id && plan.planContent) {
        return plan.planContent
      }
    }
    return ''
  })

  const handleCopyPlan = async () => {
    const planContent = ((toolUse.input?.plan as string | undefined) || pendingPlanContent || '').trim()
    if (!planContent) {
      toast.error('No plan content to copy')
      return
    }

    try {
      await navigator.clipboard.writeText(planContent)
      toast.success('Plan copied to clipboard')
    } catch {
      toast.error('Failed to copy')
    }
  }

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
          {isExitPlanMode && (
            <ContextMenuItem
              onClick={handleCopyPlan}
              className="gap-2"
              data-testid="context-menu-copy-plan"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy plan
            </ContextMenuItem>
          )}
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
