import { useState, useCallback, useMemo } from 'react'
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
import { useSettingsStore } from '@/stores/useSettingsStore'
import { patternMatches } from '@/lib/permissionUtils'
import type {
  CommandApprovalRequest,
  SubCommandSuggestions
} from '@/stores/useCommandApprovalStore'

interface CommandApprovalPromptProps {
  request: CommandApprovalRequest
  onReply: (
    requestId: string,
    approved: boolean,
    remember?: 'allow' | 'block',
    pattern?: string,
    patterns?: string[]
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

/**
 * Pattern picker for a bash && chain: shows one radio group per sub-command.
 * Each sub-command has its own set of progressively broader patterns to choose from.
 * Default selection is the second option (one wildcard step up from exact).
 */
function SubCommandPatternPicker({
  subCommandPatterns,
  selectedPatterns,
  approvedSubCommands,
  onSelect
}: {
  subCommandPatterns: SubCommandSuggestions[]
  selectedPatterns: Record<number, string>
  approvedSubCommands: Set<number>
  onSelect: (idx: number, pattern: string) => void
}) {
  return (
    <div className="space-y-3">
      {subCommandPatterns.map((group, idx) => {
        const isApproved = approvedSubCommands.has(idx)
        return (
          <div key={idx}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[11px] text-muted-foreground font-mono truncate">
                {group.subCommand}
              </span>
              {isApproved && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-500 font-medium shrink-0">
                  <Check className="h-2.5 w-2.5" />
                  Already allowed
                </span>
              )}
            </div>
            <div className={cn('space-y-0.5', isApproved && 'opacity-40 pointer-events-none')}>
              {group.patterns.map((pattern) => (
                <button
                  key={pattern}
                  onClick={() => onSelect(idx, pattern)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1 rounded text-left text-xs font-mono transition-colors',
                    selectedPatterns[idx] === pattern
                      ? 'bg-primary/20 border border-primary/40 text-foreground'
                      : 'bg-muted/30 border border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  <Check
                    className={cn(
                      'h-3 w-3 shrink-0',
                      selectedPatterns[idx] === pattern ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="break-all">{pattern}</span>
                </button>
              ))}
            </div>
            {idx < subCommandPatterns.length - 1 && (
              <div className="flex items-center gap-1 mt-2">
                <div className="h-px flex-1 bg-border/40" />
                <span className="text-[10px] font-mono text-muted-foreground/50">&&</span>
                <div className="h-px flex-1 bg-border/40" />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Flat pattern picker for single-command bash or non-bash tools (original behavior).
 */
function FlatPatternPicker({
  suggestions,
  selectedPattern,
  onSelect
}: {
  suggestions: string[]
  selectedPattern: string
  onSelect: (pattern: string) => void
}) {
  return (
    <div className="space-y-1">
      {suggestions.map((pattern) => (
        <button
          key={pattern}
          onClick={() => onSelect(pattern)}
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
  )
}

/**
 * Split a bash command for display, respecting quotes and command substitutions.
 * Mirrors backend splitBashChain logic.
 */
function splitBashForDisplay(
  command: string
): Array<{ cmd: string; separator?: string }> {
  const parts: Array<{ cmd: string; separator?: string }> = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escapeNext = false
  let parenDepth = 0
  let i = 0

  while (i < command.length) {
    const char = command[i]
    const next = command[i + 1]

    if (escapeNext) {
      current += char
      escapeNext = false
      i++
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      current += char
      escapeNext = true
      i++
      continue
    }

    if (char === "'" && !inDoubleQuote && parenDepth === 0) {
      inSingleQuote = !inSingleQuote
      current += char
      i++
      continue
    }

    if (char === '"' && !inSingleQuote && parenDepth === 0) {
      inDoubleQuote = !inDoubleQuote
      current += char
      i++
      continue
    }

    // Track command substitutions $(...)
    if (char === '$' && next === '(' && !inSingleQuote) {
      parenDepth++
      current += char + next
      i += 2
      continue
    }

    if (char === ')' && parenDepth > 0 && !inSingleQuote && !inDoubleQuote) {
      parenDepth--
      current += char
      i++
      continue
    }

    // Only split when not inside quotes or command substitutions
    if (!inSingleQuote && !inDoubleQuote && parenDepth === 0) {
      if (char === '&' && next === '&') {
        if (current.trim()) parts.push({ cmd: current.trim(), separator: '&&' })
        current = ''
        i += 2
        while (i < command.length && /\s/.test(command[i])) i++
        continue
      }

      if (char === '|' && next === '|') {
        if (current.trim()) parts.push({ cmd: current.trim(), separator: '||' })
        current = ''
        i += 2
        while (i < command.length && /\s/.test(command[i])) i++
        continue
      }

      if (char === '|' && next !== '|') {
        if (current.trim()) parts.push({ cmd: current.trim(), separator: '|' })
        current = ''
        i++
        while (i < command.length && /\s/.test(command[i])) i++
        continue
      }

      if (char === ';') {
        if (current.trim()) parts.push({ cmd: current.trim(), separator: ';' })
        current = ''
        i++
        while (i < command.length && /\s/.test(command[i])) i++
        continue
      }
    }

    current += char
    i++
  }

  if (current.trim()) parts.push({ cmd: current.trim() })
  return parts
}

/**
 * Display a bash command, splitting on && / || / ; into labelled rows.
 * For non-bash or single commands: shows the plain command string.
 */
function CommandDisplay({ commandStr }: { commandStr: string }) {
  const prefix = 'bash: '
  if (!commandStr.startsWith(prefix)) {
    return (
      <div className="text-xs font-mono px-2 py-1.5 rounded bg-muted/50 text-foreground break-all max-h-32 overflow-y-auto">
        {commandStr}
      </div>
    )
  }

  const command = commandStr.slice(prefix.length)
  const parts = splitBashForDisplay(command)

  if (parts.length <= 1) {
    return (
      <div className="text-xs font-mono px-2 py-1.5 rounded bg-muted/50 text-foreground break-all max-h-32 overflow-y-auto">
        {commandStr}
      </div>
    )
  }

  return (
    <div className="max-h-40 overflow-y-auto space-y-0.5">
      {parts.map((part, idx) => (
        <div key={idx}>
          <div className="text-xs font-mono px-2 py-1.5 rounded bg-muted/50 text-foreground break-all">
            {part.cmd}
          </div>
          {part.separator && (
            <div className="flex items-center gap-1 py-0.5 px-2">
              <div className="h-px flex-1 bg-border/40" />
              <span className="text-[10px] font-mono text-muted-foreground/60">
                {part.separator}
              </span>
              <div className="h-px flex-1 bg-border/40" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Build initial per-sub-command selected patterns: pick index 1 (one wildcard step up) or index 0 */
function buildDefaultSubPatterns(groups: SubCommandSuggestions[]): Record<number, string> {
  const defaults: Record<number, string> = {}
  groups.forEach((group, idx) => {
    defaults[idx] = group.patterns[1] ?? group.patterns[0] ?? ''
  })
  return defaults
}

export function CommandApprovalPrompt({ request, onReply }: CommandApprovalPromptProps) {
  const [sending, setSending] = useState(false)
  const [patternPickerMode, setPatternPickerMode] = useState<'allow' | 'block' | null>(null)

  // For flat (single command / block always) picker
  const flatSuggestions = useMemo(
    () => request.patternSuggestions || [request.commandStr],
    [request.patternSuggestions, request.commandStr]
  )
  const [selectedFlatPattern, setSelectedFlatPattern] = useState<string>(
    flatSuggestions[0] || request.commandStr
  )

  // For per-sub-command (allow always, && chain) picker — deduplicate identical sub-commands
  const uniqueSubCommandPatterns = useMemo(() => {
    if (!request.subCommandPatterns) return undefined
    const seen = new Set<string>()
    return request.subCommandPatterns.filter((group) => {
      if (seen.has(group.subCommand)) return false
      seen.add(group.subCommand)
      return true
    })
  }, [request.subCommandPatterns])

  const hasSubCommands = Boolean(uniqueSubCommandPatterns && uniqueSubCommandPatterns.length > 1)
  const [selectedSubPatterns, setSelectedSubPatterns] = useState<Record<number, string>>(() =>
    uniqueSubCommandPatterns ? buildDefaultSubPatterns(uniqueSubCommandPatterns) : {}
  )

  // Check which sub-commands are already covered by the allowlist
  const { commandFilter } = useSettingsStore()
  const approvedSubCommands = useMemo(() => {
    const approved = new Set<number>()
    if (uniqueSubCommandPatterns) {
      uniqueSubCommandPatterns.forEach((group, idx) => {
        const commandStr = `bash: ${group.subCommand}`
        const isApproved = commandFilter.allowlist.some((pattern) =>
          patternMatches(commandStr, pattern)
        )
        if (isApproved) approved.add(idx)
      })
    }
    return approved
  }, [uniqueSubCommandPatterns, commandFilter.allowlist])

  const { icon: Icon, label, color } = getToolDisplay(request.toolName)

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

    if (patternPickerMode === 'allow' && hasSubCommands && uniqueSubCommandPatterns) {
      // Multi-pattern: one per unique sub-command, skip already-approved ones
      const patterns = uniqueSubCommandPatterns
        .map((_g, idx) =>
          approvedSubCommands.has(idx) ? null : (selectedSubPatterns[idx] ?? _g.patterns[0])
        )
        .filter((p): p is string => p !== null)
      onReply(request.id, true, 'allow', undefined, patterns.length > 0 ? patterns : undefined)
    } else if (patternPickerMode === 'allow') {
      onReply(request.id, true, 'allow', selectedFlatPattern)
    } else {
      onReply(request.id, false, 'block', selectedFlatPattern)
    }
  }, [
    sending,
    patternPickerMode,
    hasSubCommands,
    request,
    selectedSubPatterns,
    selectedFlatPattern,
    approvedSubCommands,
    onReply
  ])

  const handleCancelPicker = useCallback(() => {
    setPatternPickerMode(null)
  }, [])

  const handleAllowAlways = useCallback(() => {
    if (sending) return
    if (hasSubCommands) {
      // Always open picker so user can choose per-sub-command granularity
      setPatternPickerMode('allow')
    } else if (flatSuggestions.length > 1) {
      setPatternPickerMode('allow')
    } else {
      setSending(true)
      onReply(request.id, true, 'allow', flatSuggestions[0])
    }
  }, [sending, hasSubCommands, flatSuggestions, onReply, request.id])

  const handleBlockAlways = useCallback(() => {
    if (sending) return
    if (flatSuggestions.length > 1) {
      setPatternPickerMode('block')
    } else {
      setSending(true)
      onReply(request.id, false, 'block', flatSuggestions[0])
    }
  }, [sending, flatSuggestions, onReply, request.id])

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
        {/* Command display — bash && chains split into rows */}
        <div className="mb-3">
          <div className="text-xs font-semibold mb-1 text-muted-foreground">
            Tool: {request.toolName}
          </div>
          <CommandDisplay commandStr={request.commandStr} />
        </div>

        {/* Pattern picker */}
        {patternPickerMode && (
          <div className="mb-3 rounded-md border border-border bg-muted/20 p-2.5">
            <div className="text-xs font-medium mb-2 text-foreground">
              {patternPickerMode === 'allow'
                ? hasSubCommands
                  ? 'Choose patterns to always allow (one per command):'
                  : 'Choose pattern to always allow:'
                : 'Choose pattern to always block:'}
            </div>

            {/* Scrollable pattern list */}
            <div className="max-h-56 overflow-y-auto">
              {patternPickerMode === 'allow' && hasSubCommands && uniqueSubCommandPatterns ? (
                <SubCommandPatternPicker
                  subCommandPatterns={uniqueSubCommandPatterns}
                  selectedPatterns={selectedSubPatterns}
                  approvedSubCommands={approvedSubCommands}
                  onSelect={(idx, pattern) =>
                    setSelectedSubPatterns((prev) => ({ ...prev, [idx]: pattern }))
                  }
                />
              ) : (
                <FlatPatternPicker
                  suggestions={flatSuggestions}
                  selectedPattern={selectedFlatPattern}
                  onSelect={setSelectedFlatPattern}
                />
              )}
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
              onClick={handleAllowAlways}
              disabled={sending}
              title="Always allow this command pattern"
              data-testid="command-approve-always"
            >
              Allow always
              <ChevronDown className="h-3 w-3 ml-1" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleBlockAlways}
              disabled={sending}
              className="text-destructive hover:text-destructive"
              title="Always block this command pattern"
              data-testid="command-block-always"
            >
              Block always
              {flatSuggestions.length > 1 && <ChevronDown className="h-3 w-3 ml-1" />}
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
