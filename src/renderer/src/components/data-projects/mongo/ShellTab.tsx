// Shell tab: mongosh-style statements (`db.orders.find({…}).sort({…})`, `use shop`, `show dbs`,
// CRUD, indexes, runCommand…) parsed without eval on the server and run through
// `dataProjects.query.execute` (source 'mongo') — so the safe mode gates them like SQL.
//
// ⌘↵ runs the selection or the statement under the cursor, ⇧⌘↵ the whole tab, ⌘. cancels, ⌘S
// saves the tab as a saved query (the engine-agnostic saved-queries store; Save updates the
// linked one). The editor underlines statements the shell cannot run (shared structural parser)
// and the toolbar shows the READ / WRITE / DDL badge of the statement under the cursor (shared
// classifier). Results: one tab per statement — document lists in the List / JSON / Table viewer,
// values as highlighted shell text, command messages — plus Messages with every statement's
// outcome. A server error position is underlined in the editor. `use x` switches the tab's
// database. Assistant proposals arrive through the editor bridge (the workspace applies them to
// the store; this editor is controlled by the tab text).
//
// The run state lives in shell-runs (not here): a statement keeps running, with its Cancel, when
// the user switches to another tab and back; closing the tab cancels it.
//
// A tab restored after a restart may hold masked text (`pwd: '***'`, see MongoShellTab.masked).
// Linked to a saved query and not edited since, it reloads the saved text when it opens; edited,
// Save never writes it over the saved query (it offers Save as instead).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bookmark,
  ListChecks,
  Loader2,
  Play,
  PlayCircle,
  Sparkles,
  Square
} from 'lucide-react'
import type {
  DataProject,
  DataQueryResponse,
  DataStatementClass,
  DataStatementResult
} from '@shared/data-projects/types'
import { classifyMongoShellStatement, type MongoShellSpan } from '@shared/data-projects/mongo-shell'
import { dataProjectsApi } from '@/api/data-projects-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import {
  QueryEditor,
  type EditorErrorRange,
  type QueryEditorHandle,
  type QueryEditorRunTarget
} from '@/components/data-projects/editor'
import { ResultGrid } from '@/components/data-projects/grid'
import {
  SaveQueryDialog,
  StatementBadge,
  runWithConfirmation
} from '@/components/data-projects/shared'
import { ResizeHandle } from '@/components/layout/ResizeHandle'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  SHELL_LIMITS,
  useMongoWorkspaceStore,
  type MongoShellTab
} from '@/stores/useMongoWorkspaceStore'
import { useMongoCompletionData } from './completion-data'
import { DocumentResults, DocumentViewToggle, HighlightedCode } from './DocumentResults'
import { formatShellValue } from './ejson'
import { createMongoCompletionSource } from './mongo-completion-source'
import { formatDuration, isCancelError, mongoErrorText, newQueryId } from './mongo-ui'
import { mongoCursorStatement, mongoShellLinter, mongoStatementRange } from './shell-extensions'
import {
  EMPTY_SHELL_RUN,
  cancelShellRun,
  databaseAfterRun,
  finishShellRun,
  resetShellRuns,
  setShellRunActive,
  shellRunEntry,
  startShellRun,
  useShellRuns,
  type ShellRun
} from './shell-runs'

/** Tests only. */
export function resetShellCache(): void {
  resetShellRuns()
}

const MASKED_SAVE_MESSAGE =
  'This tab was restored with its secrets masked (***) or its text cut short, so saving it would replace the saved query’s real text. Save it as a new query, or reopen the saved query from Saved queries.'

const ORIGIN_LABEL: Record<string, string> = {
  assistant: 'From the assistant',
  history: 'From history',
  saved: 'Saved query',
  schema: 'Generated'
}

