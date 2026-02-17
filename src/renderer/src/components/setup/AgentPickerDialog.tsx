import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

interface AgentPickerDialogProps {
  onSelect: (sdk: 'opencode' | 'claude-code') => void
}

export function AgentPickerDialog({ onSelect }: AgentPickerDialogProps): React.JSX.Element {
  return (
    <AlertDialog open={true}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Bot className="size-5" />
            Choose Your AI Agent
          </AlertDialogTitle>
          <AlertDialogDescription>
            Both OpenCode and Claude Code are installed. Choose which one to use as the default for
            new sessions. You can change this later in Settings.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex gap-3 pt-2">
          <button
            onClick={() => onSelect('opencode')}
            className={cn(
              'flex-1 px-4 py-3 rounded-lg border-2 border-border',
              'hover:border-primary hover:bg-accent/50 transition-colors',
              'text-center cursor-pointer'
            )}
          >
            <div className="text-sm font-medium">OpenCode</div>
            <div className="text-xs text-muted-foreground mt-1">Open-source AI coding agent</div>
          </button>
          <button
            onClick={() => onSelect('claude-code')}
            className={cn(
              'flex-1 px-4 py-3 rounded-lg border-2 border-border',
              'hover:border-primary hover:bg-accent/50 transition-colors',
              'text-center cursor-pointer'
            )}
          >
            <div className="text-sm font-medium">Claude Code</div>
            <div className="text-xs text-muted-foreground mt-1">
              Anthropic&apos;s coding assistant
            </div>
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
