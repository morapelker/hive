import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Tag, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useTicketLabelsStore } from '@/stores/useTicketLabelsStore'
import {
  TICKET_LABEL_COLOR_NAMES,
  TICKET_LABEL_SWATCH_CLASS,
  leastUsedTicketLabelColor,
  ticketLabelColorOf
} from '@/lib/ticket-label-colors'
import { isComposingKeyboardEvent } from '@/lib/message-composer-shortcuts'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  TICKET_LABEL_NAME_MAX,
  normalizeTicketLabelName,
  type SavedTicketLabel,
  type TicketLabelColor
} from '@shared/lib/ticket-labels'
import { TicketLabelChip } from './TicketLabelChip'
import { TicketLabelColorPicker } from './TicketLabelColorPicker'
import { savedTicketLabelsOf } from './ticket-label-catalog'

/**
 * Marks a field holding an unsaved edit (data-label-draft-dirty): Escape there reverts the edit
 * instead of closing the dialog (Radix handles Escape on the document before the field sees it).
 */
const DIRTY_DRAFT_SELECTOR = '[data-label-draft-dirty]'

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const ticketCount = (count: number): string => `${count} ticket${count === 1 ? '' : 's'}`

/**
 * How many tickets carry each saved label, as one answer of the usage query. The answer only
 * lists labels some ticket carries, so a label missing from it is unused only if it was in the
 * catalog when the query went out (`seen`); one added since is unknown until the next answer.
 */
interface UsageSnapshot {
  counts: Readonly<Record<string, number>>
  seen: ReadonlySet<string>
}

/** The snapshot's count for a label; null when the snapshot cannot tell (unknown). */
function usageCountOf(snapshot: UsageSnapshot | null, id: string): number | null {
  if (!snapshot) return null
  const count: number | undefined = snapshot.counts[id]
  if (count !== undefined) return count
  return snapshot.seen.has(id) ? 0 : null
}

/**
 * Board-level host for "Manage labels…" (the labels store's dialog kind 'manage'): the saved
 * catalog — rename, recolour, reorder, delete — for every project on this Mac. One-off labels
 * never appear here: they belong to their ticket alone.
 */
export function ManageTicketLabelsDialog() {
  const open = useTicketLabelsStore((s) => s.dialog?.kind === 'manage')
  if (!open) return null
  return <ManageTicketLabelsContent />
}

