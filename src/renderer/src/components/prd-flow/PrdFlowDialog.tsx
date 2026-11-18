// "New PRD → orchestrator ticket": the form that starts a PRD flow (lib/prd-flow). The person
// names the work and says what they want; "Start" hands both to startPrdFlow, which makes the
// board ticket and starts its session, and the driver (hooks/usePrdFlowDriver) takes it from
// there: the PRD, then the tasks document, then the orchestrator ticket made of it. The form is
// opened through usePrdFlowStore's dialog state, by the To Do header's right-click menu, the
// command palette and a connection row's menu.
//
// Keyboard: focus starts in "Name"; Tab moves between the fields instead of toggling the mode
// of the session behind the dialog; Cmd/Ctrl+Enter is "Start" from anywhere in the form; and
// Esc or Cmd/Ctrl+W closes it, except while "Start" is in flight. Tab is not kept from the
// session everywhere: the model picker's dropdown is drawn by the shared ModelSelector in a
// portal outside the dialog's content, where the dialog's opt-out does not reach, so with
// that list open Tab can still toggle the session's mode, as in every dialog that hosts
// LaunchConfigPicker.
import { useCallback, useEffect, useRef, useState } from 'react'
import { LaunchConfigPicker } from '@/components/document-flow/LaunchConfigPicker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ShortcutHint } from '@/components/ui/shortcut-hint'
import { Textarea } from '@/components/ui/textarea'
import { startPrdFlow } from '@/lib/prd-flow/start'
import {
  findExistingPrdFlowFiles,
  resolvePrdFlowTarget,
  type PrdFlowTargetResult
} from '@/lib/prd-flow/target'
import { submitShortcutLabel } from '@/lib/shortcut-labels'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { usePrdFlowStore } from '@/stores/usePrdFlowStore'
import { prdFlowPrefix } from '@shared/document-flow/prd-flow'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import {
  PRD_FLOW_EXISTING_FILES_DEBOUNCE_MS,
  prdFlowExistingFilesError,
  prdFlowFilesLine
} from './prd-flow-form'

const LABEL_CLASS = 'text-sm font-medium text-foreground'

/** The documents found on disk for one name in one directory: an answer for any other is stale. */
interface ExistingFiles {
  cwd: string
  prefix: string
  paths: string[]
}

