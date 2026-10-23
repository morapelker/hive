// The SQL client of a data project (MySQL, MariaDB, PostgreSQL, SQLite, ClickHouse):
//
//   ┌ SchemaExplorer ┬ tabs: Query N • │ users │ Processes │ History │ Console │ + ─┐
//   │ [db ▾][schema ▾]│ query tab: toolbar / editor / ═ / results                      │
//   │ filter          │ table tab: Data | Structure | DDL                              │
//   │ ▾ Tables …      │ Processes / History / Saved queries / Console panels           │
//
// Responsibilities here: connect on mount (renderer-shell's store, which also opens the
// credentials prompt), load the database list and pick the working database, keep visited tabs
// mounted (hidden) so editors, results and staged edits survive tab switches, place editor-bridge
// insertions (assistant / history / saved / schema actions) into the workspace, and close the
// active tab on ⌘W while focus is inside the workspace (the shortcut arrives from the main process
// as `onCloseSessionShortcut`, not as a DOM keydown).
//
// Closing asks first when something would be lost: an unsaved query draft or a table tab's
// staged edits (Close, ⌘W, middle-click, Close others, Close to the right; one question for the
// whole set). Closed tabs' running queries are cancelled. The workspace also answers
// `confirmDiscardPendingEdits` (project switch, connection edit) with the same question, and
// reloads the explorer after a query tab ran DDL.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, FileCode, History, ScrollText } from 'lucide-react'
import {
  sqlDialectOf,
  type DataDatabaseInfo,
  type DataProject,
  type DataSavedQuery
} from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { systemApi } from '@/api/system-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import { selectPendingFor, useDataEditorBridge } from '@/components/data-projects/editor-bridge'
import { ResizeHandle } from '@/components/layout/ResizeHandle'
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
import { cn } from '@/lib/utils'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import {
  isQueryTabDirty,
  tabsClosedBy,
  useDataWorkspaceStore,
  type DataQueryTab,
  type DataWorkspaceTab,
  tabStagedEditCount
} from '@/stores/useDataWorkspaceStore'
import { ConsolePanel } from '../console/ConsolePanel'
import { HistoryPanel } from '../shared/HistoryPanel'
import { ProcessesPanel } from '../shared/ProcessesPanel'
import { SavedQueriesPanel } from '../shared/SavedQueriesPanel'
import { cancelQueryInTab } from './query-runner'
import { QueryTab } from './QueryTab'
import { SchemaExplorer } from './SchemaExplorer'
import { TableTab } from './TableTab'
import { WorkspaceTabs } from './WorkspaceTabs'

export interface SqlWorkspaceProps {
  project: DataProject
}

const NO_TABS: DataWorkspaceTab[] = []

const anyDialogOpen = (): boolean =>
  !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
  )

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** Closing these tabs (after the user agreed when something is lost). */
interface CloseRequest {
  tabs: DataWorkspaceTab[]
  /** Tab to activate once they are closed (Close others). */
  activate?: string
  /** Unsaved query drafts among them. */
  drafts: DataQueryTab[]
  /** Table tabs with staged edits, and how many each holds. */
  edits: Array<{ tab: DataWorkspaceTab; count: number }>
}

/** Title, explanation and confirm label of the close question. */
function describeClose(request: CloseRequest): {
  title: string
  description: string
  action: string
} {
  const { tabs, drafts, edits } = request
  const editCount = edits.reduce((sum, e) => sum + e.count, 0)
  if (tabs.length === 1 && edits.length === 1) {
    return {
      title: `Discard ${plural(editCount, 'pending change')} in “${tabs[0].title}”?`,
      description:
        'Closing the tab drops the staged edits; nothing has been written. Commit them first to keep them.',
      action: 'Discard and close'
    }
  }
  if (tabs.length === 1) {
    return {
      title: `Close “${tabs[0].title}”?`,
      description: 'Its text is not saved as a query. Statements you ran stay in History.',
      action: 'Close'
    }
  }
  const lost = [
    drafts.length
      ? `${plural(drafts.length, 'unsaved query', 'unsaved queries')} (${drafts.map((t) => t.title).join(', ')})`
      : null,
    edits.length
      ? `${plural(editCount, 'pending change')} in ${edits.map((e) => e.tab.title).join(', ')}`
      : null
  ].filter(Boolean)
  return {
    title: `Close ${plural(tabs.length, 'tab')}?`,
    description: `${lost.join(' and ')} will be lost. Statements you ran stay in History.`,
    action: `Close ${plural(tabs.length, 'tab')}`
  }
}

