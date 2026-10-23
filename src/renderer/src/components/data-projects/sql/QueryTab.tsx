// A query tab: toolbar (Run ⌘↵, Run all ⇧⌘↵, Cancel ⌘., Explain ⌥⌘E, Format ⇧⌥F, Save ⌘S,
// database and auto-limit selectors), the editor, a draggable split and the results panel.
//
// The text lives in useDataWorkspaceStore (persisted draft), so insertions from the assistant /
// history / saved queries / schema tree land here through the store and the editor follows its
// controlled value as one undo step. Runs go through `runQueryInTab` (safety confirmation, cancel,
// stale-run protection); a failing statement's position is underlined in the editor.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlignLeft, Bookmark, Loader2, Play, PlayCircle, Square, Telescope } from 'lucide-react'
import type {
  DataDatabaseInfo,
  DataProject,
  DataStatementResult,
  SqlDialect
} from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import { ResizeHandle } from '@/components/layout/ResizeHandle'
import { Button } from '@/components/ui/button'
import { ShortcutHint } from '@/components/ui/shortcut-hint'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  completionKey,
  useDataWorkspaceStore,
  type DataQueryTab,
  type QueryRunTarget
} from '@/stores/useDataWorkspaceStore'
import { QueryEditor, type QueryEditorHandle } from '../editor/QueryEditor'
import { SaveQueryDialog } from '../shared/SavedQueriesPanel'
import { cancelQueryInTab, runQueryInTab } from './query-runner'
import { errorRangeFor, LIMIT_OPTIONS, ORIGIN_LABEL } from './query-tab-utils'
import { ResultsPanel } from './ResultsPanel'

export interface QueryTabProps {
  project: DataProject
  tab: DataQueryTab
  active: boolean
  dialect: SqlDialect
  /** Databases of the connection (null while unknown). */
  databases: DataDatabaseInfo[] | null
}

