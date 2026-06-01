import { memo, useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { getAvailableHandoffAgentSdks, getHandoffSdkDisplayName } from '@/lib/handoffSelection'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

interface SessionProviderSelectorProps {
  sessionId: string
  agentSdk: HandoffAgentSdk
  canChange: boolean
}

function getCompactProviderLabel(agentSdk: HandoffAgentSdk): string {
  switch (agentSdk) {
    case 'opencode':
      return 'OPENCODE'
    case 'claude-code':
      return 'CLAUDE CODE'
    case 'codex':
      return 'CODEX'
    case 'claude-code-cli':
      return 'CLAUDE CLI'
  }
}

export const SessionProviderSelector = memo(function SessionProviderSelector({
  sessionId,
  agentSdk,
  canChange
}: SessionProviderSelectorProps): React.JSX.Element {
  const availableAgentSdks = useSettingsStore((state) => state.availableAgentSdks)
  const changeBlankSessionProvider = useSessionStore((state) => state.changeBlankSessionProvider)
  const [isChanging, setIsChanging] = useState(false)

  const options = useMemo(
    () => (availableAgentSdks ? getAvailableHandoffAgentSdks(availableAgentSdks) : []),
    [availableAgentSdks]
  )
  const label = getCompactProviderLabel(agentSdk)

  if (!canChange || !availableAgentSdks) {
    return (
      <span
        className="text-[10px] font-medium text-muted-foreground uppercase shrink-0"
        data-testid="session-provider-label"
      >
        {label}
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1 text-[10px] font-medium uppercase shrink-0',
            'text-muted-foreground hover:text-foreground transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-60'
          )}
          type="button"
          disabled={isChanging}
          aria-label={`Current provider: ${getHandoffSdkDisplayName(agentSdk)}. Click to change provider`}
          title="Change provider"
          data-testid="session-provider-selector"
        >
          <span>{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {options.map((option) => {
          const isActive = option === agentSdk
          return (
            <DropdownMenuItem
              key={option}
              onClick={async () => {
                if (isActive || isChanging) return
                setIsChanging(true)
                try {
                  const result = await changeBlankSessionProvider(sessionId, option)
                  if (!result.success) {
                    toast.error(result.error ?? 'Failed to change provider')
                  }
                } finally {
                  setIsChanging(false)
                }
              }}
              className="flex items-center justify-between gap-2 cursor-pointer"
              data-testid={`session-provider-option-${option}`}
            >
              <span className="truncate text-sm">{getHandoffSdkDisplayName(option)}</span>
              {isActive && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