function PrdFlowForm({
  projectId,
  starting,
  onStartingChange
}: {
  projectId: string
  /** "Start" is in flight. Kept by the dialog, which stays open meanwhile. */
  starting: boolean
  onStartingChange: (starting: boolean) => void
}): React.JSX.Element {
  const closeDialog = usePrdFlowStore((s) => s.closeDialog)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  // Both checkmarks are on in every new form: they are not remembered.
  const [research, setResearch] = useState(true)
  const [clarify, setClarify] = useState(true)
  // The agent and model start from the last choice made here; null is the app's default launch.
  const [launch, setLaunch] = useState<DocumentRunLaunchConfig | null>(
    () => usePrdFlowStore.getState().launchPref
  )
  const [target, setTarget] = useState<PrdFlowTargetResult | null>(null)
  const [existing, setExisting] = useState<ExistingFiles | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  // Raised whenever the window comes back to the front: the person may have removed a file.
  const [lookAgain, setLookAgain] = useState(0)
  // A second Cmd/Ctrl+Enter lands before "starting" is drawn; one ticket per "Start".
  const startingRef = useRef(false)

  const prefix = prdFlowPrefix(name)
  const where = target?.ok ? target.target : null

  // Where the session would run: the project's main checkout, or a connection project's base
  // instance. An answer for a form that is gone is dropped.
  useEffect(() => {
    let stale = false
    void resolvePrdFlowTarget(projectId).then(
      (result) => {
        if (!stale) setTarget(result)
      },
      // No answer is not a refusal: "Start" asks again and says what is wrong.
      () => undefined
    )
    return () => {
      stale = true
    }
  }, [projectId])

  useEffect(() => {
    const onFocus = (): void => setLookAgain((count) => count + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Documents already there under this name would be taken for the session's own: once the
  // name rests, they are looked for, and the name is refused while one exists.
  useEffect(() => {
    if (!where || !prefix) return
    let stale = false
    const timer = setTimeout(() => {
      void findExistingPrdFlowFiles(where, prefix).then(
        (paths) => {
          if (!stale) setExisting({ cwd: where.cwd, prefix, paths })
        },
        // A look that failed refuses nothing: "Start" looks again.
        () => undefined
      )
    }, PRD_FLOW_EXISTING_FILES_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [where, prefix, lookAgain])

  const existingError =
    where && existing && existing.cwd === where.cwd && existing.prefix === prefix
      ? prdFlowExistingFilesError(existing.paths)
      : null
  const error = startError ?? existingError
  const filesLine = prdFlowFilesLine({ name, prefix, target })
  const canStart =
    !starting &&
    name.trim() !== '' &&
    prompt.trim() !== '' &&
    prefix !== '' &&
    target?.ok !== false &&
    existingError === null

  const submit = useCallback(async (): Promise<void> => {
    if (!canStart || startingRef.current) return
    startingRef.current = true
    onStartingChange(true)
    setStartError(null)
    const title = name.trim()
    try {
      const result = await startPrdFlow({
        projectId,
        name: title,
        prompt: prompt.trim(),
        research,
        clarify,
        launch
      })
      if (result.ok) {
        closeDialog()
        toast.success(`PRD flow started: “${title}”`)
      } else {
        setStartError(result.error)
      }
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      startingRef.current = false
      onStartingChange(false)
    }
  }, [canStart, onStartingChange, name, projectId, prompt, research, clarify, launch, closeDialog])

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  return (
    <div className="grid gap-4" onKeyDown={handleKeyDown}>
      <DialogHeader>
        <DialogTitle>New PRD → orchestrator ticket</DialogTitle>
        <DialogDescription>
          A session writes NAME_PRD.html, then NAME_TASKS.html, which becomes an orchestrator ticket
          that waits to be launched.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="prd-flow-name" className={LABEL_CLASS}>
            Name
          </label>
          <Input
            id="prd-flow-name"
            data-testid="prd-flow-name-input"
            placeholder="What are we building?"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setStartError(null)
            }}
            autoFocus
          />
          {/* Always drawn, so the fields below do not jump when the directory is known */}
          <p
            data-testid="prd-flow-files"
            className={cn(
              'min-h-4 break-all text-[11px] leading-snug',
              filesLine?.blocking ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
            )}
          >
            {filesLine?.text}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="prd-flow-prompt" className={LABEL_CLASS}>
            Prompt
          </label>
          <Textarea
            id="prd-flow-prompt"
            data-testid="prd-flow-prompt-input"
            placeholder="Describe what you want to create…"
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value)
              setStartError(null)
            }}
            rows={8}
            className="resize-y"
          />
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox
              checked={research}
              onCheckedChange={setResearch}
              data-testid="prd-flow-research-checkbox"
            />
            Research with subagents first
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox
              checked={clarify}
              onCheckedChange={setClarify}
              data-testid="prd-flow-clarify-checkbox"
            />
            Ask me for clarifications
          </label>
        </div>

        <div className="space-y-1.5">
          <p className={LABEL_CLASS}>Agent and model</p>
          <LaunchConfigPicker
            value={launch}
            onChange={(next) => {
              setLaunch(next)
              setStartError(null)
            }}
            inheritLabel="App default"
            clearLabel="Use app default"
            testIdPrefix="prd-flow-launch"
          />
        </div>
      </div>

      {error && (
        <p data-testid="prd-flow-error" role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          data-testid="prd-flow-cancel-btn"
          disabled={starting}
          onClick={closeDialog}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="prd-flow-start-btn"
          disabled={!canStart}
          onClick={() => void submit()}
        >
          {starting ? 'Starting…' : 'Start'}
          <ShortcutHint label={submitShortcutLabel()} />
        </Button>
      </DialogFooter>
    </div>
  )
}

/**
 * Mount once (AppLayout). The form of "New PRD → orchestrator ticket…", for the project
 * usePrdFlowStore's dialog state names. It closes without asking, whatever was typed.
 */
export function PrdFlowDialog(): React.JSX.Element {
  const open = usePrdFlowStore((s) => s.dialog.open)
  const projectId = usePrdFlowStore((s) => s.dialog.projectId)
  const closeDialog = usePrdFlowStore((s) => s.closeDialog)
  // Every opening is a new form: nothing typed before is left, and both checkmarks are on.
  const [opening, setOpening] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) setOpening((count) => count + 1)
  }
  // Esc, the X and the overlay are ignored while "Start" is in flight: a refusal is shown in
  // the form, and the form closes itself once the flow is on.
  const [starting, setStarting] = useState(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !starting) closeDialog()
      }}
    >
      <DialogContent
        data-testid="prd-flow-dialog"
        // Tab moves between the form's fields, not the mode of the session behind it.
        data-tab-navigates=""
        // Cmd/Ctrl+W (useKeyboardShortcuts) leaves the form alone while "Start" is in flight.
        data-starting={starting ? '' : undefined}
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
      >
        {projectId && (
          <PrdFlowForm
            key={`${opening}:${projectId}`}
            projectId={projectId}
            starting={starting}
            onStartingChange={setStarting}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
