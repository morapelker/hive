import { useCallback, useEffect, useRef, useState } from 'react'
import { History, Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { VoiceHistoryModal } from '@/components/voice/VoiceHistoryModal'
import { copyVoiceTranscript } from '@/components/voice/copy-transcript'
import { describeVoiceStatus } from '@/components/voice/voice-status'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { isVoiceAvailable, useVoiceStore } from '@/stores/useVoiceStore'
import { voiceHistoryPreview } from '@shared/types/voice'

const HOVER_OPEN_DELAY_MS = 150
const HOVER_CLOSE_DELAY_MS = 250

/**
 * Header icon for voice dictation: grey when idle, red while recording, amber
 * while transcribing. Hovering or clicking opens its menu with the recent
 * transcripts (click one to copy it) and a way into the full history.
 */
export function HeaderVoiceToggle(): React.JSX.Element | null {
  const voiceEnabled = useSettingsStore((s) => s.voice.enabled)
  const status = useVoiceStore((s) => s.status)
  const recent = useVoiceStore((s) => s.recent)
  const recentLoaded = useVoiceStore((s) => s.recentLoaded)
  const refreshRecent = useVoiceStore((s) => s.refreshRecent)
  const toggleDictation = useVoiceStore((s) => s.toggle)
  const [open, setOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = useCallback((): void => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  useEffect(() => {
    if (open) void refreshRecent()
  }, [open, refreshRecent])

  if (!isVoiceAvailable() || !voiceEnabled) return null

  const state = status?.state ?? 'unavailable'
  const modelStatus = status?.model.status
  const colorClass =
    state === 'recording'
      ? 'text-red-500 hover:text-red-500'
      : state === 'processing'
        ? 'text-amber-500 hover:text-amber-500'
        : modelStatus === 'failed' || status?.hotkeyProblem
          ? 'text-red-400/80'
          : state === 'unavailable'
            ? 'text-muted-foreground/50'
            : 'text-muted-foreground'

  const scheduleOpen = (): void => {
    clearTimers()
    openTimer.current = setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS)
  }
  const scheduleClose = (): void => {
    clearTimers()
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }
  const cancelClose = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }

  return (
    <>
      {/* Non-modal: a modal menu strips pointer events from the page, which makes the
          trigger fire a spurious pointer-leave right after a click and auto-close the menu. */}
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn('size-6 rounded-md hover:bg-accent', colorClass)}
            title={describeVoiceStatus(status)}
            aria-label="Voice dictation"
            data-testid="voice-toggle"
            data-voice-state={state}
            onPointerEnter={scheduleOpen}
            onPointerLeave={scheduleClose}
          >
            <span className="relative inline-flex">
              <Mic className={cn('h-4 w-4', state === 'recording' && 'animate-pulse')} />
              {modelStatus === 'downloading' && (
                <span className="absolute -right-1 -bottom-1 h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
              )}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          data-testid="voice-menu"
        >
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="voice-menu-history">
              <History className="h-4 w-4 mr-2" />
              History
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className="max-h-80 overflow-y-auto min-w-[16rem] max-w-[24rem]"
              onPointerEnter={cancelClose}
              onPointerLeave={scheduleClose}
            >
              {recent.length === 0 ? (
                <DropdownMenuItem disabled>
                  {recentLoaded ? 'No transcriptions yet' : 'Loading…'}
                </DropdownMenuItem>
              ) : (
                recent.map((entry) => (
                  <DropdownMenuItem
                    key={entry.id}
                    title="Copy to clipboard"
                    onSelect={() => void copyVoiceTranscript(entry.text)}
                    data-testid={`voice-history-item-${entry.id}`}
                  >
                    <span className="truncate">{voiceHistoryPreview(entry.text)}</span>
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  setOpen(false)
                  setHistoryOpen(true)
                }}
                data-testid="voice-history-more"
              >
                More history…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {(state === 'idle' || state === 'recording') && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void toggleDictation()}
                data-testid="voice-menu-toggle"
              >
                <Mic className="h-4 w-4 mr-2" />
                {state === 'recording' ? 'Stop dictation' : 'Start dictation'}
                {status?.hotkeyDisplay && (
                  <span className="ml-auto pl-4 text-[11px] text-muted-foreground">
                    {status.hotkeyDisplay}
                  </span>
                )}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <VoiceHistoryModal open={historyOpen} onOpenChange={setHistoryOpen} />
    </>
  )
}