function ManageTicketLabelsContent() {
  const catalog = useTicketLabelsStore(savedTicketLabelsOf)
  // How many tickets carry each label (archived ones included), for the counts and the
  // delete confirmation; null until the first answer arrives
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [adding, setAdding] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  // Only the latest query's answer is shown: an older one may predate a label it would miss
  const usageRequest = useRef(0)

  /** Queries the counts afresh; resolves to the new snapshot, or null when the query failed. */
  const refreshUsage = useCallback(async (): Promise<UsageSnapshot | null> => {
    const request = ++usageRequest.current
    const seen = new Set(savedTicketLabelsOf(useTicketLabelsStore.getState()).map((l) => l.id))
    try {
      const counts = await useTicketLabelsStore.getState().usage()
      const snapshot: UsageSnapshot = { counts, seen }
      if (request === usageRequest.current) setUsage(snapshot)
      return snapshot
    } catch {
      // The counts stay as they were; a delete then asks for confirmation without a number
      return null
    }
  }, [])

  useEffect(() => {
    useTicketLabelsStore
      .getState()
      .ensureLoaded()
      .catch(() => undefined)
  }, [])

  // The counts are fetched when the dialog opens and again whenever a label joins or leaves
  // the catalog — a delete here, or a label created elsewhere (another window, a ticket moved
  // in from another Mac, a restore), which the last answer knows nothing about
  const catalogIdsKey = useMemo(
    () =>
      catalog
        .map((label) => label.id)
        .sort()
        .join('\n'),
    [catalog]
  )
  useEffect(() => {
    void refreshUsage()
  }, [catalogIdsKey, refreshUsage])

  /** A label's count straight from the DB, for deciding whether a delete needs asking. */
  const checkUsage = useCallback(
    async (id: string): Promise<number | null> => usageCountOf(await refreshUsage(), id),
    [refreshUsage]
  )

  const close = useCallback(() => useTicketLabelsStore.getState().closeDialog(), [])

  const move = useCallback(
    async (index: number, delta: -1 | 1) => {
      const ids = catalog.map((label) => label.id)
      const target = index + delta
      if (target < 0 || target >= ids.length) return
      ;[ids[index], ids[target]] = [ids[target], ids[index]]
      try {
        await useTicketLabelsStore.getState().reorder(ids)
      } catch (err) {
        toast.error(`Couldn't reorder the labels: ${errorMessage(err)}`)
      }
    },
    [catalog]
  )

  // The counts are fetched again by the catalog change the delete makes (and its rollback)
  const remove = useCallback(async (id: string) => {
    try {
      await useTicketLabelsStore.getState().remove(id)
    } catch (err) {
      toast.error(`Couldn't delete the label: ${errorMessage(err)}`)
    }
  }, [])

  // Escape in a field with an unsaved edit reverts that edit (the field does it) rather than
  // closing the dialog and losing track of what was typed
  const handleEscapeKeyDown = (e: KeyboardEvent): void => {
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest(DIRTY_DRAFT_SELECTOR)) e.preventDefault()
  }

  // The dialog itself takes the focus as it opens, not its first control (the first row's
  // "move down" button, which would show a focus ring as if it were the point of the dialog);
  // Tab then walks into the rows
  const handleOpenAutoFocus = (e: Event): void => {
    e.preventDefault()
    contentRef.current?.focus()
  }

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent
        ref={contentRef}
        className="max-w-lg outline-none"
        data-testid="manage-ticket-labels-dialog"
        // Tab moves between the fields here, never toggling the mode of the session behind
        data-tab-navigates=""
        onOpenAutoFocus={handleOpenAutoFocus}
        onEscapeKeyDown={handleEscapeKeyDown}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Tag className="h-4 w-4" />
            Labels
          </DialogTitle>
          <DialogDescription className="text-xs">
            Shown on cards only, never sent to the model.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 flex max-h-[min(60vh,420px)] min-w-0 flex-col gap-1 overflow-y-auto px-1">
          {catalog.length === 0 && !adding && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No saved labels yet. Add one here or from a ticket&rsquo;s Labels menu.
            </p>
          )}
          {catalog.map((label, index) => (
            <ManageLabelRow
              key={label.id}
              label={label}
              isFirst={index === 0}
              isLast={index === catalog.length - 1}
              usageCount={usageCountOf(usage, label.id)}
              onCheckUsage={() => checkUsage(label.id)}
              onMove={(delta) => void move(index, delta)}
              onDelete={() => remove(label.id)}
            />
          ))}
          {adding && <NewLabelRow onDone={() => setAdding(false)} />}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            data-testid="manage-labels-new"
            onClick={() => setAdding(true)}
            disabled={adding}
          >
            <Plus className="h-3.5 w-3.5" />
            New label
          </Button>
          <Button size="sm" data-testid="manage-labels-done" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ManageLabelRowProps {
  label: SavedTicketLabel
  isFirst: boolean
  isLast: boolean
  /** Tickets carrying the label; null while unknown. */
  usageCount: number | null
  /** Asks the DB again how many tickets carry the label; null when it cannot tell. */
  onCheckUsage: () => Promise<number | null>
  onMove: (delta: -1 | 1) => void
  onDelete: () => Promise<void>
}

/**
 * One catalog entry: reorder, live chip, inline rename (Enter or leaving the field saves,
 * Escape reverts; a clash with another label's name is shown and the name reverts), a colour
 * popover, the usage count and delete — which asks first, in the row, when tickets carry it.
 */