export function QueryTab({
  project,
  tab,
  active,
  dialect,
  databases
}: QueryTabProps): React.JSX.Element {
  const editorRef = useRef<QueryEditorHandle>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  const run = useDataWorkspaceStore((s) => s.runs[tab.id])
  const workspaceDatabase = useDataWorkspaceStore((s) => s.workspaces[project.id]?.database)
  const workspaceSchema = useDataWorkspaceStore((s) => s.workspaces[project.id]?.schema)
  const editorFraction = useDataWorkspaceStore((s) => s.editorFraction)
  const database = tab.database ?? workspaceDatabase
  const schema = tab.schema ?? workspaceSchema
  const completion = useDataWorkspaceStore(
    (s) => s.completion[completionKey(project.id, database)]?.schema ?? null
  )
  const limit = tab.limit ?? project.defaultLimit
  const running = run?.status === 'running'
  const [saveOpen, setSaveOpen] = useState(false)

  useEffect(() => {
    if (active) void useDataWorkspaceStore.getState().loadCompletion(project.id, database)
  }, [active, project.id, database])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => editorRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [active])

  const execute = useCallback(
    (target: QueryRunTarget, options: { limit?: number | null; explain?: boolean } = {}) => {
      if (useDataWorkspaceStore.getState().runs[tab.id]?.status === 'running') {
        toast.info('A query is already running in this tab. Press ⌘. to cancel it.')
        return
      }
      void runQueryInTab({
        project,
        tabId: tab.id,
        target,
        database,
        schema,
        limit: options.limit !== undefined ? options.limit : limit,
        explain: options.explain
      })
    },
    [project, tab.id, database, schema, limit]
  )

  const runFromToolbar = (mode: 'current' | 'all', explain = false): void => {
    const target = editorRef.current?.getRunTarget(mode)
    if (!target) {
      toast.info(
        tab.text.trim() ? 'Put the cursor in a statement to run it.' : 'Write a query first.'
      )
      return
    }
    execute(target, { explain })
  }

  const cancel = useCallback(() => void cancelQueryInTab(tab.id), [tab.id])

  const format = (): void => {
    const result = editorRef.current?.format()
    if (result && result.failed > 0) {
      toast.warning(
        `${result.failed} statement${result.failed === 1 ? '' : 's'} could not be formatted and ${result.failed === 1 ? 'was' : 'were'} left as written.`
      )
    }
  }

  const saveTo = async (name: string, id?: string): Promise<void> => {
    try {
      const saved = await dataProjectsApi.saveQuery(project.id, {
        ...(id ? { id } : {}),
        name,
        text: tab.text,
        database: database ?? null
      })
      useDataWorkspaceStore.getState().patchQueryTab(project.id, tab.id, {
        savedQueryId: saved.id,
        title: saved.name,
        baseline: tab.text
      })
      useDataWorkspaceStore.getState().bumpHistory(project.id)
      toast.success(`Saved "${saved.name}"`)
    } catch (error) {
      toast.error(`Could not save the query: ${errorMessage(error)}`)
      throw error
    }
  }

  const save = useCallback(() => {
    if (!tab.text.trim()) {
      toast.info('Nothing to save yet.')
      return
    }
    if (tab.savedQueryId) void saveTo(tab.title, tab.savedQueryId).catch(() => undefined)
    else setSaveOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.text, tab.savedQueryId, tab.title])

  const errorRange = useMemo(() => {
    const failed = run?.status !== 'running' ? run?.statements.find((s) => s.error) : undefined
    return failed && run ? errorRangeFor(failed, run.target.from, tab.text) : null
    // The text is only read to size the underlined token: recomputing per keystroke is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])

  const showError = (statement: DataStatementResult): void => {
    if (!run) return
    const range = errorRangeFor(statement, run.target.from, tab.text)
    const view = editorRef.current?.getView()
    if (!range || !view) return
    const pos = Math.min(range.from, view.state.doc.length)
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    view.focus()
  }

  const databaseOptions = useMemo(() => {
    const names = (databases ?? []).map((d) => d.name)
    if (database && !names.includes(database)) names.unshift(database)
    return names
  }, [databases, database])

  const limitOptions = LIMIT_OPTIONS.includes(project.defaultLimit)
    ? LIMIT_OPTIONS
    : [...LIMIT_OPTIONS.slice(0, -1), project.defaultLimit, 0].sort((a, b) =>
        a === 0 ? 1 : b === 0 ? -1 : a - b
      )

  const onResize = (delta: number): void => {
    const height = splitRef.current?.clientHeight ?? 0
    if (height > 0)
      useDataWorkspaceStore.getState().setEditorFraction(editorFraction + delta / height)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={`data-project-query-tab-${tab.id}`}>
      {/* Narrow panes (sidebar + assistant open) drop secondary labels to icons so the database
          and limit pickers stay in view (wrapping to a second row in very narrow panes). */}
      <div className="@container/qtb flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {running ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={cancel}
            disabled={!run?.queryId || run?.cancelRequested}
            data-testid="data-project-cancel"
          >
            {run?.cancelRequested ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            Cancel
            <span className="hidden @[560px]/qtb:inline-flex">
              <ShortcutHint label="⌘." />
            </span>
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => runFromToolbar('current')}
            data-testid="data-project-run"
            title="Run the statement under the cursor or the selection"
          >
            <Play className="h-3.5 w-3.5" />
            Run
            <span className="hidden @[560px]/qtb:inline-flex">
              <ShortcutHint label="⌘↵" />
            </span>
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={running}
          onClick={() => runFromToolbar('all')}
          data-testid="data-project-run-all"
          title="Run every statement"
        >
          <PlayCircle className="h-3.5 w-3.5" />
          <span className="hidden @[640px]/qtb:inline">Run all</span>
          <span className="hidden @[860px]/qtb:inline-flex">
            <ShortcutHint label="⇧⌘↵" />
          </span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={running}
          onClick={() => runFromToolbar('current', true)}
          data-testid="data-project-explain"
          title="Explain the statement under the cursor (⌥⌘E)"
        >
          <Telescope className="h-3.5 w-3.5" />
          <span className="hidden @[760px]/qtb:inline">Explain</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={format}
          data-testid="data-project-format"
          title="Format SQL (⇧⌥F)"
        >
          <AlignLeft className="h-3.5 w-3.5" />
          <span className="hidden @[760px]/qtb:inline">Format</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={save}
          data-testid="data-project-save-query"
          title={tab.savedQueryId ? 'Update the saved query (⌘S)' : 'Save the query (⌘S)'}
        >
          <Bookmark className={cn('h-3.5 w-3.5', tab.savedQueryId && 'fill-current')} />
          <span className="hidden @[760px]/qtb:inline">Save</span>
        </Button>
        {tab.origin && (
          <span
            className="ml-1 hidden shrink-0 rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] text-violet-700 @[900px]/qtb:inline dark:text-violet-300"
            data-testid="data-project-origin-badge"
          >
            From {ORIGIN_LABEL[tab.origin]}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <select
            value={database ?? ''}
            onChange={(e) =>
              useDataWorkspaceStore
                .getState()
                .patchQueryTab(project.id, tab.id, { database: e.target.value || undefined })
            }
            title="Database this tab runs in"
            data-testid="data-project-tab-database"
            className="h-7 max-w-[110px] rounded-md border border-input bg-background px-1.5 text-[12px] @[700px]/qtb:max-w-[180px]"
          >
            {!database && <option value="">Default database</option>}
            {databaseOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={String(limit)}
            onChange={(e) =>
              useDataWorkspaceStore
                .getState()
                .patchQueryTab(project.id, tab.id, { limit: Number(e.target.value) })
            }
            title="Auto-limit for result rows"
            data-testid="data-project-limit-select"
            className="h-7 rounded-md border border-input bg-background px-1.5 text-[12px]"
          >
            {limitOptions.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'No limit' : `Limit ${n.toLocaleString('en-US')}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div ref={splitRef} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-[60px] shrink-0" style={{ height: `${editorFraction * 100}%` }}>
          <QueryEditor
            ref={editorRef}
            value={tab.text}
            onChange={(text) =>
              useDataWorkspaceStore.getState().updateQueryText(project.id, tab.id, text)
            }
            language="sql"
            dialect={dialect}
            completionSchema={completion}
            onRun={(target) => execute(target)}
            onCancel={cancel}
            onExplain={(target) => execute(target, { explain: true })}
            onSave={save}
            errorRange={errorRange}
            placeholder="Write SQL… ⌘↵ runs the statement under the cursor"
            data-testid="data-project-query-editor"
          />
        </div>
        <ResizeHandle direction="up" onResize={onResize} />
        <ResultsPanel
          project={project}
          dialect={dialect}
          tabTitle={tab.title}
          run={run}
          onSelectResult={(index) =>
            useDataWorkspaceStore.getState().setActiveResult(tab.id, index)
          }
          onRerun={(target, rerunLimit) => execute(target, { limit: rerunLimit })}
          onCancel={cancel}
          onShowError={showError}
        />
      </div>
      <SaveQueryDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        initialName={/^Query \d+$/.test(tab.title) ? '' : tab.title}
        onSave={(name) => saveTo(name)}
      />
    </div>
  )
}
