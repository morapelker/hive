// A table tab: Data | Structure | DDL for tables, views, materialized views, foreign tables and
// dictionaries; DDL only for routines, triggers, sequences, types and events. The describe result
// is loaded once per tab and shared by Data (primary key) and Structure.
//
// Structure is the structure editor (structure/StructureEditor.tsx): columns (type, nullability,
// default, key, extra, comment) and indexes edit in place and are staged until Apply, which runs
// the DDL through the safety gate; foreign keys, triggers, CHECK / UNIQUE constraints and the
// engine-specific properties (ClickHouse engine / sorting key / partition key / TTL, MySQL storage
// engine, sizes and row estimates) are listed read-only. Objects that cannot be altered show the
// same view read-only with the reason. Both the describe result and the DDL reload after DDL ran
// anywhere in the project (Apply here, ALTER TABLE ... in a query tab); after an Apply the Data
// view reloads too when it holds no staged row edits (its columns may have changed).

import { useCallback, useEffect, useState } from 'react'
import { Copy, FilePlus2, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import type { DataProject, DataTableDetails, SqlDialect } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import { useDataEditorBridge } from '@/components/data-projects/editor-bridge'
import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  useDataWorkspaceStore,
  type DataTableTab,
  type DataTableView
} from '@/stores/useDataWorkspaceStore'
import { QueryEditor } from '../editor/QueryEditor'
import { formatBytes } from '../shared/format-utils'
import { isTableLike, OBJECT_KIND_LABELS } from './schema-actions'
import {
  ForeignKeysSection,
  PropertiesSection,
  Section,
  SimpleTable,
  Mono,
  TriggersSection
} from './structure/sections'
import { StructureEditor } from './structure/StructureEditor'
import { TableDataView } from './TableDataView'

export interface TableTabProps {
  project: DataProject
  tab: DataTableTab
  dialect: SqlDialect
}

/** The structure without editing (columns, indexes, foreign keys, triggers, properties). */
export function TableStructureView({ details }: { details: DataTableDetails }): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="data-project-table-structure">
      <PropertiesSection details={details} />
      <Section title="Columns" count={details.columns.length}>
        <SimpleTable
          testId="data-project-structure-columns"
          headers={['#', 'Name', 'Type', 'Nullable', 'Default', 'Extra', 'Comment']}
          rows={details.columns.map((c) => [
            <span key="o" className="tabular-nums text-muted-foreground">
              {c.ordinal}
            </span>,
            <span key="n" className="flex items-center gap-1 font-mono font-medium">
              {c.isPrimaryKey && (
                <KeyRound className="h-3 w-3 text-amber-500" aria-label="primary key" />
              )}
              {c.name}
            </span>,
            <Mono text={c.type} />,
            c.nullable ? 'yes' : <span className="font-medium">NOT NULL</span>,
            <Mono text={c.defaultValue ?? null} />,
            <Mono
              text={
                [c.autoIncrement ? 'auto increment' : null, c.extra].filter(Boolean).join(' · ') ||
                null
              }
            />,
            c.comment ?? ''
          ])}
        />
      </Section>
      <Section title="Indexes" count={details.indexes.length}>
        {details.indexes.length ? (
          <SimpleTable
            testId="data-project-structure-indexes"
            headers={['Name', 'Columns', 'Unique', 'Type', 'Size', 'Definition']}
            rows={details.indexes.map((ix) => [
              <span key="n" className="font-mono">
                {ix.name}
                {ix.primary && (
                  <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">
                    PRIMARY
                  </span>
                )}
              </span>,
              <Mono text={ix.columns.join(', ')} />,
              ix.unique ? 'yes' : 'no',
              <Mono text={ix.type ?? null} />,
              ix.sizeBytes ? formatBytes(ix.sizeBytes) : '',
              <Mono text={ix.definition ?? null} />
            ])}
          />
        ) : (
          <p className="text-[12px] text-muted-foreground">No indexes.</p>
        )}
      </Section>
      <ForeignKeysSection details={details} />
      <TriggersSection details={details} />
    </div>
  )
}

/** Read-only DDL with Copy and "Open in a query tab". */
export function DdlView({
  project,
  tab,
  dialect
}: {
  project: DataProject
  tab: DataTableTab
  dialect: SqlDialect
}): React.JSX.Element {
  const [ddl, setDdl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const schemaVersion = useDataWorkspaceStore((s) => s.schemaVersion[project.id] ?? 0)
  const refKey = JSON.stringify([
    tab.ref.database ?? '',
    tab.ref.schema ?? '',
    tab.ref.name,
    tab.ref.kind ?? ''
  ])

  useEffect(() => {
    let cancelled = false
    setDdl(null)
    setError(null)
    dataProjectsApi
      .ddl(project.id, tab.ref)
      .then((text) => !cancelled && setDdl(text))
      .catch((err) => !cancelled && setError(errorMessage(err, 'Could not load the DDL')))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, refKey, reload, schemaVersion])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-project-table-ddl">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          title="Reload"
          onClick={() => setReload((n) => n + 1)}
          data-testid="data-project-ddl-reload"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!ddl}
          onClick={async () => {
            if (ddl && (await copyTextToClipboard(ddl))) toast.success('DDL copied')
          }}
          data-testid="data-project-ddl-copy"
        >
          <Copy className="h-3.5 w-3.5" />
          Copy
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!ddl}
          onClick={() =>
            ddl &&
            useDataEditorBridge.getState().insert({
              dataProjectId: project.id,
              text: ddl,
              mode: 'new-tab',
              database: tab.ref.database,
              title: `DDL ${tab.ref.name}`,
              origin: 'schema'
            })
          }
          data-testid="data-project-ddl-open"
        >
          <FilePlus2 className="h-3.5 w-3.5" />
          Open in query tab
        </Button>
      </div>
      {error ? (
        <div
          className="p-3 text-[12px] text-red-600 dark:text-red-400"
          data-testid="data-project-ddl-error"
        >
          {error}
        </div>
      ) : ddl === null ? (
        <div className="flex h-24 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <QueryEditor
            value={ddl}
            onChange={() => undefined}
            language="sql"
            dialect={dialect}
            readOnly
            data-testid="data-project-ddl-editor"
          />
        </div>
      )}
    </div>
  )
}

