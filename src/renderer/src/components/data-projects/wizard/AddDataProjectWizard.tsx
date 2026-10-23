// The add / edit database connection wizard. Store-driven (useDataProjectStore.wizard) and
// mounted once in AppLayout, so the sidebar menu, the command palette, the context menu and the
// data project toolbar all open the same dialog.
//
// Steps: engine (cards or a pasted URL) → connection (fields ⇄ URL) → test (skippable) →
// details (name, icon, environment, safe mode, limits, AI access, pin). Edit mode starts at the
// connection step with the engine fixed and secrets shown as "•••• saved" (never fetched).
// Keyboard: Enter in a text field advances (validating the step first), ⌘/Ctrl+Enter saves from
// anywhere once everything is valid, Escape closes. Tab moves between fields (the dialog carries
// `data-db-dialog`, which the global shortcut handler leaves alone).
//
// Uploaded icon images are stored under a fresh key per wizard session; an upload that does not
// end up saved is deleted again on close, and a replaced image of an edited project is removed
// after the save.
//
// SQLite "New file…": the connection test creates the empty database. Saving without a
// successful test (⌘Enter on the connection step, or Save in edit mode) creates it first, so the
// saved connection always points at an existing file.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { dataProjectsApi } from '@/api/data-projects-api'
import { useDataProjectStore, type DataProjectWizardRequest } from '@/stores/useDataProjectStore'
import {
  DATA_ENGINE_INFO,
  type DataEngine,
  type DataParsedConnectionUrl,
  type DataProject
} from '@shared/data-projects/types'
import { parseConnectionUrl } from '@shared/data-projects/connection-url'
import { errorMessage } from '../data-project-ui'
import { ConnectionStep } from './ConnectionStep'
import { DetailsStep } from './DetailsStep'
import { EngineStep } from './EngineStep'
import { TestStep } from './TestStep'
import { iconFileKey, newIconUploadKey, removeIconUpload } from './icon-uploads'
import {
  applyParsedUrl,
  emptyForm,
  fileToCreate,
  formFromProject,
  formToCreateInput,
  formToUpdatePatch,
  hasErrors,
  switchEngine,
  testConfig,
  validateConnection,
  validateDetails,
  type FieldErrors,
  type WizardForm,
  type WizardStepId
} from './wizard-model'

const STEP_LABEL: Readonly<Record<WizardStepId, string>> = {
  engine: 'Database',
  connection: 'Connection',
  test: 'Test',
  details: 'Details'
}

export function AddDataProjectWizard(): React.JSX.Element | null {
  const request = useDataProjectStore((s) => s.wizard)
  if (!request) return null
  const key = request.mode === 'edit' ? `edit:${request.projectId}` : 'create'
  return <WizardDialog key={key} request={request} />
}