function ManageLabelRow({
  label,
  isFirst,
  isLast,
  usageCount,
  onCheckUsage,
  onMove,
  onDelete
}: ManageLabelRowProps) {
  const [draft, setDraft] = useState(label.name)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [colorOpen, setColorOpen] = useState(false)
  // The swatch the arrow keys have reached in the open colour popover: browsing writes
  // nothing, a click / Enter / Space saves it
  const [pendingColor, setPendingColor] = useState<TicketLabelColor>(() =>
    ticketLabelColorOf(label.color)
  )
  // The name being saved, so Enter followed by the blur it causes saves once
  const savingName = useRef<string | null>(null)

  // Follow renames made elsewhere (another window, or this row's own save)
  useEffect(() => setDraft(label.name), [label.name])

  const normalizedDraft = normalizeTicketLabelName(draft)
  const isDirty = draft !== label.name

  const commit = async (): Promise<void> => {
    if (normalizedDraft.length === 0 || normalizedDraft === label.name) {
      setDraft(label.name)
      return
    }
    if (savingName.current === normalizedDraft) return
    savingName.current = normalizedDraft
    try {
      await useTicketLabelsStore.getState().update(label.id, { name: normalizedDraft })
      setError(null)
      setDraft(normalizedDraft)
    } catch (err) {
      setError(errorMessage(err))
      setDraft(label.name)
    } finally {
      savingName.current = null
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isComposingKeyboardEvent(e.nativeEvent)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit()
    } else if (e.key === 'Escape') {
      setDraft(label.name)
      setError(null)
    }
  }

  const handleColorOpenChange = (open: boolean): void => {
    // Each opening starts from the saved colour; one browsed to and not chosen is dropped
    if (open) setPendingColor(ticketLabelColorOf(label.color))
    setColorOpen(open)
  }

  const recolor = async (color: TicketLabelColor): Promise<void> => {
    setColorOpen(false)
    if (color === label.color) return
    try {
      await useTicketLabelsStore.getState().update(label.id, { color })
    } catch (err) {
      toast.error(`Couldn't change the colour: ${errorMessage(err)}`)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    setDeleting(true)
    try {
      await onDelete()
    } finally {
      setDeleting(false)
      setConfirming(false)
    }
  }

  const requestDelete = async (): Promise<void> => {
    if (usageCount !== 0) {
      setConfirming(true)
      return
    }
    // The count shown says nothing carries it, but it may be older than a ticket that took the
    // label meanwhile (from another window or Mac): ask the DB again before deleting unasked
    setDeleting(true)
    let fresh: number | null
    try {
      fresh = await onCheckUsage()
    } finally {
      setDeleting(false)
    }
    // Nothing carries it: nothing to warn about
    if (fresh === 0) await confirmDelete()
    else setConfirming(true)
  }

  const color = ticketLabelColorOf(label.color)
  const preview = { name: normalizedDraft || label.name, color: label.color }

  if (confirming) {
    return (
      <div
        data-testid={`manage-label-confirm-${label.id}`}
        className="flex min-h-9 items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5"
      >
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs">
          <span>Remove</span>
          <TicketLabelChip label={label} className="max-w-[160px]" />
          <span>
            {/* No count to give (unknown, or a 0 the fresh check overruled): no number */}
            {usageCount
              ? `from ${ticketCount(usageCount)} and delete it?`
              : 'from every ticket and delete it?'}
          </span>
        </p>
        <Button
          size="sm"
          variant="destructive"
          data-testid={`manage-label-confirm-delete-${label.id}`}
          onClick={() => void confirmDelete()}
          disabled={deleting}
        >
          Delete
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setConfirming(false)}
          disabled={deleting}
        >
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <div data-testid={`manage-label-row-${label.id}`} className="flex flex-col gap-0.5">
      <div className="flex min-h-9 min-w-0 items-center gap-1.5 rounded-md px-1 py-1 hover:bg-accent/40">
        <div className="flex shrink-0 flex-col">
          <button
            type="button"
            aria-label={`Move ${label.name} up`}
            data-testid={`manage-label-up-${label.id}`}
            disabled={isFirst}
            onClick={() => onMove(-1)}
            className="inline-flex h-3.5 w-4 items-center justify-center rounded-[3px] text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-label={`Move ${label.name} down`}
            data-testid={`manage-label-down-${label.id}`}
            disabled={isLast}
            onClick={() => onMove(1)}
            className="inline-flex h-3.5 w-4 items-center justify-center rounded-[3px] text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
        <div className="flex w-[120px] shrink-0">
          <TicketLabelChip label={preview} />
        </div>
        <Input
          data-testid={`manage-label-name-${label.id}`}
          aria-label={`Name of ${label.name}`}
          value={draft}
          maxLength={TICKET_LABEL_NAME_MAX}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onBlur={() => void commit()}
          onKeyDown={handleKeyDown}
          aria-invalid={error !== null || undefined}
          data-label-draft-dirty={isDirty ? '' : undefined}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <Popover open={colorOpen} onOpenChange={handleColorOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Colour of ${label.name}: ${TICKET_LABEL_COLOR_NAMES[color]}`}
              title={TICKET_LABEL_COLOR_NAMES[color]}
              data-testid={`manage-label-color-${label.id}`}
              className={cn(
                'h-4 w-4 shrink-0 rounded-full outline-none',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                TICKET_LABEL_SWATCH_CLASS[color]
              )}
            />
          </PopoverTrigger>
          {/* Portaled outside the dialog, so it opts out of the Tab shortcuts on its own */}
          <PopoverContent align="end" className="w-auto p-2" data-tab-navigates="">
            <TicketLabelColorPicker
              value={pendingColor}
              onChange={setPendingColor}
              onCommit={(next) => void recolor(next)}
              ariaLabel={`Colour of ${label.name}`}
              testIdPrefix={`manage-label-swatch-${label.id}`}
            />
          </PopoverContent>
        </Popover>
        <span
          data-testid={`manage-label-usage-${label.id}`}
          className="w-[60px] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"
        >
          {usageCount === null ? '…' : ticketCount(usageCount)}
        </span>
        <button
          type="button"
          aria-label={`Delete ${label.name}`}
          title="Delete"
          data-testid={`manage-label-delete-${label.id}`}
          onClick={() => void requestDelete()}
          disabled={deleting}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {error && (
        <p
          data-testid={`manage-label-error-${label.id}`}
          role="alert"
          className="pl-[148px] text-[11px] text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  )
}

/** The inline "New label" row: adds a saved label to the catalog, on no ticket. */
function NewLabelRow({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<TicketLabelColor>(() =>
    leastUsedTicketLabelColor(savedTicketLabelsOf(useTicketLabelsStore.getState()))
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const normalized = normalizeTicketLabelName(name)

  const submit = async (): Promise<void> => {
    if (normalized.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      await useTicketLabelsStore.getState().create({ name: normalized, color })
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isComposingKeyboardEvent(e.nativeEvent)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape' && name.length > 0) {
      onDone()
    }
  }

  return (
    <div
      data-testid="manage-label-new-row"
      className="flex flex-col gap-2 rounded-md border border-dashed border-border px-2 py-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex w-[120px] shrink-0">
          <TicketLabelChip
            label={{ name: normalized || 'New label', color }}
            dimmed={normalized.length === 0}
          />
        </div>
        <Input
          autoFocus
          data-testid="manage-label-new-name"
          aria-label="New label name"
          placeholder="e.g. Waiting for Joy"
          value={name}
          maxLength={TICKET_LABEL_NAME_MAX}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={handleKeyDown}
          aria-invalid={error !== null || undefined}
          data-label-draft-dirty={name.length > 0 ? '' : undefined}
          disabled={busy}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <Button
          size="sm"
          data-testid="manage-label-new-add"
          onClick={() => void submit()}
          disabled={normalized.length === 0 || busy}
        >
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
      <TicketLabelColorPicker
        value={color}
        onChange={setColor}
        ariaLabel="Colour of the new label"
        testIdPrefix="manage-label-new-color"
        disabled={busy}
      />
      {error && (
        <p data-testid="manage-label-new-error" role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
