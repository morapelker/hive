// Left rail of the SQL workspace: database switcher (MySQL/MariaDB/ClickHouse databases, PG
// databases, SQLite main/temp/attached), PostgreSQL schema switcher, a filter, and a virtualized
// tree of object kinds (tables with row estimates and sizes, views, materialized views,
// functions, procedures, triggers, sequences, types, events, dictionaries; ClickHouse engines).
//
// Clicking a table/view opens its Data tab; anything else opens its DDL. The context menu offers
// Open data / Structure / DDL, Generate SELECT (new query tab via the editor bridge), Copy name,
// Export to CSV/JSON/SQL (server-streamed), Import CSV… (tables: the import dialog, gated like
// any write), Truncate / Drop (the statement is written into a NEW query tab for review, never
// run from here) and Refresh.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  BookOpen,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Cog,
  Database,
  Download,
  Eye,
  FileCode2,
  Globe,
  Hash,
  KeyRound,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Shapes,
  Sigma,
  Table2,
  Trash2,
  Upload,
  Zap
} from 'lucide-react'
import type {
  DataConnectionState,
  DataDatabaseInfo,
  DataObjectInfo,
  DataObjectKind,
  DataObjectsListing,
  DataProject,
  SqlDialect
} from '@shared/data-projects/types'
import type { DataImportTarget } from '@shared/data-projects/import-types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import { ImportDialog } from '@/components/data-projects/import'
import { useDataEditorBridge } from '@/components/data-projects/editor-bridge'
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
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDataWorkspaceStore } from '@/stores/useDataWorkspaceStore'
import { FULL_EXPORT_FORMATS, startFullExport } from '../shared/export-actions'
import { formatBytes, formatCount } from '../shared/format-utils'
import {
  generateDrop,
  generateSelect,
  generateTruncate,
  isTableLike,
  OBJECT_GROUP_ORDER,
  OBJECT_KIND_LABELS,
  objectSqlName,
  plainObjectName,
  refForObject
} from './schema-actions'

export interface SchemaExplorerProps {
  project: DataProject
  dialect: SqlDialect
  connectionState: DataConnectionState | undefined
  connectionError?: string
  /** True when the server asked for credentials (the prompt is or was open). */
  credentialsRequired: boolean
  databases: DataDatabaseInfo[] | null
  databasesError: string | null
  database: string | undefined
  schema: string | undefined
  onDatabaseChange: (database: string) => void
  onSchemaChange: (schema: string) => void
  /** Reload databases, objects and the completion schema. */
  onRefresh: () => void
  onReconnect: () => void
  onEnterCredentials: () => void
  /** Bumped by onRefresh: reloads the objects. */
  refreshKey: number
}

const KIND_ICON: Record<DataObjectKind, typeof Table2> = {
  table: Table2,
  view: Eye,
  materialized_view: Layers,
  foreign_table: Globe,
  dictionary: BookOpen,
  function: Sigma,
  procedure: Cog,
  trigger: Zap,
  sequence: Hash,
  type: Shapes,
  event: CalendarClock,
  collection: Table2
}

type TreeRow =
  | { type: 'group'; kind: DataObjectKind; count: number; expanded: boolean }
  | { type: 'object'; object: DataObjectInfo }
  | { type: 'empty'; kind: DataObjectKind; text: string }

const ROW_HEIGHT = 24

