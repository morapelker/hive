// Structure sub-tab of a table tab, editable TablePlus-style: columns (add with a type picker,
// rename, change type / NULL / default / comment, drop) and indexes (create, drop) are staged like
// the Data tab's row edits, shown in place (amber = changed, green = new, struck = dropped), and
// applied together. "Review SQL" shows the exact DDL for the engine (structure-model.ts plans it)
// with Copy and "Open in query tab".
//
// Apply sends the statements in one `query.execute` through runWithConfirmation (apply.ts), so the
// safety gate sees DDL like any other: read-only mode blocks it (the editor is read-only there
// anyway), safe / half-safe confirm, production types the table name for a drop. The server stops
// at the first failing statement: the banner says which one and why, the statements before it are
// dropped from the staging and the rest stays staged. Any run that changed something tells the
// workspace (notifySchemaChanged), which re-describes this table, reloads its DDL, the explorer
// and the completion schemas; TableTab reloads the Data view when it holds no row edits.
//
// Engine rules on top (apply.ts): MySQL / MariaDB never apply while the session has an open
// transaction (DDL would commit it) and quote literals for the session's NO_BACKSLASH_ESCAPES
// mode; a PostgreSQL failure inside an open transaction applies nothing (it is aborted); a
// failed ClickHouse type change is read back, since ClickHouse may keep the new type, and the
// banner offers the statement that changes it back. Warnings marked `confirm` (a ClickHouse
// retype, a SQLite non-constant default) make Apply open the review first.
//
// Views, materialized views, foreign tables, dictionaries, SQLite virtual tables and ClickHouse
// engines outside the MergeTree family show the same view read-only with the reason; per-column
// limits (SQLite cannot retype, ClickHouse key columns, identity / generated columns...) lock just
// those cells, with the reason in the tooltip. CHECK and UNIQUE constraints are listed read-only.
//
// The staged changes survive switching to Data / DDL (TableTab keeps this view mounted). Their
// count is reported under structureStagedKey(tab.id); "Discard" answered in the workspace's leave
// question (discardEpoch) drops them. ⌘S applies, ⌘R (from the data client) refreshes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Code2,
  Copy,
  FilePlus2,
  ListPlus,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  X
} from 'lucide-react'
import type { DataProject, DataTableDetails, SqlDialect } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import { useDataEditorBridge } from '@/components/data-projects/editor-bridge'
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
import { ShortcutHint } from '@/components/ui/shortcut-hint'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useDataWorkspaceStore, type DataTableTab } from '@/stores/useDataWorkspaceStore'
import {
  DATA_TABLE_COMMAND_EVENT,
  type DataTableCommandDetail
} from '../../DataProjectWorkspaceHost'
import { SqlText } from '../../shared/SqlText'
import {
  applyFailureSummary,
  applyStructureStatements,
  openTransactionMessage,
  type StructureApplyOutcome
} from './apply'
import { ColumnsTable } from './ColumnsTable'
import { constraintRows, parseCreateTable } from './ddl-parse'
import { IndexDialog } from './IndexDialog'
import { IndexesTable } from './IndexesTable'
import {
  ConstraintsSection,
  ForeignKeysSection,
  PropertiesSection,
  Section,
  TriggersSection
} from './sections'
import { structureStagedKey } from './staged-key'
import {
  addNewColumn,
  buildStructureModel,
  effectiveChange,
  emptyStructure,
  parseServerVersion,
  pendingStructureCount,
  planStructureChanges,
  planText,
  pruneStaged,
  rebaseAfterApply,
  upsertIndex,
  type IndexDraft,
  type StagedStructure,
  type StructureIssue
} from './structure-model'

export interface StructureEditorProps {
  project: DataProject
  dialect: SqlDialect
  tab: DataTableTab
  details: DataTableDetails
  /** Describe is running again (refresh, or after a schema change). */
  detailsLoading: boolean
  /** The last re-describe failed (the shown details are the previous ones). */
  detailsError: string | null
  /** Describes the table again. */
  onReload: () => void
  /** Statements ran: the table's columns may have changed. */
  onApplied?: () => void
}

