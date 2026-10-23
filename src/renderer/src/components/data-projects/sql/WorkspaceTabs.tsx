// Tab strip of the SQL workspace, with the anatomy of SessionTabs' file tabs: 32px strip, icon,
// title, dirty dot that turns into × on hover, middle-click closes, context menu (Close, Close
// others, Close to the right), "+" for a new query tab. Query tabs show a spinner while running
// and an origin badge (AI / History / Saved / Schema) until edited or run; the dirty dot means
// unsaved query text or, on a table tab, staged edits. Every close goes through the workspace
// (`onRequestClose` / `onRequestCloseMany`), which asks first when something would be lost and
// cancels the closed tabs' running queries (⌘W uses the same path).

import {
  Activity,
  Bookmark,
  FileCode,
  History,
  Loader2,
  Plus,
  ScrollText,
  Table2,
  X
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { TAB_ACTIVE_SURFACE_CLASS, TAB_UNDERLINE_CLASS } from '@/lib/tab-styles'
import { cn } from '@/lib/utils'
import {
  isQueryTabDirty,
  useDataWorkspaceStore,
  type DataTabOrigin,
  type DataWorkspaceTab,
  tabStagedEditCount
} from '@/stores/useDataWorkspaceStore'

const ORIGIN_BADGE: Record<DataTabOrigin, string> = {
  assistant: 'AI',
  history: 'Hist',
  saved: 'Saved',
  schema: 'Gen'
}

const tabClass = (active: boolean): string =>
  cn(
    'group relative flex h-full min-w-[88px] max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap border-r border-border px-2.5 text-[12px] tracking-[0.01em] transition-colors',
    active
      ? cn(TAB_ACTIVE_SURFACE_CLASS, 'text-foreground')
      : 'bg-card text-muted-foreground hover:text-foreground'
  )

const STRIP_BUTTON =
  'flex h-full w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_4%,var(--card))] hover:text-foreground'

function TabIcon({ tab, running }: { tab: DataWorkspaceTab; running: boolean }): React.JSX.Element {
  if (running) return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-500" />
  switch (tab.kind) {
    case 'query':
      return <FileCode className="h-3.5 w-3.5 shrink-0 text-sky-500" />
    case 'table':
      return <Table2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
    case 'processes':
      return <Activity className="h-3.5 w-3.5 shrink-0 text-amber-500" />
    case 'history':
      return <History className="h-3.5 w-3.5 shrink-0 text-violet-500" />
    case 'saved':
      return <Bookmark className="h-3.5 w-3.5 shrink-0 text-violet-500" />
    case 'console':
      return <ScrollText className="h-3.5 w-3.5 shrink-0 text-slate-500" />
  }
}

export interface WorkspaceTabsProps {
  projectId: string
  tabs: DataWorkspaceTab[]
  activeTabId: string | null
  onNewQuery: () => void
  /** Close a tab (the workspace asks first when a query tab has unsaved text). */
  onRequestClose: (tab: DataWorkspaceTab) => void
  /** Close the other tabs / the tabs to the right of `tab` (one question for the whole set). */
  onRequestCloseMany: (tab: DataWorkspaceTab, which: 'others' | 'right') => void
}

export function WorkspaceTabs({
  projectId,
  tabs,
  activeTabId,
  onNewQuery,
  onRequestClose,
  onRequestCloseMany
}: WorkspaceTabsProps): React.JSX.Element {
  const runningIds = useDataWorkspaceStore((s) =>
    tabs
      .filter((t) => s.runs[t.id]?.status === 'running')
      .map((t) => t.id)
      .join('\u0000')
  )
  const running = new Set(runningIds ? runningIds.split('\u0000') : [])
  const stagedIds = useDataWorkspaceStore((s) =>
    tabs
      .filter((t) => t.kind === 'table' && tabStagedEditCount(s.stagedEdits, t.id))
      .map((t) => t.id)
      .join('\u0000')
  )
  const staged = new Set(stagedIds ? stagedIds.split('\u0000') : [])
  const store = useDataWorkspaceStore.getState
  const requestClose = onRequestClose

  return (
    <div
      className="flex h-8 shrink-0 items-stretch border-b border-border bg-card"
      data-testid="data-project-tabs"
    >
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId
          const dirty = isQueryTabDirty(tab) || staged.has(tab.id)
          const origin = tab.kind === 'query' ? tab.origin : undefined
          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="tab"
                  aria-selected={active}
                  title={
                    tab.kind === 'table'
                      ? [tab.ref.database, tab.ref.schema, tab.ref.name].filter(Boolean).join('.') +
                        (staged.has(tab.id) ? ' · staged edits not committed' : '')
                      : tab.title
                  }
                  data-testid={`data-project-tab-${tab.kind}-${index}`}
                  data-tab-id={tab.id}
                  className={tabClass(active)}
                  onClick={() => store().setActiveTab(projectId, tab.id)}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault()
                      requestClose(tab)
                    }
                  }}
                >
                  <TabIcon tab={tab} running={running.has(tab.id)} />
                  <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                  {origin && (
                    <span
                      className="shrink-0 rounded-[4px] bg-violet-500/15 px-1 text-[9px] font-semibold uppercase text-violet-600 dark:text-violet-300"
                      data-testid={`data-project-tab-origin-${index}`}
                    >
                      {ORIGIN_BADGE[origin]}
                    </span>
                  )}
                  {dirty ? (
                    <>
                      <span
                        className="h-2 w-2 shrink-0 rounded-full bg-current group-hover:hidden"
                        data-testid={`data-project-tab-dirty-${index}`}
                      />
                      <button
                        type="button"
                        className="hidden shrink-0 rounded p-0.5 hover:bg-accent group-hover:block"
                        onClick={(e) => {
                          e.stopPropagation()
                          requestClose(tab)
                        }}
                        data-testid={`data-project-tab-close-${index}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={cn(
                        'shrink-0 rounded p-0.5 transition-opacity hover:bg-accent',
                        active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      )}
                      onClick={(e) => {
                        e.stopPropagation()
                        requestClose(tab)
                      }}
                      data-testid={`data-project-tab-close-${index}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                  {active && <div className={TAB_UNDERLINE_CLASS} />}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => requestClose(tab)}>
                  Close
                  <ContextMenuShortcut>⌘W</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={tabs.length < 2}
                  onSelect={() => onRequestCloseMany(tab, 'others')}
                  data-testid={`data-project-tab-close-others-${index}`}
                >
                  Close others
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={index === tabs.length - 1}
                  onSelect={() => onRequestCloseMany(tab, 'right')}
                  data-testid={`data-project-tab-close-right-${index}`}
                >
                  Close to the right
                </ContextMenuItem>
                {tab.kind === 'query' && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onSelect={() =>
                        store().openQuery(projectId, tab.text, tab.database, {
                          title: `${tab.title} copy`
                        })
                      }
                    >
                      Duplicate
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>
      <button
        type="button"
        className={STRIP_BUTTON}
        onClick={onNewQuery}
        title="New query tab"
        data-testid="data-project-new-query"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
