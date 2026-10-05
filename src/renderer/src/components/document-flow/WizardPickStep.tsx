import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Loader2, Trash2, Upload } from 'lucide-react'
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
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { selectRunsForProject, useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import type { DocumentRunDetail } from '@shared/types/document-flow'
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
}

export function WizardPickStep({ projectId }: WizardPickStepProps): React.JSX.Element {
  const createRun = useDocumentFlowStore((s) => s.createRun)
  const [pathInput, setPathInput] = useState('')
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
      const detail = await createRun(projectId, parsed.path)
      markRunAwaitingPrefs(detail.run.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }, [createRun, pathInput, projectId, submitting])

  const stopDrag = (event: React.DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
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
          Document path
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="docflow-path"
            data-testid="docflow-path-input"
            placeholder="/absolute/path/to/spec.html, ~/spec.md or file:///…"
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

      <PreviousRuns projectId={projectId} />
    </div>
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
          return (
            <div key={detail.run.id} className="flex items-center gap-1 pr-1.5">
              <button
                type="button"
                data-testid={`docflow-run-row-${detail.run.id}`}
                className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/40"
                onClick={() => openRun(detail)}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-foreground">
                    {detail.run.title || documentNameFromPath(detail.run.source_path)}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {runCountsLabel(detail)} · {formatRunDate(detail.run.created_at)}
                  </span>
                </span>
                <TonePill tone={status.tone}>{status.label}</TonePill>
              </button>
              {isRunDeletable(detail.run.status) && (
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
              {deleteTarget?.run.title || 'This run'} and its extracted tickets are removed from the
              list. {describeRunDeletion(deleteTarget?.items ?? [])}
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
