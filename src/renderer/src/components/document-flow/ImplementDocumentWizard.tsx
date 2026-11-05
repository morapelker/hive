import { useEffect, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { resolveDocumentFlowGeneration, useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { isTicketRun, type DocumentRun } from '@shared/types/document-flow'
import { documentNameFromPath, formatGeneration, wizardStep } from './document-flow-ui'
import type { WizardSource } from './ticket-run-ui'
import { WizardPickStep } from './WizardPickStep'
import { WizardPreviewStep } from './WizardPreviewStep'

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * The global "Implement document" dialog: pick a spec document, wait for its tickets to be
 * extracted, review and edit them, launch the run. Which step shows is read off the run the
 * wizard points at, so closing and reopening (or a restart) lands where the run is.
 *
 * The same dialog is "Orchestrate tickets" when the run is made from board tickets instead:
 * the pick step's switch (or "Orchestrate tickets…", which opens on it) picks tickets already
 * on the board, and the run is created straight into its preview — no extraction step.
 */
export function ImplementDocumentWizard(): React.JSX.Element {
  const wizard = useDocumentFlowStore((s) => s.wizard)
  const detail = useDocumentFlowStore((s) =>
    s.wizard.runId ? s.runsById[s.wizard.runId] : undefined
  )
  const closeWizard = useDocumentFlowStore((s) => s.closeWizard)
  const openWizard = useDocumentFlowStore((s) => s.openWizard)
  const refreshRun = useDocumentFlowStore((s) => s.refreshRun)
  const project = useProjectStore((s) =>
    wizard.projectId ? s.projects.find((candidate) => candidate.id === wizard.projectId) : undefined
  )

  const { open, projectId, runId } = wizard
  const step = wizardStep(runId, detail?.run.status)
  // The pick step's source. Each opening starts where it was asked to ("Orchestrate tickets…"
  // opens on the board's tickets, everything else on a document), whatever was chosen before.
  const requestedSource: WizardSource = wizard.source ?? 'document'
  const [source, setSource] = useState<WizardSource>(requestedSource)
  const openedWith = `${open}:${requestedSource}`
  const [seenOpening, setSeenOpening] = useState(openedWith)
  if (seenOpening !== openedWith) {
    setSeenOpening(openedWith)
    setSource(requestedSource)
  }
  const ticketsMode = detail ? isTicketRun(detail.run) : source === 'tickets'
  // Esc, the X and the overlay are ignored while a launch is in flight: on success the dialog
  // closes itself, on failure it is the only place the reason is shown in full.
  const [launching, setLaunching] = useState(false)

  // Opened on a run this client has not loaded yet (or that was deleted meanwhile).
  useEffect(() => {
    if (!open || !projectId || !runId || step !== 'loading') return
    let cancelled = false
    void refreshRun(runId).then((loaded) => {
      if (!cancelled && !loaded) openWizard(projectId, null)
    })
    return () => {
      cancelled = true
    }
  }, [open, projectId, runId, step, refreshRun, openWizard])

  const isPreview = step === 'preview' && !!project && !!detail

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !launching) closeWizard()
      }}
    >
      <DialogContent
        data-testid="docflow-wizard"
        data-docflow-dialog=""
        data-step={step}
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          isPreview ? 'h-[85vh] max-w-5xl' : 'max-h-[80vh] max-w-xl'
        )}
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3 pt-4">
          <DialogTitle className="text-[15px]" data-testid="docflow-wizard-title">
            {ticketsMode ? 'Orchestrate tickets' : 'Implement document'}
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            {ticketsMode ? describeTicketsWizard(project) : describeWizard(project)}
          </DialogDescription>
        </DialogHeader>

        {!project || !projectId ? (
          <StepMessage testId="docflow-wizard-no-project">
            This project is no longer open. Select a project and try again.
          </StepMessage>
        ) : step === 'pick' ? (
          <WizardPickStep projectId={projectId} source={source} onSourceChange={setSource} />
        ) : step === 'loading' || !detail ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading the run…
          </div>
        ) : step === 'extracting' ? (
          <ExtractingStep run={detail.run} />
        ) : step === 'failed' ? (
          <FailedStep run={detail.run} projectId={projectId} />
        ) : step === 'preview' ? (
          <WizardPreviewStep
            key={detail.run.id}
            detail={detail}
            project={project}
            onLaunchingChange={setLaunching}
          />
        ) : (
          <LaunchedStep run={detail.run} />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The dialog's one-line description: a connection project runs the tickets into an
 * integration branch in every member repository at once, a git project into one branch.
 */
function describeWizard(
  project: { name: string; kind?: 'git' | 'connection' } | undefined
): string {
  if (!project) return 'Turn a spec document into tickets and run them into one integration branch.'
  return project.kind === 'connection'
    ? `Turn a spec document into tickets for ${project.name} and run them into one integration branch per member repository.`
    : `Turn a spec document into tickets for ${project.name} and run them into one integration branch.`
}

/** The same, for an orchestrator made from tickets already on the project's board. */
function describeTicketsWizard(
  project: { name: string; kind?: 'git' | 'connection' } | undefined
): string {
  if (!project) return 'Run tickets from the board into one integration branch.'
  return project.kind === 'connection'
    ? `Run tickets from the ${project.name} board into one integration branch per member repository.`
    : `Run tickets from the ${project.name} board into one integration branch.`
}

function StepMessage({
  children,
  testId
}: {
  children: React.ReactNode
  testId: string
}): React.JSX.Element {
  return (
    <p className="px-5 py-6 text-[13px] leading-relaxed text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  )
}

function ExtractingStep({ run }: { run: DocumentRun }): React.JSX.Element {
  const generation = run.config.generation ?? resolveDocumentFlowGeneration()
  return (
    <div
      className="flex flex-col items-center gap-3 px-5 py-10 text-center"
      data-testid="docflow-extracting"
    >
      <Loader2 className="h-6 w-6 animate-spin text-blue-400" />
      <p className="text-[13px] text-foreground">
        Extracting tickets from{' '}
        <span className="font-mono text-[12px]">{documentNameFromPath(run.source_path)}</span>
      </p>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        Reading the document with{' '}
        <span className="text-foreground" data-testid="docflow-extracting-model">
          {formatGeneration(generation)}
        </span>
        , inside the project, with read-only access to its files. This is the default model for
        building; change it in Settings › Models.
      </p>
      <RunNotes run={run} />
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        You can close this dialog. Extraction continues, and the run shows up under Previous runs.
      </p>
    </div>
  )
}

function FailedStep({
  run,
  projectId
}: {
  run: DocumentRun
  projectId: string
}): React.JSX.Element {
  const retryExtraction = useDocumentFlowStore((s) => s.retryExtraction)
  const openWizard = useDocumentFlowStore((s) => s.openWizard)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  const retry = async (): Promise<void> => {
    setRetrying(true)
    setRetryError(null)
    try {
      await retryExtraction(run.id)
    } catch (cause) {
      setRetryError(errorMessage(cause))
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="space-y-4 px-5 py-5" data-testid="docflow-extract-failed">
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div className="min-w-0 space-y-1">
          <p className="text-[13px] text-foreground">
            No tickets could be extracted from{' '}
            <span className="font-mono text-[12px]">{documentNameFromPath(run.source_path)}</span>
          </p>
          <p
            className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-destructive"
            data-testid="docflow-extract-error"
          >
            {retryError ?? run.error ?? 'The extraction failed without an error message.'}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          data-testid="docflow-choose-another-btn"
          onClick={() => openWizard(projectId, null)}
        >
          Choose another document
        </Button>
        <Button
          type="button"
          data-testid="docflow-retry-extraction-btn"
          disabled={retrying}
          onClick={() => void retry()}
        >
          {retrying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Try again
        </Button>
      </div>
    </div>
  )
}

/** The notes the document was picked with; they apply to every extraction of the run. */
function RunNotes({ run }: { run: DocumentRun }): React.JSX.Element | null {
  if (!run.config.notes) return null
  return (
    <p
      className="max-w-md whitespace-pre-wrap break-words rounded-md border border-border px-3 py-2 text-left text-[12px] leading-relaxed text-muted-foreground"
      data-testid="docflow-run-notes"
    >
      <span className="text-foreground">Your notes: </span>
      {run.config.notes}
    </p>
  )
}

/** The wizard was pointed at a run that is already past preview; its place is the dashboard. */
function LaunchedStep({ run }: { run: DocumentRun }): React.JSX.Element {
  const openDashboard = useDocumentFlowStore((s) => s.openDashboard)
  const closeWizard = useDocumentFlowStore((s) => s.closeWizard)
  return (
    <div className="space-y-4 px-5 py-5" data-testid="docflow-wizard-launched">
      <p className="text-[13px] text-muted-foreground">
        <span className="text-foreground">{run.title}</span> has already been launched.
      </p>
      <div className="flex justify-end">
        <Button
          type="button"
          data-testid="docflow-open-dashboard-btn"
          onClick={() => {
            openDashboard(run.id)
            closeWizard()
          }}
        >
          Open the run
        </Button>
      </div>
    </div>
  )
}