interface ApplyError {
  headline: string
  note?: string
  message: string
  statement?: string
  /** A statement that undoes what the failure left behind (ClickHouse type change). */
  revert?: string
}

const applyErrorOf = (outcome: StructureApplyOutcome): ApplyError => {
  const { headline, note } = applyFailureSummary(outcome)
  return {
    headline,
    ...(note ? { note } : {}),
    message: outcome.error?.message ?? 'The structure change failed',
    ...(outcome.error?.statement ? { statement: outcome.error.statement } : {}),
    ...(outcome.retype && outcome.retype.state !== 'not-applied'
      ? { revert: outcome.retype.revert }
      : {})
  }
}

/** The status may carry the session's backslash mode (MySQL / MariaDB). */

const plural = (n: number, word: string, many = `${word}s`): string =>
  `${n} ${n === 1 ? word : many}`

export function StructureEditor({
  project,
  dialect,
  tab,
  details,
  detailsLoading,
  detailsError,
  onReload,
  onApplied
}: StructureEditorProps): React.JSX.Element {
  const refKey = JSON.stringify([tab.ref.database ?? '', tab.ref.schema ?? '', tab.ref.name])
  const schemaVersion = useDataWorkspaceStore((s) => s.schemaVersion[project.id] ?? 0)
  const serverVersion = useDataProjectStore((s) => s.statuses[project.id]?.serverVersion)
  const mysqlFamily = dialect === 'mysql' || dialect === 'mariadb'
  // MySQL / MariaDB: DDL commits an open transaction of the session, so Apply waits for it.
  const openTransaction = useDataProjectStore((s) => s.statuses[project.id]?.inTransaction === true)
  // MySQL / MariaDB NO_BACKSLASH_ESCAPES: what Apply last found (it checks before sending
  // statements with a backslash), else what the status says, else the server default.
  const statusBackslash = useDataProjectStore((s) => s.statuses[project.id]?.backslashEscapes)
  const [foundBackslash, setFoundBackslash] = useState<boolean | undefined>(undefined)
  useEffect(() => setFoundBackslash(undefined), [statusBackslash])
  const backslashEscapes = mysqlFamily ? (foundBackslash ?? statusBackslash ?? true) : true

  // ---- The CREATE TABLE text: MySQL column definitions, constraints ---------------------------
  const [ddl, setDdl] = useState<{
    text: string | null
    state: 'loading' | 'ready' | 'failed'
    error?: string
  }>({ text: null, state: 'loading' })
  const [ddlReload, setDdlReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    // The previous text stays until the new one arrives (constraints do not blink).
    setDdl((d) => ({ text: d.text, state: 'loading' }))
    dataProjectsApi
      .ddl(project.id, tab.ref)
      .then((text) => !cancelled && setDdl({ text, state: 'ready' }))
      .catch(
        (err) =>
          !cancelled &&
          setDdl({
            text: null,
            state: 'failed',
            error: errorMessage(err, 'Could not read the DDL')
          })
      )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, refKey, schemaVersion, ddlReload])

  const server = useMemo(() => parseServerVersion(serverVersion, dialect), [serverVersion, dialect])
  const parsed = useMemo(
    () => (ddl.text ? parseCreateTable(ddl.text, dialect) : null),
    [ddl.text, dialect]
  )
  const model = useMemo(
    () =>
      buildStructureModel({
        dialect,
        details,
        ref: tab.ref,
        safeMode: project.safeMode,
        server,
        parsed,
        ddlState: ddl.state,
        backslashEscapes
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dialect, details, refKey, project.safeMode, server, parsed, ddl.state, backslashEscapes]
  )

  // ---- Staging -------------------------------------------------------------------------------
  const [staged, setStaged] = useState<StagedStructure>(emptyStructure)
  const stagedRef = useRef(staged)
  stagedRef.current = staged
  const update = useCallback(
    (fn: (s: StagedStructure) => StagedStructure) => setStaged((s) => fn(s)),
    []
  )
  const [focusColumnId, setFocusColumnId] = useState<string | null>(null)
  const onFocused = useCallback(() => setFocusColumnId(null), [])
  const [indexDialog, setIndexDialog] = useState<{ initial: IndexDraft | null } | null>(null)
  const [review, setReview] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<ApplyError | null>(null)
  const [guardAction, setGuardAction] = useState<{ run: () => void } | null>(null)
  // After statements ran: the staging was rebased onto names the old describe does not have yet.
  const [awaitingRefresh, setAwaitingRefresh] = useState(false)

  const plan = useMemo(() => planStructureChanges(model, staged), [model, staged])
  const pending = pendingStructureCount(staged, model)
  const errors = plan.issues.filter((i) => i.level === 'error')
  const warnings = plan.issues.filter((i) => i.level === 'warning')
  const mustReview = warnings.some((w) => w.confirm)
  const readOnly = model.caps.readOnly
  const columnsLock = readOnly ?? model.caps.columns
  const indexesLock = readOnly ?? model.caps.indexes

  // A new describe ends the wait; then staged edits of columns / indexes that are gone (changed
  // elsewhere, e.g. in a query tab) are dropped, saying so.
  const seenDetails = useRef(details)
  useEffect(() => {
    if (seenDetails.current === details && !detailsError) return
    seenDetails.current = details
    setAwaitingRefresh(false)
  }, [details, detailsError])
  useEffect(() => {
    if (awaitingRefresh) return
    const { staged: pruned, removed } = pruneStaged(stagedRef.current, model)
    if (!removed) return
    setStaged(pruned)
    toast.warning(
      `${plural(removed, 'staged structure change')} no longer matched the table and ${removed === 1 ? 'was' : 'were'} dropped.`
    )
  }, [model, awaitingRefresh])

  // The workspace asks before closing this tab / leaving the project while changes are staged.
  useEffect(() => {
    useDataWorkspaceStore.getState().setStagedEditCount(structureStagedKey(tab.id), pending)
  }, [tab.id, pending])
  useEffect(
    () => () => useDataWorkspaceStore.getState().setStagedEditCount(structureStagedKey(tab.id), 0),
    [tab.id]
  )
  // Row edits staged in the Data view of this tab (a rename / drop can make them fail).
  const rowEdits = useDataWorkspaceStore((s) => s.stagedEdits[tab.id] ?? 0)
  const discardEpoch = useDataWorkspaceStore((s) => s.discardEpoch[project.id] ?? 0)
  const seenDiscardEpoch = useRef(discardEpoch)
  useEffect(() => {
    if (discardEpoch === seenDiscardEpoch.current) return
    seenDiscardEpoch.current = discardEpoch
    setStaged(emptyStructure())
    setReview(false)
  }, [discardEpoch])

  const discard = (): void => {
    setStaged(emptyStructure())
    setReview(false)
    setApplyError(null)
  }
  const reload = (): void => {
    onReload()
    setDdlReload((n) => n + 1)
  }
  const guarded = (action: () => void): void => {
    if (pending > 0) setGuardAction({ run: action })
    else action()
  }

  // ⌘R from the data client while this tab shows its structure.
  const guardedRef = useRef(guarded)
  guardedRef.current = guarded
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    const onCommand = (event: Event): void => {
      const detail = (event as CustomEvent<DataTableCommandDetail>).detail
      if (detail?.projectId !== project.id || detail.command !== 'refresh') return
      if (useDataWorkspaceStore.getState().getActiveTab(project.id)?.id !== tab.id) return
      if (tab.view !== 'structure') return
      event.preventDefault()
      guardedRef.current(() => reloadRef.current())
    }
    window.addEventListener(DATA_TABLE_COMMAND_EVENT, onCommand)
    return () => window.removeEventListener(DATA_TABLE_COMMAND_EVENT, onCommand)
  }, [project.id, tab.id, tab.view])

  // ---- Apply ---------------------------------------------------------------------------------
  const applyBlock = readOnly
    ? readOnly
    : plan.statements.length === 0
      ? 'Nothing to apply'
      : errors.length
        ? `${plural(errors.length, 'problem')} to fix first: ${errors[0].message}`
        : mysqlFamily && openTransaction
          ? openTransactionMessage(project.engine)
          : awaitingRefresh || detailsLoading
            ? 'Reading the table again…'
            : mysqlFamily && ddl.state === 'loading'
              ? 'Reading the column definitions…'
              : null

  const database = details.ref.database ?? tab.ref.database
  // The table as the DDL above is read (a failed ClickHouse retype is read back the same way).
  const context = { table: tab.ref, backslashEscapes: model.backslashEscapes }

  /** `reviewed`: the review dialog (which lists every warning) is what asked for it. */
  const apply = async (reviewed: boolean): Promise<void> => {
    if (applying || applyBlock) return
    if (!reviewed && mustReview) {
      setReview(true)
      return
    }
    const statements = plan.statements
    setApplying(true)
    setApplyError(null)
    try {
      const outcome = await applyStructureStatements(project, database, statements, context)
      if (outcome.backslashEscapes !== undefined) setFoundBackslash(outcome.backslashEscapes)
      if (outcome.applied > 0) setStaged((s) => rebaseAfterApply(s, outcome.appliedOps))
      if (outcome.applied > 0 || outcome.schemaChanged) {
        setAwaitingRefresh(true)
        useDataWorkspaceStore.getState().notifySchemaChanged(project.id)
        onApplied?.()
      }
      if (outcome.inTransaction && outcome.applied > 0) {
        toast.warning(
          'The changes ran inside the open transaction of this connection: COMMIT it in a query tab to keep them.'
        )
      }
      if (outcome.status === 'ok') {
        setReview(false)
        toast.success(
          `Structure of ${tab.ref.name} updated (${plural(outcome.total, 'statement')})`
        )
      } else if (outcome.status === 'failed' || outcome.status === 'refused') {
        setReview(false)
        setApplyError(applyErrorOf(outcome))
      }
    } finally {
      setApplying(false)
    }
  }

  /** Runs the banner's undo statement (a ClickHouse type changed back) through the gate. */
  const runRevert = async (sql: string): Promise<void> => {
    if (applying) return
    setApplying(true)
    try {
      const outcome = await applyStructureStatements(
        project,
        database,
        [{ sql, ops: [], parts: [] }],
        context
      )
      if (outcome.status === 'ok' || outcome.schemaChanged) {
        setAwaitingRefresh(true)
        useDataWorkspaceStore.getState().notifySchemaChanged(project.id)
        onApplied?.()
      }
      if (outcome.status === 'ok') {
        setApplyError(null)
        toast.success('The type was changed back')
      } else if (outcome.status === 'failed' || outcome.status === 'refused') {
        setApplyError({ ...applyErrorOf(outcome), revert: sql })
      }
    } finally {
      setApplying(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      // Not from the index dialog (it renders inside this tree): the index is not staged yet.
      if (pending && !indexDialog) void apply(review)
    }
  }

  const addColumn = (): void => {
    const { staged: next, id } = addNewColumn(staged, model)
    setStaged(next)
    setFocusColumnId(id)
  }

  // ---- Summary -------------------------------------------------------------------------------
  const changedColumns = model.columns.filter(
    (c) =>
      !staged.drops.includes(c.info.name) &&
      Object.keys(effectiveChange(c, staged.changes[c.info.name])).length > 0
  ).length
  const summary = [
    changedColumns && `${plural(changedColumns, 'column')} changed`,
    staged.adds.length && `${plural(staged.adds.length, 'column')} added`,
    staged.drops.length && `${plural(staged.drops.length, 'column')} dropped`,
    staged.addIndexes.length && plural(staged.addIndexes.length, 'new index', 'new indexes'),
    staged.dropIndexes.length && `${plural(staged.dropIndexes.length, 'index', 'indexes')} dropped`
  ]
    .filter(Boolean)
    .join(' · ')
  const constraints = constraintRows(dialect, details, parsed)
  const sql = planText(plan)

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
      data-testid="data-project-table-structure"
    >
      <div className="@container/stv flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => guarded(reload)}
          title="Refresh the structure"
          data-testid="data-project-structure-refresh"
        >
          {detailsLoading || ddl.state === 'loading' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
        {readOnly ? (
          <span
            className="flex min-w-0 items-center gap-1 px-1 text-[11px] text-muted-foreground"
            title={readOnly}
            data-testid="data-project-structure-readonly"
          >
            <Lock className="h-3 w-3 shrink-0" />
            <span className="truncate">{readOnly}</span>
          </span>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!columnsLock}
              onClick={addColumn}
              title={columnsLock ?? 'Add a column (staged until Apply)'}
              data-testid="data-project-structure-add-column"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden @[420px]/stv:inline">Column</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!indexesLock}
              onClick={() => setIndexDialog({ initial: null })}
              title={indexesLock ?? 'Create an index (staged until Apply)'}
              data-testid="data-project-structure-add-index"
            >
              <ListPlus className="h-3.5 w-3.5" />
              <span className="hidden @[420px]/stv:inline">Index</span>
            </Button>
            {model.caps.columns && (
              <span
                className="flex min-w-0 items-center gap-1 px-1 text-[11px] text-muted-foreground"
                title={model.caps.columns}
              >
                <Lock className="h-3 w-3 shrink-0" />
                <span className="hidden truncate @[640px]/stv:inline">{model.caps.columns}</span>
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {mysqlFamily && ddl.state === 'failed' && !readOnly && (
            <span
              className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300"
              title={`${ddl.error ?? 'SHOW CREATE TABLE failed'}: changing existing columns needs their full definition.`}
            >
              <AlertTriangle className="h-3 w-3" />
              <span className="hidden @[560px]/stv:inline">No column definitions</span>
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!pending}
            onClick={() => setReview(true)}
            title="Review the SQL of the staged changes"
            data-testid="data-project-structure-show-sql"
          >
            <Code2 className="h-3.5 w-3.5" />
            <span className="hidden @[560px]/stv:inline">SQL</span>
          </Button>
        </div>
      </div>
      {applyError && (
        <div
          className="flex shrink-0 items-start gap-2 border-b border-border bg-red-500/10 px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400"
          data-testid="data-project-structure-apply-error"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-medium">{applyError.headline}</div>
            <div className="whitespace-pre-wrap break-words">{applyError.message}</div>
            {applyError.statement && (
              <div className="max-h-24 overflow-auto rounded border border-red-500/20 bg-background/60 px-1.5 py-1">
                <SqlText text={applyError.statement} dialect={dialect} />
              </div>
            )}
            {applyError.note && (
              <div data-testid="data-project-structure-apply-error-note">{applyError.note}</div>
            )}
            {applyError.revert && (
              <div className="space-y-1">
                <div className="max-h-24 overflow-auto rounded border border-red-500/20 bg-background/60 px-1.5 py-1">
                  <SqlText
                    text={`${applyError.revert};`}
                    dialect={dialect}
                    data-testid="data-project-structure-apply-error-revert-sql"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6"
                    disabled={applying}
                    onClick={() => applyError.revert && void runRevert(applyError.revert)}
                    data-testid="data-project-structure-apply-error-revert"
                  >
                    Change the type back
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6"
                    onClick={() =>
                      applyError.revert &&
                      useDataEditorBridge.getState().insert({
                        dataProjectId: project.id,
                        text: `${applyError.revert};`,
                        mode: 'new-tab',
                        database: tab.ref.database,
                        title: `ALTER ${tab.ref.name}`,
                        origin: 'schema'
                      })
                    }
                    data-testid="data-project-structure-apply-error-revert-open"
                  >
                    Open in query tab
                  </Button>
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setApplyError(null)}
            className="shrink-0 rounded p-0.5 hover:bg-red-500/10"
            title="Dismiss"
            data-testid="data-project-structure-apply-error-dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {detailsError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-red-500/10 px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400">
          <span className="min-w-0 flex-1 truncate" title={detailsError}>
            Could not read the table again: {detailsError}
          </span>
          <Button variant="outline" size="sm" className="h-6" onClick={reload}>
            Retry
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <PropertiesSection details={details} />
        <Section
          title="Columns"
          count={details.columns.length}
          actions={
            !columnsLock && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[12px]"
                onClick={addColumn}
                data-testid="data-project-structure-add-column-inline"
              >
                <Plus className="h-3 w-3" />
                Column
              </Button>
            )
          }
        >
          <ColumnsTable
            model={model}
            staged={staged}
            onChange={update}
            issues={plan.issues}
            lockReason={columnsLock}
            focusColumnId={focusColumnId}
            onFocused={onFocused}
          />
        </Section>
        <Section
          title="Indexes"
          count={details.indexes.length}
          actions={
            !indexesLock && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[12px]"
                onClick={() => setIndexDialog({ initial: null })}
                data-testid="data-project-structure-add-index-inline"
              >
                <Plus className="h-3 w-3" />
                Index
              </Button>
            )
          }
        >
          <IndexesTable
            model={model}
            staged={staged}
            onChange={update}
            issues={plan.issues}
            lockReason={indexesLock}
            onEdit={(initial) => setIndexDialog({ initial })}
          />
        </Section>
        <ConstraintsSection rows={constraints} />
        <ForeignKeysSection details={details} />
        <TriggersSection details={details} />
      </div>
      {pending > 0 && (
        <div
          className="@container/pending flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[12px]"
          data-testid="data-project-structure-pending-bar"
        >
          <span
            className="font-medium text-amber-700 dark:text-amber-300"
            data-testid="data-project-structure-pending-count"
          >
            {pending} pending structure {pending === 1 ? 'change' : 'changes'}
          </span>
          {summary && (
            <span className="hidden text-muted-foreground @[620px]/pending:inline">{summary}</span>
          )}
          {errors.length > 0 && (
            <button
              type="button"
              onClick={() => setReview(true)}
              className="flex items-center gap-1 text-red-600 hover:underline dark:text-red-400"
              title={errors[0].message}
              data-testid="data-project-structure-problems"
            >
              <AlertTriangle className="h-3 w-3" />
              {plural(errors.length, 'problem')}
            </button>
          )}
          {errors.length === 0 && warnings.length > 0 && (
            <button
              type="button"
              onClick={() => setReview(true)}
              className="flex items-center gap-1 text-amber-700 hover:underline dark:text-amber-300"
              title={warnings[0].message}
              data-testid="data-project-structure-warnings"
            >
              <AlertTriangle className="h-3 w-3" />
              {plural(warnings.length, 'warning')}
            </button>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setReview(true)}
              title="Review the SQL of the pending changes"
              data-testid="data-project-structure-review"
            >
              <span className="@[380px]/pending:hidden">SQL</span>
              <span className="hidden @[380px]/pending:inline">Review SQL</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={discard}
              disabled={applying}
              data-testid="data-project-structure-discard"
            >
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => void apply(false)}
              disabled={applying || !!applyBlock}
              title={
                applyBlock ??
                (mustReview
                  ? 'Review the warnings, then apply (⌘S)'
                  : 'Apply the staged changes (⌘S)')
              }
              data-testid="data-project-structure-apply"
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Apply
              <ShortcutHint label="⌘S" />
            </Button>
          </div>
        </div>
      )}
      <Dialog open={review} onOpenChange={setReview}>
        <DialogContent
          className="flex max-h-[80vh] max-w-2xl flex-col"
          data-testid="data-project-structure-review-dialog"
        >
          <DialogHeader>
            <DialogTitle className="text-[15px]">Structure changes as SQL</DialogTitle>
            <DialogDescription className="text-[12px]">
              {mysqlFamily
                ? 'One ALTER TABLE: it applies as a whole or not at all.'
                : 'Runs statement by statement and stops at the first error; the statements before it stay applied.'}{' '}
              Nothing has been sent yet.
            </DialogDescription>
          </DialogHeader>
          {(plan.issues.length > 0 || rowEdits > 0) && (
            <IssueList
              issues={[
                ...errors,
                ...warnings,
                ...(rowEdits > 0
                  ? [
                      {
                        level: 'warning' as const,
                        message: `The Data view holds ${plural(rowEdits, 'staged row edit')}: commit them first if these changes rename or drop their columns.`
                      }
                    ]
                  : [])
              ]}
            />
          )}
          <div className="min-h-[120px] flex-1 overflow-auto rounded-md border border-border bg-muted/40 p-2">
            {sql ? (
              <SqlText
                text={sql}
                dialect={dialect}
                data-testid="data-project-structure-review-sql"
              />
            ) : (
              <span className="text-[12px] text-muted-foreground">No statements.</span>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!sql}
              onClick={async () => {
                if (await copyTextToClipboard(sql)) toast.success('SQL copied')
              }}
              data-testid="data-project-structure-review-copy"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!sql}
              onClick={() => {
                useDataEditorBridge.getState().insert({
                  dataProjectId: project.id,
                  text: sql,
                  mode: 'new-tab',
                  database: tab.ref.database,
                  title: `ALTER ${tab.ref.name}`,
                  origin: 'schema'
                })
                setReview(false)
              }}
              data-testid="data-project-structure-review-open"
            >
              <FilePlus2 className="h-3.5 w-3.5" />
              Open in query tab
            </Button>
            <Button
              size="sm"
              disabled={applying || !!applyBlock || !!readOnly}
              title={applyBlock ?? undefined}
              onClick={() => void apply(true)}
              data-testid="data-project-structure-review-apply"
            >
              {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {indexDialog && (
        <IndexDialog
          model={model}
          staged={staged}
          initial={indexDialog.initial}
          onClose={() => setIndexDialog(null)}
          onSave={(draft) => {
            setStaged((s) => upsertIndex(s, draft))
            setIndexDialog(null)
          }}
        />
      )}
      <AlertDialog
        open={guardAction !== null}
        onOpenChange={(open) => !open && setGuardAction(null)}
      >
        <AlertDialogContent size="sm" data-testid="data-project-structure-discard-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">
              Discard {plural(pending, 'pending structure change')}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]">
              Reading the table again drops the staged changes. Apply them first to keep them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const action = guardAction
                setGuardAction(null)
                discard()
                action?.run()
              }}
              data-testid="data-project-structure-discard-confirm"
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function IssueList({ issues }: { issues: StructureIssue[] }): React.JSX.Element {
  return (
    <ul
      className="max-h-28 space-y-0.5 overflow-auto text-[12px]"
      data-testid="data-project-structure-issues"
    >
      {issues.map((issue, i) => (
        <li
          key={i}
          className={cn(
            'flex items-start gap-1.5',
            issue.level === 'error'
              ? 'text-red-600 dark:text-red-400'
              : 'text-amber-700 dark:text-amber-300'
          )}
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  )
}
