import { useCallback, useId, useState } from 'react'
import { PenLine, Tag } from 'lucide-react'
import type { KanbanTicket } from '../../../../main/db/types'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useTicketLabelsStore } from '@/stores/useTicketLabelsStore'
import {
  setTicketLabel,
  type TicketLabelTarget,
  type TicketLabelWriteOutcome
} from '@/lib/ticket-label-toggle'
import { canAddTicketLabel, type TicketLabelSession } from '@/lib/ticket-label-session'
import { leastUsedTicketLabelColor } from '@/lib/ticket-label-colors'
import { isComposingKeyboardEvent } from '@/lib/message-composer-shortcuts'
import { toast } from '@/lib/toast'
import { visibleTicketTitle } from '@/lib/ticket-key-display'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  TICKET_LABELS_MAX,
  TICKET_LABEL_NAME_MAX,
  hasTicketLabelNamed,
  normalizeTicketLabelName,
  ticketLabelNameKey,
  ticketLabelsOf,
  type SavedTicketLabel,
  type TicketLabel,
  type TicketLabelColor
} from '@shared/lib/ticket-labels'
import { TicketLabelChip } from './TicketLabelChip'
import { TicketLabelColorPicker } from './TicketLabelColorPicker'
import { savedTicketLabelsOf } from './ticket-label-catalog'

type TicketLabelMode = 'saved' | 'once'

/** A label added from the dialog has no menu memory to be ordered by. */
const NO_SESSION: TicketLabelSession = []

const EXAMPLE_NAME: Record<TicketLabelMode, string> = {
  saved: 'Waiting for Joy',
  once: 'Waiting until 21/10'
}

const FULL_MESSAGE = `This ticket already has ${TICKET_LABELS_MAX} labels, the most it can carry.`

/** The ticket as the board holds it now; null once it is gone (deleted, moved away…). */
function findTicket({ projectId, ticketId }: TicketLabelTarget): KanbanTicket | null {
  return (
    useKanbanStore
      .getState()
      .tickets.get(projectId)
      ?.find((t) => t.id === ticketId) ?? null
  )
}

/**
 * Why the label the dialog tried to add is not on the ticket, judged from the ticket's labels
 * as they are now. `created`: a saved label was created for it first, so the catalog has it
 * although the ticket does not (a retry then offers it under "Apply it").
 */
function notAddedMessage(
  outcome: Exclude<TicketLabelWriteOutcome, 'applied'>,
  current: readonly TicketLabel[],
  name: string,
  created: boolean
): string {
  if (outcome === 'unchanged' && hasTicketLabelNamed(current, name)) return 'Already on this ticket'
  if (outcome === 'unchanged' && !canAddTicketLabel(current)) {
    return created
      ? `The label was saved, but this ticket already has ${TICKET_LABELS_MAX} labels, the most it can carry.`
      : FULL_MESSAGE
  }
  return created
    ? 'The label was saved, but not added to this ticket. Try again.'
    : "Couldn't add the label. Try again."
}

/**
 * Board-level host for the "New label" / "One-off label" dialog, driven by the labels store's
 * dialog (the card's Labels submenu opens it). Mounted once per board, beside RenameTicketDialog,
 * rather than inside the card: the card's menu has closed by the time it opens, and the ticket
 * is looked up by project and id (markdown ticket ids are only unique within a project).
 */
export function TicketLabelDialog() {
  const dialog = useTicketLabelsStore((s) => s.dialog)
  const createDialog = dialog?.kind === 'create' ? dialog : null
  const projectId = createDialog?.projectId ?? null
  const ticketId = createDialog?.ticketId ?? null
  const ticket = useKanbanStore(
    useCallback(
      (s) =>
        projectId && ticketId
          ? (s.tickets.get(projectId)?.find((t) => t.id === ticketId) ?? null)
          : null,
      [projectId, ticketId]
    )
  )

  if (!createDialog || !ticket) return null

  return (
    <TicketLabelCreateDialog
      key={`${createDialog.projectId}:${createDialog.ticketId}:${createDialog.mode}`}
      ticket={ticket}
      initialMode={createDialog.mode}
    />
  )
}

