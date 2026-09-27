import { useCallback, useEffect, useState } from 'react'
import { Copy, Loader2, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { getVoiceBridge, useVoiceStore } from '@/stores/useVoiceStore'
import type { VoiceHistoryEntry } from '@shared/types/voice'
import { copyVoiceTranscript } from './copy-transcript'

const PAGE_SIZE = 50

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

interface VoiceHistoryModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Everything ever dictated: search, copy, delete. */
export function VoiceHistoryModal({
  open,
  onOpenChange
}: VoiceHistoryModalProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<VoiceHistoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const refreshRecent = useVoiceStore((s) => s.refreshRecent)

  const load = useCallback(
    async (nextQuery: string, offset: number, append: boolean): Promise<void> => {
      const bridge = getVoiceBridge()
      if (!bridge) return
      setLoading(true)
      try {
        const [page, count] = await Promise.all([
          bridge.listHistory({ limit: PAGE_SIZE, offset, query: nextQuery || undefined }),
          bridge.countHistory(nextQuery || undefined)
        ])
        setEntries((current) => (append ? [...current, ...page] : page))
        setTotal(count)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    if (!open) {
      setQuery('')
      setConfirmClear(false)
      return
    }
    void load('', 0, false)
  }, [open, load])

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => void load(query, 0, false), 150)
    return () => clearTimeout(timer)
  }, [query, open, load])

  const remove = async (id: string): Promise<void> => {
    const bridge = getVoiceBridge()
    if (!bridge) return
    await bridge.deleteHistory(id)
    setEntries((current) => current.filter((entry) => entry.id !== id))
    setTotal((count) => Math.max(0, count - 1))
    void refreshRecent()
  }

  const clearAll = async (): Promise<void> => {
    const bridge = getVoiceBridge()
    if (!bridge) return
    await bridge.clearHistory()
    setEntries([])
    setTotal(0)
    setConfirmClear(false)
    void refreshRecent()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[80vh] max-w-2xl flex-col"
        data-testid="voice-history-modal"
      >
        <DialogHeader>
          <DialogTitle>Dictation history</DialogTitle>
          <DialogDescription>
            Everything you dictated, newest first. Click a transcript to copy it.
          </DialogDescription>
        </DialogHeader>

        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search transcripts…"
            className="pl-8"
            data-testid="voice-history-search"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto -mx-2 px-2">
          {entries.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {loading ? (
                <Loader2 className="mx-auto h-4 w-4 animate-spin" />
              ) : query ? (
                'No transcripts match your search'
              ) : (
                'No transcriptions yet'
              )}
            </div>
          ) : (
            <ul className="space-y-1" data-testid="voice-history-list">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="group flex items-start gap-2 rounded-md px-2 py-2 hover:bg-accent/50"
                  data-testid={`voice-history-row-${entry.id}`}
                >
                  <button
                    type="button"
                    onClick={() => void copyVoiceTranscript(entry.text)}
                    className="min-w-0 flex-1 text-left"
                    title="Copy to clipboard"
                  >
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-snug line-clamp-3">
                      {entry.text}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {formatWhen(entry.createdAt)}
                      {entry.durationMs > 0 && ` · ${formatDuration(entry.durationMs)}`}
                      {entry.cleaned ? ' · cleaned' : ''}
                    </p>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      title="Copy"
                      onClick={() => void copyVoiceTranscript(entry.text)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      title="Delete"
                      onClick={() => void remove(entry.id)}
                      data-testid={`voice-history-delete-${entry.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {entries.length < total && (
            <div className="py-2 text-center">
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void load(query, entries.length, true)}
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Load more'}
              </Button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-xs text-muted-foreground">
          <span>
            {total} transcript{total === 1 ? '' : 's'}
          </span>
          {total > 0 && (
            <Button
              variant="outline"
              size="sm"
              className={cn(
                'text-destructive hover:text-destructive',
                confirmClear && 'border-destructive'
              )}
              onClick={() => (confirmClear ? void clearAll() : setConfirmClear(true))}
              onBlur={() => setConfirmClear(false)}
              data-testid="voice-history-clear"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              {confirmClear ? 'Click again to clear everything' : 'Clear history'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
