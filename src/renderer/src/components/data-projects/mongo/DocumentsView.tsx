// Documents sub-tab of a collection tab (Compass's Documents view):
//
// Query bar — Filter (Enter / ⌘↵ runs Find), Options (Project, Sort, Collation, Hint, Skip,
// Limit, maxTimeMS), Reset, Explain, recent filters of this collection. Every field is a Mongo
// editor with completion in the right context (field paths, operators, BSON helpers).
//
// Results — List / JSON / Table, pages on top of the bar's skip/limit with "1–20 of N" (the
// server counts with a short time limit; "of many" when it could not), refresh, cancel while
// running. The query that produced the results ("applied") is what paging and refresh re-run,
// so editing the bar does not silently change what Next shows.
//
// Writes — Add / Edit / Clone / Delete (deleteOne by _id) and Update/Delete matching… all go
// through the safe-mode gate (runWithConfirmation). A document shown through a projection is
// re-read in full before editing or cloning, so a save can never drop the fields the projection
// hid. Edit is optimistic: replaceOne matches the document only as it was loaded (every field,
// and the field count, compared with the simple binary collation whatever the collection's
// default), so a change made meanwhile by someone else is never overwritten silently — the
// dialog says so and offers Reload or Overwrite. Update/Delete matching… use the
// query bar's filter and collation, for the count and the write alike. Views are read-only.
//
// Results survive tab switches in a small per-tab cache; a tab opened for the first time runs
// Find once.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Gauge,
  History,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  WandSparkles
} from 'lucide-react'
import type { DataProject } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  filterHistoryKey,
  useMongoWorkspaceStore,
  type MongoCollectionTab
} from '@/stores/useMongoWorkspaceStore'
import { DATA_TABLE_COMMAND_EVENT, type DataTableCommandDetail } from '../DataProjectWorkspaceHost'
import { BulkDialog, type BulkState } from './BulkDialog'
import { useMongoCompletionData } from './completion-data'
import { DocumentResults, DocumentViewToggle, type DocumentActions } from './DocumentResults'
import { formatShellDocument } from './ejson'
import { exportMongoSource, saveVisibleDocuments } from './export'
import { MongoCodeEditor, type MongoCodeEditorHandle } from './MongoCodeEditor'
import {
  DocumentEditorDialog,
  ExplainDialog,
  type DocumentEditorState,
  type DocumentSaveOutcome,
  type ExplainState
} from './MongoDialogs'
import {
  formatDuration,
  isCancelError,
  isReadOnlyCollectionType,
  mongoErrorText,
  newQueryId,
  runGated
} from './mongo-ui'
import {
  EMPTY_QUERY,
  NEW_DOCUMENT_TEXT,
  PAGE_SIZES,
  buildFindRequest,
  cloneDocumentText,
  CONCURRENCY_COLLATION,
  concurrencyFilterText,
  findShellText,
  idFilterText,
  pageInfo,
  parseQueryNumbers,
  type MongoQueryDraft,
  type ParsedQueryNumbers
} from './requests'
import { registerMongoCache } from './tab-caches'

interface DocsResult {
  documents: Array<Record<string, unknown>>
  count: number | null
  truncated: boolean
  durationMs: number
  page: number
  pageSize: number
  numbers: ParsedQueryNumbers
  /** The query bar as it was when this result was fetched. */
  applied: MongoQueryDraft
}

/** Results per tab id, so switching tabs does not re-query (bounded; oldest dropped). */
const resultCache = new Map<string, DocsResult>()
const CACHE_MAX = 40
function cacheResult(tabId: string, result: DocsResult): void {
  resultCache.delete(tabId)
  resultCache.set(tabId, result)
  while (resultCache.size > CACHE_MAX) resultCache.delete(resultCache.keys().next().value as string)
}

/** Tests only. */
export function resetDocumentsCache(): void {
  resultCache.clear()
}

registerMongoCache(({ tabIds }) => {
  for (const id of tabIds) resultCache.delete(id)
})

