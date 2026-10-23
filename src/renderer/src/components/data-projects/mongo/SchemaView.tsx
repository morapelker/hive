// Schema sub-tab: analyses a random sample of the collection ($sample of 100 / 1,000 / 5,000
// documents, server-side with mongodb-schema) and lists every field path with how often it is
// present, its type mix (a field can hold several types), a few sample values and how unique
// the sampled values are. Clicking a field adds `field: ` to the Documents filter and switches
// there. The $jsonSchema validator, when the collection has one, is shown below the table.
// The analysis runs once when the tab is first shown; Analyze re-samples.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Filter, Loader2, RefreshCw, Search } from 'lucide-react'
import type {
  DataProject,
  MongoSchemaField,
  MongoSchemaResponse
} from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  SCHEMA_SAMPLE_SIZES,
  useMongoWorkspaceStore,
  type MongoCollectionTab
} from '@/stores/useMongoWorkspaceStore'
import { HighlightedCode } from './DocumentResults'
import { toRelaxedJsonText } from './ejson'
import { formatCount, formatDuration, mongoErrorText } from './mongo-ui'
import { registerMongoCache } from './tab-caches'

interface SchemaState {
  status: 'loading' | 'ok' | 'error'
  result?: MongoSchemaResponse
  error?: string
  durationMs?: number
}

const schemaCache = new Map<string, SchemaState>()

/** Tests only. */
export function resetSchemaCache(): void {
  schemaCache.clear()
}

registerMongoCache(({ tabIds }) => {
  for (const id of tabIds) schemaCache.delete(id)
})

const TYPE_COLORS: Record<string, string> = {
  String: 'bg-emerald-500',
  ObjectId: 'bg-amber-500',
  Date: 'bg-cyan-500',
  Int32: 'bg-sky-500',
  Double: 'bg-blue-500',
  Long: 'bg-indigo-500',
  Decimal128: 'bg-violet-500',
  Number: 'bg-sky-500',
  Boolean: 'bg-fuchsia-500',
  Document: 'bg-zinc-500',
  Array: 'bg-stone-500',
  Null: 'bg-zinc-300 dark:bg-zinc-600',
  Undefined: 'bg-zinc-300 dark:bg-zinc-600',
  Binary: 'bg-orange-500',
  UUID: 'bg-amber-600',
  BSONRegExp: 'bg-orange-400',
  Timestamp: 'bg-teal-500'
}
const typeColor = (type: string): string => TYPE_COLORS[type] ?? 'bg-rose-400'

const pct = (p: number): string => `${Math.round(p * 1000) / 10}%`

function FieldRow({
  field,
  onPick
}: {
  field: MongoSchemaField
  onPick: (path: string) => void
}): React.JSX.Element {
  const segments = field.path.split('.')
  const depth = segments.length - 1
  const types = [...field.types].sort((a, b) => b.probability - a.probability)
  return (
    <tr
      className="group cursor-pointer border-b border-border/60 hover:bg-accent/40"
      onClick={() => onPick(field.path)}
      title={`Filter on ${field.path}`}
      data-testid={`data-project-mongo-schema-field-${field.path}`}
    >
      <td className="py-1.5 pr-3 align-top">
        <div
          className="flex items-center gap-1 font-mono text-[12px]"
          style={{ paddingLeft: depth * 14 }}
        >
          {depth > 0 && <span className="text-muted-foreground/60">└</span>}
          <span className="text-sky-800 dark:text-sky-300">{segments[segments.length - 1]}</span>
          <Filter className="ml-1 h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </div>
      </td>
      <td className="w-[140px] py-1.5 pr-3 align-top">
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-foreground/60"
              style={{ width: pct(field.probability) }}
            />
          </div>
          <span className="w-12 text-right text-[11px] tabular-nums text-muted-foreground">
            {pct(field.probability)}
          </span>
        </div>
      </td>
      <td className="w-[240px] py-1.5 pr-3 align-top">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
          {types.map((t) => (
            <div
              key={t.type}
              className={typeColor(t.type)}
              style={{ width: pct(t.probability) }}
              title={`${t.type} ${pct(t.probability)}`}
            />
          ))}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {types.map((t) => (
            <span key={t.type} className="flex items-center gap-1">
              <span className={cn('inline-block size-1.5 rounded-full', typeColor(t.type))} />
              {t.type} {pct(t.probability)}
            </span>
          ))}
        </div>
      </td>
      <td className="max-w-[320px] py-1.5 pr-3 align-top">
        <div className="flex flex-wrap gap-1">
          {(field.sampleValues ?? []).slice(0, 5).map((v, i) => (
            <span
              key={`${i}-${v}`}
              className="max-w-[180px] truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]"
              title={v}
            >
              {v}
            </span>
          ))}
        </div>
      </td>
      <td className="w-[80px] py-1.5 text-right align-top text-[11px] tabular-nums text-muted-foreground">
        {field.uniqueness === undefined ? '—' : pct(field.uniqueness)}
      </td>
    </tr>
  )
}