interface TicketLabelCreateDialogProps {
  ticket: KanbanTicket
  /** Which menu entry opened it; the "Save for reuse" checkbox switches it in place. */
  initialMode: TicketLabelMode
}

/**
 * Names a label, picks its colour and puts it on the ticket at once. A saved label joins the
 * catalog (offered on every ticket's menu); a one-off lives on this ticket only and leaves no
 * record once removed. The name is checked against the ticket (no label twice) and the catalog
 * (reuse the saved label rather than make a second one).
 */
function TicketLabelCreateDialog({ ticket, initialMode }: TicketLabelCreateDialogProps) {
  const catalog = useTicketLabelsStore(savedTicketLabelsOf)
  const [mode, setMode] = useState<TicketLabelMode>(initialMode)
  const [name, setName] = useState('')
  // The default colour of a saved label is fixed when the dialog opens: one created elsewhere
  // meanwhile must not change the swatch under the user. A colour picked by hand is kept when
  // the mode changes; until then a one-off defaults to gray.
  const [savedDefaultColor] = useState(() =>
    leastUsedTicketLabelColor(savedTicketLabelsOf(useTicketLabelsStore.getState()))
  )
  const [pickedColor, setPickedColor] = useState<TicketLabelColor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputId = useId()
  const saveId = useId()

  const color = pickedColor ?? (mode === 'saved' ? savedDefaultColor : 'gray')
  const ref = { projectId: ticket.project_id, ticketId: ticket.id }
  const labels = ticketLabelsOf(ticket)
  const normalized = normalizeTicketLabelName(name)
  const isEmpty = normalized.length === 0
  const onTicket = !isEmpty && hasTicketLabelNamed(labels, normalized)
  const nameKey = ticketLabelNameKey(normalized)
  const savedMatch: SavedTicketLabel | null =
    isEmpty || onTicket
      ? null
      : (catalog.find((label) => ticketLabelNameKey(label.name) === nameKey) ?? null)
  const isFull = !canAddTicketLabel(labels)
  // A saved label of that name exists: offer it rather than create a duplicate
  const blockedBySaved = mode === 'saved' && savedMatch !== null
  const canSubmit = !isEmpty && !onTicket && !isFull && !blockedBySaved && !busy

  const close = useCallback(() => useTicketLabelsStore.getState().closeDialog(), [])

  /**
   * Puts the label on the ticket, then closes. When it did not go on (the write failed, or the
   * ticket filled up meanwhile) the dialog stays open with the reason, keeping the name, colour
   * and mode, so nothing typed is lost. `created`: see notAddedMessage.
   */
  const attach = async (label: TicketLabel, created = false): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await setTicketLabel(ref, label, true, NO_SESSION)
      if (outcome === 'applied') {
        close()
        return
      }
      const latest = findTicket(ref)
      if (!latest) {
        // Deleted or moved away meanwhile, and the dialog went with it. A failed write has
        // already said so in its own toast.
        close()
        if (outcome === 'unchanged') toast.error("The ticket is gone, so the label wasn't added")
        return
      }
      const current = ticketLabelsOf(latest)
      // Already there (ticked from the menu meanwhile, or a write reported failed that landed
      // after all, as the reload shows): nothing is left to do
      if (current.some((entry) => entry.id === label.id)) {
        close()
        return
      }
      setError(notAddedMessage(outcome, current, label.name, created))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    if (mode === 'once') {
      await attach({ id: crypto.randomUUID(), kind: 'once', name: normalized, color })
      return
    }
    setBusy(true)
    setError(null)
    let saved: SavedTicketLabel
    try {
      saved = await useTicketLabelsStore.getState().create({ name: normalized, color })
    } catch (err) {
      // E.g. the name was taken by another window meanwhile: the dialog stays open to fix it
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
      return
    }
    await attach({ id: saved.id, kind: 'saved', name: saved.name, color: saved.color }, true)
  }

  const applySaved = (): void => {
    if (!savedMatch || busy || isFull) return
    void attach({ id: savedMatch.id, kind: 'saved', name: savedMatch.name, color: savedMatch.color })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Enter that confirms an IME candidate (Japanese, Chinese…) must not add the label
    if (isComposingKeyboardEvent(e.nativeEvent)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    }
  }

  const Icon = mode === 'saved' ? Tag : PenLine

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="max-w-sm"
        data-testid="ticket-label-dialog"
        // Tab moves between the fields here, never toggling the mode of the session behind
        data-tab-navigates=""
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Icon className="h-4 w-4" />
            {mode === 'saved' ? 'New label' : 'One-off label'}
          </DialogTitle>
          <DialogDescription className="truncate text-xs">
            {visibleTicketTitle(ticket)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor={inputId} className="text-xs font-medium">
                Name
              </label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {name.length}/{TICKET_LABEL_NAME_MAX}
              </span>
            </div>
            <Input
              id={inputId}
              autoFocus
              data-testid="ticket-label-name-input"
              value={name}
              maxLength={TICKET_LABEL_NAME_MAX}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              onKeyDown={handleKeyDown}
              placeholder={`e.g. ${EXAMPLE_NAME[mode]}`}
              aria-invalid={onTicket || error !== null || undefined}
              disabled={busy}
            />
            {onTicket ? (
              <p data-testid="ticket-label-on-ticket" className="text-[11px] text-destructive">
                Already on this ticket
              </p>
            ) : error ? (
              <p data-testid="ticket-label-error" role="alert" className="text-[11px] text-destructive">
                {error}
              </p>
            ) : isFull ? (
              <p className="text-[11px] text-destructive">{FULL_MESSAGE}</p>
            ) : null}
            {/* Shown beside an error too: after "saved, but not added" it is the way to retry */}
            {savedMatch && !isFull ? (
              <div
                data-testid="ticket-label-saved-match"
                className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                {mode === 'saved' ? (
                  <>
                    <TicketLabelChip label={savedMatch} className="max-w-[160px]" />
                    <span>already exists.</span>
                  </>
                ) : (
                  <>
                    <span>Matches saved label</span>
                    <TicketLabelChip label={savedMatch} className="max-w-[160px]" />
                  </>
                )}
                <Button
                  type="button"
                  variant="link"
                  data-testid="ticket-label-apply-saved"
                  className="h-auto p-0 text-[11px]"
                  onClick={applySaved}
                  disabled={busy}
                >
                  {mode === 'saved' ? 'Apply it' : 'Apply saved label'}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Colour</span>
            <TicketLabelColorPicker
              value={color}
              onChange={setPickedColor}
              ariaLabel="Colour"
              disabled={busy}
            />
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">Preview</span>
            <TicketLabelChip
              label={{ name: isEmpty ? EXAMPLE_NAME[mode] : normalized, color }}
              dimmed={isEmpty}
              className="max-w-[220px]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id={saveId}
                data-testid="ticket-label-save-checkbox"
                checked={mode === 'saved'}
                onCheckedChange={(checked) => {
                  setMode(checked ? 'saved' : 'once')
                  setError(null)
                }}
                disabled={busy}
              />
              <label htmlFor={saveId} className="text-xs">
                Save for reuse on other tickets
              </label>
            </div>
            {mode === 'once' && (
              <p className="pl-6 text-[11px] text-muted-foreground">
                Only on this ticket. Once removed, it&rsquo;s gone for good.
              </p>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground">
            Labels only show on the board. They&rsquo;re never sent to the model.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="ticket-label-submit"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {busy ? 'Adding…' : 'Add label'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
