// Left pane of the Mongo workspace: databases (with sizes) → collections (document count, size,
// view / time-series / capped badges), a filter box, and context menus:
//   database   — New shell tab here, Create collection…, Refresh, Copy name, Drop database…
//   collection — Open, Open in new tab, Aggregate, Schema, Indexes, New shell tab here,
//                Export (JSON / CSV), Import JSON / CSV… (not views), Copy name,
//                Create collection…, Rename…, Drop…
// Drops ask for the name to be typed, then go through the safe-mode gate like every change.
// Rows are virtualized (databases with thousands of collections stay smooth); collections of a
// database load when it is expanded, or for every expanded database while filtering.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertCircle,
  Archive,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Download,
  Eye,
  FileStack,
  Folder,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Table2,
  Trash2,
  Upload,
  Workflow,
  X
} from 'lucide-react'
import type { DataImportTarget } from '@shared/data-projects/import-types'
import type { DataObjectInfo, DataProject } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { ImportDialog } from '@/components/data-projects/import'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useMongoWorkspaceStore } from '@/stores/useMongoWorkspaceStore'
import {
  CreateCollectionDialog,
  RenameCollectionDialog,
  type CreateCollectionRequest,
  type RenameCollectionRequest
} from './CollectionDialogs'
import { invalidateCompletionSchema } from './completion-data'
import { exportMongoSource } from './export'
import { ConfirmNameDialog, type ConfirmNameState } from './MongoDialogs'
import { COLLECTION_TYPE_BADGE, formatBytes, formatCount, runGated } from './mongo-ui'
import { collectionAccessor } from './requests'
import { isSystemDatabase, type MongoCatalog } from './useMongoCatalog'

const ROW_HEIGHT = 26

type Row =
  | {
      kind: 'db'
      name: string
      sizeBytes: number | null | undefined
      system: boolean
      expanded: boolean
    }
  | { kind: 'coll'; database: string; info: DataObjectInfo }
  | { kind: 'status'; database: string; text: string; error?: boolean }

function collectionIcon(type: string | undefined): typeof Table2 {
  if (type === 'view') return Eye
  if (type === 'timeseries') return Clock
  if (type === 'capped') return Archive
  return Table2
}

