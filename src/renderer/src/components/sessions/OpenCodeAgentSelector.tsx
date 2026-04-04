import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Bot, ChevronDown } from 'lucide-react'
import { useSessionStore } from '@/stores/useSessionStore'
import { cn } from '@/lib/utils'

// Hidden system agents — run automatically, not user-selectable
const SYSTEM_AGENT_NAMES = new Set(['title', 'summary', 'compaction'])

interface OpenCodeAgent {
  name: string
  description?: string
  mode: string
}

interface OpenCodeAgentSelectorProps {
  sessionId: string
  worktreePath?: string | null
}

export function OpenCodeAgentSelector({
  sessionId,
  worktreePath
}: OpenCodeAgentSelectorProps): React.JSX.Element | null {
  const [agents, setAgents] = useState<OpenCodeAgent[]>([])
  const [open, setOpen] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const selectedAgent = useSessionStore((state) => state.agentBySession.get(sessionId) ?? null)
  const setSessionAgent = useSessionStore((state) => state.setSessionAgent)

  // Load agents on mount (or when worktreePath changes)
  useEffect(() => {
    if (!window.opencodeOps?.listAgents) return
    window.opencodeOps
      .listAgents({ worktreePath: worktreePath ?? undefined })
      .then((result) => {
        if (result.success && result.agents.length > 0) {
          const visible = result.agents.filter(
            (a) => (a.mode === 'primary' || a.mode === 'all') && !SYSTEM_AGENT_NAMES.has(a.name)
          )
          setAgents(visible)
        }
      })
      .catch(() => {
        // Silently fail — agent selection is optional
      })
  }, [worktreePath])

  // Open dropdown and calculate portal position
  const handleButtonClick = (): void => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setDropdownPos({ top: rect.top - 4, left: rect.left })
    }
    setOpen((v) => !v)
  }

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      const target = e.target as Node
      if (
        buttonRef.current &&
        !buttonRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Don't render if no agents loaded
  if (agents.length === 0) return null

  const displayName = selectedAgent ?? agents[0]?.name ?? 'build'

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleButtonClick}
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
          'border select-none',
          'bg-emerald-500/10 border-emerald-500/30 text-emerald-500 hover:bg-emerald-500/20'
        )}
        title="Select OpenCode agent"
        aria-label={`Current agent: ${displayName}. Click to change`}
        data-testid="opencode-agent-selector"
      >
        <Bot className="h-3 w-3" aria-hidden="true" />
        <span className="max-w-[80px] truncate">{displayName}</span>
        <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
      </button>

      {open &&
        dropdownPos &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: 'fixed',
              top: dropdownPos.top,
              left: dropdownPos.left,
              transform: 'translateY(-100%)',
              zIndex: 9999
            }}
            className="rounded-lg border border-border bg-popover shadow-md py-1 w-fit"
          >
            {agents.map((agent) => (
              <button
                key={agent.name}
                onClick={() => {
                  setSessionAgent(sessionId, agent.name)
                  setOpen(false)
                }}
                className={cn(
                  'group/item relative block w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors whitespace-nowrap',
                  selectedAgent === agent.name || (!selectedAgent && agent.name === agents[0]?.name)
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground'
                )}
              >
                {agent.name}
                {agent.description && (
                  <div className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover/item:block">
                    <div className="rounded bg-popover border border-border px-2 py-1 text-[11px] text-foreground shadow-md whitespace-nowrap">
                      {agent.description}
                    </div>
                  </div>
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
