// Wizard step 3: test the connection with exactly what the form says (typed secrets; in edit
// mode the server fills untyped ones from the vault). Runs on entry, shows server version and
// round-trip time on success — plus the server's notice, e.g. an SSH host key accepted on first
// use with its fingerprint — or the (server-redacted) error with a classified hint. Skippable:
// a connection to a server that is down today can still be saved. A SQLite file picked with
// "New file…" is created by this test (`testConfig`).

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, RotateCw, ShieldAlert, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { dataProjectsApi } from '@/api/data-projects-api'
import { DATA_ENGINE_INFO, type DataTestConnectionResult } from '@shared/data-projects/types'
import { connectionErrorHint, describeDataProjectTarget, errorMessage } from '../data-project-ui'
import { Field, NativeSelect } from './wizard-fields'
import { formToConfig, testConfig, testSecrets, type WizardForm } from './wizard-model'

export type TestOutcome = { state: 'running' } | { state: 'done'; result: DataTestConnectionResult }

export interface TestStepProps {
  form: WizardForm
  /** Edit mode: lets the server use the stored secrets for anything not typed. */
  dataProjectId?: string
  onDatabaseChange: (database: string) => void
  onOutcome?: (outcome: TestOutcome) => void
}

export function TestStep({
  form,
  dataProjectId,
  onDatabaseChange,
  onOutcome
}: TestStepProps): React.JSX.Element {
  const [outcome, setOutcome] = useState<TestOutcome>({ state: 'running' })
  const seq = useRef(0)
  // The form as it was when the step opened: editing the database below must not re-test.
  const formRef = useRef(form)
  const onOutcomeRef = useRef(onOutcome)
  onOutcomeRef.current = onOutcome

  const run = useCallback(async (): Promise<void> => {
    const current = ++seq.current
    const running: TestOutcome = { state: 'running' }
    setOutcome(running)
    onOutcomeRef.current?.(running)
    const snapshot = formRef.current
    let result: DataTestConnectionResult
    try {
      result = await dataProjectsApi.testConnection({
        engine: snapshot.engine,
        config: testConfig(snapshot),
        secrets: testSecrets(snapshot),
        ...(dataProjectId ? { dataProjectId } : {})
      })
      if (!result || typeof result !== 'object') {
        result = { ok: false, error: 'The server returned no answer' }
      }
    } catch (error) {
      result = { ok: false, error: errorMessage(error, 'Connection test failed') }
    }
    if (current !== seq.current) return
    const done: TestOutcome = { state: 'done', result }
    setOutcome(done)
    onOutcomeRef.current?.(done)
  }, [dataProjectId])

  useEffect(() => {
    void run()
    const runs = seq
    // A result arriving after the step closed is ignored: bumping the counter (not a DOM ref)
    // makes the pending run's check fail.
    return () => {
      runs.current++
    }
  }, [run])

  const target = describeDataProjectTarget({ engine: form.engine, config: formToConfig(form) })
  const engineLabel = DATA_ENGINE_INFO[form.engine].label

  return (
    <div className="flex flex-col gap-4" data-testid="data-project-wizard-test-step">
      {outcome.state === 'running' ? (
        <div
          className="flex items-center gap-3 rounded-[9px] border border-border px-4 py-5"
          data-testid="data-project-wizard-test-running"
        >
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <div className="flex flex-col">
            <span className="text-[13px] font-medium">Connecting to {target}…</span>
            <span className="text-[12px] text-muted-foreground">
              Opening a {engineLabel} connection{form.sshEnabled ? ' through the SSH tunnel' : ''}.
            </span>
          </div>
        </div>
      ) : outcome.result.ok ? (
        <div
          className="flex flex-col gap-3 rounded-[9px] border border-emerald-500/30 bg-emerald-500/6 px-4 py-4"
          data-testid="data-project-wizard-test-success"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-emerald-500" />
            <span className="text-[13px] font-medium">Connected</span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            <dt className="text-muted-foreground">Server</dt>
            <dd className="font-mono" data-testid="data-project-wizard-test-version">
              {outcome.result.serverVersion || engineLabel}
            </dd>
            {typeof outcome.result.latencyMs === 'number' && (
              <>
                <dt className="text-muted-foreground">Round trip</dt>
                <dd className="font-mono" data-testid="data-project-wizard-test-latency">
                  {Math.round(outcome.result.latencyMs)} ms
                </dd>
              </>
            )}
            {outcome.result.databases && outcome.result.databases.length > 0 && (
              <>
                <dt className="text-muted-foreground">Databases</dt>
                <dd>{outcome.result.databases.length}</dd>
              </>
            )}
          </dl>
          {outcome.result.notice && <TestNotice notice={outcome.result.notice} />}
          {form.engine !== 'sqlite' &&
            outcome.result.databases &&
            outcome.result.databases.length > 0 && (
              <Field label="Default database" htmlFor="data-project-wizard-test-database" optional>
                <NativeSelect
                  id="data-project-wizard-test-database"
                  value={form.database}
                  onChange={onDatabaseChange}
                  options={[
                    { value: '', label: '(none)' },
                    ...Array.from(new Set([...outcome.result.databases, form.database]))
                      .filter(Boolean)
                      .map((name) => ({ value: name, label: name }))
                  ]}
                  testId="data-project-wizard-test-database"
                />
              </Field>
            )}
        </div>
      ) : (
        <div
          className="flex flex-col gap-2 rounded-[9px] border border-destructive/30 bg-destructive/6 px-4 py-4"
          data-testid="data-project-wizard-test-error"
        >
          <div className="flex items-center gap-2">
            <XCircle className="size-5 text-destructive" />
            <span className="text-[13px] font-medium">Could not connect</span>
          </div>
          <pre
            className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-[11px]"
            data-testid="data-project-wizard-test-error-message"
          >
            {outcome.result.error || 'Unknown error'}
          </pre>
          {outcome.result.notice && <TestNotice notice={outcome.result.notice} />}
          {connectionErrorHint(outcome.result.error, form.engine) && (
            <p
              className="text-[12px] text-muted-foreground"
              data-testid="data-project-wizard-test-hint"
            >
              {connectionErrorHint(outcome.result.error, form.engine)}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">
          {outcome.state === 'done' && !outcome.result.ok
            ? 'Go back to fix the settings, or continue and save it anyway.'
            : 'You can skip the test and save the connection anyway.'}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void run()}
          disabled={outcome.state === 'running'}
          data-testid="data-project-wizard-test-again"
        >
          <RotateCw className="size-3.5" />
          Test again
        </Button>
      </div>
    </div>
  )
}

/** A non-fatal server notice next to the result (the SSH host key fingerprint on first use). */
function TestNotice({ notice }: { notice: string }): React.JSX.Element {
  return (
    <p
      className="flex gap-1.5 rounded-md bg-amber-500/8 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300"
      role="status"
      data-testid="data-project-wizard-test-notice"
    >
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{notice}</span>
    </p>
  )
}
