import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getTelegramForwardingTarget } from '@/lib/telegramForwardingTarget'
import { cn } from '@/lib/utils'
import { telegramApi } from '@/api/telegram-api'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useTelegramStore } from '@/stores/useTelegramStore'
import type { TelegramMode } from '@shared/types/telegram'

export function HeaderTelegramToggle(): React.JSX.Element {
  const telegramConfig = useSettingsStore((s) => s.telegramConfig)
  const openSettings = useSettingsStore((s) => s.openSettings)
  const activeSessionIdRaw = useSessionStore((s) => s.activeSessionId)
  const activeWorktreeIdRaw = useSessionStore((s) => s.activeWorktreeId)
  const activeConnectionIdRaw = useSessionStore((s) => s.activeConnectionId)
  const activePinnedSessionId = useSessionStore((s) => s.activePinnedSessionId)
  const sessionsByWorktree = useSessionStore((s) => s.sessionsByWorktree)
  const sessionsByConnection = useSessionStore((s) => s.sessionsByConnection)
  const boardMode = useSettingsStore((s) => s.boardMode)
  const boardTelegramTarget = useKanbanStore((s) => s.boardTelegramTarget)
  const isBoardViewActive = useKanbanStore((s) => s.isBoardViewActive)
  const isPinnedBoardActive = useKanbanStore((s) => s.isPinnedBoardActive)
  const tickets = useKanbanStore((s) => s.tickets)
  const { activeForwardingSessionId, activeForwardingMode, health, refreshStatus } =
    useTelegramStore()

  const forwardingTarget = getTelegramForwardingTarget({
    activeSessionId: activeSessionIdRaw,
    activeWorktreeId: activeWorktreeIdRaw,
    activeConnectionId: activeConnectionIdRaw,
    activePinnedSessionId,
    sessionsByWorktree,
    sessionsByConnection,
    boardMode,
    boardTelegramTarget,
    isBoardViewActive,
    isPinnedBoardActive,
    tickets
  })
  const activeSessionId = forwardingTarget.sessionId
  const activeWorktreeId = forwardingTarget.worktreeId
  const activeConnectionId = forwardingTarget.connectionId
  const configured = !!telegramConfig?.botToken && !!telegramConfig.chatId
  const isHere = !!activeSessionId && activeForwardingSessionId === activeSessionId
  const isElsewhere = !!activeForwardingSessionId && !isHere
  const disabled = !configured || !activeSessionId || (!activeWorktreeId && !activeConnectionId)

  const startForwarding = async (mode: TelegramMode): Promise<void> => {
    if (!activeSessionId || (!activeWorktreeId && !activeConnectionId)) return
    const result = await telegramApi.startForwarding({
      sessionId: activeSessionId,
      worktreeId: activeWorktreeId,
      connectionId: activeConnectionId,
      mode
    })
    useTelegramStore.getState().setStatus(result.status)
    if (result.ok) {
      toast.success(
        isElsewhere
          ? 'Telegram forwarding moved to this session'
          : `Telegram forwarding started (${mode} mode)`
      )
    } else {
      toast.error(result.error ?? 'Failed to start Telegram forwarding')
    }
  }

  const stopForwarding = async (): Promise<void> => {
    const result = await telegramApi.stopForwarding()
    useTelegramStore.getState().setStatus(result.status)
    toast.success('Telegram forwarding stopped')
  }

  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      disabled={disabled}
      onClick={() => {
        if (!configured) openSettings('telegram')
      }}
      className={cn(
        isHere && 'bg-[#229ED9]/10 text-[#229ED9] hover:bg-[#229ED9]/15 hover:text-[#229ED9]'
      )}
      title={
        !configured
          ? 'Configure in Settings'
          : forwardingTarget.source === 'board-ticket'
            ? 'Telegram forwarding: selected ticket session'
            : 'Telegram forwarding'
      }
      data-testid="telegram-forwarding-toggle"
    >
      <span className="relative inline-flex">
        <Send className={cn('h-4 w-4', isHere && 'text-[#229ED9]')} />
        {isHere && activeForwardingMode && (
          <span className="absolute -right-2 -top-2 text-[9px] leading-3 min-w-3 h-3 rounded-full bg-[#229ED9] text-white">
            {activeForwardingMode === 'questions' ? 'Q' : 'A'}
          </span>
        )}
        {isElsewhere && (
          <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-amber-500" />
        )}
        {health === 'error' && (
          <span className="absolute -right-1 -bottom-1 h-2 w-2 rounded-full bg-red-500" />
        )}
      </span>
    </Button>
  )

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent>
          {!configured ? 'Configure in Settings' : 'Open a session to forward'}
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) refreshStatus().catch(() => {})
      }}
    >
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void stopForwarding()}>
          Off {!activeForwardingSessionId ? '✓' : ''}
        </DropdownMenuItem>
        {isElsewhere ? (
          <DropdownMenuItem onClick={() => void startForwarding('questions')}>
            Move forwarding here
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => void startForwarding('questions')}>
          Questions {isHere && activeForwardingMode === 'questions' ? '✓' : ''}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void startForwarding('all')}>
          All {isHere && activeForwardingMode === 'all' ? '✓' : ''}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