const CONFLICT_MESSAGE =
  'Not saved: this document changed (or was deleted) since you opened it. Reload it to edit the current version, or overwrite it with yours.'

const hasText = (text: string): boolean => text.trim() !== '' && text.replace(/\s+/g, '') !== '{}'

export function DocumentsView({
  project,
  tab
}: {
  project: DataProject
  tab: MongoCollectionTab
}): React.JSX.Element {
  const { database, collection } = tab
  const updateQuery = useMongoWorkspaceStore((s) => s.updateQuery)
  const updateTab = useMongoWorkspaceStore((s) => s.updateCollectionTab)
  const rememberFilter = useMongoWorkspaceStore((s) => s.rememberFilter)
  const openShell = useMongoWorkspaceStore((s) => s.openShell)
  const recentFilters = useMongoWorkspaceStore(
    (s) => s.filterHistory[filterHistoryKey(project.id, database, collection)]
  )
  const completionData = useMongoCompletionData(project, database, collection)
  const readOnly = isReadOnlyCollectionType(tab.collectionType)

  const [result, setResult] = useState<DocsResult | null>(() => resultCache.get(tab.id) ?? null)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editor, setEditor] = useState<DocumentEditorState | null>(null)
  const [bulk, setBulk] = useState<BulkState | null>(null)
  const [explain, setExplain] = useState<ExplainState | null>(null)
  const filterRef = useRef<MongoCodeEditorHandle>(null)
  const runSeq = useRef(0)
  const inflight = useRef<string | null>(null)
  const cancelled = useRef<string | null>(null)
  const tabRef = useRef(tab)
  tabRef.current = tab

  const query = tab.query
  const setQuery = (patch: Partial<MongoQueryDraft>): void => updateQuery(project.id, tab.id, patch)

  const run = useCallback(
    async (
      page: number,
      options: { source?: 'bar' | 'applied'; query?: MongoQueryDraft; pageSize?: number } = {}
    ): Promise<void> => {
      const current = tabRef.current
      const source = options.source ?? 'bar'
      const q = options.query ?? (source === 'applied' && result ? result.applied : current.query)
      const pageSize = options.pageSize ?? current.pageSize
      const queryId = newQueryId()
      const built = buildFindRequest(
        { dataProjectId: project.id, database, collection, queryId },
        q,
        page,
        pageSize
      )
      if (!built.ok) {
        setError(built.error)
        return
      }
      const seq = ++runSeq.current
      inflight.current = queryId
      setRunning(queryId)
      setError(null)
      setNotice(null)
      try {
        const res = await dataProjectsApi.mongo.find(built.request)
        if (seq !== runSeq.current) return
        const next: DocsResult = {
          documents: res.documents,
          count: res.count,
          truncated: res.truncated,
          durationMs: res.durationMs,
          page,
          pageSize,
          numbers: built.numbers,
          applied: { ...q }
        }
        setResult(next)
        cacheResult(current.id, next)
        if (source === 'bar' && hasText(q.filter))
          rememberFilter(project.id, database, collection, q.filter)
      } catch (e) {
        if (seq !== runSeq.current) return
        if (cancelled.current === queryId || isCancelError(e)) setNotice('Query cancelled')
        else setError(mongoErrorText(project, e, 'The query failed'))
      } finally {
        if (inflight.current === queryId) inflight.current = null
        if (seq === runSeq.current) setRunning(null)
      }
    },
    [project, database, collection, result, rememberFilter]
  )

  // First open of the tab: show the collection right away.
  const ranOnce = useRef(false)
  useEffect(() => {
    if (ranOnce.current) return
    ranOnce.current = true
    if (!resultCache.has(tab.id)) void run(0)
  }, [tab.id, run])

  // Cancel the in-flight query when the view goes away. The id is kept in a ref set synchronously
  // (`running` state may not have committed yet), and the first-open guard is reset so a
  // StrictMode remount starts a fresh run instead of waiting on the one just discarded.
  useEffect(
    () => () => {
      runSeq.current++
      ranOnce.current = false
      const queryId = inflight.current
      inflight.current = null
      if (queryId) void dataProjectsApi.cancel(queryId).catch(() => undefined)
    },
    []
  )

  // Schema tab "click a field": focus the filter with the cursor after `field: `. The request is
  // one-shot — consumed here (this view usually mounts because of it) so a later remount of the
  // tab does not steal focus again.
  const focusRequest = tab.filterFocus
  useEffect(() => {
    if (!focusRequest) return
    requestAnimationFrame(() => filterRef.current?.focus(focusRequest.cursor))
    updateTab(project.id, tab.id, { filterFocus: undefined })
  }, [focusRequest, updateTab, project.id, tab.id])

  const cancel = (): void => {
    if (!running) return
    cancelled.current = running
    void dataProjectsApi.cancel(running).catch(() => undefined)
  }

  const refresh = (): void => void run(result?.page ?? 0, { source: result ? 'applied' : 'bar' })

  // ⌘R / ⌘F from the data client (DataProjectView): re-run the query or focus the filter, only
  // while this collection tab is the active one and shows its documents.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    const onCommand = (event: Event): void => {
      const detail = (event as CustomEvent<DataTableCommandDetail>).detail
      if (detail?.projectId !== project.id) return
      const workspace = useMongoWorkspaceStore.getState().workspaces[project.id]
      if (workspace?.activeTabId !== tab.id || tab.subTab !== 'documents') return
      event.preventDefault()
      if (detail.command === 'refresh') refreshRef.current()
      else filterRef.current?.focus(tabRef.current.query.filter.length)
    }
    window.addEventListener(DATA_TABLE_COMMAND_EVENT, onCommand)
    return () => window.removeEventListener(DATA_TABLE_COMMAND_EVENT, onCommand)
  }, [project.id, tab.id, tab.subTab])

  const info = useMemo(
    () =>
      result
        ? pageInfo({
            page: result.page,
            pageSize: result.pageSize,
            shown: result.documents.length,
            truncated: result.truncated,
            count: result.count,
            numbers: result.numbers
          })
        : null,
    [result]
  )

  // ---- writes ---------------------------------------------------------------------------------

  /** The full document behind a (possibly projected) result; `fresh` re-reads it regardless. */
  const fullDocument = async (
    doc: Record<string, unknown>,
    fresh = false
  ): Promise<Record<string, unknown> | null> => {
    if (!fresh && (!result || !hasText(result.applied.project))) return doc
    const filter = idFilterText(doc)
    if (!filter) {
      toast.error('This document has no _id, so it cannot be re-read in full')
      return null
    }
    try {
      const res = await dataProjectsApi.mongo.find({
        dataProjectId: project.id,
        queryId: newQueryId(),
        database,
        collection,
        filter,
        limit: 1
      })
      if (!res.documents[0]) {
        toast.warning('The document no longer exists')
        return null
      }
      return res.documents[0]
    } catch (e) {
      toast.error(mongoErrorText(project, e, 'Could not load the document'))
      return null
    }
  }

  /** Edit: replaces the loaded version only (`force` = by _id alone, overwriting any change). */
  const replaceDocument = async (
    text: string,
    st: DocumentEditorState,
    force: boolean
  ): Promise<DocumentSaveOutcome> => {
    const original = st.original
    const filter = original
      ? force
        ? idFilterText(original)
        : concurrencyFilterText(original)
      : null
    if (!original || !filter) return 'This document has no _id, so it cannot be replaced'
    const outcome = await runGated(
      project,
      (confirmToken) =>
        dataProjectsApi.mongo.write({
          dataProjectId: project.id,
          database,
          collection,
          op: 'replaceOne',
          filter,
          // Overwrite matches by _id alone and needs no collation.
          ...(force ? {} : { collation: CONCURRENCY_COLLATION }),
          document: text,
          ...(confirmToken ? { confirmToken } : {})
        }),
      'Could not save the document'
    )
    switch (outcome.kind) {
      case 'ok':
        if (outcome.response.matchedCount === 0) {
          if (force)
            return 'Nothing replaced: the document was deleted or its _id changed meanwhile'
          return {
            message: CONFLICT_MESSAGE,
            reload: () => reloadIntoEditor(original),
            overwrite: (latest) => replaceDocument(latest, st, true)
          }
        }
        toast.success('Document saved')
        setEditor(null)
        refresh()
        return null
      case 'declined':
        return 'Not saved: the change was not confirmed'
      case 'blocked':
        return `Blocked by the safe mode: ${outcome.reason}`
      case 'cancelled':
        return 'Cancelled'
      case 'error':
        return outcome.message
    }
  }

  /** Conflict → Reload: the current version replaces the editor's text (and the baseline). */
  const reloadIntoEditor = async (original: Record<string, unknown>): Promise<string | null> => {
    const current = await fullDocument(original, true)
    if (!current) return 'The document no longer exists: it was deleted since you opened it'
    setEditor({
      mode: 'edit',
      title: 'Edit document',
      text: formatShellDocument(current, 'edit'),
      original: current
    })
    toast.info('Loaded the current version of the document')
    return null
  }

  const saveDocument = async (
    text: string,
    st: DocumentEditorState
  ): Promise<DocumentSaveOutcome> => {
    if (st.mode === 'edit') return replaceDocument(text, st, false)
    const many = text.trim().startsWith('[')
    const outcome = await runGated(
      project,
      (confirmToken) =>
        dataProjectsApi.mongo.write({
          dataProjectId: project.id,
          database,
          collection,
          op: many ? 'insertMany' : 'insertOne',
          document: text,
          ...(confirmToken ? { confirmToken } : {})
        }),
      'Could not insert the document'
    )
    switch (outcome.kind) {
      case 'ok': {
        const n = outcome.response.insertedCount ?? 1
        toast.success(many ? `Inserted ${n} documents` : 'Document inserted')
        setEditor(null)
        refresh()
        return null
      }
      case 'declined':
        return 'Not inserted: the change was not confirmed'
      case 'blocked':
        return `Blocked by the safe mode: ${outcome.reason}`
      case 'cancelled':
        return 'Cancelled'
      case 'error':
        return outcome.message
    }
  }

  const deleteDocument = async (doc: Record<string, unknown>): Promise<void> => {
    const filter = idFilterText(doc)
    if (!filter) {
      toast.error('This document has no _id, so it cannot be deleted from here')
      return
    }
    const outcome = await runGated(
      project,
      (confirmToken) =>
        dataProjectsApi.mongo.write({
          dataProjectId: project.id,
          database,
          collection,
          op: 'deleteOne',
          filter,
          ...(confirmToken ? { confirmToken } : {})
        }),
      'Could not delete the document'
    )
    switch (outcome.kind) {
      case 'ok':
        if (outcome.response.deletedCount === 0) toast.warning('The document was already deleted')
        else toast.success('Document deleted')
        refresh()
        break
      case 'blocked':
        toast.error(`Blocked by the safe mode: ${outcome.reason}`)
        break
      case 'error':
        toast.error(outcome.message)
        break
      default:
        break
    }
  }

  const actions: DocumentActions | null = readOnly
    ? null
    : {
        onEdit: async (doc) => {
          const full = await fullDocument(doc)
          if (full)
            setEditor({
              mode: 'edit',
              title: 'Edit document',
              text: formatShellDocument(full, 'edit'),
              original: full
            })
        },
        onClone: async (doc) => {
          const full = await fullDocument(doc)
          if (full)
            setEditor({ mode: 'insert', title: 'Clone document', text: cloneDocumentText(full) })
        },
        onDelete: deleteDocument
      }

  // ---- explain / export -------------------------------------------------------------------------

  const runExplain = async (): Promise<void> => {
    const numbers = parseQueryNumbers(query)
    if (!numbers.ok) {
      setError(numbers.error)
      return
    }
    setExplain({ title: `Explain · ${collection}`, loading: true })
    try {
      const res = await dataProjectsApi.mongo.explain({
        dataProjectId: project.id,
        database,
        collection,
        find: {
          ...(query.filter.trim() ? { filter: query.filter.trim() } : {}),
          ...(query.project.trim() ? { projection: query.project.trim() } : {}),
          ...(query.sort.trim() ? { sort: query.sort.trim() } : {}),
          ...(hasText(query.collation) ? { collation: query.collation.trim() } : {}),
          ...(query.hint.trim() ? { hint: query.hint.trim() } : {}),
          ...(numbers.value.skip ? { skip: numbers.value.skip } : {}),
          limit: numbers.value.limit ?? 0
        }
      })
      setExplain({ title: `Explain · ${collection}`, loading: false, result: res })
    } catch (e) {
      setExplain({
        title: `Explain · ${collection}`,
        loading: false,
        error: mongoErrorText(project, e, 'Explain failed')
      })
    }
  }

  const exportQuery = (format: 'json' | 'csv'): void => {
    // Collation and hint ride along so the export matches what Find shows.
    void exportMongoSource(
      project,
      {
        kind: 'mongo',
        database,
        collection,
        ...(hasText(query.filter) ? { filter: query.filter.trim() } : {}),
        ...(hasText(query.project) ? { projection: query.project.trim() } : {}),
        ...(hasText(query.sort) ? { sort: query.sort.trim() } : {}),
        ...(hasText(query.collation) ? { collation: query.collation.trim() } : {}),
        ...(query.hint.trim() ? { hint: query.hint.trim() } : {})
      },
      format
    )
  }

  const prefix = (call: string): string => `db.getCollection(${JSON.stringify(collection)})${call}`
  const busy = running !== null
  // The last Find's count stands for Update/Delete matching… only when it counted what the write
  // will match: same filter, same collation, and no hint (skip/limit/projection do not change
  // the count, but a hint on a sparse or partial index counts only the documents that index
  // holds, while the write has no hint and matches them all). Otherwise the dialog recounts.
  const knownCount =
    result &&
    result.count !== null &&
    result.applied.filter.trim() === query.filter.trim() &&
    result.applied.collation.trim() === query.collation.trim() &&
    !result.applied.hint.trim()
      ? result.count
      : null

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-project-mongo-documents">
      {/* Query bar: narrow panes (sidebar + explorer + assistant) drop the button labels to
          icons, then wrap the buttons under the filter; Find never leaves the pane. */}
      <div className="@container/mqb space-y-2 border-b border-border p-2">
        <div className="flex flex-wrap items-start gap-1.5">
          <div className="flex min-w-[220px] flex-1 items-start gap-1.5">
            <span className="mt-[5px] w-12 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
              Filter
            </span>
            <MongoCodeEditor
              ref={filterRef}
              value={query.filter}
              onChange={(filter) => setQuery({ filter })}
              onSubmit={() => void run(0)}
              submitOnEnter
              placeholder="{ field: 'value' }"
              completionPrefix={prefix('.find(')}
              completionData={completionData}
              maxHeight={120}
              className="min-w-0 flex-1"
              aria-label="Filter"
              data-testid="data-project-mongo-filter"
            />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Recent filters"
                  disabled={!recentFilters?.length}
                  data-testid="data-project-mongo-filter-history"
                >
                  <History className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-[480px]">
                <DropdownMenuLabel>Recent filters</DropdownMenuLabel>
                {(recentFilters ?? []).map((f, i) => (
                  <DropdownMenuItem
                    key={f}
                    className="font-mono text-[12px]"
                    data-testid={`data-project-mongo-filter-history-${i}`}
                    onSelect={() => {
                      setQuery({ filter: f })
                      void run(0, { query: { ...query, filter: f } })
                    }}
                  >
                    <span className="truncate">{f}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant={tab.optionsOpen ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => updateTab(project.id, tab.id, { optionsOpen: !tab.optionsOpen })}
              title="Project, Sort, Collation, Hint, Skip, Limit, maxTimeMS"
              data-testid="data-project-mongo-options-toggle"
              aria-expanded={tab.optionsOpen}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="hidden @[680px]/mqb:inline">Options</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Reset the query bar"
              onClick={() => {
                setQuery({ ...EMPTY_QUERY })
                void run(0, { query: { ...EMPTY_QUERY } })
              }}
              data-testid="data-project-mongo-reset"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden @[680px]/mqb:inline">Reset</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Explain the query"
              onClick={() => void runExplain()}
              data-testid="data-project-mongo-explain-button"
            >
              <Gauge className="h-3.5 w-3.5" />
              <span className="hidden @[680px]/mqb:inline">Explain</span>
            </Button>
            {busy ? (
              <Button
                variant="outline"
                size="sm"
                onClick={cancel}
                data-testid="data-project-mongo-cancel"
              >
                <Square className="h-3.5 w-3.5" />
                Cancel
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void run(0)}
                data-testid="data-project-mongo-find"
                title="Find (Enter / ⌘↵)"
              >
                <Play className="h-3.5 w-3.5" />
                Find
              </Button>
            )}
          </div>
        </div>
        {tab.optionsOpen && (
          <div
            className="grid grid-cols-1 gap-1.5 @[760px]/mqb:grid-cols-2"
            data-testid="data-project-mongo-options"
          >
            {(
              [
                ['project', 'Project', '{ field: 1 }', '.find({}, '],
                ['sort', 'Sort', '{ field: -1 }', '.find().sort('],
                ['collation', 'Collation', "{ locale: 'en', strength: 2 }", '.find().collation('],
                ['hint', 'Hint', "{ field: 1 } or 'index_name'", '.find().hint(']
              ] as const
            ).map(([key, label, placeholder, call]) => (
              <div key={key} className="flex items-start gap-1.5">
                <span className="mt-[5px] w-12 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  {label}
                </span>
                <MongoCodeEditor
                  value={query[key]}
                  onChange={(v) => setQuery({ [key]: v })}
                  onSubmit={() => void run(0)}
                  submitOnEnter
                  placeholder={placeholder}
                  completionPrefix={prefix(call)}
                  completionData={completionData}
                  maxHeight={96}
                  className="min-w-0 flex-1"
                  aria-label={label}
                  data-testid={`data-project-mongo-option-${key}`}
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-1.5 @[760px]/mqb:col-span-2">
              {(
                [
                  ['skip', 'Skip', '0'],
                  ['limit', 'Limit', 'none'],
                  ['maxTimeMS', 'maxTimeMS', '60000']
                ] as const
              ).map(([key, label, placeholder]) => (
                <label key={key} className="flex items-center gap-1.5">
                  <span className="w-12 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                    {label}
                  </span>
                  <Input
                    value={query[key]}
                    onChange={(e) => setQuery({ [key]: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void run(0)
                    }}
                    inputMode="numeric"
                    placeholder={placeholder}
                    className="h-7 w-28 font-mono text-[12px]"
                    data-testid={`data-project-mongo-option-${key}`}
                  />
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Toolbar: narrow panes drop the action labels to icons so paging stays in view, and the
          paging group wraps to a second row in very narrow panes. */}
      <div className="@container/mdt flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={readOnly}
          title={readOnly ? 'Views are read-only' : 'Insert a document'}
          onClick={() =>
            setEditor({ mode: 'insert', title: 'Insert document', text: NEW_DOCUMENT_TEXT })
          }
          data-testid="data-project-mongo-add"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden @[820px]/mdt:inline">Add</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              title="Export documents"
              data-testid="data-project-mongo-export"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden @[820px]/mdt:inline">Export</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onSelect={() =>
                void saveVisibleDocuments(project, `${collection}-results`, result?.documents ?? [])
              }
              data-testid="data-project-mongo-export-visible"
            >
              Shown documents (JSON)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>All query results</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => exportQuery('json')}
              data-testid="data-project-mongo-export-query-json"
            >
              JSON…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => exportQuery('csv')}
              data-testid="data-project-mongo-export-query-csv"
            >
              CSV…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="sm"
          disabled={readOnly}
          onClick={() =>
            setBulk({
              kind: 'update',
              filter: query.filter,
              collation: query.collation,
              knownCount
            })
          }
          title="Update every document matching the filter"
          data-testid="data-project-mongo-update-matching"
        >
          <WandSparkles className="h-3.5 w-3.5" />
          <span className="hidden @[820px]/mdt:inline">Update matching…</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={readOnly}
          className="hover:text-destructive"
          onClick={() =>
            setBulk({
              kind: 'delete',
              filter: query.filter,
              collation: query.collation,
              knownCount
            })
          }
          title="Delete every document matching the filter"
          data-testid="data-project-mongo-delete-matching"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="hidden @[820px]/mdt:inline">Delete matching…</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Open this query in a shell tab"
          onClick={() =>
            openShell(project.id, { database, text: findShellText(collection, query) })
          }
          data-testid="data-project-mongo-open-shell"
        >
          <SquareTerminal className="h-3.5 w-3.5" />
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {result && !busy && (
            <span
              className="hidden whitespace-nowrap text-[11px] text-muted-foreground @[640px]/mdt:inline"
              data-testid="data-project-mongo-duration"
            >
              {formatDuration(result.durationMs)}
            </span>
          )}
          <DocumentViewToggle
            value={tab.view}
            onChange={(view) => updateTab(project.id, tab.id, { view })}
            testIdPrefix="data-project-mongo"
            labelClassName="hidden @[980px]/mdt:inline"
          />
          <span
            className="min-w-[96px] text-right text-[12px] tabular-nums text-muted-foreground"
            data-testid="data-project-mongo-page-label"
          >
            {info?.label ?? ''}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy || !info?.hasPrev}
            onClick={() => void run((result?.page ?? 1) - 1, { source: 'applied' })}
            title="Previous page"
            data-testid="data-project-mongo-prev"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy || !info?.hasNext}
            onClick={() => void run((result?.page ?? -1) + 1, { source: 'applied' })}
            title="Next page"
            data-testid="data-project-mongo-next"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <select
            value={tab.pageSize}
            onChange={(e) => {
              const pageSize = Number(e.target.value)
              updateTab(project.id, tab.id, { pageSize })
              void run(0, { source: result ? 'applied' : 'bar', pageSize })
            }}
            className="h-7 rounded-[6px] border border-input bg-background px-1.5 text-[12px] dark:bg-input/30"
            title="Documents per page"
            data-testid="data-project-mongo-page-size"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={refresh}
            title="Refresh"
            data-testid="data-project-mongo-refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {busy && (
        <div
          className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-1 text-[12px] text-muted-foreground"
          data-testid="data-project-mongo-running"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Running…
          <button
            type="button"
            className="ml-1 underline-offset-2 hover:underline"
            onClick={cancel}
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <div
          className="whitespace-pre-wrap border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 font-mono text-[12px] text-destructive"
          data-testid="data-project-mongo-error"
        >
          {error}
        </div>
      )}
      {notice && !error && (
        <div
          className="border-b border-border px-3 py-1 text-[12px] text-muted-foreground"
          data-testid="data-project-mongo-notice"
        >
          {notice}
        </div>
      )}
      {readOnly && (
        <div className="border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
          This is a view: documents are computed by its pipeline and cannot be edited.
        </div>
      )}

      {result ? (
        <DocumentResults
          documents={result.documents}
          view={tab.view}
          actions={actions}
          rowNumberOffset={result.page * result.pageSize}
          emptyText={
            hasText(result.applied.filter)
              ? 'No documents match the filter'
              : 'This collection has no documents'
          }
          testIdPrefix="data-project-mongo"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
          {busy ? 'Loading documents…' : 'Press Find to load documents'}
        </div>
      )}

      <DocumentEditorDialog
        state={editor}
        collection={collection}
        completionData={completionData}
        onClose={() => setEditor(null)}
        onSave={saveDocument}
      />
      <BulkDialog
        state={bulk}
        project={project}
        database={database}
        collection={collection}
        completionData={completionData}
        onClose={() => setBulk(null)}
        onDone={refresh}
      />
      <ExplainDialog state={explain} onClose={() => setExplain(null)} />
    </div>
  )
}