export function SchemaView({
  project,
  tab
}: {
  project: DataProject
  tab: MongoCollectionTab
}): React.JSX.Element {
  const { database, collection } = tab
  const updateTab = useMongoWorkspaceStore((s) => s.updateCollectionTab)
  const addFilterField = useMongoWorkspaceStore((s) => s.addFilterField)
  const [state, setState] = useState<SchemaState | null>(() => schemaCache.get(tab.id) ?? null)
  const [search, setSearch] = useState('')
  const [validatorOpen, setValidatorOpen] = useState(false)
  const seq = useRef(0)

  const analyze = async (sampleSize = tab.schemaSampleSize): Promise<void> => {
    const mine = ++seq.current
    const started = performance.now()
    setState((s) => ({ status: 'loading', result: s?.result }))
    try {
      const result = await dataProjectsApi.mongo.schema({
        dataProjectId: project.id,
        database,
        collection,
        sampleSize
      })
      if (mine !== seq.current) return
      const next: SchemaState = { status: 'ok', result, durationMs: performance.now() - started }
      setState(next)
      schemaCache.set(tab.id, next)
    } catch (e) {
      if (mine !== seq.current) return
      const next: SchemaState = {
        status: 'error',
        error: mongoErrorText(project, e, 'Schema analysis failed')
      }
      setState(next)
      schemaCache.set(tab.id, next)
    }
  }

  const analyzedOnce = useRef(false)
  useEffect(() => {
    if (analyzedOnce.current) return
    analyzedOnce.current = true
    if (!schemaCache.has(tab.id)) void analyze()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  // Unmount (or a StrictMode remount): drop the pending analysis and let the mount effect redo it.
  useEffect(
    () => () => {
      seq.current++
      analyzedOnce.current = false
    },
    []
  )

  const fields = useMemo(() => {
    const all = state?.result?.fields ?? []
    const needle = search.trim().toLowerCase()
    return needle ? all.filter((f) => f.path.toLowerCase().includes(needle)) : all
  }, [state?.result, search])

  const result = state?.result
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-project-mongo-schema">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="text-[12px] text-muted-foreground">Sample</span>
        <select
          value={tab.schemaSampleSize}
          onChange={(e) => {
            const size = Number(e.target.value)
            updateTab(project.id, tab.id, { schemaSampleSize: size })
            void analyze(size)
          }}
          className="h-7 rounded-[6px] border border-input bg-background px-1.5 text-[12px] dark:bg-input/30"
          data-testid="data-project-mongo-schema-sample"
        >
          {SCHEMA_SAMPLE_SIZES.map((n) => (
            <option key={n} value={n}>
              {formatCount(n)} documents
            </option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={() => void analyze()}
          disabled={state?.status === 'loading'}
          data-testid="data-project-mongo-schema-analyze"
        >
          {state?.status === 'loading' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Analyze
        </Button>
        {result && (
          <span
            className="text-[12px] text-muted-foreground"
            data-testid="data-project-mongo-schema-summary"
          >
            {formatCount(result.fields.length)} fields from {formatCount(result.sampleSize)} sampled
            {result.count !== null ? ` of ~${formatCount(result.count)}` : ''} documents
            {state?.durationMs !== undefined ? ` · ${formatDuration(state.durationMs)}` : ''}
          </span>
        )}
        <div className="relative ml-auto w-56">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter fields"
            className="h-7 pl-7 text-[12px]"
            data-testid="data-project-mongo-schema-search"
          />
        </div>
      </div>
      {state?.status === 'error' && (
        <div
          className="whitespace-pre-wrap border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 font-mono text-[12px] text-destructive"
          data-testid="data-project-mongo-schema-error"
        >
          {state.error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-3">
        {!result && state?.status === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Sampling documents…
          </div>
        )}
        {result && result.fields.length === 0 && (
          <div className="py-12 text-center text-[13px] text-muted-foreground">
            No documents were sampled: the collection is empty.
          </div>
        )}
        {result && result.fields.length > 0 && (
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="border-b border-border text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">Field</th>
                <th className="py-2 pr-3 font-semibold">Present</th>
                <th className="py-2 pr-3 font-semibold">Types</th>
                <th className="py-2 pr-3 font-semibold">Sample values</th>
                <th className="py-2 text-right font-semibold">Unique</th>
              </tr>
            </thead>
            <tbody className={cn(state?.status === 'loading' && 'opacity-60')}>
              {fields.map((field) => (
                <FieldRow
                  key={field.path}
                  field={field}
                  onPick={(path) => addFilterField(project.id, tab.id, path)}
                />
              ))}
            </tbody>
          </table>
        )}
        {result?.validator && (
          <div className="my-3 rounded-[8px] border border-border">
            <button
              type="button"
              className="flex w-full items-center gap-1 px-3 py-2 text-[12px] font-medium"
              onClick={() => setValidatorOpen((o) => !o)}
              data-testid="data-project-mongo-schema-validator-toggle"
            >
              {validatorOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              Validation rules
            </button>
            {validatorOpen && (
              <div className="border-t border-border p-3">
                <HighlightedCode text={toRelaxedJsonText(result.validator)} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
