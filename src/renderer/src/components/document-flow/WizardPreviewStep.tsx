import { useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Rocket } from 'lucide-react'
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
import {
  getCachedModelCatalog,
  getModelCatalogCacheVersion,
  loadHandoffModelCatalog,
  subscribeModelCatalogCache
} from '@/lib/handoffSelection'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import type { HandoffAgentSdk } from '@shared/types/agent-sdk'
import type { DocumentRunConfig, DocumentRunDetail } from '@shared/types/document-flow'
import { DocumentRunItemEditor } from './DocumentRunItemEditor'
import { DocumentRunSettingsPanel } from './DocumentRunSettingsPanel'
import { describeLaunchConfig, validateLaunch } from './document-flow-launch'
import { describeBaseBranch, pluralize } from './document-flow-ui'
import { useBaseBranchOptions } from './useBaseBranchOptions'
import { PendingWritesProvider, usePendingWrites } from './useDebouncedText'
import { useRunConfigDraft } from './useRunConfigDraft'

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

interface WizardPreviewStepProps {
  detail: DocumentRunDetail
  projectPath: string
  /** Reports whether a launch is in flight, so the dialog can refuse to close meanwhile. */
  onLaunchingChange: (launching: boolean) => void
}

/** The extracted tickets and the run settings, editable until the run is launched. */
export function WizardPreviewStep({
  detail,
  projectPath,
  onLaunchingChange
}: WizardPreviewStepProps): React.JSX.Element {
  const { run, items } = detail
  const updateItem = useDocumentFlowStore((s) => s.updateItem)
  const updateRun = useDocumentFlowStore((s) => s.updateRun)
  const startRun = useDocumentFlowStore((s) => s.startRun)
  const retryExtraction = useDocumentFlowStore((s) => s.retryExtraction)
  const closeWizard = useDocumentFlowStore((s) => s.closeWizard)
  const openDashboard = useDocumentFlowStore((s) => s.openDashboard)

  const pendingWrites = usePendingWrites()
  const draft = useRunConfigDraft(run)
  const branches = useBaseBranchOptions(projectPath)
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [confirm, setConfirm] = useState<'launch' | 'reextract' | null>(null)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)

  // Variants are checked against the SDK's model catalog, which may still be loading.
  useSyncExternalStore(subscribeModelCatalogCache, getModelCatalogCacheVersion)
  const validation = validateLaunch(items, draft.config.defaultLaunch, getCachedModelCatalog)
  const variantSdks = [
    ...new Set(
      [draft.config.defaultLaunch, ...items.map((item) => item.launch_config)].flatMap(
        (config): HandoffAgentSdk[] => (config?.model?.variant ? [config.sdk] : [])
      )
    )
  ]
    .sort()
    .join(',')
  useEffect(() => {
    for (const sdk of variantSdks.split(',')) {
      if (sdk) void loadHandoffModelCatalog(sdk as HandoffAgentSdk)
    }
  }, [variantSdks])

  const extraction = run.extraction
  const documentTitle = extraction?.documentTitle || run.title
  const ownModelCount = items.filter((item) => item.selected && item.launch_config).length

  const setAllSelected = (selected: boolean): void => {
    for (const item of items) {
      if (item.selected === selected) continue
      updateItem(run.id, item.id, { selected }).catch((cause: unknown) => {
        toast.error(`Could not update ${item.key}: ${errorMessage(cause)}`)
      })
    }
  }

  const reextract = (): void => {
    retryExtraction(run.id).catch((cause: unknown) => {
      toast.error(`Could not re-extract the tickets: ${errorMessage(cause)}`)
    })
  }

  const launch = async (): Promise<void> => {
    if (launching) return
    setLaunching(true)
    onLaunchingChange(true)
    setLaunchError(null)
    try {
      await pendingWrites.flushAll()
      await updateRun(run.id, { config: draft.settle() })
      await startRun(run.id)
      closeWizard()
      openDashboard(run.id)
    } catch (cause) {
      // Also as a toast: the wizard may have been closed (Cmd+W) while the launch was in
      // flight, and then nothing else says that the run never started.
      setLaunchError(errorMessage(cause))
      toast.error(`The run could not be launched: ${errorMessage(cause)}`)
    } finally {
      setLaunching(false)
      onLaunchingChange(false)
    }
  }

  return (
    <PendingWritesProvider value={pendingWrites}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="space-y-2 border-b border-border px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p
                  className="truncate text-[14px] font-semibold text-foreground"
                  title={documentTitle}
                >
                  {documentTitle}
                </p>
                <p className="text-[12px] text-muted-foreground" data-testid="docflow-preview-meta">
                  {pluralize(items.length, 'ticket')} · {validation.selectedCount} selected
                  {extraction?.numbering && ` · numbered ${extraction.numbering}`}
                  {extraction?.generatedBy && ` · extracted by ${extraction.generatedBy}`}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="docflow-reextract-btn"
                onClick={() => setConfirm('reextract')}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-extract
              </Button>
            </div>

            {extraction && extraction.warnings.length > 0 && (
              <ul
                className="list-disc space-y-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 py-2 pl-7 pr-3 text-[12px] leading-snug text-amber-600 dark:text-amber-400"
                data-testid="docflow-extraction-warnings"
              >
                {extraction.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}

            {extraction && extraction.openQuestions.length > 0 && (
              <div>
                <button
                  type="button"
                  aria-expanded={questionsOpen}
                  data-testid="docflow-open-questions-toggle"
                  className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setQuestionsOpen((open) => !open)}
                >
                  {questionsOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  Questions the document leaves open ({extraction.openQuestions.length})
                </button>
                {questionsOpen && (
                  <ul
                    className="mt-1 list-disc space-y-0.5 pl-7 text-[12px] leading-snug text-muted-foreground"
                    data-testid="docflow-open-questions"
                  >
                    {extraction.openQuestions.map((question, index) => (
                      <li key={index}>{question}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-4 py-1.5">
            <span
              className="text-[12px] text-muted-foreground"
              data-testid="docflow-selected-count"
            >
              {validation.selectedCount} of {items.length} selected
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-6 text-xs"
              data-testid="docflow-select-all"
              disabled={validation.selectedCount === items.length}
              onClick={() => setAllSelected(true)}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              data-testid="docflow-select-none"
              disabled={validation.selectedCount === 0}
              onClick={() => setAllSelected(false)}
            >
              Select none
            </Button>
          </div>

          {items.length === 0 && (
            <p
              className="px-4 py-6 text-[13px] text-muted-foreground"
              data-testid="docflow-no-items"
            >
              No tickets were found in this document. Re-extract it, or cancel and choose another
              document.
            </p>
          )}
          <div className="divide-y divide-border" data-testid="docflow-item-list">
            {items.map((item) => (
              <DocumentRunItemEditor
                key={item.id}
                runId={run.id}
                item={item}
                items={items}
                expanded={expandedItemId === item.id}
                onToggleExpanded={() =>
                  setExpandedItemId((current) => (current === item.id ? null : item.id))
                }
              />
            ))}
          </div>
        </div>

        <aside className="w-[330px] shrink-0 overflow-y-auto border-l border-border px-4 py-3">
          <p className="mb-3 text-[13px] font-semibold text-foreground">Run settings</p>
          <DocumentRunSettingsPanel
            branches={branches}
            config={draft.config}
            onChange={draft.change}
          />
        </aside>
      </div>

      <div className="flex shrink-0 items-end gap-3 border-t border-border px-4 py-3">
        <div className="max-h-24 min-w-0 flex-1 space-y-0.5 overflow-y-auto text-[12px] leading-snug">
          {validation.blockers.map((blocker, index) => (
            <p key={index} className="text-destructive" data-testid="docflow-launch-blocker">
              {blocker}
            </p>
          ))}
          {validation.notes.map((note, index) => (
            <p key={index} className="text-muted-foreground" data-testid="docflow-launch-note">
              {note}
            </p>
          ))}
          {launchError && (
            <p className="text-destructive" data-testid="docflow-launch-error">
              The run could not be launched: {launchError}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          data-testid="docflow-preview-cancel"
          disabled={launching}
          onClick={closeWizard}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="docflow-launch-btn"
          disabled={validation.blockers.length > 0 || launching}
          onClick={() => setConfirm('launch')}
        >
          {launching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Rocket className="h-3.5 w-3.5" />
          )}
          Launch run ({validation.selectedCount})
        </Button>
      </div>

      <AlertDialog
        open={confirm === 'reextract'}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
      >
        <AlertDialogContent data-docflow-dialog="">
          <AlertDialogHeader>
            <AlertDialogTitle>Re-extract the tickets?</AlertDialogTitle>
            <AlertDialogDescription>
              The document is read again and the tickets below are replaced, including every edit
              you made to them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="docflow-reextract-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="docflow-reextract-confirm" onClick={reextract}>
              Re-extract
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LaunchConfirmDialog
        open={confirm === 'launch'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void launch()}
        ticketCount={validation.selectedCount}
        ownModelCount={ownModelCount}
        config={draft.config}
        currentBranch={branches.current}
      />
    </PendingWritesProvider>
  )
}

interface LaunchConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  ticketCount: number
  /** Selected tickets that carry their own model instead of the run default. */
  ownModelCount: number
  config: DocumentRunConfig
  /** The root checkout's branch: where a run without a base branch of its own starts. */
  currentBranch: string | null
}

function LaunchConfirmDialog({
  open,
  onClose,
  onConfirm,
  ticketCount,
  ownModelCount,
  config,
  currentBranch
}: LaunchConfirmDialogProps): React.JSX.Element {
  const baseBranch = describeBaseBranch(config, currentBranch)
  const verifyCommand = config.verifyCommand?.trim()
  const rows: [string, React.ReactNode][] = [
    ['Tickets', ticketCount],
    ['Base branch', baseBranch],
    ['Parallel tickets', config.maxParallel],
    [
      'Verification',
      verifyCommand ? (
        <code className="font-mono text-[12px]">{verifyCommand}</code>
      ) : (
        'no verification'
      )
    ],
    [
      'Model',
      ownModelCount > 0
        ? `${describeLaunchConfig(config.defaultLaunch)} (${pluralize(ownModelCount, 'ticket')} with their own)`
        : describeLaunchConfig(config.defaultLaunch)
    ],
    ['Questions', config.interactive ? 'agents may ask you' : 'agents decide on their own']
  ]

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <AlertDialogContent data-docflow-dialog="" data-testid="docflow-launch-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Launch {pluralize(ticketCount, 'ticket')}?</AlertDialogTitle>
          <AlertDialogDescription>
            An integration branch is created from {baseBranch} and every ticket is merged into it.
            The base branch itself is not modified.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="docflow-launch-confirm-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="docflow-launch-confirm-btn" onClick={onConfirm}>
            Launch run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
