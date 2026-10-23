// The confirm / blocked dialogs behind `runWithConfirmation`. Mounted once per DataProjectView.
//
// Confirm dialog (research/safety.md §B):
// - a header strip in the environment colour: `PRODUCTION · orders-db · shop`, so production is
//   impossible to miss;
// - every statement of the request, dangerous ones first, each with its class badge
//   (READ/WRITE/DDL/ADMIN/LOCK/UNKNOWN), the reasons it needs confirmation, the dangerous-statement
//   warnings in red and the highlighted text;
// - when the plan carries `typedConfirmation` (production + DROP/TRUNCATE/DELETE without WHERE)
//   the Run button stays disabled until that exact text is typed;
// - Cancel has the default focus (Enter on open = cancel); Cmd/Ctrl+Enter runs.
// The blocked variant lists the same statements with the reason and a single Close button.

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Ban, ShieldAlert } from 'lucide-react'
import {
  DATA_ENGINE_INFO,
  type DataExecutionPlan,
  type DataPlannedStatement
} from '@shared/data-projects/types'
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
import { ShortcutHint } from '@/components/ui/shortcut-hint'
import {
  environmentColor,
  environmentLabel,
  glyphColorOn,
  SAFE_MODE_INFO
} from '@/components/data-projects/data-project-ui'
import { cn } from '@/lib/utils'
import { orderPlanStatements, useDataConfirmStore, type DataConfirmRequest } from './confirm'
import { SqlText } from './SqlText'
import { StatementBadge } from './StatementBadge'

const sqlDialectOfPlan = (plan: DataExecutionPlan) =>
  plan.engine === 'mongodb' ? null : plan.engine

function EnvironmentStrip({ plan }: { plan: DataExecutionPlan }): React.JSX.Element {
  const color = environmentColor({ environment: plan.environment, color: null })
  const parts = [environmentLabel(plan.environment).toUpperCase(), plan.projectName, plan.database]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      className="-mx-5 -mt-5 mb-1 flex items-center gap-2 px-5 py-2 text-[12px] font-semibold tracking-[0.04em]"
      style={{ backgroundColor: color, color: glyphColorOn(color) }}
      data-testid="data-project-confirm-env"
    >
      {plan.environment === 'production' && <ShieldAlert className="h-4 w-4 shrink-0" />}
      <span className="truncate">{parts}</span>
      <span className="ml-auto shrink-0 font-normal opacity-80">
        {DATA_ENGINE_INFO[plan.engine].label} · {SAFE_MODE_INFO[plan.safeMode].label}
      </span>
    </div>
  )
}