export function SchemaExplorer(props: SchemaExplorerProps): React.JSX.Element {
  const {
    project,
    dialect,
    connectionState,
    connectionError,
    credentialsRequired,
    databases,
    databasesError,
    database,
    schema,
    onDatabaseChange,
    onSchemaChange,
    onRefresh,
    onReconnect,
    onEnterCredentials,
    refreshKey
  } = props
  const connected = connectionState === 'connected'
  const [listing, setListing] = useState<DataObjectsListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<DataObjectKind>>(
    () => new Set(['table', 'view'])
  )
  const [cursor, setCursor] = useState(-1)
  const [importTarget, setImportTarget] = useState<DataImportTarget | null>(null)
  const seqRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const effectiveSchema = dialect === 'postgres' ? (schema ?? 'public') : undefined

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await dataProjectsApi.objects(project.id, database, effectiveSchema)
      if (seq !== seqRef.current) return
      setListing(result)
      // PG: settle on a schema the database really has.
      if (
        dialect === 'postgres' &&
        result.schemas?.length &&
        effectiveSchema &&
        !result.schemas.includes(effectiveSchema)
      ) {
        onSchemaChange(result.schemas.includes('public') ? 'public' : result.schemas[0])
      }
    } catch (err) {
      if (seq === seqRef.current) setError(errorMessage(err, 'Could not list the objects'))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, database, effectiveSchema, dialect])

  useEffect(() => {
    if (!connected) return
    if (dialect !== 'sqlite' && databases === null) return // wait for the database list
    void load()
  }, [connected, load, refreshKey, databases, dialect])

  const objectsByKind = useMemo(() => {
    const map = new Map<DataObjectKind, DataObjectInfo[]>()
    for (const o of listing?.objects ?? []) {
      const list = map.get(o.kind)
      if (list) list.push(o)
      else map.set(o.kind, [o])
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [listing])

  const rows = useMemo<TreeRow[]>(() => {
    const needle = filter.trim().toLowerCase()
    const out: TreeRow[] = []
    for (const kind of OBJECT_GROUP_ORDER) {
      const all = objectsByKind.get(kind) ?? []
      if (!all.length && kind !== 'table') continue
      const matches = needle ? all.filter((o) => o.name.toLowerCase().includes(needle)) : all
      if (needle && !matches.length) continue
      const open = needle ? true : expanded.has(kind)
      out.push({ type: 'group', kind, count: matches.length, expanded: open })
      if (!open) continue
      if (!matches.length) {
        out.push({
          type: 'empty',
          kind,
          text:
            dialect === 'postgres'
              ? `No tables in ${effectiveSchema ?? 'this schema'}`
              : 'No tables'
        })
      }
      for (const object of matches) out.push({ type: 'object', object })
    }
    return out
  }, [objectsByKind, filter, expanded, dialect, effectiveSchema])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })

  const toggleGroup = (kind: DataObjectKind): void =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })

  const current = { database, schema: effectiveSchema }
  const refOf = (object: DataObjectInfo) =>
    refForObject(object, { dialect, database, schema: effectiveSchema })

  const open = (object: DataObjectInfo, view?: 'data' | 'structure' | 'ddl'): void => {
    const ref = refOf(object)
    useDataWorkspaceStore
      .getState()
      .openTable(project.id, ref, view ?? (isTableLike(object.kind) ? 'data' : 'ddl'))
  }

  const toNewTab = (text: string, title: string): void =>
    useDataEditorBridge.getState().insert({
      dataProjectId: project.id,
      text,
      mode: 'new-tab',
      database,
      title,
      origin: 'schema'
    })

  const copy = async (text: string, what: string): Promise<void> => {
    if (await copyTextToClipboard(text)) toast.success(`${what} copied`)
    else toast.error('Could not copy to the clipboard')
  }

  const onTreeKeyDown = (e: React.KeyboardEvent): void => {
    if (!rows.length) return
    const move = (index: number): void => {
      const next = Math.max(0, Math.min(rows.length - 1, index))
      setCursor(next)
      virtualizer.scrollToIndex(next, { align: 'auto' })
    }
    const row = rows[cursor]
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(cursor + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        move(cursor - 1)
        break
      case 'ArrowRight':
        if (row?.type === 'group' && !row.expanded) {
          e.preventDefault()
          toggleGroup(row.kind)
        }
        break
      case 'ArrowLeft':
        if (row?.type === 'group' && row.expanded) {
          e.preventDefault()
          toggleGroup(row.kind)
        }
        break
      case 'Enter':
        if (row?.type === 'group') toggleGroup(row.kind)
        else if (row?.type === 'object') open(row.object)
        break
    }
  }

  const systemDbs = (databases ?? []).filter((d) => d.isSystem)
  const userDbs = (databases ?? []).filter((d) => !d.isSystem)
  const dbOptionsMissing = database && databases && !databases.some((d) => d.name === database)

  const renderObject = (object: DataObjectInfo, index: number): React.JSX.Element => {
    const Icon = KIND_ICON[object.kind] ?? Table2
    const ref = refOf(object)
    const tableLike = isTableLike(object.kind)
    const showSchema = dialect === 'postgres' && object.schema && object.schema !== effectiveSchema
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            data-testid={`data-project-schema-object-${object.kind}-${object.name}`}
            onClick={() => {
              setCursor(index)
              open(object)
            }}
            title={[object.name, object.engine, object.comment, object.detail]
              .filter(Boolean)
              .join(' · ')}
            className={cn(
              'group flex h-full cursor-pointer items-center gap-1.5 rounded-sm pl-6 pr-2 text-[12px] hover:bg-accent/50',
              cursor === index && 'bg-accent/60'
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {showSchema && <span className="text-muted-foreground">{object.schema}.</span>}
              {object.name}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground/80">
              {object.engine && dialect === 'clickhouse' && (
                <span className="max-w-[80px] truncate">{object.engine}</span>
              )}
              {object.rowEstimate !== undefined && object.rowEstimate !== null && (
                <span title={`about ${formatCount(object.rowEstimate)} rows`}>
                  ~{formatCount(object.rowEstimate, true)}
                </span>
              )}
              {object.sizeBytes ? <span>{formatBytes(object.sizeBytes)}</span> : null}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[210px]" data-testid="data-project-schema-menu">
          {tableLike && (
            <>
              <ContextMenuItem
                onSelect={() => open(object, 'data')}
                data-testid="data-project-schema-menu-open"
              >
                <Table2 className="mr-2 h-4 w-4" />
                Open data
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => open(object, 'structure')}
                data-testid="data-project-schema-menu-structure"
              >
                <KeyRound className="mr-2 h-4 w-4" />
                Structure
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem
            onSelect={() => open(object, 'ddl')}
            data-testid="data-project-schema-menu-ddl"
          >
            <FileCode2 className="mr-2 h-4 w-4" />
            DDL
          </ContextMenuItem>
          {tableLike && (
            <ContextMenuItem
              onSelect={() =>
                toNewTab(generateSelect(ref, dialect, { current }), `SELECT ${object.name}`)
              }
              data-testid="data-project-schema-menu-select"
            >
              <Plus className="mr-2 h-4 w-4" />
              Generate SELECT
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => void copy(object.name, 'Name')}
            data-testid="data-project-schema-menu-copy-name"
          >
            <ClipboardCopy className="mr-2 h-4 w-4" />
            Copy name
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => void copy(plainObjectName(ref, dialect), 'Qualified name')}
          >
            Copy qualified name
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => void copy(objectSqlName(ref, dialect, {}), 'Quoted name')}
          >
            Copy quoted name
          </ContextMenuItem>
          {tableLike && (
            <ContextMenuSub>
              <ContextMenuSubTrigger data-testid="data-project-schema-menu-export">
                <Download className="mr-2 h-4 w-4" />
                Export
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {FULL_EXPORT_FORMATS.map((f) => (
                  <ContextMenuItem
                    key={f.format}
                    onSelect={() =>
                      void startFullExport({
                        dataProjectId: project.id,
                        source: { kind: 'table', ref },
                        format: f.format
                      })
                    }
                    data-testid={`data-project-schema-menu-export-${f.format}`}
                  >
                    {f.label}…
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {object.kind === 'table' && (
            <ContextMenuItem
              onSelect={() => setImportTarget({ kind: 'table', ref })}
              data-testid="data-project-schema-menu-import"
            >
              <Upload className="mr-2 h-4 w-4" />
              Import CSV…
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {object.kind === 'table' && (
            <ContextMenuItem
              onSelect={() =>
                toNewTab(generateTruncate(ref, dialect, current), `TRUNCATE ${object.name}`)
              }
              className="text-red-500 focus:text-red-500"
              data-testid="data-project-schema-menu-truncate"
            >
              <Scissors className="mr-2 h-4 w-4" />
              Truncate…
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onSelect={() =>
              toNewTab(generateDrop(object, ref, dialect, current), `DROP ${object.name}`)
            }
            className="text-red-500 focus:text-red-500"
            data-testid="data-project-schema-menu-drop"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Drop…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onRefresh} data-testid="data-project-schema-menu-refresh">
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const body = (): React.ReactNode => {
    if (credentialsRequired && !connected) {
      return (
        <div
          className="flex flex-col items-center gap-2 p-4 text-center text-[12px] text-muted-foreground"
          data-testid="data-project-schema-credentials"
        >
          This connection needs a password.
          <Button
            size="sm"
            variant="outline"
            onClick={onEnterCredentials}
            data-testid="data-project-schema-enter-credentials"
          >
            Enter password
          </Button>
        </div>
      )
    }
    if (connectionState === 'error') {
      return (
        <div
          className="flex flex-col items-center gap-2 p-4 text-center text-[12px]"
          data-testid="data-project-schema-connection-error"
        >
          <span className="text-red-600 dark:text-red-400">
            {connectionError || 'Could not connect'}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={onReconnect}
            data-testid="data-project-schema-reconnect"
          >
            Reconnect
          </Button>
        </div>
      )
    }
    if (!connected) {
      return (
        <div
          className="flex items-center justify-center gap-2 p-4 text-[12px] text-muted-foreground"
          data-testid="data-project-schema-connecting"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Connecting…
        </div>
      )
    }
    if (error || databasesError) {
      return (
        <div
          className="flex flex-col items-center gap-2 p-4 text-center text-[12px]"
          data-testid="data-project-schema-error"
        >
          <span className="text-red-600 dark:text-red-400">{error ?? databasesError}</span>
          <Button size="sm" variant="outline" onClick={onRefresh}>
            Retry
          </Button>
        </div>
      )
    }
    if (!listing) {
      return (
        <div className="flex items-center justify-center p-4">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )
    }
    if (!rows.length) {
      return (
        <div className="p-4 text-center text-[12px] text-muted-foreground">No matching objects</div>
      )
    }
    return (
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          return (
            <div
              key={item.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: item.size,
                transform: `translateY(${item.start}px)`
              }}
            >
              {row.type === 'group' ? (
                <div
                  role="treeitem"
                  aria-expanded={row.expanded}
                  data-testid={`data-project-schema-group-${row.kind}`}
                  onClick={() => {
                    setCursor(item.index)
                    toggleGroup(row.kind)
                  }}
                  className={cn(
                    'flex h-full cursor-pointer select-none items-center gap-1 rounded-sm px-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground hover:bg-accent/50',
                    cursor === item.index && 'bg-accent/60'
                  )}
                >
                  {row.expanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  {OBJECT_KIND_LABELS[row.kind].many}
                  <span className="ml-1 font-normal normal-case tracking-normal">{row.count}</span>
                </div>
              ) : row.type === 'empty' ? (
                <div className="flex h-full items-center pl-6 text-[12px] italic text-muted-foreground/70">
                  {row.text}
                </div>
              ) : (
                renderObject(row.object, item.index)
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-sidebar"
      data-testid="data-project-schema-explorer"
    >
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2">
        <div className="flex items-center gap-1">
          <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <select
            value={database ?? ''}
            onChange={(e) => onDatabaseChange(e.target.value)}
            disabled={!databases?.length}
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-[12px]"
            data-testid="data-project-database-select"
            title="Database"
          >
            {!database && <option value="">{databases ? 'Choose a database' : 'Loading…'}</option>}
            {dbOptionsMissing && <option value={database}>{database}</option>}
            {userDbs.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
                {d.sizeBytes ? `  (${formatBytes(d.sizeBytes)})` : ''}
              </option>
            ))}
            {systemDbs.length > 0 && (
              <optgroup label="System">
                {systemDbs.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            title="Refresh"
            data-testid="data-project-schema-refresh"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        {dialect === 'postgres' && (listing?.schemas?.length ?? 0) > 0 && (
          <select
            value={effectiveSchema ?? ''}
            onChange={(e) => onSchemaChange(e.target.value)}
            className="h-7 rounded-md border border-input bg-background px-1.5 text-[12px]"
            data-testid="data-project-schema-select"
            title="Schema"
          >
            {listing?.schemas?.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilter('')
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                scrollRef.current?.focus()
                setCursor(0)
              }
            }}
            placeholder="Filter objects…"
            className="h-7 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            data-testid="data-project-schema-filter"
          />
        </div>
      </div>
      <div
        ref={scrollRef}
        role="tree"
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        className="min-h-0 flex-1 overflow-auto px-1 py-1 outline-none"
        data-testid="data-project-schema-tree"
      >
        {body()}
      </div>
      {listing && (
        <div className="shrink-0 border-t border-border px-2 py-1 text-[10px] text-muted-foreground">
          {formatCount(listing.objects.length)} objects
        </div>
      )}
      <ImportDialog
        project={project}
        target={importTarget}
        onClose={() => setImportTarget(null)}
        onImported={onRefresh}
        onOpenTarget={() => {
          if (importTarget?.kind === 'table')
            useDataWorkspaceStore.getState().openTable(project.id, importTarget.ref, 'data')
        }}
      />
    </div>
  )
}