const VIEW_LABEL: Record<DataTableView, string> = {
  data: 'Data',
  structure: 'Structure',
  ddl: 'DDL'
}

export function TableTab({ project, tab, dialect }: TableTabProps): React.JSX.Element {
  const kind = tab.ref.kind
  const tableLike = isTableLike(kind)
  const views: DataTableView[] = tableLike ? ['data', 'structure', 'ddl'] : ['ddl']
  const view = views.includes(tab.view) ? tab.view : views[0]
  const [details, setDetails] = useState<DataTableDetails | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const schemaVersion = useDataWorkspaceStore((s) => s.schemaVersion[project.id] ?? 0)
  const refKey = JSON.stringify([tab.ref.database ?? '', tab.ref.schema ?? '', tab.ref.name])
  const [visited, setVisited] = useState<ReadonlySet<DataTableView>>(() => new Set([view]))
  useEffect(() => {
    setVisited((s) => (s.has(view) ? s : new Set([...s, view])))
  }, [view])
  // Bumped after the structure editor applied DDL: remounts the Data view (new columns), unless
  // it holds staged row edits (those are never dropped silently).
  const [dataEpoch, setDataEpoch] = useState(0)
  const onStructureApplied = useCallback(() => {
    if (!useDataWorkspaceStore.getState().stagedEdits[tab.id]) setDataEpoch((n) => n + 1)
  }, [tab.id])

  const loadDetails = useCallback(async () => {
    setDetailsLoading(true)
    setDetailsError(null)
    try {
      setDetails(await dataProjectsApi.describe(project.id, tab.ref))
    } catch (err) {
      setDetailsError(errorMessage(err, 'Could not describe the object'))
    } finally {
      setDetailsLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, refKey, schemaVersion])

  useEffect(() => {
    if (tableLike) void loadDetails()
  }, [tableLike, loadDetails])

  const setView = (next: DataTableView): void =>
    useDataWorkspaceStore.getState().setTableView(project.id, tab.id, next)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={`data-project-table-tab-${tab.id}`}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-card px-2">
        {views.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            data-testid={`data-project-table-view-${v}`}
            className={cn(
              'h-6 rounded-[5px] px-2.5 text-[12px] transition-colors',
              view === v
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
        <span className="ml-2 truncate font-mono text-[12px] text-muted-foreground">
          {[dialect === 'postgres' ? tab.ref.schema : tab.ref.database, tab.ref.name]
            .filter(Boolean)
            .join('.')}
        </span>
        {kind && kind !== 'table' && (
          <span className="rounded-full bg-secondary px-2 text-[10px] text-muted-foreground">
            {OBJECT_KIND_LABELS[kind].one}
          </span>
        )}
        {details?.engine && (
          <span className="rounded-full bg-secondary px-2 text-[10px] text-muted-foreground">
            {details.engine}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Data, Structure and DDL stay mounted once opened: switching views must not drop
            staged row edits, staged structure changes, the page position or the loaded DDL. */}
        {visited.has('data') && tableLike && (
          <div className={cn('flex min-h-0 flex-1 flex-col', view !== 'data' && 'hidden')}>
            <TableDataView
              key={dataEpoch}
              project={project}
              dialect={dialect}
              tab={tab}
              details={details}
            />
          </div>
        )}
        {visited.has('structure') && tableLike && (
          <div className={cn('flex min-h-0 flex-1 flex-col', view !== 'structure' && 'hidden')}>
            {details ? (
              <StructureEditor
                project={project}
                dialect={dialect}
                tab={tab}
                details={details}
                detailsLoading={detailsLoading}
                detailsError={detailsError}
                onReload={() => void loadDetails()}
                onApplied={onStructureApplied}
              />
            ) : detailsError ? (
              <div className="flex flex-col items-start gap-2 p-3 text-[12px] text-red-600 dark:text-red-400">
                {detailsError}
                <Button variant="outline" size="sm" onClick={() => void loadDetails()}>
                  Retry
                </Button>
              </div>
            ) : (
              <div className="flex h-24 items-center justify-center">
                {detailsLoading && (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                )}
              </div>
            )}
          </div>
        )}
        {visited.has('ddl') && (
          <div className={cn('flex min-h-0 flex-1 flex-col', view !== 'ddl' && 'hidden')}>
            <DdlView project={project} tab={tab} dialect={dialect} />
          </div>
        )}
      </div>
    </div>
  )
}