export function SqlWorkspace({ project }: SqlWorkspaceProps): React.JSX.Element {
  const dialect = sqlDialectOf(project.engine) ?? 'postgres'
  const rootRef = useRef<HTMLDivElement>(null)
  const workspace = useDataWorkspaceStore((s) => s.workspaces[project.id])
  const explorerWidth = useDataWorkspaceStore((s) => s.explorerWidth)
  const historyVersion = useDataWorkspaceStore((s) => s.historyVersion[project.id] ?? 0)
  const status = useDataProjectStore((s) => s.statuses[project.id])
  const credentialsRequired = useDataProjectStore(
    (s) => s.credentialsRequired[project.id] !== undefined
  )
  const epoch = useDataProjectStore((s) => s.connectionEpoch[project.id] ?? 0)
  const [databases, setDatabases] = useState<DataDatabaseInfo[] | null>(null)
  const [databasesError, setDatabasesError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmClose, setConfirmClose] = useState<CloseRequest | null>(null)
  const schemaVersion = useDataWorkspaceStore((s) => s.schemaVersion[project.id] ?? 0)
  const discardRequest = useDataWorkspaceStore((s) =>
    s.discardRequest?.projectId === project.id ? s.discardRequest : null
  )
  const connected = status?.state === 'connected'
  const tabs = useMemo(() => workspace?.tabs ?? NO_TABS, [workspace?.tabs])
  const activeId = workspace?.activeTabId ?? null

  // Workspace first (the bridge effect below may insert into it), then the connection.
  useEffect(() => {
    useDataWorkspaceStore.getState().ensureWorkspace(project.id, {
      database: project.config.database?.trim() || undefined
    })
  }, [project.id, project.config.database])

  useEffect(() => {
    void useDataProjectStore.getState().ensureConnected(project.id)
  }, [project.id, epoch])

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    setDatabasesError(null)
    dataProjectsApi
      .databases(project.id)
      .then((list) => {
        if (cancelled) return
        setDatabases(list)
        const store = useDataWorkspaceStore.getState()
        const names = list.map((d) => d.name)
        const current = store.getWorkspace(project.id)?.database
        if (names.length && (!current || !names.includes(current))) {
          const pick =
            [
              useDataProjectStore.getState().statuses[project.id]?.currentDatabase,
              project.config.database,
              dialect === 'sqlite' ? 'main' : undefined
            ].find((n): n is string => !!n && names.includes(n)) ??
            list.find((d) => !d.isSystem)?.name ??
            names[0]
          store.setWorkspaceDatabase(project.id, pick)
        }
      })
      .catch((err) => {
        if (!cancelled) setDatabasesError(errorMessage(err, 'Could not list the databases'))
      })
    return () => {
      cancelled = true
    }
  }, [connected, project.id, project.config.database, dialect, refreshKey, epoch, schemaVersion])

  // Editor bridge: text from the assistant, history, saved queries and schema actions, including
  // what arrived for this project while another one was on screen. consumeBridge re-reads the
  // live queue, so StrictMode's second effect run finds nothing left to apply.
  const selectPending = useMemo(() => selectPendingFor(project.id), [project.id])
  const pending = useDataEditorBridge(selectPending)
  useEffect(() => {
    if (pending) useDataWorkspaceStore.getState().consumeBridge(project.id)
  }, [pending, project.id])

  // This workspace answers "discard the staged edits?" for its project.
  useEffect(() => useDataWorkspaceStore.getState().registerDiscardHost(project.id), [project.id])

  // Keep visited tabs mounted; forget closed ones.
  useEffect(() => {
    setMounted((s) => {
      const ids = new Set(tabs.map((t) => t.id))
      let changed = false
      const next = new Set<string>()
      for (const id of s) {
        if (ids.has(id)) next.add(id)
        else changed = true
      }
      if (activeId && !next.has(activeId)) {
        next.add(activeId)
        changed = true
      }
      return changed ? next : s
    })
  }, [tabs, activeId])

  /** Cancels the closed tabs' running queries (the server would keep running them), closes them. */
  const closeNow = useCallback(
    ({ tabs: closing, activate }: Pick<CloseRequest, 'tabs' | 'activate'>) => {
      const store = useDataWorkspaceStore.getState()
      for (const tab of closing) {
        if (store.runs[tab.id]?.status === 'running') void cancelQueryInTab(tab.id)
      }
      store.closeTabs(
        project.id,
        closing.map((t) => t.id)
      )
      if (activate) store.setActiveTab(project.id, activate)
    },
    [project.id]
  )

  /** Closes the tabs, asking first when a draft or staged edits would be lost. */
  const requestCloseTabs = useCallback(
    (closing: DataWorkspaceTab[], activate?: string) => {
      if (!closing.length) return
      const { stagedEdits } = useDataWorkspaceStore.getState()
      const drafts = closing.filter((t): t is DataQueryTab => isQueryTabDirty(t))
      const edits = closing.flatMap((tab) => {
        const count = tabStagedEditCount(stagedEdits, tab.id)
        return tab.kind === 'table' && count ? [{ tab, count }] : []
      })
      if (drafts.length || edits.length) setConfirmClose({ tabs: closing, activate, drafts, edits })
      else closeNow({ tabs: closing, activate })
    },
    [closeNow]
  )

  const requestClose = useCallback(
    (tab: DataWorkspaceTab) => requestCloseTabs([tab]),
    [requestCloseTabs]
  )

  const requestCloseMany = useCallback(
    (tab: DataWorkspaceTab, which: 'others' | 'right') => {
      const current = useDataWorkspaceStore.getState().getWorkspace(project.id)?.tabs ?? []
      requestCloseTabs(
        tabsClosedBy(current, tab.id, which),
        which === 'others' ? tab.id : undefined
      )
    },
    [project.id, requestCloseTabs]
  )

  useEffect(
    () =>
      systemApi.onCloseSessionShortcut(() => {
        const focused = document.activeElement
        if (!focused || !rootRef.current?.contains(focused) || anyDialogOpen()) return
        const tab = useDataWorkspaceStore.getState().getActiveTab(project.id)
        if (tab) requestClose(tab)
      }),
    [project.id, requestClose]
  )

  const newQuery = useCallback(() => {
    useDataWorkspaceStore.getState().openQuery(project.id)
  }, [project.id])

  const openSaved = useCallback(
    (query: DataSavedQuery) => {
      const store = useDataWorkspaceStore.getState()
      const existing = store
        .getWorkspace(project.id)
        ?.tabs.find((t) => t.kind === 'query' && t.savedQueryId === query.id)
      if (existing) store.setActiveTab(project.id, existing.id)
      else {
        store.openQuery(project.id, query.text, query.database ?? undefined, {
          title: query.name,
          origin: 'saved',
          savedQueryId: query.id
        })
      }
    },
    [project.id]
  )

  const refresh = (): void => {
    setRefreshKey((k) => k + 1)
    void useDataWorkspaceStore.getState().loadCompletion(project.id, workspace?.database, true)
  }

  const renderTab = (tab: DataWorkspaceTab): React.ReactNode => {
    switch (tab.kind) {
      case 'query':
        return (
          <QueryTab
            project={project}
            tab={tab}
            active={tab.id === activeId}
            dialect={dialect}
            databases={databases}
          />
        )
      case 'table':
        return <TableTab project={project} tab={tab} dialect={dialect} />
      case 'processes':
        return <ProcessesPanel projectId={project.id} />
      case 'history':
        return (
          <HistoryPanel
            projectId={project.id}
            dialect={dialect}
            onOpen={(text, database) =>
              useDataWorkspaceStore
                .getState()
                .openQuery(project.id, text, database, { origin: 'history' })
            }
          />
        )
      case 'saved':
        return (
          <SavedQueriesPanel
            projectId={project.id}
            dialect={dialect}
            refreshKey={historyVersion}
            onOpen={openSaved}
          />
        )
      case 'console':
        return (
          <ConsolePanel
            projectId={project.id}
            dialect={dialect}
            onOpen={(text, database) =>
              useDataWorkspaceStore
                .getState()
                .openQuery(project.id, text, database, { origin: 'history' })
            }
          />
        )
    }
  }

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 min-w-0 flex-1"
      data-data-workspace=""
      data-testid="data-project-sql-workspace"
    >
      <div className="min-h-0 shrink-0 border-r border-border" style={{ width: explorerWidth }}>
        <SchemaExplorer
          project={project}
          dialect={dialect}
          connectionState={status?.state}
          connectionError={status?.error}
          credentialsRequired={credentialsRequired}
          databases={databases}
          databasesError={databasesError}
          database={workspace?.database}
          schema={workspace?.schema}
          onDatabaseChange={(database) =>
            useDataWorkspaceStore.getState().setWorkspaceDatabase(project.id, database)
          }
          onSchemaChange={(schema) =>
            useDataWorkspaceStore.getState().setWorkspaceSchema(project.id, schema)
          }
          onRefresh={refresh}
          onReconnect={() => void useDataProjectStore.getState().connect(project.id)}
          onEnterCredentials={() =>
            useDataProjectStore.getState().openCredentialsPrompt(project.id)
          }
          refreshKey={refreshKey + schemaVersion}
        />
      </div>
      <ResizeHandle
        direction="left"
        onResize={(delta) =>
          useDataWorkspaceStore.getState().setExplorerWidth(explorerWidth + delta)
        }
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceTabs
          projectId={project.id}
          tabs={tabs}
          activeTabId={activeId}
          onNewQuery={newQuery}
          onRequestClose={requestClose}
          onRequestCloseMany={requestCloseMany}
        />
        <div className="relative min-h-0 flex-1">
          {tabs.length === 0 ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
              data-testid="data-project-workspace-empty"
            >
              <FileCode className="h-9 w-9 opacity-50" />
              No open tabs
              <div className="flex gap-2">
                <Button size="sm" onClick={newQuery} data-testid="data-project-empty-new-query">
                  <FileCode className="h-3.5 w-3.5" />
                  New query
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    useDataWorkspaceStore.getState().openSpecialTab(project.id, 'history')
                  }
                >
                  <History className="h-3.5 w-3.5" />
                  History
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    useDataWorkspaceStore.getState().openSpecialTab(project.id, 'saved')
                  }
                >
                  <Bookmark className="h-3.5 w-3.5" />
                  Saved queries
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    useDataWorkspaceStore.getState().openSpecialTab(project.id, 'console')
                  }
                  data-testid="data-project-empty-console"
                >
                  <ScrollText className="h-3.5 w-3.5" />
                  Console
                </Button>
              </div>
            </div>
          ) : (
            tabs
              .filter((tab) => mounted.has(tab.id) || tab.id === activeId)
              .map((tab) => (
                <div
                  key={tab.id}
                  role="tabpanel"
                  className={cn('absolute inset-0 flex flex-col', tab.id !== activeId && 'hidden')}
                  data-testid={`data-project-tabpanel-${tab.kind}`}
                >
                  {renderTab(tab)}
                </div>
              ))
          )}
        </div>
      </div>
      <AlertDialog
        open={confirmClose !== null}
        onOpenChange={(open) => !open && setConfirmClose(null)}
      >
        {confirmClose && (
          <AlertDialogContent size="sm" data-testid="data-project-close-dirty-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-[15px]">
                {describeClose(confirmClose).title}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[12px]">
                {describeClose(confirmClose).description}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {confirmClose.edits.length ? 'Keep editing' : 'Keep'}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  closeNow(confirmClose)
                  setConfirmClose(null)
                }}
                data-testid="data-project-close-dirty-confirm"
              >
                {describeClose(confirmClose).action}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
      <AlertDialog
        open={discardRequest !== null}
        onOpenChange={(open) => {
          if (!open && discardRequest)
            useDataWorkspaceStore.getState().answerDiscardEdits(discardRequest.id, false)
        }}
      >
        {discardRequest && (
          <AlertDialogContent size="sm" data-testid="data-project-leave-dirty-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-[15px]">
                Discard {plural(discardRequest.count, 'pending change')}?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[12px]">
                {project.name} has staged table edits that were not committed. Leaving drops them;
                commit them first to keep them.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="data-project-leave-dirty-keep">
                Keep editing
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() =>
                  useDataWorkspaceStore.getState().answerDiscardEdits(discardRequest.id, true)
                }
                data-testid="data-project-leave-dirty-discard"
              >
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  )
}

export default SqlWorkspace
