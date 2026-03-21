import { useState, useCallback } from 'react'
import { Shield, Terminal, FileEdit, Eye, Search, Globe, CheckCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { splitBashCommand, getSubPatterns, patternMatches } from '@/lib/permissionUtils'
import { useSettingsStore } from '@/stores/useSettingsStore'

interface PermissionPromptProps {
  request: PermissionRequest
  onReply: (requestId: string, reply: 'once' | 'always' | 'reject', message?: string) => void
}

function getPermissionDisplay(permission: string): {
  icon: React.ElementType
  label: string
  color: string
} {
  switch (permission) {
    case 'bash':
      return { icon: Terminal, label: 'Run Command', color: 'text-orange-400' }
    case 'edit':
      return { icon: FileEdit, label: 'Edit File', color: 'text-yellow-400' }
    case 'read':
      return { icon: Eye, label: 'Read File', color: 'text-blue-400' }
    case 'glob':
    case 'grep':
    case 'list':
      return { icon: Search, label: 'Search Files', color: 'text-blue-400' }
    case 'webfetch':
    case 'websearch':
      return { icon: Globe, label: 'Web Access', color: 'text-purple-400' }
    case 'external_directory':
      return { icon: Shield, label: 'External Directory', color: 'text-red-400' }
    case 'task':
      return { icon: Shield, label: 'Run Sub-task', color: 'text-cyan-400' }
    default:
      return { icon: Shield, label: permission, color: 'text-yellow-400' }
  }
}

/**
 * Render a bash command pattern, splitting on && / || / ; into labelled sub-rows.
 * Sub-commands already approved in commandFilter.allowlist get a green checkmark indicator.
 */
function BashPatternView({
  pattern,
  commandFilterAllowlist
}: {
  pattern: string
  commandFilterAllowlist: string[]
}) {
  const parts = splitBashCommand(pattern)

  const isSubApproved = (sub: string): boolean => {
    const prefixed = `bash: ${sub}`
    return commandFilterAllowlist.some((a) => patternMatches(prefixed, a))
  }

  if (parts.length <= 1) {
    // Single command — plain display
    const single = parts[0] ?? pattern
    return (
      <div className="flex items-start gap-1.5">
        <div className="text-xs font-mono px-2 py-1.5 rounded bg-muted/50 text-foreground break-all flex-1">
          {single}
        </div>
        {isSubApproved(single) && (
          <CheckCircle className="h-3.5 w-3.5 text-green-500 mt-1.5 shrink-0" />
        )}
      </div>
    )
  }

  // Determine the separator tokens from original string
  const separators: string[] = []
  let remainder = pattern
  for (let i = 0; i < parts.length - 1; i++) {
    const after = remainder.slice(parts[i].length)
    const m = after.match(/^\s*(&&|\|\||;)\s*/)
    separators.push(m ? m[1] : '&&')
    remainder = after.slice(m ? m[0].length : 4)
  }

  return (
    <div className="space-y-0.5">
      {parts.map((part, idx) => (
        <div key={idx}>
          <div className="flex items-start gap-1.5">
            <div className="text-xs font-mono px-2 py-1.5 rounded bg-muted/50 text-foreground break-all flex-1">
              {part}
            </div>
            {isSubApproved(part) && (
              <CheckCircle className="h-3.5 w-3.5 text-green-500 mt-1.5 shrink-0" />
            )}
          </div>
          {idx < parts.length - 1 && (
            <div className="flex items-center gap-1 px-2 py-0.5">
              <div className="h-px flex-1 bg-border/50" />
              <span className="text-[10px] font-mono text-muted-foreground/60 px-1">
                {separators[idx]}
              </span>
              <div className="h-px flex-1 bg-border/50" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function PermissionPrompt({ request, onReply }: PermissionPromptProps) {
  const [sending, setSending] = useState(false)
  const { commandFilter, updateSetting } = useSettingsStore()

  const { icon: Icon, label, color } = getPermissionDisplay(request.permission)

  const handleAllow = useCallback(
    (type: 'once' | 'always') => {
      if (sending) return
      setSending(true)
      if (type === 'always') {
        // Save sub-patterns to the persistent commandFilter allowlist immediately
        // so that future identical or matching commands are auto-approved without UI
        const subPatterns = getSubPatterns(request) // already prefixed e.g. "bash: git add ."
        if (subPatterns.length > 0) {
          const current = commandFilter.allowlist
          const toAdd = subPatterns.filter((p) => !current.includes(p))
          if (toAdd.length > 0) {
            updateSetting('commandFilter', {
              ...commandFilter,
              allowlist: [...current, ...toAdd]
            })
          }
        }
      }
      onReply(request.id, type)
    },
    [sending, onReply, request, commandFilter, updateSetting]
  )

  const handleDeny = useCallback(() => {
    if (sending) return
    setSending(true)
    onReply(request.id, 'reject')
  }, [sending, onReply, request.id])

  return (
    <div
      className="rounded-md border border-border bg-zinc-900/50 overflow-hidden"
      data-testid="permission-prompt"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <Shield className={cn('h-4 w-4 shrink-0', color)} />
        <span className="text-xs font-medium text-foreground">Permission Required</span>
        <span className="text-xs text-muted-foreground">—</span>
        <Icon className={cn('h-3.5 w-3.5 shrink-0', color)} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>

      <div className="px-3 py-2.5">
        {/* Contextual info based on permission type */}
        <div className="mb-3">
          {request.patterns.length > 0 && (
            // Scrollable container: caps height so long patterns don't overflow the dialog
            <div className="max-h-40 overflow-y-auto space-y-1">
              {request.permission === 'bash'
                ? // Bash: split each pattern by && / || / ; with visual separators
                  request.patterns.map((pattern, i) => (
                    <BashPatternView
                      key={i}
                      pattern={pattern}
                      commandFilterAllowlist={commandFilter.allowlist}
                    />
                  ))
                : // Other permissions: plain pattern list
                  request.patterns.map((pattern, i) => (
                    <div
                      key={i}
                      className={cn(
                        'text-xs font-mono px-2 py-1.5 rounded',
                        'bg-muted/50 text-foreground',
                        'break-all'
                      )}
                    >
                      {pattern}
                    </div>
                  ))}
            </div>
          )}

          {/* Show diff for edit permissions */}
          {request.permission === 'edit' && Boolean(request.metadata?.diff) && (
            <pre className="text-xs font-mono mt-2 px-2 py-1.5 rounded bg-muted/50 text-foreground overflow-x-auto max-h-48 whitespace-pre-wrap">
              {String(request.metadata.diff)}
            </pre>
          )}

          {/* Show filepath for edit permissions when no patterns */}
          {request.permission === 'edit' &&
            Boolean(request.metadata?.filepath) &&
            !request.patterns.length && (
              <div className="text-xs font-mono px-2 py-1.5 rounded bg-muted/50 text-foreground break-all">
                {String(request.metadata.filepath)}
              </div>
            )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => handleAllow('once')}
            disabled={sending}
            data-testid="permission-allow-once"
          >
            {sending ? 'Sending...' : 'Allow once'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleAllow('always')}
            disabled={sending}
            title={
              request.always.length > 0
                ? `Always allow: ${request.always.join(', ')}`
                : 'Always allow this type of action'
            }
            data-testid="permission-allow-always"
          >
            Allow always
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDeny}
            disabled={sending}
            className="text-destructive hover:text-destructive"
            data-testid="permission-deny"
          >
            Deny
          </Button>
        </div>
      </div>
    </div>
  )
}