function WizardDialog({ request }: { request: DataProjectWizardRequest }): React.JSX.Element {
  const closeWizard = useDataProjectStore((s) => s.closeWizard)
  const defaults = useDataProjectStore((s) => s.defaults)
  const editProject = useDataProjectStore((s) =>
    request.mode === 'edit' ? (s.projects.find((p) => p.id === request.projectId) ?? null) : null
  )
  const editing = request.mode === 'edit'
  // Snapshot of the project when the dialog opened: a concurrent update must not reset the form.
  const projectRef = useRef<DataProject | null>(editProject)
  const project = projectRef.current

  const steps: WizardStepId[] = editing
    ? ['connection', 'test', 'details']
    : ['engine', 'connection', 'test', 'details']

  const [form, setForm] = useState<WizardForm | null>(() => {
    if (request.mode === 'edit') return project ? formFromProject(project, defaults) : null
    if (request.engine) return emptyForm(request.engine, defaults)
    return null
  })
  const [step, setStep] = useState<WizardStepId>(() =>
    request.mode === 'edit'
      ? (request.step ?? 'connection')
      : request.engine
        ? 'connection'
        : 'engine'
  )
  const [visited, setVisited] = useState<Set<WizardStepId>>(() => new Set([step]))
  const [showErrors, setShowErrors] = useState<Partial<Record<WizardStepId, boolean>>>({})
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const imageKey = useMemo(newIconUploadKey, [])
  const uploaded = useRef(false)
  const saved = useRef(false)
  /** The "New file…" SQLite path a successful connection test (or save) already created. */
  const createdFile = useRef<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Defaults for new connections live in their own setting; read them once per open.
  useEffect(() => {
    if (!useDataProjectStore.getState().defaultsLoaded) {
      void useDataProjectStore.getState().loadDefaults()
    }
  }, [])

  // A create request with a URL (palette "paste URL", tests): import it straight away.
  const initialUrl = request.mode === 'create' ? request.url : undefined
  useEffect(() => {
    if (!initialUrl) return
    const result = parseConnectionUrl(initialUrl)
    if (result.ok) importParsed(result.value)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, [])

  // Cleanup when the dialog goes away without saving the uploaded image.
  useEffect(
    () => () => {
      if (uploaded.current && !saved.current) removeIconUpload(imageKey)
    },
    [imageKey]
  )

  const update = useCallback(
    (updater: (current: WizardForm) => WizardForm) =>
      setForm((current) => (current ? updater(current) : current)),
    []
  )

  const connectionErrors: FieldErrors = useMemo(
    () => (form ? validateConnection(form) : {}),
    [form]
  )
  const detailsErrors: FieldErrors = useMemo(() => (form ? validateDetails(form) : {}), [form])

  const goTo = (next: WizardStepId): void => {
    setStep(next)
    setVisited((prev) => new Set(prev).add(next))
    setSaveError(null)
  }

  const focusFirstInvalid = (): void => {
    requestAnimationFrame(() => {
      contentRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    })
  }

  function importParsed(parsed: DataParsedConnectionUrl): void {
    setForm((current) =>
      applyParsedUrl(current ?? emptyForm(parsed.engine, defaults), parsed, defaults)
    )
    setImportWarnings(parsed.warnings)
    setEngineError(null)
    goTo('connection')
  }

  const pickEngine = (engine: DataEngine): void => {
    setForm((current) =>
      current ? switchEngine(current, engine, defaults) : emptyForm(engine, defaults)
    )
    setImportWarnings([])
    setEngineError(null)
    goTo('connection')
  }

  const save = async (): Promise<void> => {
    if (!form || saving) return
    if (hasErrors(connectionErrors)) {
      setShowErrors((prev) => ({ ...prev, connection: true }))
      goTo('connection')
      focusFirstInvalid()
      return
    }
    if (hasErrors(detailsErrors)) {
      setShowErrors((prev) => ({ ...prev, details: true }))
      goTo('details')
      focusFirstInvalid()
      return
    }
    setSaving(true)
    setSaveError(null)
    const store = useDataProjectStore.getState()
    try {
      const newFile = fileToCreate(form)
      if (newFile && createdFile.current !== newFile) {
        // Not tested: create the empty database now (the saved config has no create switch).
        const result = await dataProjectsApi
          .testConnection({ engine: form.engine, config: testConfig(form), secrets: {} })
          .catch((error: unknown) => ({ ok: false, error: errorMessage(error, 'unknown error') }))
        if (!result?.ok) {
          setSaveError(`Could not create ${newFile}: ${result?.error || 'unknown error'}`)
          return
        }
        createdFile.current = newFile
      }
      if (editing && project) {
        const patch = formToUpdatePatch(form, project)
        if (Object.keys(patch).length > 0) await store.update(project.id, patch)
        saved.current = form.icon?.kind === 'image' && iconFileKey(form.icon.fileName) === imageKey
        // The previous uploaded image is no longer referenced.
        if (
          project.icon?.kind === 'image' &&
          JSON.stringify(project.icon) !== JSON.stringify(form.icon)
        ) {
          removeIconUpload(iconFileKey(project.icon.fileName))
        }
        toast.success(`Saved ${form.name.trim() || project.name}`)
        closeWizard()
      } else {
        const input = formToCreateInput(form)
        const created = await store.create(input)
        saved.current = form.icon?.kind === 'image' && iconFileKey(form.icon.fileName) === imageKey
        toast.success(`Added ${created.name}`)
        closeWizard()
        store.select(created.id)
      }
    } catch (error) {
      setSaveError(errorMessage(error, 'Saving failed'))
    } finally {
      setSaving(false)
    }
  }

  const next = (): void => {
    switch (step) {
      case 'engine':
        if (!form) {
          setEngineError('Pick a database, or paste a connection URL')
          return
        }
        goTo('connection')
        return
      case 'connection':
        if (!form) return
        if (hasErrors(connectionErrors)) {
          setShowErrors((prev) => ({ ...prev, connection: true }))
          focusFirstInvalid()
          return
        }
        goTo('test')
        return
      case 'test':
        goTo('details')
        return
      case 'details':
        void save()
        return
    }
  }

  const back = (): void => {
    const index = steps.indexOf(step)
    if (index > 0) goTo(steps[index - 1])
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.altKey || event.shiftKey)
      return
    const target = event.target as HTMLElement
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault()
      void save()
      return
    }
    // Enter on buttons/selects keeps its native meaning.
    if (target.tagName !== 'INPUT') return
    const type = (target as HTMLInputElement).type
    if (type === 'checkbox' || type === 'radio') return
    event.preventDefault()
    next()
  }

  const close = (): void => {
    if (saving) return
    closeWizard()
  }

  const engineLabel = form ? DATA_ENGINE_INFO[form.engine].label : null
  const title = editing ? `Edit ${project?.name ?? 'connection'}` : 'Add database connection'
  const description = editing
    ? `${engineLabel ?? ''} connection settings. Saved passwords stay in secure storage.`
    : 'Connect to MySQL, MariaDB, PostgreSQL, SQLite, ClickHouse or MongoDB. Passwords go to secure storage, never to plain text.'

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        ref={contentRef}
        className="flex max-h-[86vh] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        data-testid="data-project-wizard"
        data-step={step}
        data-db-dialog=""
        onKeyDown={onKeyDown}
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3 pt-4">
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
          <DialogDescription className="text-[12px]">{description}</DialogDescription>
          <ol className="mt-2 flex items-center gap-1" aria-label="Steps">
            {steps.map((id, index) => {
              const reachable = visited.has(id) && (id !== 'test' || !!form)
              const current = id === step
              const done = steps.indexOf(step) > index
              return (
                <li key={id} className="flex items-center gap-1">
                  {index > 0 && <span className="h-px w-4 bg-border" aria-hidden="true" />}
                  <button
                    type="button"
                    disabled={!reachable || saving}
                    onClick={() => goTo(id)}
                    aria-current={current ? 'step' : undefined}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors',
                      current
                        ? 'bg-foreground text-background'
                        : reachable
                          ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
                          : 'text-muted-foreground/50'
                    )}
                    data-testid={`data-project-wizard-step-${id}`}
                  >
                    {done ? <Check className="size-3" /> : <span>{index + 1}</span>}
                    {STEP_LABEL[id]}
                  </button>
                </li>
              )
            })}
          </ol>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {editing && !project ? (
            <p
              className="text-[13px] text-muted-foreground"
              data-testid="data-project-wizard-missing"
            >
              This connection no longer exists.
            </p>
          ) : step === 'engine' ? (
            <>
              <EngineStep
                selected={form?.engine ?? null}
                onPick={pickEngine}
                onParsed={importParsed}
                initialUrl={initialUrl}
              />
              {engineError && (
                <p
                  className="mt-3 text-[12px] text-destructive"
                  role="alert"
                  data-testid="data-project-wizard-engine-error"
                >
                  {engineError}
                </p>
              )}
            </>
          ) : !form ? null : step === 'connection' ? (
            <ConnectionStep
              form={form}
              onChange={update}
              errors={showErrors.connection ? connectionErrors : {}}
              project={project}
              defaults={defaults}
              onChangeEngine={editing ? undefined : () => goTo('engine')}
              importWarnings={importWarnings}
            />
          ) : step === 'test' ? (
            <TestStep
              form={form}
              dataProjectId={project?.id}
              onDatabaseChange={(database) => update((f) => ({ ...f, database }))}
              onOutcome={(outcome) => {
                if (outcome.state === 'done' && outcome.result.ok) {
                  createdFile.current = fileToCreate(form) ?? createdFile.current
                }
              }}
            />
          ) : (
            <DetailsStep
              form={form}
              onChange={update}
              errors={showErrors.details ? detailsErrors : {}}
              defaults={defaults}
              imageKey={imageKey}
              onImageUploaded={() => {
                uploaded.current = true
              }}
            />
          )}
        </div>

        <DialogFooter className="shrink-0 items-center border-t border-border px-5 py-3 sm:justify-between">
          <div className="min-w-0 flex-1">
            {saveError && (
              <p
                className="truncate text-[12px] text-destructive"
                role="alert"
                title={saveError}
                data-testid="data-project-wizard-save-error"
              >
                {saveError}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={close}
              disabled={saving}
              data-testid="data-project-wizard-cancel"
            >
              Cancel
            </Button>
            {steps.indexOf(step) > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={back}
                disabled={saving}
                data-testid="data-project-wizard-back"
              >
                Back
              </Button>
            )}
            {step === 'details' || (editing && step !== 'test' && project) ? (
              <Button
                type="button"
                size="sm"
                onClick={() => void save()}
                disabled={saving || !form || (editing && !project)}
                data-testid="data-project-wizard-save"
              >
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                {editing ? 'Save changes' : 'Add connection'}
              </Button>
            ) : null}
            {step !== 'details' && (
              <Button
                type="button"
                size="sm"
                variant={editing && step !== 'test' ? 'outline' : 'default'}
                onClick={next}
                disabled={saving || (step !== 'engine' && !form)}
                data-testid="data-project-wizard-next"
              >
                {step === 'test' ? 'Continue' : step === 'connection' ? 'Test connection' : 'Next'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
