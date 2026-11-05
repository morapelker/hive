import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, KanbanSquare, Loader2, Trash2, Upload, Workflow } from 'lucide-react'
import { getDesktopBridge } from '@/api/desktop-bridge'
import { fileApi } from '@/api/file-api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { selectRunsForProject, useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { defaultTicketRunTitle, runKindLabel } from '@shared/document-flow/ticket-runs'
import {
  DOCUMENT_RUN_NOTES_LIMIT,
  isTicketRun,
  type DocumentRunDetail
} from '@shared/types/document-flow'
import { TonePill } from './DocumentFlowBadges'
import {
  DOCUMENT_FILE_ACCEPT,
  describeRunDeletion,
  documentNameFromPath,
  formatRunDate,
  isLaunchedRunStatus,
  isRunDeletable,
  parseDocumentPath,
  runCountsLabel,
  runStatusDisplay
} from './document-flow-ui'
import { describeTicketRunDeletion, orderTicketIdsForRun, type WizardSource } from './ticket-run-ui'
import { TicketRunPicker } from './TicketRunPicker'
import { useBoardTicketsForRun } from './useTicketRunBoard'
import { markRunAwaitingPrefs } from './useRunConfigDraft'

const SECTION_LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

/**
 * AppLayout's window-level drop zone attaches every dropped file to the active session. While
 * a document is being picked, file drags stop here instead, including the ones that miss the
 * drop zone and would otherwise make the window navigate to the file.
 */
function useBlockGlobalFileDrop(): void {
  useEffect(() => {
    const swallow = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
    }
    const events = ['dragenter', 'dragover', 'dragleave', 'drop'] as const
    for (const name of events) document.addEventListener(name, swallow)
    return () => {
      for (const name of events) document.removeEventListener(name, swallow)
    }
  }, [])
}

interface WizardPickStepProps {
  projectId: string
  /**
   * Where the run's tickets come from: a spec document (extracted into tickets) or tickets
   * already on the board. Held by the wizard (its title follows it); without it the step keeps
   * its own, starting from the wizard state's `source`.
   */
  source?: WizardSource
  onSourceChange?: (source: WizardSource) => void
}

/**
 * The wizard's first step: choose the document to implement, or (with the switch on top) the
 * board tickets to orchestrate; below either, the project's previous runs. The document side
 * is the original flow, unchanged.
 */
