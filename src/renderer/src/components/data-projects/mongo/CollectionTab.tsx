// A collection tab: the `database › collection` header with its type, and the sub-tabs
// Documents | Aggregations | Schema | Indexes (no Indexes for views: they have none). Narrow
// panes show the sub-tabs as icons (and let them scroll) rather than pushing them out of view.

import { Database, FileStack, KeyRound, Network, Workflow } from 'lucide-react'
import type { DataProject } from '@shared/data-projects/types'
import { cn } from '@/lib/utils'
import {
  useMongoWorkspaceStore,
  type MongoCollectionSubTab,
  type MongoCollectionTab
} from '@/stores/useMongoWorkspaceStore'
import { AggregationsView } from './AggregationsView'
import { DocumentsView } from './DocumentsView'
import { IndexesView } from './IndexesView'
import { COLLECTION_TYPE_BADGE } from './mongo-ui'
import { SchemaView } from './SchemaView'

const SUB_TABS: Array<{ value: MongoCollectionSubTab; label: string; icon: typeof FileStack }> = [
  { value: 'documents', label: 'Documents', icon: FileStack },
  { value: 'aggregations', label: 'Aggregations', icon: Workflow },
  { value: 'schema', label: 'Schema', icon: Network },
  { value: 'indexes', label: 'Indexes', icon: KeyRound }
]

export function CollectionTab({
  project,
  tab
}: {
  project: DataProject
  tab: MongoCollectionTab
}): React.JSX.Element {
  const updateTab = useMongoWorkspaceStore((s) => s.updateCollectionTab)
  const isView = tab.collectionType === 'view'
  const subTab = isView && tab.subTab === 'indexes' ? 'documents' : tab.subTab
  const badge = tab.collectionType ? COLLECTION_TYPE_BADGE[tab.collectionType] : undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-project-mongo-collection">
      <div className="@container/ctab flex h-9 shrink-0 items-center gap-3 border-b border-border px-3">
        <div className="flex min-w-0 shrink items-center gap-1.5 text-[12px]">
          <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-muted-foreground">{tab.database}</span>
          <span className="text-muted-foreground">›</span>
          <span className="truncate font-medium">{tab.collection}</span>
          {badge && (
            <span className="rounded-[4px] bg-secondary px-1.5 text-[10px] text-muted-foreground">
              {badge}
            </span>
          )}
        </div>
        <nav
          className="flex h-full shrink-0 items-stretch overflow-x-auto"
          role="tablist"
          aria-label="Collection views"
        >
          {SUB_TABS.filter((t) => !(isView && t.value === 'indexes')).map(
            ({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={subTab === value}
                title={label}
                onClick={() => updateTab(project.id, tab.id, { subTab: value })}
                className={cn(
                  'relative flex shrink-0 items-center gap-1.5 px-2.5 text-[12px] transition-colors',
                  subTab === value
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                data-testid={`data-project-mongo-subtab-${value}`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden @[600px]/ctab:inline">{label}</span>
                {subTab === value && (
                  <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground/70" />
                )}
              </button>
            )
          )}
        </nav>
      </div>
      {subTab === 'documents' && <DocumentsView project={project} tab={tab} />}
      {subTab === 'aggregations' && <AggregationsView project={project} tab={tab} />}
      {subTab === 'schema' && <SchemaView project={project} tab={tab} />}
      {subTab === 'indexes' && <IndexesView project={project} tab={tab} />}
    </div>
  )
}