function statementTitle(st: DataStatementResult): string {
  const m = /\.(\w+)\s*\(/.exec(st.text)
  const head = st.text.trim().split(/\s+/)[0]
  return m ? m[1] : head.length > 14 ? `${head.slice(0, 13)}…` : head
}

function errorRangeOf(run: ShellRun, docLength: number): EditorErrorRange | null {
  const failed = run.statements.find((s) => s.error)
  if (!failed?.error) return null
  const base = run.from + failed.start
  if (typeof failed.error.position === 'number') {
    const from = Math.min(docLength, base + Math.max(0, failed.error.position))
    return { from, to: Math.min(docLength, from + 1), message: failed.error.message }
  }
  const firstLine = failed.text.split('\n')[0]
  return {
    from: base,
    to: Math.min(docLength, base + firstLine.length),
    message: failed.error.message
  }
}

function StatementOutput({
  result,
  view,
  onView,
  limit
}: {
  result: DataStatementResult
  view: MongoShellTab['resultView']
  onView: (view: MongoShellTab['resultView']) => void
  limit: number
}): React.JSX.Element {
  const output = result.output
  if (result.error) {
    return (
      <div className="space-y-1 p-3" data-testid="data-project-mongo-shell-result-error">
        <div className="whitespace-pre-wrap font-mono text-[12px] text-destructive">
          {result.error.message}
        </div>
        {result.error.hint && (
          <div className="text-[12px] text-muted-foreground">{result.error.hint}</div>
        )}
      </div>
    )
  }
  if (!output) return <div className="p-3 text-[12px] text-muted-foreground">No output</div>
  if (output.kind === 'documents') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-[12px] text-muted-foreground">
          <span data-testid="data-project-mongo-shell-doc-count">
            {output.documents.length}
            {output.truncated ? '+' : ''} document{output.documents.length === 1 ? '' : 's'}
            {output.truncated && output.limit
              ? ` (limited to ${output.limit}${limit ? '' : ' by the hard cap'})`
              : ''}
          </span>
          <span>· {formatDuration(result.durationMs)}</span>
          <div className="ml-auto">
            <DocumentViewToggle
              value={view}
              onChange={onView}
              testIdPrefix="data-project-mongo-shell"
            />
          </div>
        </div>
        <DocumentResults
          documents={output.documents}
          view={view}
          emptyText="No documents"
          testIdPrefix="data-project-mongo-shell-result"
        />
      </div>
    )
  }
  if (output.kind === 'value') {
    return (
      <div
        className="min-h-0 flex-1 overflow-auto p-3"
        data-testid="data-project-mongo-shell-value"
      >
        <HighlightedCode
          text={formatShellValue(output.value, { mode: 'display', indent: 2, width: 100 })}
        />
      </div>
    )
  }
  if (output.kind === 'rows') {
    return <ResultGrid columns={output.columns} rows={output.rows} className="flex-1" />
  }
  return (
    <div className="p-3 text-[13px]" data-testid="data-project-mongo-shell-command">
      {output.message ?? 'OK'}
      {output.affectedRows !== null && output.affectedRows !== undefined && (
        <span className="text-muted-foreground"> · {output.affectedRows} affected</span>
      )}
      <span className="text-muted-foreground"> · {formatDuration(result.durationMs)}</span>
    </div>
  )
}

