import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, GitBranch, Loader2, Play, RotateCcw, X } from 'lucide-react'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  defaultManualStepsTarget,
  launchManualStepsSession,
  manualStepsTargets,
  type LaunchedManualSteps,
  type ManualStepsCheckout,
  type ManualStepsTarget,
  type ManualStepsTargetKind
} from '@/lib/document-flow/manual-steps'
import { resolveDefaultLaunchConfig } from '@/lib/document-flow/runner-ports'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import {
  buildManualStepsPrompt,
  DEFAULT_MANUAL_STEPS_PROMPT,
  DOC_PATH_PLACEHOLDER,
  MANUAL_STEPS_PLACEHOLDERS,
  NO_DOCUMENT_PATH_TEXT
} from '@shared/document-flow/prompts'
import {
  hasDocument,
  isConnectionRun,
  type DocumentRun,
  type DocumentRunLaunchConfig
} from '@shared/types/document-flow'
import { TonePill } from './DocumentFlowBadges'
import { LaunchConfigPicker } from './LaunchConfigPicker'

const SECTION_LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

const TARGET_HINTS: Record<ManualStepsTargetKind, string> = {
  integration: 'this run’s branch',
  'no-worktree': 'no worktree'
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const canLaunchOn = (
  target: ManualStepsTarget | undefined
): target is ManualStepsTarget & { checkout: ManualStepsCheckout } => !!target?.checkout

interface ExecuteManualStepsDialogProps {
  run: DocumentRun
  manualSteps: readonly string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The session is running: the dashboard offers the way to it (a modal blocks a toast's). */
  onLaunched: (launched: LaunchedManualSteps) => void
}

/**
 * Reviews the prompt that executes a finished run's manual steps, and launches it: where it runs
 * and with which agent are picked here, and an edit to the prompt can be kept for next time. The
 * body mounts with the dialog, so every opening starts from the saved prompt and the app's model.
 */
export function ExecuteManualStepsDialog({
  run,
  manualSteps,
  open,
  onOpenChange,
  onLaunched
}: ExecuteManualStepsDialogProps): React.JSX.Element {
  const [launching, setLaunching] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The launch is on its way: the dialog stays to report how it went.
        if (!launching) onOpenChange(next)
      }}
    >
      <DialogContent
        data-testid="docflow-manual-steps-dialog"
        data-docflow-dialog=""
        className="flex max-h-[85vh] max-w-2xl flex-col gap-4 overflow-y-auto"
      >
        <ManualStepsBody
          run={run}
          manualSteps={manualSteps}
          launching={launching}
          setLaunching={setLaunching}
          onLaunched={onLaunched}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function ManualStepsBody({
  run,
  manualSteps,
  launching,
  setLaunching,
  onLaunched,
  onClose
}: {
  run: DocumentRun
  manualSteps: readonly string[]
  launching: boolean
  setLaunching: (launching: boolean) => void
  onLaunched: (launched: LaunchedManualSteps) => void
  onClose: () => void
}): React.JSX.Element {
  const savedTemplate =
    useSettingsStore((s) => s.manualStepsPromptTemplate) ?? DEFAULT_MANUAL_STEPS_PROMPT
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const [template, setTemplate] = useState(savedTemplate)
  const [launchConfig, setLaunchConfig] = useState<DocumentRunLaunchConfig | null>(() =>
    resolveDefaultLaunchConfig()
  )
  const [picked, setPicked] = useState<ManualStepsTargetKind | null>(null)
  const [askingToKeep, setAskingToKeep] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const connectionRun = isConnectionRun(run)
  const projectId = run.project_id
  // An entry alone does not mean the list is complete: a worktree may have been added to a
  // project that was never loaded.
  const worktrees = useWorktreeStore((s) =>
    s.loadedProjectIds.has(projectId) ? s.worktreesByProject.get(projectId) : undefined
  )
  const connections = useConnectionStore((s) => (s.loaded ? s.connections : undefined))
  useEffect(() => {
    if (connectionRun) void useConnectionStore.getState().loadConnections()
    else void useWorktreeStore.getState().loadWorktrees(projectId)
  }, [connectionRun, projectId])

  const targets = useMemo(
    () => manualStepsTargets(run, worktrees, connections),
    [run, worktrees, connections]
  )
  const targetKind = picked ?? defaultManualStepsTarget(targets)
  const target = targets.find((candidate) => candidate.kind === targetKind)

  const edited = template !== savedTemplate
  const blank = template.trim() === ''
  const placeholders = MANUAL_STEPS_PLACEHOLDERS.map((placeholder) => ({
    placeholder,
    included: template.includes(placeholder)
  }))
  const noDocumentNote = !hasDocument(run) && template.includes(DOC_PATH_PLACEHOLDER)

  const launch = async (keep: boolean): Promise<void> => {
    if (launching || !canLaunchOn(target)) return
    setLaunching(true)
    try {
      if (keep) {
        // The built-in prompt is not stored: a later version of it reaches this user too.
        await updateSetting(
          'manualStepsPromptTemplate',
          template === DEFAULT_MANUAL_STEPS_PROMPT ? null : template
        )
      }
      const modelConfig = launchConfig ?? resolveDefaultLaunchConfig()
      const prompt = buildManualStepsPrompt({
        template,
        documentPath: hasDocument(run) ? run.source_path : null,
        manualSteps,
        sdk: modelConfig.sdk
      })
      const sessionId = await launchManualStepsSession(target, projectId, prompt, modelConfig)
      toast.success(`Executing the manual steps on ${target.branch}`)
      onLaunched({ sessionId, checkout: target.checkout })
      setLaunching(false)
      onClose()
    } catch (cause) {
      setLaunching(false)
      toast.error(`Could not execute the manual steps: ${errorMessage(cause)}`)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-[15px]">Execute manual steps</DialogTitle>
        <DialogDescription>
          A new agent session is sent this prompt. The placeholders are filled in when it launches.
        </DialogDescription>
      </DialogHeader>

      <div
        className="flex flex-wrap items-center gap-1.5"
        data-testid="docflow-manual-steps-placeholders"
      >
        {placeholders.map(({ placeholder, included }) => (
          <TonePill
            key={placeholder}
            tone={included ? 'success' : 'danger'}
            testId={`docflow-manual-steps-placeholder-${placeholder.slice(1, -1)}`}
          >
            {included ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
            <span className="font-mono">{placeholder}</span>
            {included ? 'included' : 'missing'}
          </TonePill>
        ))}
      </div>
      {noDocumentNote && (
        <p
          className="-mt-2 text-[11px] leading-snug text-amber-600 dark:text-amber-400"
          data-testid="docflow-manual-steps-no-document"
        >
          This run was made from board tickets, so {DOC_PATH_PLACEHOLDER} becomes “
          {NO_DOCUMENT_PATH_TEXT}”.
        </p>
      )}

      <div className="space-y-1.5">
        <div className="flex min-h-6 items-center justify-between gap-3">
          <p className={SECTION_LABEL_CLASS}>Prompt</p>
          {template !== DEFAULT_MANUAL_STEPS_PROMPT && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 text-xs text-muted-foreground"
              data-testid="docflow-manual-steps-reset"
              disabled={launching}
              onClick={() => setTemplate(DEFAULT_MANUAL_STEPS_PROMPT)}
            >
              <RotateCcw className="h-3 w-3" />
              Reset to default
            </Button>
          )}
        </div>
        <Textarea
          aria-label="Prompt"
          data-testid="docflow-manual-steps-prompt"
          className="min-h-[256px] resize-y font-mono text-[12px] leading-relaxed"
          ref={promptRef}
          value={template}
          readOnly={launching}
          onChange={(event) => setTemplate(event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <p className={SECTION_LABEL_CLASS}>Run on</p>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Run on">
          {targets.map((candidate) => {
            const active = candidate.kind === targetKind
            return (
              <button
                key={candidate.kind}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`docflow-manual-steps-target-${candidate.kind}`}
                disabled={launching || candidate.refusal !== null}
                className={cn(
                  'flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-muted/50 text-muted-foreground hover:bg-accent/50'
                )}
                onClick={() => setPicked(candidate.kind)}
              >
                <GitBranch className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono" title={candidate.branch}>
                  {candidate.branch}
                </span>
                <span className="shrink-0 opacity-70">{TARGET_HINTS[candidate.kind]}</span>
              </button>
            )
          })}
        </div>
        {/* Said in words: a disabled button shows no tooltip */}
        {targets
          .filter((candidate) => candidate.refusal !== null)
          .map((candidate) => (
            <p
              key={candidate.kind}
              className="text-[11px] leading-snug text-muted-foreground"
              data-testid={`docflow-manual-steps-refusal-${candidate.kind}`}
            >
              {candidate.refusal}
            </p>
          ))}
      </div>

      <div className="space-y-1.5">
        <p className={SECTION_LABEL_CLASS}>Agent</p>
        <LaunchConfigPicker
          value={launchConfig}
          onChange={setLaunchConfig}
          inheritLabel="App default"
          clearLabel="Use app default"
          testIdPrefix="docflow-manual-steps-agent"
        />
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          data-testid="docflow-manual-steps-cancel"
          disabled={launching}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="docflow-manual-steps-launch"
          disabled={launching || blank || !canLaunchOn(target)}
          onClick={() => {
            if (edited) setAskingToKeep(true)
            else void launch(false)
          }}
        >
          {launching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Launch
        </Button>
      </DialogFooter>

      <AlertDialog open={askingToKeep} onOpenChange={setAskingToKeep}>
        <AlertDialogContent
          data-docflow-dialog=""
          data-testid="docflow-manual-steps-keep-dialog"
          // Opened by no trigger, so Radix has nothing to give the focus back to. On the body it
          // would be out of every dialog: typing is lost and Tab flips the session behind them.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            promptRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Keep this prompt for next time?</AlertDialogTitle>
            <AlertDialogDescription>
              You changed the prompt. Keeping it makes it the one this dialog starts from whenever
              you execute manual steps. Otherwise it is used for this launch only.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="docflow-manual-steps-keep-cancel">
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              data-testid="docflow-manual-steps-keep-no"
              onClick={() => void launch(false)}
            >
              Just this once
            </AlertDialogAction>
            <AlertDialogAction
              data-testid="docflow-manual-steps-keep-yes"
              onClick={() => void launch(true)}
            >
              Keep and launch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
