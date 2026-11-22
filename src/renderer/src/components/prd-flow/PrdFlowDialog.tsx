// "New PRD → orchestrator ticket": the form that starts a PRD flow (lib/prd-flow). The person
// names the work and says what they want; "Start" hands both to startPrdFlow, which makes the
// board ticket and starts its session, and the driver (hooks/usePrdFlowDriver) takes it from
// there: the PRD, then the tasks document, then the orchestrator ticket made of it. "Save for
// later" starts nothing: savePrdFlowDraft keeps the answers as a draft on a ticket in To Do,
// and the same form opens on that draft again (from its card) to edit it, save it once more or
// start it. The form is opened through usePrdFlowStore's dialog state, by the To Do header's
// right-click menu, the command palette, a connection row's menu and a draft's card.
//
// Keyboard: focus starts in "Name"; Tab moves between the fields instead of toggling the mode
// of the session behind the dialog; Cmd/Ctrl+Enter is "Start" and Cmd/Ctrl+Shift+Enter "Save
// for later" from anywhere in the form; and Esc or Cmd/Ctrl+W closes it, except while "Start"
// or the save is in flight. Tab is not kept from the
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
import { savePrdFlowDraft } from '@/lib/prd-flow/draft'
import { startPrdFlow } from '@/lib/prd-flow/start'
import {
  findExistingPrdFlowFiles,
  resolvePrdFlowTarget,
  type PrdFlowTargetResult
} from '@/lib/prd-flow/target'
import { submitShortcutLabel } from '@/lib/shortcut-labels'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { usePrdFlowStore, type PrdFlowDraft } from '@/stores/usePrdFlowStore'
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
  draft,
  starting,
  onStartingChange
}: {
  projectId: string
  /** The saved draft the form edits, as it was when the form opened; null for a new form. */
  draft: PrdFlowDraft | null
  /** "Start" or the save is in flight. Kept by the dialog, which stays open meanwhile. */
  starting: boolean
  onStartingChange: (starting: boolean) => void
}): React.JSX.Element {
  const closeDialog = usePrdFlowStore((s) => s.closeDialog)
  const [name, setName] = useState(draft?.name ?? '')
  const [prompt, setPrompt] = useState(draft?.prompt ?? '')
  // Both checkmarks are on in every new form: they are not remembered. A draft keeps its own.
  const [research, setResearch] = useState(draft?.research ?? true)
  const [clarify, setClarify] = useState(draft?.clarify ?? true)
  // The agent and model start from the last choice made here (a draft's: the one it was saved
  // with); null is the app's default launch.
  const [launch, setLaunch] = useState<DocumentRunLaunchConfig | null>(() =>
    draft ? draft.launch : usePrdFlowStore.getState().launchPref
  )
  // Which of the two is in flight says which button reads "…ing".
  const [saving, setSaving] = useState(false)
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
  // A draft needs a name for its ticket and nothing more: the rest can wait until the launch.
  const canSave = !starting && name.trim() !== '' && prefix !== '' && target?.ok !== false

  const save = useCallback(async (): Promise<void> => {
    if (!canSave || startingRef.current) return
    startingRef.current = true
    onStartingChange(true)
    setSaving(true)
    setStartError(null)
    const title = name.trim()
    try {
      const result = await savePrdFlowDraft({
        projectId,
        name: title,
        prompt: prompt.trim(),
        research,
        clarify,
        launch,
        ticketId: draft?.ticketId
      })
      if (result.ok) {
        closeDialog()
        toast.success(`PRD draft saved: “${title}”. It waits in To Do until you launch it.`)
      } else {
        setStartError(result.error)
      }
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      startingRef.current = false
      setSaving(false)
      onStartingChange(false)
    }
  }, [
    canSave,
    onStartingChange,
    name,
    projectId,
    prompt,
    research,
    clarify,
    launch,
    draft?.ticketId,
    closeDialog
  ])

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
        launch,
        // A draft's own ticket becomes the flow's.
        ticketId: draft?.ticketId
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
  }, [
    canStart,
    onStartingChange,
    name,
    projectId,
    prompt,
    research,
    clarify,
    launch,
    draft?.ticketId,
    closeDialog
  ])

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    void (event.shiftKey ? save() : submit())
  }

  return (
    <div className="grid gap-4" onKeyDown={handleKeyDown}>
      <DialogHeader>
        <DialogTitle>{draft ? 'Edit PRD draft' : 'New PRD → orchestrator ticket'}</DialogTitle>
        <DialogDescription>
          A session writes NAME_PRD.html, then NAME_TASKS.html, which becomes an orchestrator ticket
          that waits to be launched.{' '}
          {draft
            ? 'This draft waits in To Do: nothing runs until you start it.'
            : 'Save it for later to keep it in To Do as a draft instead.'}
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
          variant="outline"
          data-testid="prd-flow-save-btn"
          title={
            draft
              ? 'Keep the changes and leave the draft in To Do'
              : 'Keep it in To Do as a draft, to edit and launch later'
          }
          disabled={!canSave}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : draft ? 'Save' : 'Save for later'}
          <ShortcutHint label={submitShortcutLabel({ shift: true })} />
        </Button>
        <Button
          type="button"
          data-testid="prd-flow-start-btn"
          disabled={!canStart}
          onClick={() => void submit()}
        >
          {starting && !saving ? 'Starting…' : 'Start'}
          <ShortcutHint label={submitShortcutLabel()} />
        </Button>
      </DialogFooter>
    </div>
  )
}

/**
 * Mount once (AppLayout). The form of "New PRD → orchestrator ticket…", for the project
 * usePrdFlowStore's dialog state names, and for the saved draft it names when the form was
 * opened from a draft's card. It closes without asking, whatever was typed.
 */
export function PrdFlowDialog(): React.JSX.Element {
  const open = usePrdFlowStore((s) => s.dialog.open)
  const projectId = usePrdFlowStore((s) => s.dialog.projectId)
  const draftTicketId = usePrdFlowStore((s) => s.dialog.draftTicketId)
  const closeDialog = usePrdFlowStore((s) => s.closeDialog)
  // Every opening is a new form: nothing typed before is left, and both checkmarks are on. A
  // form opened on a saved draft starts from the draft as it is at that moment; saving it
  // while the form is open does not write over what is being typed.
  const [opening, setOpening] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  const [draft, setDraft] = useState<PrdFlowDraft | null>(null)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setOpening((count) => count + 1)
      setDraft(
        draftTicketId ? (usePrdFlowStore.getState().drafts[draftTicketId] ?? null) : null
      )
    }
  }
  // Esc, the X and the overlay are ignored while "Start" or the save is in flight: a refusal is shown in
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
        data-draft={draft ? draft.ticketId : undefined}
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
            draft={draft}
            starting={starting}
            onStartingChange={setStarting}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
