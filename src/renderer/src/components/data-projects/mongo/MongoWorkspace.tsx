// The MongoDB client of a data project (a Compass-class document client):
//
//   ┌ Explorer ───────────┬ [orders ×] [Shell 1 •] [Processes] [History] [Console] [+] ─────┐
//   │ ▾ shop      2.1 GB  │ shop › orders   Documents | Aggregations | Schema | Indexes     │
//   │   ▣ orders  1.2M    │ Filter [{ status: 'A' }]          Options  Reset  Explain  Find │
//   │   ◇ v_daily  view   │ Add  Export  Update matching…  Delete matching…  List JSON Table│
//   │ filter…             │ documents…                                                      │
//   └─────────────────────┴────────────────────────────────────────────────────────────────┘
//
// Tabs (collection / Shell / Processes / History / Saved queries / Console), their drafts and the
// explorer state live in useMongoWorkspaceStore (persisted per project). On mount the workspace
// makes sure the project is connected (the data project store opens the credentials prompt when
// needed) and applies editor-bridge insertions for this project — assistant proposals, history
// and saved queries land in the active Shell tab or a new one, never run.
//
// Closing a Shell tab whose text is neither saved nor unchanged since it was opened asks first
// (×, middle-click, Close, Close others, and ⌘W while focus is inside the workspace: the
// shortcut arrives from the main process as `onCloseSessionShortcut`, not as a DOM keydown).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Bookmark, Database, History, ScrollText, SquareTerminal } from 'lucide-react'
import type { DataProject, DataSavedQuery } from '@shared/data-projects/types'
import { systemApi } from '@/api/system-api'
import { selectPendingFor, useDataEditorBridge } from '@/components/data-projects/editor-bridge'
import { ConsolePanel } from '@/components/data-projects/console/ConsolePanel'
import { HistoryPanel, ProcessesPanel, SavedQueriesPanel } from '@/components/data-projects/shared'
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
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import {
  isShellTabDirty,
  useMongoWorkspaceStore,
  type MongoShellTab,
  type MongoWorkspaceTab
} from '@/stores/useMongoWorkspaceStore'
import { CollectionTab } from './CollectionTab'
import { MongoExplorer } from './MongoExplorer'
import { MongoTabStrip } from './MongoTabStrip'
import { ShellTab } from './ShellTab'
import { useMongoCatalog } from './useMongoCatalog'

export interface MongoWorkspaceProps {
  project: DataProject
}

interface CloseConfirmation {
  title: string
  description: string
  close: () => void
}

const anyDialogOpen = (): boolean =>
  !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
  )

function EmptyWorkspace({ project }: { project: DataProject }): React.JSX.Element {
  const openShell = useMongoWorkspaceStore((s) => s.openShell)
  const openSpecialTab = useMongoWorkspaceStore((s) => s.openSpecialTab)
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
      data-testid="data-project-mongo-empty"
    >
      <Database className="h-9 w-9 opacity-50" />
      <div className="text-sm">Open a collection from the explorer, or start a shell.</div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          size="sm"
          onClick={() => openShell(project.id)}
          data-testid="data-project-mongo-empty-shell"
        >
          <SquareTerminal className="h-3.5 w-3.5" /> New shell
        </Button>
        <Button size="sm" variant="outline" onClick={() => openSpecialTab(project.id, 'history')}>
          <History className="h-3.5 w-3.5" /> History
        </Button>
        <Button size="sm" variant="outline" onClick={() => openSpecialTab(project.id, 'processes')}>
          <Activity className="h-3.5 w-3.5" /> Processes
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => openSpecialTab(project.id, 'saved')}
          data-testid="data-project-mongo-empty-saved"
        >
          <Bookmark className="h-3.5 w-3.5" /> Saved queries
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => openSpecialTab(project.id, 'console')}
          data-testid="data-project-mongo-empty-console"
        >
          <ScrollText className="h-3.5 w-3.5" /> Console
        </Button>
      </div>
    </div>
  )
}

