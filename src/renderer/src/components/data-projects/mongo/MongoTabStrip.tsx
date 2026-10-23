// Tab strip of the Mongo workspace (same anatomy as the session/file tabs): collection tabs,
// Shell tabs, Processes, History and Saved queries; middle-click or × closes, the context menu
// has Close / Close others, + opens a new Shell tab in the current database. Closing goes
// through the workspace (`onRequestClose*`), which asks first for Shell tabs with unsaved text
// (marked with a dot here).

import {
  Activity,
  Bookmark,
  Clock,
  Eye,
  History,
  Plus,
  ScrollText,
  SquareTerminal,
  Table2,
  X
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { TAB_ACTIVE_SURFACE_CLASS, TAB_UNDERLINE_CLASS } from '@/lib/tab-styles'
import { cn } from '@/lib/utils'
import {
  isShellTabDirty,
  useMongoWorkspaceStore,
  type MongoWorkspaceTab
} from '@/stores/useMongoWorkspaceStore'

function tabLabel(tab: MongoWorkspaceTab): { title: string; hint: string; icon: typeof Table2 } {
  switch (tab.kind) {
    case 'collection':
      return {
        title: tab.collection,
        hint: `${tab.database}.${tab.collection}`,
        icon:
          tab.collectionType === 'view' ? Eye : tab.collectionType === 'timeseries' ? Clock : Table2
      }
    case 'shell':
      return {
        title: tab.title,
        hint: `${tab.title}${tab.database ? ` · ${tab.database}` : ''}`,
        icon: SquareTerminal
      }
    case 'processes':
      return { title: 'Processes', hint: 'Operations running on the server', icon: Activity }
    case 'history':
      return { title: 'History', hint: 'Queries run in this data project', icon: History }
    case 'saved':
      return { title: 'Saved queries', hint: 'Queries saved with this connection', icon: Bookmark }
    case 'console':
      return { title: 'Console', hint: 'Every statement sent to the server', icon: ScrollText }
  }
}

export function MongoTabStrip({
  projectId,
  onRequestClose,
  onRequestCloseOthers
}: {
  projectId: string
  /** Close one tab (the workspace confirms unsaved Shell text). */
  onRequestClose: (tab: MongoWorkspaceTab) => void
  /** Close every tab but this one (one confirmation for all unsaved Shell tabs). */
  onRequestCloseOthers: (tab: MongoWorkspaceTab) => void
}): React.JSX.Element {
  const tabs = useMongoWorkspaceStore((s) => s.workspaces[projectId]?.tabs)
  const activeTabId = useMongoWorkspaceStore((s) => s.workspaces[projectId]?.activeTabId ?? null)
  const activateTab = useMongoWorkspaceStore((s) => s.activateTab)
  const openShell = useMongoWorkspaceStore((s) => s.openShell)

  return (
    <div
      className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-card"
      role="tablist"
      data-testid="data-project-mongo-tabs"
    >
      {(tabs ?? []).map((tab) => {
        const { title, hint, icon: Icon } = tabLabel(tab)
        const isActive = tab.id === activeTabId
        return (
          <ContextMenu key={tab.id}>
            <ContextMenuTrigger asChild>
              <div
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                title={hint}
                onClick={() => activateTab(projectId, tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') activateTab(projectId, tab.id)
                }}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault()
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) onRequestClose(tab)
                }}
                className={cn(
                  'group relative flex h-full min-w-[96px] max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-2.5 text-[12px] select-none',
                  isActive
                    ? `${TAB_ACTIVE_SURFACE_CLASS} text-foreground`
                    : 'bg-card text-muted-foreground hover:text-foreground'
                )}
                data-testid={`data-project-mongo-tab-${tab.id}`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{title}</span>
                {tab.kind === 'shell' && tab.origin ? (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-violet-500"
                    title="Inserted text, not run yet"
                  />
                ) : (
                  isShellTabDirty(tab) && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-foreground/50"
                      title="Not saved as a query"
                      data-testid={`data-project-mongo-tab-dirty-${tab.id}`}
                    />
                  )
                )}
                <button
                  type="button"
                  className="ml-auto shrink-0 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100 focus:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRequestClose(tab)
                  }}
                  aria-label={`Close ${title}`}
                  data-testid={`data-project-mongo-tab-close-${tab.id}`}
                >
                  <X className="h-3 w-3" />
                </button>
                {isActive && <div className={TAB_UNDERLINE_CLASS} />}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => onRequestClose(tab)}>Close</ContextMenuItem>
              <ContextMenuItem
                disabled={(tabs ?? []).length < 2}
                onSelect={() => onRequestCloseOthers(tab)}
                data-testid={`data-project-mongo-tab-close-others-${tab.id}`}
              >
                Close others
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
      <button
        type="button"
        className="flex h-full w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        onClick={() => openShell(projectId)}
        title="New shell tab"
        data-testid="data-project-mongo-new-shell"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
