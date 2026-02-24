import { useState, useCallback } from 'react'
import {
  Shield,
  Terminal,
  FileEdit,
  Eye,
  Search,
  Globe,
  Zap,
  FileCode,
  FileDown,
  ChevronDown,
  Check
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { CommandApprovalRequest } from '@/stores/useCommandApprovalStore'

interface CommandApprovalPromptProps {
  request: CommandApprovalRequest
  onReply: (
    requestId: string,
    approved: boolean,
    remember?: 'allow' | 'block',
    pattern?: string
  ) => void
}

function getToolDisplay(toolName: string): {
  icon: React.ElementType
  label: string
  color: string
} {
  const tool = toolName.toLowerCase()
  switch (tool) {
    case 'bash':
      return { icon: Terminal, label: 'Execute Command', color: 'text-orange-400' }
    case 'edit':
      return { icon: FileEdit, label: 'Edit File', color: 'text-yellow-400' }
    case 'write':
      return { icon: FileDown, label: 'Write File', color: 'text-yellow-400' }
    case 'read':
      return { icon: Eye, label: 'Read File', color: 'text-blue-400' }
    case 'glob':
    case 'grep':
      return { icon: Search, label: 'Search Files', color: 'text-blue-400' }
    case 'webfetch':
    case 'websearch':
      return { icon: Globe, label: 'Web Access', color: 'text-purple-400' }
    case 'task':
      return { icon: Zap, label: 'Run Sub-task', color: 'text-cyan-400' }
    case 'skill':
      return { icon: FileCode, label: 'Execute Skill', color: 'text-green-400' }
    case 'notebookedit':
      return { icon: FileEdit, label: 'Edit Notebook', color: 'text-yellow-400' }
    default:
      return { icon: Shield, label: toolName, color: 'text-yellow-400' }
  }
}

export function CommandApprovalPrompt({ request, onReply }: CommandApprovalPromptProps) {
  const [sending, setSending] = useState(false)
  const [patternPickerMode, setPatternPickerMode] = useState<'allow' | 'block' | null>(null)
  const [selectedPattern, setSelectedPattern] = useState<string>(
    request.patternSuggestions?.[0] || request.commandStr
  )

  const { icon: Icon, label, color } = getToolDisplay(request.toolName)

  const suggestions = request.patternSuggestions || [request.commandStr]

  const handleAllow = useCallback(() => {
    if (sending) return
    setSending(true)
    onReply(request.id, true)
  }, [sending, onReply, request.id])

  const handleDeny = useCallback(() => {
    if (sending) return
    setSending(true)
    onReply(request.id, false)
  }, [sending, onReply, request.id])

  const handleConfirmPattern = useCallback(() => {
    if (sending || !patternPickerMode) return
    setSending(true)
    if (patternPickerMode === 'allow') {
      onReply(request.id, true, 'allow', selectedPattern)
    } else {
      onReply(request.id, false, 'block', selectedPattern)
    }
  }, [sending, patternPickerMode, onReply, request.id, selectedPattern])

  const handleCancelPicker = useCallback(() => {
    setPatternPickerMode(null)
  }, [])

  return (
    <div
      className="rounded-md border border-border bg-zinc-900/50 overflow-hidden"
      data-testid="command-approval-prompt"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <Shield className={cn('h-4 w-4 shrink-0', color)} />
        <span className="text-xs font-medium text-foreground">Command Approval Required</span>
        <span className="text-xs text-muted-foreground">—</span>
        <Icon className={cn('h-3.5 w-3.5 shrink-0', color)} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>

      <div className="px-3 py-2.5">
        {/* Command display */}
        <div className="mb-3">
          <div className="text-xs font-semibold mb-1 text-muted-foreground">
            Tool: {request.toolName}
          </div>
          <div
            className={cn(
              'text-xs font-mono px-2 py-1.5 rounded',
              'bg-muted/50 text-foreground',
              'break-all max-h-32 overflow-y-auto'
            )}
          >
            {request.commandStr}
          </div>
        </div>

        {/* Pattern picker (shown when Allow always / Block always clicked) */}
        {patternPickerMode && (
          <div className="mb-3 rounded-md border border-border bg-muted/20 p-2.5">
            <div className="text-xs font-medium mb-2 text-foreground">
              {patternPickerMode === 'allow'
                ? 'Choose pattern to always allow:'
                : 'Choose pattern to always block:'}
            </div>
            <div className="space-y-1">
              {suggestions.map((pattern) => (
                <button
                  key={pattern}
                  onClick={() => setSelectedPattern(pattern)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs font-mono transition-colors',
                    selectedPattern === pattern
                      ? 'bg-primary/20 border border-primary/40 text-foreground'
                      : 'bg-muted/30 border border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  <Check
                    className={cn(
                      'h-3 w-3 shrink-0',
                      selectedPattern === pattern ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="break-all">{pattern}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2.5">
              <Button
                size="sm"
                onClick={handleConfirmPattern}
                disabled={sending}
                className={cn(
                  patternPickerMode === 'block' &&
                    'bg-destructive hover:bg-destructive/90 text-destructive-foreground'
                )}
                data-testid="confirm-pattern"
              >
                {sending
                  ? 'Saving...'
                  : patternPickerMode === 'allow'
                    ? 'Allow always'
                    : 'Block always'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancelPicker}
                disabled={sending}
                data-testid="cancel-pattern"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Action buttons */}
        {!patternPickerMode && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              onClick={handleAllow}
              disabled={sending}
              data-testid="command-approve-once"
            >
              {sending ? 'Sending...' : 'Allow once'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                suggestions.length > 1
                  ? setPatternPickerMode('allow')
                  : (() => {
                      setSending(true)
                      onReply(request.id, true, 'allow', suggestions[0])
                    })()
              }
              disabled={sending}
              title="Always allow this command pattern"
              data-testid="command-approve-always"
            >
              Allow always
              {suggestions.length > 1 && <ChevronDown className="h-3 w-3 ml-1" />}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                suggestions.length > 1
                  ? setPatternPickerMode('block')
                  : (() => {
                      setSending(true)
                      onReply(request.id, false, 'block', suggestions[0])
                    })()
              }
              disabled={sending}
              className="text-destructive hover:text-destructive"
              title="Always block this command pattern"
              data-testid="command-block-always"
            >
              Block always
              {suggestions.length > 1 && <ChevronDown className="h-3 w-3 ml-1" />}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDeny}
              disabled={sending}
              className="text-destructive hover:text-destructive"
              data-testid="command-deny"
            >
              Deny
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