export function MongoExplorer({
  project,
  catalog,
  active
}: {
  project: DataProject
  catalog: MongoCatalog
  /** The active tab's collection (highlighted). */
  active: { database: string; collection?: string } | null
}): React.JSX.Element {
  const expanded = useMongoWorkspaceStore((s) => s.workspaces[project.id]?.expanded)
  const setExpanded = useMongoWorkspaceStore((s) => s.setExpanded)
  const setDatabase = useMongoWorkspaceStore((s) => s.setDatabase)
  const openCollection = useMongoWorkspaceStore((s) => s.openCollection)
  const openShell = useMongoWorkspaceStore((s) => s.openShell)
  const renameTabs = useMongoWorkspaceStore((s) => s.renameCollection)
  const closeCollectionTabs = useMongoWorkspaceStore((s) => s.closeCollectionTabs)
  const status = useDataProjectStore((s) => s.statuses[project.id])
  const [filter, setFilter] = useState('')
  const [createRequest, setCreateRequest] = useState<CreateCollectionRequest | null>(null)
  const [renameRequest, setRenameRequest] = useState<RenameCollectionRequest | null>(null)
  const [confirm, setConfirm] = useState<ConfirmNameState | null>(null)
  const [importTarget, setImportTarget] = useState<Extract<
    DataImportTarget,
    { kind: 'collection' }
  > | null>(null)
  const parentRef = useRef<HTMLDivElement>(null)
  const { databases, collections, loadCollections } = catalog
  const expandedSet = useMemo(() => new Set(expanded ?? []), [expanded])
  const needle = filter.trim().toLowerCase()

  // Expanded databases need their collections (also restored from the last session) — once the
  // database list has loaded, i.e. the connection is up.
  useEffect(() => {
    if (databases === null) return
    for (const db of expandedSet) if (!collections[db]) void loadCollections(db)
  }, [databases, expandedSet, collections, loadCollections])

  const rows = useMemo((): Row[] => {
    const out: Row[] = []
    for (const db of databases ?? []) {
      const state = collections[db.name]
      const dbMatches = !needle || db.name.toLowerCase().includes(needle)
      const objects = state?.objects ?? []
      const matching =
        needle && !dbMatches
          ? objects.filter((o) => o.name.toLowerCase().includes(needle))
          : objects
      if (needle && !dbMatches && matching.length === 0) continue
      const isOpen = expandedSet.has(db.name) || (!!needle && matching.length > 0)
      out.push({
        kind: 'db',
        name: db.name,
        sizeBytes: db.sizeBytes,
        system: isSystemDatabase(db),
        expanded: isOpen
      })
      if (!isOpen) continue
      if (!state || (state.status === 'loading' && objects.length === 0)) {
        out.push({ kind: 'status', database: db.name, text: 'Loading…' })
        continue
      }
      if (state.status === 'error') {
        out.push({
          kind: 'status',
          database: db.name,
          text: state.error ?? 'Could not list the collections',
          error: true
        })
        continue
      }
      if (matching.length === 0)
        out.push({ kind: 'status', database: db.name, text: 'No collections' })
      for (const info of matching) out.push({ kind: 'coll', database: db.name, info })
    }
    return out
  }, [databases, collections, expandedSet, needle])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })

  const toggleDb = (name: string, isOpen: boolean): void => {
    setExpanded(project.id, name, !isOpen)
    setDatabase(project.id, name)
    if (!isOpen) void loadCollections(name)
  }

  const copy = async (text: string): Promise<void> => {
    if (await copyTextToClipboard(text)) toast.success('Copied')
    else toast.error('Could not copy to the clipboard')
  }

  const refreshDb = (db: string): void => {
    invalidateCompletionSchema(project.id, db)
    void loadCollections(db, true)
  }

  const dropCollection = (database: string, info: DataObjectInfo): void =>
    setConfirm({
      title: `Drop ${info.engine === 'view' ? 'view' : 'collection'} ${info.name}?`,
      description: `${database}.${info.name}${info.rowEstimate ? ` and its ~${formatCount(info.rowEstimate)} documents` : ''} and indexes are deleted permanently.`,
      name: info.name,
      confirmLabel: 'Drop',
      run: async () => {
        const outcome = await runGated(
          project,
          (confirmToken) =>
            dataProjectsApi.mongo.collection({
              dataProjectId: project.id,
              database,
              action: { kind: 'drop', collection: info.name },
              ...(confirmToken ? { confirmToken } : {})
            }),
          'Could not drop the collection'
        )
        if (outcome.kind === 'ok') {
          toast.success(`Dropped ${database}.${info.name}`)
          closeCollectionTabs(project.id, database, info.name)
          refreshDb(database)
          return null
        }
        if (outcome.kind === 'declined') return 'Not dropped: the change was not confirmed'
        if (outcome.kind === 'blocked') return `Blocked by the safe mode: ${outcome.reason}`
        return outcome.kind === 'error' ? outcome.message : 'Cancelled'
      }
    })

  const dropDatabase = (database: string): void =>
    setConfirm({
      title: `Drop database ${database}?`,
      description: 'Every collection, document and index in it is deleted permanently.',
      name: database,
      confirmLabel: 'Drop database',
      run: async () => {
        const outcome = await runGated(
          project,
          (confirmToken) =>
            dataProjectsApi.mongo.collection({
              dataProjectId: project.id,
              database,
              action: { kind: 'dropDatabase' },
              ...(confirmToken ? { confirmToken } : {})
            }),
          'Could not drop the database'
        )
        if (outcome.kind === 'ok') {
          toast.success(`Dropped database ${database}`)
          closeCollectionTabs(project.id, database)
          setExpanded(project.id, database, false)
          catalog.forgetDatabase(database)
          invalidateCompletionSchema(project.id)
          void catalog.reloadDatabases()
          return null
        }
        if (outcome.kind === 'declined') return 'Not dropped: the change was not confirmed'
        if (outcome.kind === 'blocked') return `Blocked by the safe mode: ${outcome.reason}`
        return outcome.kind === 'error' ? outcome.message : 'Cancelled'
      }
    })

  const renderRow = (row: Row): React.JSX.Element => {
    if (row.kind === 'status') {
      return (
        <div
          className={cn(
            'flex h-full items-center truncate pl-9 pr-2 text-[12px]',
            row.error ? 'text-destructive' : 'text-muted-foreground'
          )}
          title={row.text}
        >
          {row.error && <AlertCircle className="mr-1 h-3 w-3 shrink-0" />}
          <span className="truncate">{row.text}</span>
          {row.error && (
            <button
              type="button"
              className="ml-auto shrink-0 underline-offset-2 hover:underline"
              onClick={() => refreshDb(row.database)}
            >
              Retry
            </button>
          )}
        </div>
      )
    }
    if (row.kind === 'db') {
      const isActive = active?.database === row.name && !active.collection
      return (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              role="treeitem"
              aria-expanded={row.expanded}
              onClick={() => toggleDb(row.name, row.expanded)}
              className={cn(
                'flex h-full w-full items-center gap-1 rounded-[5px] px-1.5 text-left text-[13px] hover:bg-accent/50',
                isActive && 'bg-accent/40',
                row.system && 'text-muted-foreground'
              )}
              data-testid={`data-project-mongo-db-${row.name}`}
            >
              {row.expanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{row.name}</span>
              {row.sizeBytes ? (
                <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
                  {formatBytes(row.sizeBytes)}
                </span>
              ) : null}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={() => openShell(project.id, { database: row.name })}
              data-testid="data-project-mongo-db-menu-shell"
            >
              <SquareTerminal className="mr-2 h-4 w-4" /> New shell tab here
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => setCreateRequest({ database: row.name })}
              data-testid="data-project-mongo-db-menu-create"
            >
              <Plus className="mr-2 h-4 w-4" /> Create collection…
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => refreshDb(row.name)}
              data-testid="data-project-mongo-db-menu-refresh"
            >
              <RefreshCw className="mr-2 h-4 w-4" /> Refresh
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void copy(row.name)}>
              <Copy className="mr-2 h-4 w-4" /> Copy name
            </ContextMenuItem>
            {!row.system && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => dropDatabase(row.name)}
                  data-testid="data-project-mongo-db-menu-drop"
                >
                  <Trash2 className="mr-2 h-4 w-4" /> Drop database…
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      )
    }
    const { info, database } = row
    const type = info.engine
    const Icon = collectionIcon(type)
    const badge = type ? COLLECTION_TYPE_BADGE[type] : undefined
    const isActive = active?.database === database && active.collection === info.name
    const isView = type === 'view'
    const open = (
      subTab?: 'documents' | 'aggregations' | 'schema' | 'indexes',
      newTab = false
    ): void => {
      openCollection(project.id, database, info.name, {
        collectionType: type,
        newTab,
        ...(subTab ? { subTab } : {})
      })
    }
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            role="treeitem"
            onClick={() => open()}
            onAuxClick={(e) => {
              if (e.button === 1) open(undefined, true)
            }}
            title={[`${database}.${info.name}`, info.detail].filter(Boolean).join(' · ')}
            className={cn(
              'flex h-full w-full items-center gap-1.5 rounded-[5px] pl-7 pr-1.5 text-left text-[13px] hover:bg-accent/50',
              isActive && 'bg-accent text-accent-foreground'
            )}
            data-testid={`data-project-mongo-coll-${database}-${info.name}`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{info.name}</span>
            {badge && (
              <span className="shrink-0 rounded-[4px] bg-secondary px-1 text-[10px] text-muted-foreground">
                {badge}
              </span>
            )}
            <span className="ml-auto flex shrink-0 gap-1.5 pl-2 text-[11px] tabular-nums text-muted-foreground">
              {info.rowEstimate !== null && info.rowEstimate !== undefined && (
                <span>{formatCount(info.rowEstimate)}</span>
              )}
              {info.sizeBytes ? (
                <span className="hidden @[260px]:inline">{formatBytes(info.sizeBytes)}</span>
              ) : null}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => open('documents')}
            data-testid="data-project-mongo-coll-menu-open"
          >
            <FileStack className="mr-2 h-4 w-4" /> Open
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => open('documents', true)}
            data-testid="data-project-mongo-coll-menu-open-new"
          >
            <FileStack className="mr-2 h-4 w-4" /> Open in new tab
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => open('aggregations')}>
            <Workflow className="mr-2 h-4 w-4" /> Aggregate
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => open('schema')}>
            <Folder className="mr-2 h-4 w-4" /> Schema
          </ContextMenuItem>
          {!isView && (
            <ContextMenuItem onSelect={() => open('indexes')}>
              <KeyRound className="mr-2 h-4 w-4" /> Indexes
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onSelect={() =>
              openShell(project.id, { database, text: `${collectionAccessor(info.name)}.find({})` })
            }
            data-testid="data-project-mongo-coll-menu-shell"
          >
            <SquareTerminal className="mr-2 h-4 w-4" /> New shell tab here
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="data-project-mongo-coll-menu-export">
              <Download className="mr-2 h-4 w-4" /> Export collection
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {(['json', 'csv'] as const).map((format) => (
                <ContextMenuItem
                  key={format}
                  onSelect={() =>
                    void exportMongoSource(
                      project,
                      { kind: 'mongo', database, collection: info.name },
                      format
                    )
                  }
                  data-testid={`data-project-mongo-coll-menu-export-${format}`}
                >
                  {format === 'json' ? 'JSON (relaxed EJSON)…' : 'CSV (flattened fields)…'}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {!isView && (
            <ContextMenuItem
              onSelect={() =>
                setImportTarget({ kind: 'collection', database, collection: info.name })
              }
              data-testid="data-project-mongo-coll-menu-import"
            >
              <Upload className="mr-2 h-4 w-4" /> Import JSON / CSV…
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => void copy(info.name)}>
            <Copy className="mr-2 h-4 w-4" /> Copy name
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => setCreateRequest({ database })}
            data-testid="data-project-mongo-coll-menu-create"
          >
            <Plus className="mr-2 h-4 w-4" /> Create collection…
          </ContextMenuItem>
          {!isView && (
            <ContextMenuItem
              onSelect={() => setRenameRequest({ database, collection: info.name })}
              data-testid="data-project-mongo-coll-menu-rename"
            >
              <Pencil className="mr-2 h-4 w-4" /> Rename…
            </ContextMenuItem>
          )}
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => dropCollection(database, info)}
            data-testid="data-project-mongo-coll-menu-drop"
          >
            <Trash2 className="mr-2 h-4 w-4" /> Drop…
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => refreshDb(database)}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <div
      className="@container flex h-full min-h-0 flex-col"
      data-testid="data-project-mongo-explorer"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Databases
        </span>
        <div className="ml-auto flex items-center">
          <Button
            variant="ghost"
            size="icon-xs"
            title="Create database"
            onClick={() => setCreateRequest({ database: '', newDatabase: true })}
            data-testid="data-project-mongo-create-database"
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Refresh"
            disabled={catalog.loadingDatabases}
            onClick={() => {
              invalidateCompletionSchema(project.id)
              void catalog.reloadDatabases()
              for (const db of expandedSet) void loadCollections(db, true)
            }}
            data-testid="data-project-mongo-explorer-refresh"
          >
            <RefreshCw className={cn(catalog.loadingDatabases && 'animate-spin')} />
          </Button>
        </div>
      </div>
      <div className="relative shrink-0 border-b border-border p-1.5">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            // Filtering looks inside every expanded database, so make sure they are loaded.
            for (const db of expandedSet) if (!collections[db]) void loadCollections(db)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setFilter('')
          }}
          placeholder="Filter databases and collections"
          className="h-7 pl-7 pr-7 text-[12px]"
          data-testid="data-project-mongo-explorer-filter"
        />
        {filter && (
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => setFilter('')}
            aria-label="Clear filter"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {catalog.databasesError && (
        <div
          className="flex items-start gap-1.5 border-b border-border px-2 py-2 text-[12px] text-destructive"
          data-testid="data-project-mongo-explorer-error"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{catalog.databasesError}</span>
          <button
            type="button"
            className="shrink-0 underline-offset-2 hover:underline"
            onClick={() => void catalog.reloadDatabases()}
          >
            Retry
          </button>
        </div>
      )}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto px-1 py-1" role="tree">
        {databases === null && catalog.loadingDatabases && (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading databases…
          </div>
        )}
        {databases === null && !catalog.loadingDatabases && !catalog.databasesError && (
          <div
            className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground"
            data-testid="data-project-mongo-explorer-waiting"
          >
            {status?.state === 'error' ? (
              <>
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                <span className="min-w-0 break-words">
                  Not connected{status.error ? `: ${status.error}` : ''}
                </span>
              </>
            ) : (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…
              </>
            )}
          </div>
        )}
        {databases !== null && rows.length === 0 && (
          <div className="px-2 py-3 text-[12px] text-muted-foreground">
            {needle
              ? 'Nothing matches the filter (only expanded databases are searched).'
              : 'No databases visible to this user.'}
          </div>
        )}
        <div
          style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            return (
              <div
                key={
                  row.kind === 'coll'
                    ? `c:${row.database}:${row.info.name}`
                    : `${row.kind}:${'name' in row ? row.name : row.database}`
                }
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${item.size}px`,
                  transform: `translateY(${item.start}px)`
                }}
              >
                {renderRow(row)}
              </div>
            )
          })}
        </div>
      </div>
      {status?.serverVersion && (
        <div className="flex h-6 shrink-0 items-center gap-1.5 border-t border-border px-2 text-[11px] text-muted-foreground">
          <span>MongoDB {status.serverVersion}</span>
          {status.readOnlyUser && <span className="rounded bg-secondary px-1">read-only user</span>}
        </div>
      )}

      <CreateCollectionDialog
        request={createRequest}
        project={project}
        onClose={() => setCreateRequest(null)}
        onCreated={(database, collection) => {
          invalidateCompletionSchema(project.id, database)
          setExpanded(project.id, database, true)
          if (!databases?.some((d) => d.name === database)) void catalog.reloadDatabases()
          void loadCollections(database, true)
          openCollection(project.id, database, collection, { collectionType: 'collection' })
        }}
      />
      <RenameCollectionDialog
        request={renameRequest}
        project={project}
        onClose={() => setRenameRequest(null)}
        onRenamed={(database, from, to) => {
          renameTabs(project.id, database, from, to)
          refreshDb(database)
        }}
      />
      <ConfirmNameDialog state={confirm} onClose={() => setConfirm(null)} />
      <ImportDialog
        project={project}
        target={importTarget}
        onClose={() => setImportTarget(null)}
        onImported={() => {
          if (importTarget) refreshDb(importTarget.database)
        }}
        onOpenTarget={() => {
          if (importTarget)
            openCollection(project.id, importTarget.database, importTarget.collection, {
              subTab: 'documents'
            })
        }}
      />
    </div>
  )
}