export function WizardPickStep({
  projectId,
  source: controlledSource,
  onSourceChange
}: WizardPickStepProps): React.JSX.Element {
  const initialSource = useDocumentFlowStore((s) => s.wizard.source ?? 'document')
  const [ownSource, setOwnSource] = useState<WizardSource>(initialSource)
  const source = controlledSource ?? ownSource
  const changeSource = (next: WizardSource): void => {
    setOwnSource(next)
    onSourceChange?.(next)
  }
  const createRun = useDocumentFlowStore((s) => s.createRun)
  const [pathInput, setPathInput] = useState('')
  const [notes, setNotes] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // The web UI cannot turn a File into a path on this machine; it gets the path field only.
  const canPickFiles = typeof getDesktopBridge()?.getPathForFile === 'function'

  useBlockGlobalFileDrop()

  const takeFile = useCallback((file: File | undefined): void => {
    if (!file) return
    let path = ''
    try {
      path = fileApi.getPathForFile(file)
    } catch {
      path = ''
    }
    if (!path) {
      setError('Could not read the location of that file. Type its path instead.')
      return
    }
    setPathInput(path)
    setError(null)
  }, [])

  const handleExtract = useCallback(async (): Promise<void> => {
    if (submitting) return
    const parsed = parseDocumentPath(pathInput)
    if (parsed.path === null) {
      setError(parsed.error)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const detail = await createRun(projectId, parsed.path, notes)
      markRunAwaitingPrefs(detail.run.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }, [createRun, notes, pathInput, projectId, submitting])

  const stopDrag = (event: React.DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <SourceSwitch value={source} onChange={changeSource} />
      {source === 'tickets' ? (
        <TicketsPick projectId={projectId} />
      ) : (
        <>
          {canPickFiles && (
            <div
              data-testid="docflow-drop-zone"
              className={cn(
                'flex flex-col items-center gap-2 rounded-[8px] border border-dashed border-border px-4 py-6 text-center transition-colors',
                isDragOver && 'border-ring bg-accent/40'
              )}
              onDragEnter={(event) => {
                stopDrag(event)
                setIsDragOver(true)
              }}
              onDragOver={(event) => {
                stopDrag(event)
                event.dataTransfer.dropEffect = 'copy'
              }}
              onDragLeave={(event) => {
                stopDrag(event)
                setIsDragOver(false)
              }}
              onDrop={(event) => {
                stopDrag(event)
                setIsDragOver(false)
                takeFile(event.dataTransfer.files[0])
              }}
            >
              <Upload className="h-5 w-5 text-muted-foreground" />
              <p className="text-[13px] text-foreground">Drop a spec document here</p>
              <p className="text-[11px] text-muted-foreground">HTML, Markdown or plain text</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="docflow-choose-file-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose file
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={DOCUMENT_FILE_ACCEPT}
                className="hidden"
                data-testid="docflow-file-input"
                onChange={(event) => {
                  takeFile(event.target.files?.[0])
                  event.target.value = ''
                }}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="docflow-path" className={SECTION_LABEL_CLASS}>
              Document path or link
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="docflow-path"
                data-testid="docflow-path-input"
                placeholder="/absolute/path/to/spec.html, ~/spec.md or https://…"
                value={pathInput}
                autoFocus
                spellCheck={false}
                className="font-mono text-[12px]"
                onChange={(event) => {
                  setPathInput(event.target.value)
                  setError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void handleExtract()
                  }
                }}
              />
              <Button
                type="button"
                data-testid="docflow-extract-btn"
                disabled={!pathInput.trim() || submitting}
                onClick={() => void handleExtract()}
              >
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Extract tickets
              </Button>
            </div>
            {error && (
              <p className="text-[12px] text-destructive" data-testid="docflow-pick-error">
                {error}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="docflow-notes" className={SECTION_LABEL_CLASS}>
              Notes (optional)
            </label>
            <Textarea
              id="docflow-notes"
              data-testid="docflow-notes-input"
              placeholder="Anything the extraction should know, e.g. “only tasks 7, 8 and 9” or “skip the mobile section”."
              value={notes}
              rows={3}
              maxLength={DOCUMENT_RUN_NOTES_LIMIT}
              className="resize-y text-[12px]"
              onChange={(event) => setNotes(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void handleExtract()
                }
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Given to the model that reads the document: they decide which tickets are created and
              how.
            </p>
          </div>
        </>
      )}

      <PreviousRuns projectId={projectId} />
    </div>
  )
}

const SOURCES: {
  value: WizardSource
  label: string
  icon: typeof FileText
  testId: string
}[] = [
  { value: 'document', label: 'Document', icon: FileText, testId: 'docflow-source-document' },
  {
    value: 'tickets',
    label: 'Board tickets',
    icon: KanbanSquare,
    testId: 'docflow-source-tickets'
  }
]

const RADIO_ARROW_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']

/** "Document | Board tickets": where the run's tickets come from. */
function SourceSwitch({
  value,
  onChange
}: {
  value: WizardSource
  onChange: (source: WizardSource) => void
}): React.JSX.Element {
  const group = useRef<HTMLDivElement>(null)
  // An arrow key keeps the focus on the switch, also over a field the new source focuses as it
  // mounts: after the commit, hence an effect.
  const refocus = useRef(false)
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [value])
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label="Make the run from"
      className="inline-flex h-8 w-fit shrink-0 items-center rounded-[8px] bg-secondary p-0.5 text-muted-foreground"
    >
      {SOURCES.map((option) => {
        const Icon = option.icon
        const active = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            // A radio group is one tab stop, the checked option: the dialog's first focus lands
            // on what is selected, and the arrow keys move between the options.
            tabIndex={active ? 0 : -1}
            data-testid={option.testId}
            className={cn(
              'inline-flex items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 py-1 text-[13px] font-medium tracking-[0.01em] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active ? 'bg-background text-foreground' : 'hover:text-foreground'
            )}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (!RADIO_ARROW_KEYS.includes(event.key)) return
              event.preventDefault()
              const other = SOURCES.find((source) => source.value !== option.value)
              if (!other) return
              refocus.current = true
              onChange(other.value)
            }}
          >
            <Icon className="h-3.5 w-3.5" />
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The tickets side of the pick step: check board tickets (with what they wait for on the
 * board), optionally name the orchestrator, and create it. It is created straight into its
 * preview, where the tickets, their dependencies and the run settings are reviewed before
 * anything launches; the remembered run settings apply there as for a document.
 */
function TicketsPick({ projectId }: { projectId: string }): React.JSX.Element {
  const createTicketRun = useDocumentFlowStore((s) => s.createTicketRun)
  const preselectedIds = useDocumentFlowStore((s) => s.wizard.preselectedTicketIds)
  const board = useBoardTicketsForRun(projectId)
  const [selectedIds, setSelectedIds] = useState<string[]>(() => preselectedIds ?? [])
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Opened again from a card with other tickets checked: start from those.
  const preselectedKey = preselectedIds?.join('\n') ?? ''
  const [seenPreselection, setSeenPreselection] = useState(preselectedKey)
  if (seenPreselection !== preselectedKey) {
    setSeenPreselection(preselectedKey)
    setSelectedIds(preselectedIds ?? [])
  }

  const { refusalOf, tickets, ticketsById, blockersOf } = board
  const ordered = useMemo(
    () =>
      orderTicketIdsForRun(
        selectedIds.filter((id) => refusalOf(id) === null),
        tickets.map((ticket) => ticket.id),
        blockersOf
      ),
    [selectedIds, refusalOf, tickets, blockersOf]
  )
  const orderedTickets = ordered.flatMap((id) => {
    const ticket = ticketsById.get(id)
    return ticket ? [ticket] : []
  })

  const create = async (): Promise<void> => {
    if (submitting || ordered.length === 0) return
    setSubmitting(true)
    setError(null)
    // The remembered run settings apply when the run is first previewed. A document's run
    // reaches its preview long after it is created (the extraction comes first); this one is
    // created straight into it, and the preview mounts as soon as the wizard turns to the run
    // — before `createTicketRun` has returned to this function. So the run is marked the moment
    // the wizard turns to it: the store's listeners run as it changes, ahead of React's render.
    // Only a run that did not exist before counts (a previous run opened meanwhile keeps the
    // settings it has).
    const known = new Set(Object.keys(useDocumentFlowStore.getState().runsById))
    const stopWatching = useDocumentFlowStore.subscribe((state, previous) => {
      const runId = state.wizard.runId
      if (runId && runId !== previous.wizard.runId && !known.has(runId)) {
        markRunAwaitingPrefs(runId)
      }
    })
    try {
      await createTicketRun(projectId, ordered, name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      stopWatching()
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="space-y-1.5">
        <p className={SECTION_LABEL_CLASS}>Tickets</p>
        <TicketRunPicker
          projectId={projectId}
          selectedIds={selectedIds}
          onSelectedIdsChange={(ids) => {
            setSelectedIds(ids)
            setError(null)
          }}
          board={board}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="docflow-ticket-run-name" className={SECTION_LABEL_CLASS}>
          Name (optional)
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="docflow-ticket-run-name"
            data-testid="docflow-ticket-run-name"
            placeholder={
              orderedTickets.length > 0
                ? defaultTicketRunTitle(orderedTickets)
                : 'Named after its first ticket'
            }
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void create()
              }
            }}
          />
          <Button
            type="button"
            data-testid="docflow-create-ticket-run"
            disabled={ordered.length === 0 || submitting}
            onClick={() => void create()}
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create orchestrator{ordered.length > 0 ? ` (${ordered.length})` : ''}
          </Button>
        </div>
        {error && (
          <p className="text-[12px] text-destructive" data-testid="docflow-pick-error">
            {error}
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          The tickets run into one integration branch, each in its own worktree, in the order their
          dependencies allow. Nothing launches until you review them and launch the run.
        </p>
      </div>
    </>
  )
}

function PreviousRuns({ projectId }: { projectId: string }): React.JSX.Element | null {
  const runsById = useDocumentFlowStore((s) => s.runsById)
  const loaded = useDocumentFlowStore((s) => s.loadedProjects[projectId] === true)
  const loadRuns = useDocumentFlowStore((s) => s.loadRuns)
  const openWizard = useDocumentFlowStore((s) => s.openWizard)
  const closeWizard = useDocumentFlowStore((s) => s.closeWizard)
  const openDashboard = useDocumentFlowStore((s) => s.openDashboard)
  const deleteRun = useDocumentFlowStore((s) => s.deleteRun)
  const [deleteTarget, setDeleteTarget] = useState<DocumentRunDetail | null>(null)
  const runs = useMemo(() => selectRunsForProject(runsById, projectId), [runsById, projectId])

  useEffect(() => {
    void loadRuns(projectId)
  }, [loadRuns, projectId])

  const openRun = (detail: DocumentRunDetail): void => {
    if (isLaunchedRunStatus(detail.run.status)) {
      openDashboard(detail.run.id)
      closeWizard()
    } else {
      openWizard(projectId, detail.run.id)
    }
  }

  const confirmDelete = (): void => {
    if (!deleteTarget) return
    const runId = deleteTarget.run.id
    setDeleteTarget(null)
    deleteRun(runId).catch((cause: unknown) => {
      toast.error(
        `Could not delete the run: ${cause instanceof Error ? cause.message : String(cause)}`
      )
    })
  }

  if (runs.length === 0) {
    return loaded ? null : (
      <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading previous runs…
      </p>
    )
  }

  return (
    <div className="space-y-1.5" data-testid="docflow-previous-runs">
      <p className={SECTION_LABEL_CLASS}>Previous runs</p>
      <div className="divide-y divide-border rounded-[8px] border border-border">
        {runs.map((detail) => {
          const status = runStatusDisplay(detail.run, detail.items)
          const ticketRun = isTicketRun(detail.run)
          const KindIcon = ticketRun ? Workflow : FileText
          return (
            <div key={detail.run.id} className="flex items-center gap-1 pr-1.5">
              <button
                type="button"
                data-testid={`docflow-run-row-${detail.run.id}`}
                className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/40"
                onClick={() => openRun(detail)}
              >
                <KindIcon
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-label={runKindLabel(detail.run)}
                  data-testid={`docflow-run-kind-${detail.run.id}`}
                  data-kind={detail.run.source_kind}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-foreground">
                    {detail.run.title ||
                      (ticketRun
                        ? runKindLabel(detail.run)
                        : documentNameFromPath(detail.run.source_path))}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {runCountsLabel(detail)} · {formatRunDate(detail.run.created_at)}
                  </span>
                </span>
                <TonePill tone={status.tone}>{status.label}</TonePill>
              </button>
              {isRunDeletable(detail.run.status, detail.run) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title="Delete run"
                  aria-label={`Delete run ${detail.run.title}`}
                  data-testid={`docflow-run-delete-${detail.run.id}`}
                  className="text-muted-foreground"
                  onClick={() => setDeleteTarget(detail)}
                >
                  <Trash2 />
                </Button>
              )}
            </div>
          )
        })}
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent data-docflow-dialog="">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this run?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && isTicketRun(deleteTarget.run) ? (
                <>
                  {deleteTarget.run.title || 'This orchestrator'} is removed from the list.{' '}
                  {describeTicketRunDeletion(isLaunchedRunStatus(deleteTarget.run.status))}
                </>
              ) : (
                <>
                  {deleteTarget?.run.title || 'This run'} and its extracted tickets are removed from
                  the list. {describeRunDeletion(deleteTarget?.items ?? [])}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="docflow-run-delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="docflow-run-delete-confirm"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