export function MongoWorkspace({ project }: MongoWorkspaceProps): React.JSX.Element {
  const ensureWorkspace = useMongoWorkspaceStore((s) => s.ensureWorkspace)
  const consumeBridge = useMongoWorkspaceStore((s) => s.consumeBridge)
  const openShell = useMongoWorkspaceStore((s) => s.openShell)
  const setExplorerWidth = useMongoWorkspaceStore((s) => s.setExplorerWidth)
  const workspace = useMongoWorkspaceStore((s) => s.workspaces[project.id])
  const pendingSelector = useMemo(() => selectPendingFor(project.id), [project.id])
  const pending = useDataEditorBridge(pendingSelector)
  const catalog = useMongoCatalog(project)
  const [historyKey, setHistoryKey] = useState(0)
  const [confirmClose, setConfirmClose] = useState<CloseConfirmation | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ensureWorkspace(project.id, { database: project.config.database || null })
  }, [ensureWorkspace, project.id, project.config.database])

  useEffect(() => {
    void useDataProjectStore
      .getState()
      .ensureConnected(project.id)
      .catch(() => undefined)
  }, [project.id])

  // Assistant proposals / history / saved queries for this project → a Shell tab.
  useEffect(() => {
    if (pending) consumeBridge(project.id)
  }, [pending, project.id, consumeBridge])

  // ---- closing tabs ----------------------------------------------------------------------------

  const requestClose = useCallback(
    (tab: MongoWorkspaceTab) => {
      const close = (): void => useMongoWorkspaceStore.getState().closeTab(project.id, tab.id)
      if (!isShellTabDirty(tab)) return close()
      setConfirmClose({
        title: `Close “${(tab as MongoShellTab).title}”?`,
        description: 'Its text is not saved as a query. Statements you ran stay in History.',
        close
      })
    },
    [project.id]
  )

  const requestCloseOthers = useCallback(
    (tab: MongoWorkspaceTab) => {
      const close = (): void => useMongoWorkspaceStore.getState().closeOtherTabs(project.id, tab.id)
      const dirty = (useMongoWorkspaceStore.getState().workspaces[project.id]?.tabs ?? []).filter(
        (t): t is MongoShellTab => t.id !== tab.id && isShellTabDirty(t)
      )
      if (!dirty.length) return close()
      setConfirmClose({
        title:
          dirty.length === 1
            ? `Close “${dirty[0].title}” and the other tabs?`
            : `Close ${dirty.length} shell tabs with unsaved text?`,
        description: `${dirty.map((t) => t.title).join(', ')}: not saved as queries. Statements you ran stay in History.`,
        close
      })
    },
    [project.id]
  )

  useEffect(
    () =>
      systemApi.onCloseSessionShortcut(() => {
        const focused = document.activeElement
        if (!focused || !rootRef.current?.contains(focused) || anyDialogOpen()) return
        const ws = useMongoWorkspaceStore.getState().workspaces[project.id]
        const tab = ws?.tabs.find((t) => t.id === ws.activeTabId)
        if (tab) requestClose(tab)
      }),
    [project.id, requestClose]
  )

  const openSaved = useCallback(
    (query: DataSavedQuery) => {
      const store = useMongoWorkspaceStore.getState()
      const existing = store.workspaces[project.id]?.tabs.find(
        (t): t is MongoShellTab => t.kind === 'shell' && t.savedQueryId === query.id
      )
      if (existing) {
        // Restored with masked secrets ('***') and not edited since: take the real text back.
        if (existing.masked && existing.text === existing.baseline)
          store.updateShell(project.id, existing.id, {
            text: query.text,
            baseline: query.text,
            masked: false
          })
        store.activateTab(project.id, existing.id)
      } else
        store.openShell(project.id, {
          text: query.text,
          // null = saved from a '(connection default)' tab.
          database: query.database ?? '',
          title: query.name,
          origin: 'saved',
          savedQueryId: query.id
        })
    },
    [project.id]
  )

  const activeTab: MongoWorkspaceTab | undefined = workspace?.tabs.find(
    (t) => t.id === workspace.activeTabId
  )

  // The History tab refetches whenever it is shown again.
  useEffect(() => {
    if (activeTab?.kind === 'history') setHistoryKey((k) => k + 1)
  }, [activeTab?.id, activeTab?.kind])

  const databaseNames = useMemo(
    () => (catalog.databases ?? []).map((d) => d.name),
    [catalog.databases]
  )
  const explorerActive =
    activeTab?.kind === 'collection'
      ? { database: activeTab.database, collection: activeTab.collection }
      : activeTab?.kind === 'shell' && activeTab.database
        ? { database: activeTab.database }
        : null

  let content: React.JSX.Element
  if (!activeTab) content = <EmptyWorkspace project={project} />
  else if (activeTab.kind === 'collection')
    content = <CollectionTab key={activeTab.id} project={project} tab={activeTab} />
  else if (activeTab.kind === 'shell')
    content = (
      <ShellTab key={activeTab.id} project={project} tab={activeTab} databases={databaseNames} />
    )
  else if (activeTab.kind === 'processes')
    content = <ProcessesPanel key={activeTab.id} projectId={project.id} className="flex-1" />
  else if (activeTab.kind === 'console')
    content = (
      <ConsolePanel
        key={activeTab.id}
        projectId={project.id}
        dialect={null}
        className="flex-1"
        onOpen={(text, database) =>
          openShell(project.id, { text, ...(database ? { database } : {}), origin: 'history' })
        }
      />
    )
  else if (activeTab.kind === 'saved')
    content = (
      <SavedQueriesPanel
        key={activeTab.id}
        projectId={project.id}
        dialect={null}
        className="flex-1"
        onOpen={openSaved}
      />
    )
  else
    content = (
      <HistoryPanel
        key={activeTab.id}
        projectId={project.id}
        dialect={null}
        refreshKey={historyKey}
        className="flex-1"
        onOpen={(text, database) =>
          openShell(project.id, { text, ...(database ? { database } : {}), origin: 'history' })
        }
      />
    )

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 min-w-0 flex-1"
      data-data-workspace=""
      data-testid="data-project-mongo-workspace"
    >
      <div
        className="flex min-h-0 shrink-0 flex-col border-r border-border bg-sidebar"
        style={{ width: workspace?.explorerWidth ?? 260 }}
      >
        <MongoExplorer project={project} catalog={catalog} active={explorerActive} />
      </div>
      <ResizeHandle
        direction="left"
        onResize={(delta) =>
          setExplorerWidth(project.id, (workspace?.explorerWidth ?? 260) + delta)
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MongoTabStrip
          projectId={project.id}
          onRequestClose={requestClose}
          onRequestCloseOthers={requestCloseOthers}
        />
        <div className="flex min-h-0 flex-1 flex-col">{content}</div>
      </div>
      <AlertDialog
        open={confirmClose !== null}
        onOpenChange={(open) => !open && setConfirmClose(null)}
      >
        <AlertDialogContent size="sm" data-testid="data-project-mongo-close-dirty-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">{confirmClose?.title}</AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]">
              {confirmClose?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                confirmClose?.close()
                setConfirmClose(null)
              }}
              data-testid="data-project-mongo-close-dirty-confirm"
            >
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default MongoWorkspace
