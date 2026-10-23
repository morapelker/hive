// The seam between the data project shell (view, toolbar) and the two database clients:
// SqlWorkspace (sql-ui, components/data-projects/sql) for the SQL family and MongoWorkspace
// (mongo-ui, components/data-projects/mongo) for MongoDB, plus the shared confirmation host
// (sql-ui, components/data-projects/shared). Both workspaces load lazily so CodeMirror, the
// dialects and the grid stay out of the app's first chunk, and only the family in use loads.
//
// The toolbar's Processes / History / Saved / Console buttons go through
// `openWorkspaceSpecialTab`, which talks to the matching workspace store (both expose
// `openSpecialTab(projectId, kind)`); the view's
// keyboard shortcuts (new tab, next / previous tab, next / previous view of a table or collection
// tab) through `openWorkspaceNewTab`, `cycleWorkspaceTab` and `stepWorkspaceView`; refresh and
// filter of the active table go to the table views as a cancelable event (`sendTableCommand`).

import { lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { dataEngineFamily, type DataProject } from '@shared/data-projects/types'
import type { DataTableView } from '@/stores/useDataWorkspaceStore'
import type { MongoCollectionSubTab } from '@/stores/useMongoWorkspaceStore'

interface WorkspaceProps {
  project: DataProject
}

const SqlWorkspace = lazy(() => import('./sql/SqlWorkspace'))
const MongoWorkspace = lazy(() => import('./mongo/MongoWorkspace'))
const DataConfirmHost = lazy(() =>
  import('./shared/DataConfirmHost').then((m) => ({ default: m.DataConfirmHost }))
)

function WorkspaceLoading(): React.JSX.Element {
  return (
    <div
      className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground"
      data-testid="data-project-workspace-loading"
    >
      <Loader2 className="h-5 w-5 animate-spin" />
      Loading the client…
    </div>
  )
}

/** The project's database client (SQL or document family) and the confirm dialog host. */
export function DataProjectWorkspace({ project }: WorkspaceProps): React.JSX.Element {
  const family = dataEngineFamily(project.engine)
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      {family === 'document' ? (
        <MongoWorkspace key={project.id} project={project} />
      ) : (
        <SqlWorkspace key={project.id} project={project} />
      )}
    </Suspense>
  )
}

/** Mount once per open data project: renders the safe-mode confirmation dialogs. */
export function DataProjectConfirmHost(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <DataConfirmHost />
    </Suspense>
  )
}

/** The workspace panels the toolbar opens (both workspaces have each of them). */
export type WorkspaceSpecialTab = 'processes' | 'history' | 'saved' | 'console'

/** Opens (or focuses) the Processes / History / Saved queries / Console tab of the workspace. */
export async function openWorkspaceSpecialTab(
  project: DataProject,
  kind: WorkspaceSpecialTab
): Promise<void> {
  if (dataEngineFamily(project.engine) === 'document') {
    const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')
    useMongoWorkspaceStore.getState().openSpecialTab(project.id, kind)
    return
  }
  const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
  useDataWorkspaceStore.getState().openSpecialTab(project.id, kind)
}

/** A new query tab (SQL) or Shell tab (MongoDB) in the project's workspace (⌘T). */
export async function openWorkspaceNewTab(project: DataProject): Promise<void> {
  if (dataEngineFamily(project.engine) === 'document') {
    const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')
    useMongoWorkspaceStore.getState().openShell(project.id)
    return
  }
  const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
  useDataWorkspaceStore.getState().openQuery(project.id)
}

/** Activates the next (+1) / previous (-1) tab of the project's workspace (⌃Tab / ⌃⇧Tab). */
export async function cycleWorkspaceTab(project: DataProject, step: 1 | -1): Promise<void> {
  if (dataEngineFamily(project.engine) === 'document') {
    const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')
    useMongoWorkspaceStore.getState().cycleTab(project.id, step)
    return
  }
  const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
  useDataWorkspaceStore.getState().cycleTab(project.id, step)
}

/**
 * ⌘R (refresh) / ⌘F (filter) from DataProjectView, as a cancelable window event. The table or
 * collection view of the project's active tab answers by calling `preventDefault()` (and then
 * reloads its rows / focuses its filter); an unanswered event leaves the key alone.
 */
export const DATA_TABLE_COMMAND_EVENT = 'hive:data-table-command'

export interface DataTableCommandDetail {
  projectId: string
  command: 'refresh' | 'filter'
}

/** Sends a table command to the project's active tab; true when a view handled it. */
export function sendTableCommand(detail: DataTableCommandDetail): boolean {
  return !window.dispatchEvent(
    new CustomEvent<DataTableCommandDetail>(DATA_TABLE_COMMAND_EVENT, { detail, cancelable: true })
  )
}

/** The sub-tab strip of a Mongo collection tab, in CollectionTab's order (a view has no indexes). */
const MONGO_SUB_TABS: readonly MongoCollectionSubTab[] = [
  'documents',
  'aggregations',
  'schema',
  'indexes'
]

/** The view after `current` in `views`, clamped at the ends (no wrap, like a segmented control). */
function stepIn<T>(views: readonly T[], current: T, step: 1 | -1): T {
  const index = Math.max(0, views.indexOf(current))
  return views[Math.min(views.length - 1, Math.max(0, index + step))]
}

/**
 * Moves the active table tab to its next (+1) / previous (-1) view — Data → Structure → DDL — or
 * the active collection tab to its next / previous sub-tab (⌃⌘] / ⌃⌘[, TablePlus' Data /
 * Structure switch). Query, Shell and panel tabs have no views: nothing happens.
 */
export async function stepWorkspaceView(project: DataProject, step: 1 | -1): Promise<void> {
  if (dataEngineFamily(project.engine) === 'document') {
    const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')
    const store = useMongoWorkspaceStore.getState()
    const workspace = store.workspaces[project.id]
    const tab = workspace?.tabs.find((t) => t.id === workspace.activeTabId)
    if (tab?.kind !== 'collection') return
    const isView = tab.collectionType === 'view'
    const views: readonly MongoCollectionSubTab[] = MONGO_SUB_TABS.filter(
      (v) => !(isView && v === 'indexes')
    )
    const current = views.includes(tab.subTab) ? tab.subTab : views[0]
    const next = stepIn(views, current, step)
    if (next !== current) store.updateCollectionTab(project.id, tab.id, { subTab: next })
    return
  }
  const [{ useDataWorkspaceStore }, { isTableLike }] = await Promise.all([
    import('@/stores/useDataWorkspaceStore'),
    import('./sql/schema-actions')
  ])
  const store = useDataWorkspaceStore.getState()
  const tab = store.getActiveTab(project.id)
  if (tab?.kind !== 'table') return
  // TableTab's views: objects that hold rows have Data / Structure / DDL, the rest DDL only.
  const views: readonly DataTableView[] = isTableLike(tab.ref.kind)
    ? ['data', 'structure', 'ddl']
    : ['ddl']
  const current = views.includes(tab.view) ? tab.view : views[0]
  const next = stepIn(views, current, step)
  if (next !== current) store.setTableView(project.id, tab.id, next)
}