function StatementCard({
  statement,
  plan,
  muted
}: {
  statement: DataPlannedStatement
  plan: DataExecutionPlan
  muted?: boolean
}): React.JSX.Element {
  const dangerous = statement.dangerous.length > 0
  return (
    <li
      className={cn(
        'rounded-[8px] border p-2',
        dangerous ? 'border-red-500/60 bg-red-500/[0.06]' : 'border-border',
        muted && !dangerous && 'opacity-70'
      )}
      data-testid={`data-project-confirm-statement-${statement.index}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <StatementBadge classification={statement.classification} />
        <span className="text-[11px] text-muted-foreground">#{statement.index + 1}</span>
        {statement.reasons.length > 0 && (
          <span className="text-[11px] text-muted-foreground">{statement.reasons.join(' · ')}</span>
        )}
      </div>
      {statement.dangerous.map((warning) => (
        <div
          key={warning}
          className="mb-1 flex items-start gap-1.5 text-[12px] font-medium text-red-600 dark:text-red-400"
        >
          <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" />
          <span>{warning}</span>
        </div>
      ))}
      <SqlText
        text={statement.text}
        dialect={sqlDialectOfPlan(plan)}
        className="max-h-40 overflow-auto rounded-[6px] bg-muted/50 px-2 py-1"
      />
    </li>
  )
}

function ConfirmDialog({ request }: { request: DataConfirmRequest }): React.JSX.Element {
  const resolve = useDataConfirmStore((s) => s.resolve)
  const { plan } = request
  const [typed, setTyped] = useState('')
  const ordered = useMemo(() => orderPlanStatements(plan.statements), [plan.statements])
  const needsTyping = !!plan.typedConfirmation
  const canRun = !needsTyping || typed === plan.typedConfirmation
  const anyDangerous = plan.statements.some((s) => s.dangerous.length > 0)
  const destructive =
    anyDangerous ||
    plan.environment === 'production' ||
    plan.statements.some((s) => s.classification !== 'read' && s.classification !== 'session')
  const count = plan.statements.length
  const confirmCount = plan.statements.filter((s) => s.needsConfirmation).length

  const run = (): void => {
    if (canRun) resolve(request.id, true)
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && resolve(request.id, false)}>
      <AlertDialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl"
        style={{
          borderTop: `3px solid ${environmentColor({ environment: plan.environment, color: null })}`
        }}
        data-testid="data-project-confirm-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            run()
          }
        }}
      >
        <EnvironmentStrip plan={plan} />
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[15px]">
            {anyDangerous
              ? 'Run a dangerous statement?'
              : count === 1
                ? 'Run this statement?'
                : `Run ${count} statements?`}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[12px]">
            {SAFE_MODE_INFO[plan.safeMode].label} mode asks before{' '}
            {confirmCount === count
              ? 'this request runs'
              : `${confirmCount} of these ${count} statements run`}
            . Nothing has run yet.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul
          className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1"
          data-testid="data-project-confirm-statements"
        >
          {ordered.map((s) => (
            <StatementCard key={s.index} statement={s} plan={plan} muted={!s.needsConfirmation} />
          ))}
        </ul>
        {needsTyping && (
          <label className="flex flex-col gap-1.5 text-[12px]">
            <span>
              Type{' '}
              <code className="rounded bg-muted px-1 font-mono font-semibold">
                {plan.typedConfirmation}
              </code>{' '}
              to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              data-testid="data-project-confirm-typed"
              className="h-8 rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault()
                  run()
                }
              }}
            />
          </label>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="data-project-confirm-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={!canRun}
            onClick={(e) => {
              e.preventDefault()
              run()
            }}
            data-testid="data-project-confirm-run"
          >
            {count === 1 ? 'Run' : `Run ${count} statements`}
            <ShortcutHint label="⌘↵" />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function BlockedDialog({ request }: { request: DataConfirmRequest }): React.JSX.Element {
  const resolve = useDataConfirmStore((s) => s.resolve)
  const { plan } = request
  const ordered = useMemo(() => orderPlanStatements(plan.statements), [plan.statements])
  const blockedOnes = ordered.filter((s) => s.needsConfirmation || s.reasons.length > 0)
  return (
    <AlertDialog open onOpenChange={(open) => !open && resolve(request.id, false)}>
      <AlertDialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl"
        data-testid="data-project-blocked-dialog"
      >
        <EnvironmentStrip plan={plan} />
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-[15px]">
            <Ban className="h-4 w-4 text-red-500" />
            {plan.safeMode === 'read-only' ? 'Blocked by read-only mode' : 'Not allowed'}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[12px]" data-testid="data-project-blocked-reason">
            {request.reason || 'This request was refused.'} Nothing ran.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {(blockedOnes.length ? blockedOnes : ordered).map((s) => (
            <StatementCard key={s.index} statement={s} plan={plan} />
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="data-project-blocked-close">Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Mount once (DataProjectView). Renders the head of the confirmation queue. */
export function DataConfirmHost(): React.JSX.Element | null {
  const head = useDataConfirmStore((s) => s.queue[0] ?? null)
  const registerHost = useDataConfirmStore((s) => s.registerHost)
  useEffect(() => registerHost(), [registerHost])
  if (!head) return null
  return head.kind === 'blocked' ? (
    <BlockedDialog key={head.id} request={head} />
  ) : (
    <ConfirmDialog key={head.id} request={head} />
  )
}