export function ShellTab({
  project,
  tab,
  databases
}: {
  project: DataProject
  tab: MongoShellTab
  /** Databases for the selector (from the explorer). */
  databases: readonly string[]
}): React.JSX.Element {
  const updateShell = useMongoWorkspaceStore((s) => s.updateShell)
  const completionData = useMongoCompletionData(project, tab.database || undefined)
  const editorRef = useRef<QueryEditorHandle>(null)
  const entry = useShellRuns((s) => s.entries[tab.id]) ?? EMPTY_SHELL_RUN
  const { run, running, active } = entry
  const setActive = (next: number | 'messages'): void => setShellRunActive(tab.id, next)
  const [cursorStatement, setCursorStatement] = useState<MongoShellSpan | null>(null)
  const [fraction, setFraction] = useState(0.5)
  const [saveOpen, setSaveOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const tabRef = useRef(tab)
  tabRef.current = tab
  /** The tab as stored now (a keystroke may not have re-rendered this component yet). */
  const liveTab = useCallback((): MongoShellTab => {
    const stored = useMongoWorkspaceStore
      .getState()
      .workspaces[project.id]?.tabs.find((t) => t.id === tabRef.current.id)
    return stored?.kind === 'shell' ? stored : tabRef.current
  }, [project.id])

  // Restored with masked text but linked to a saved query and not edited since: the saved
  // query holds the real text, so load it back (Run and Save then use it, not the '***' copy).
  const reloadSavedId =
    tab.masked && tab.savedQueryId && tab.text === tab.baseline ? tab.savedQueryId : null
  useEffect(() => {
    if (!reloadSavedId) return
    let cancelled = false
    const restoredText = liveTab().text
    dataProjectsApi
      .savedQueries(project.id)
      .then((list) => {
        if (cancelled) return
        const query = Array.isArray(list) ? list.find((q) => q.id === reloadSavedId) : undefined
        const current = liveTab()
        // Edited, relinked or reloaded meanwhile: leave it to the user.
        if (
          !query ||
          !current.masked ||
          current.savedQueryId !== reloadSavedId ||
          current.text !== restoredText
        )
          return
        updateShell(project.id, current.id, {
          text: query.text,
          baseline: query.text,
          masked: false
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [reloadSavedId, project.id, liveTab, updateShell])

  const completionSources = useMemo(
    () => [createMongoCompletionSource(completionData)],
    [completionData]
  )
  const extraExtensions = useMemo(
    () => [mongoShellLinter(), mongoCursorStatement((span) => setCursorStatement(span))],
    []
  )

  const badge = useMemo((): { cls: DataStatementClass; dangerous: string[] } | null => {
    if (!cursorStatement) return null
    const c = classifyMongoShellStatement(cursorStatement.text, {
      database: tab.database || undefined
    })
    return { cls: c.classification, dangerous: c.dangerous }
  }, [cursorStatement, tab.database])

  const execute = useCallback(
    async (target: QueryEditorRunTarget): Promise<void> => {
      const current = liveTab()
      // Read live: the run may have started before this component (re)mounted.
      if (shellRunEntry(current.id).running) return
      const queryId = newQueryId()
      startShellRun(current.id, queryId)
      if (current.origin) updateShell(project.id, current.id, { origin: null })
      // '(connection default)' is the configured database, sent explicitly so another tab's
      // `use` cannot redirect this one.
      const database = current.database || project.config.database?.trim() || undefined
      const finish = (next: ShellRun, nextActive: number | 'messages'): boolean =>
        finishShellRun(current.id, queryId, next, nextActive)
      let response: DataQueryResponse | { status: 'declined' }
      try {
        response = await runWithConfirmation<DataQueryResponse>((confirmToken) =>
          dataProjectsApi.execute({
            dataProjectId: project.id,
            queryId,
            text: target.text,
            ...(database ? { database } : {}),
            limit: current.limit > 0 ? current.limit : null,
            source: 'mongo',
            ...(confirmToken ? { confirmToken } : {})
          })
        )
      } catch (e) {
        const cancelledByUser = shellRunEntry(current.id).cancelRequested || isCancelError(e)
        finish(
          {
            status: cancelledByUser ? 'cancelled' : 'error',
            statements: [],
            from: target.from,
            message: cancelledByUser
              ? 'Cancelled'
              : mongoErrorText(project, e, 'The statement failed')
          },
          'messages'
        )
        return
      }
      switch (response.status) {
        case 'ok': {
          const failedIndex = response.statements.findIndex((s) => s.error)
          const applied = finish(
            {
              status: 'ok',
              statements: response.statements,
              from: target.from,
              durationMs: response.durationMs
            },
            failedIndex >= 0 && response.statements.length > 1
              ? 'messages'
              : Math.max(0, failedIndex >= 0 ? failedIndex : response.statements.length - 1)
          )
          // `use x` (or the server's view of the session database) moves the tab.
          const nextDb = databaseAfterRun(response.statements, response.database)
          if (applied && nextDb && nextDb !== tabRef.current.database)
            updateShell(project.id, current.id, { database: nextDb })
          break
        }
        case 'cancelled':
          finish(
            {
              status: 'cancelled',
              statements: response.statements,
              from: target.from,
              durationMs: response.durationMs,
              message: 'Cancelled'
            },
            'messages'
          )
          break
        case 'declined':
          finish(
            {
              status: 'declined',
              statements: [],
              from: target.from,
              message: 'Not run: the statement was not confirmed'
            },
            'messages'
          )
          break
        case 'blocked':
          finish(
            {
              status: 'blocked',
              statements: [],
              from: target.from,
              message: `Blocked by the safe mode: ${response.reason}`
            },
            'messages'
          )
          break
        default:
          finish(
            { status: 'error', statements: [], from: target.from, message: 'Unexpected response' },
            'messages'
          )
      }
    },
    [project, updateShell, liveTab]
  )

  const cancel = useCallback((): void => cancelShellRun(tab.id), [tab.id])

  // ---- save ------------------------------------------------------------------------------------

  const saveTo = async (name: string, id?: string): Promise<void> => {
    const current = liveTab()
    if (id && current.masked) {
      // Never write the '***' copy over the saved query's real text.
      toast.error(MASKED_SAVE_MESSAGE)
      throw new Error(MASKED_SAVE_MESSAGE)
    }
    try {
      const saved = await dataProjectsApi.saveQuery(project.id, {
        ...(id ? { id } : {}),
        name,
        text: current.text,
        database: current.database || null
      })
      updateShell(project.id, current.id, {
        savedQueryId: saved.id,
        title: saved.name,
        baseline: current.text,
        // The linked saved query now holds exactly this text.
        masked: false
      })
      toast.success(`Saved "${saved.name}"`)
    } catch (error) {
      toast.error(`Could not save the query: ${errorMessage(error)}`)
      throw error
    }
  }

  const save = (): void => {
    const current = liveTab()
    if (!current.text.trim()) {
      toast.info('Nothing to save yet.')
      return
    }
    if (current.savedQueryId && current.masked) {
      toast.warning(MASKED_SAVE_MESSAGE)
      setSaveOpen(true)
    } else if (current.savedQueryId)
      void saveTo(current.title, current.savedQueryId).catch(() => undefined)
    else setSaveOpen(true)
  }

  const errorRange = useMemo(
    () => (run && run.status === 'ok' ? errorRangeOf(run, tab.text.length) : null),
    [run, tab.text.length]
  )

  const runFromToolbar = (mode: 'current' | 'all'): void => {
    const target = editorRef.current?.getRunTarget(mode)
    if (target) void execute(target)
    else editorRef.current?.focus()
  }

  const statements = run?.statements ?? []
  const shown = active === 'messages' ? null : (statements[active] ?? null)
  const dbOptions = useMemo(() => {
    const set = new Set(databases)
    if (tab.database) set.add(tab.database)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [databases, tab.database])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-project-mongo-shell">
      {/* Narrow panes (sidebar + explorer + assistant) drop labels and shortcut hints first, then
          wrap the run group onto a second row; Run never leaves the pane. */}
      <div className="@container/mst flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
        <span className="hidden text-[12px] text-muted-foreground @[620px]/mst:inline">
          Database
        </span>
        <select
          value={tab.database}
          onChange={(e) => updateShell(project.id, tab.id, { database: e.target.value })}
          title="Database this tab runs in"
          className="h-7 min-w-0 max-w-[140px] rounded-[6px] border border-input bg-background px-1.5 font-mono text-[12px] @[620px]/mst:max-w-[200px] dark:bg-input/30"
          data-testid="data-project-mongo-shell-database"
        >
          <option value="">(connection default)</option>
          {dbOptions.map((db) => (
            <option key={db} value={db}>
              {db}
            </option>
          ))}
        </select>
        <select
          value={tab.limit}
          onChange={(e) => updateShell(project.id, tab.id, { limit: Number(e.target.value) })}
          title="Documents returned per statement"
          className="h-7 rounded-[6px] border border-input bg-background px-1.5 text-[12px] dark:bg-input/30"
          data-testid="data-project-mongo-shell-limit"
        >
          {SHELL_LIMITS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'No limit' : `Limit ${n}`}
            </option>
          ))}
        </select>
        {badge && (
          <span
            className="flex items-center gap-1"
            title={badge.dangerous.join('\n') || undefined}
            data-testid="data-project-mongo-shell-badge"
          >
            <StatementBadge classification={badge.cls} />
            {badge.dangerous.length > 0 && (
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
            )}
          </span>
        )}
        {tab.origin && (
          <span
            className="flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] text-violet-700 dark:text-violet-300"
            title={ORIGIN_LABEL[tab.origin] ?? tab.origin}
            data-testid="data-project-mongo-shell-origin"
          >
            <Sparkles className="h-3 w-3" />
            <span className="hidden @[720px]/mst:inline">
              {ORIGIN_LABEL[tab.origin] ?? tab.origin}
            </span>
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={save}
            title={tab.savedQueryId ? 'Update the saved query (⌘S)' : 'Save as a query (⌘S)'}
            data-testid="data-project-mongo-shell-save"
          >
            <Bookmark className={cn('h-3.5 w-3.5', tab.savedQueryId && 'fill-current')} />
            <span className="hidden @[620px]/mst:inline">Save</span>
          </Button>
          {running ? (
            <Button
              variant="outline"
              size="sm"
              onClick={cancel}
              disabled={entry.cancelRequested}
              data-testid="data-project-mongo-shell-cancel"
            >
              {entry.cancelRequested ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              Cancel
              <span className="hidden text-[11px] opacity-60 @[520px]/mst:inline">⌘.</span>
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => runFromToolbar('all')}
                title="Run every statement (⇧⌘↵)"
                data-testid="data-project-mongo-shell-run-all"
              >
                <PlayCircle className="h-3.5 w-3.5" />
                <span className="hidden @[520px]/mst:inline">Run all</span>
                <span className="hidden text-[11px] opacity-60 @[760px]/mst:inline">⇧⌘↵</span>
              </Button>
              <Button
                size="sm"
                onClick={() => runFromToolbar('current')}
                title="Run the statement under the cursor or the selection (⌘↵)"
                data-testid="data-project-mongo-shell-run"
              >
                <Play className="h-3.5 w-3.5" />
                Run
                <span className="hidden text-[11px] opacity-60 @[520px]/mst:inline">⌘↵</span>
              </Button>
            </>
          )}
        </div>
      </div>

      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0" style={{ height: `${(run ? fraction : 1) * 100}%` }}>
          <QueryEditor
            ref={editorRef}
            value={tab.text}
            onChange={(text) =>
              updateShell(project.id, tab.id, { text, ...(tab.origin ? { origin: null } : {}) })
            }
            language="mongo"
            completionSources={completionSources}
            extraExtensions={extraExtensions}
            statementRange={mongoStatementRange}
            onRun={(target) => void execute(target)}
            onCancel={cancel}
            onSave={save}
            errorRange={errorRange}
            placeholder={"db.orders.find({ status: 'A' }).sort({ createdAt: -1 })"}
            autoFocus
            data-testid="data-project-mongo-shell-editor"
          />
        </div>
        {run && (
          <>
            <ResizeHandle
              direction="down"
              onResize={(delta) => {
                const height = bodyRef.current?.clientHeight ?? 600
                setFraction((f) => Math.min(0.85, Math.max(0.15, f - delta / height)))
              }}
            />
            <div
              className="flex min-h-0 flex-1 flex-col"
              data-testid="data-project-mongo-shell-results"
            >
              <div className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-border bg-card text-[12px]">
                {statements.map((st, i) => (
                  <button
                    key={`${st.index}-${st.start}`}
                    type="button"
                    onClick={() => setActive(i)}
                    className={cn(
                      'flex h-full shrink-0 items-center gap-1.5 border-r border-border px-2.5',
                      active === i
                        ? 'bg-background text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    data-testid={`data-project-mongo-shell-result-tab-${i}`}
                  >
                    {st.error && <AlertTriangle className="h-3 w-3 text-destructive" />}
                    <span className="font-mono">
                      {i + 1} · {statementTitle(st)}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setActive('messages')}
                  className={cn(
                    'flex h-full shrink-0 items-center gap-1.5 border-r border-border px-2.5',
                    active === 'messages'
                      ? 'bg-background text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  data-testid="data-project-mongo-shell-messages-tab"
                >
                  <ListChecks className="h-3.5 w-3.5" />
                  Messages
                </button>
                {running && (
                  <span className="ml-2 flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Running…
                  </span>
                )}
              </div>
              {shown ? (
                <StatementOutput
                  result={shown}
                  view={tab.resultView}
                  onView={(resultView) => updateShell(project.id, tab.id, { resultView })}
                  limit={tab.limit}
                />
              ) : (
                <div
                  className="min-h-0 flex-1 overflow-auto p-2"
                  data-testid="data-project-mongo-shell-messages"
                >
                  {run.message && (
                    <div
                      className={cn(
                        'mb-2 whitespace-pre-wrap rounded-[6px] px-2.5 py-1.5 font-mono text-[12px]',
                        run.status === 'error' || run.status === 'blocked'
                          ? 'bg-destructive/10 text-destructive'
                          : 'bg-secondary text-muted-foreground'
                      )}
                    >
                      {run.message}
                    </div>
                  )}
                  {statements.map((st, i) => (
                    <div
                      key={`${st.index}-${st.start}`}
                      className="flex items-start gap-2 border-b border-border/60 py-1.5 text-[12px]"
                    >
                      <StatementBadge classification={st.classification} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono">{st.text.split('\n')[0]}</div>
                        {st.error ? (
                          <div className="whitespace-pre-wrap text-destructive">
                            {st.error.message}
                          </div>
                        ) : (
                          <div className="text-muted-foreground">
                            {st.output?.kind === 'documents'
                              ? `${st.output.documents.length}${st.output.truncated ? '+' : ''} documents`
                              : st.output?.kind === 'command'
                                ? (st.output.message ?? 'OK')
                                : 'OK'}
                          </div>
                        )}
                        {st.notices?.map((n, j) => (
                          <div key={j} className="text-muted-foreground">
                            {n}
                          </div>
                        ))}
                      </div>
                      <span className="shrink-0 text-muted-foreground">
                        {formatDuration(st.durationMs)}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setActive(i)}
                      >
                        Show
                      </button>
                    </div>
                  ))}
                  {statements.length === 0 && !run.message && (
                    <div className="p-2 text-muted-foreground">Nothing ran.</div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
        {!run && (
          <div
            className="flex h-7 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-border px-3 text-[11px] text-muted-foreground"
            data-testid="data-project-mongo-shell-hint"
          >
            <span>⌘↵ runs the statement at the cursor</span>
            <span>⇧⌘↵ runs everything</span>
            <span>⌘. cancels</span>
            <span>⌘S saves</span>
            <span className="ml-auto font-mono">
              use &lt;db&gt; · show collections · db.coll.find()
            </span>
          </div>
        )}
      </div>
      <SaveQueryDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        initialName={
          tab.masked && tab.savedQueryId
            ? `${tab.title} (copy)`
            : /^Shell \d+$/.test(tab.title)
              ? ''
              : tab.title
        }
        onSave={(name) => saveTo(name)}
      />
    </div>
  )
}
