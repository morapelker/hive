// Aggregations sub-tab: a pipeline builder in the Compass style.
//
// Stage cards — operator dropdown (stages from @mongodb-js/mongodb-constants, filtered by
// server version / Atlas), a body editor with stage-aware completion, enable/disable, move
// up/down, delete, insert after; next to each card a collapsible preview of the first 10
// documents after that stage. Previews send only the enabled stages up to the card
// (stagePreviewRequest), re-run ~0.7 s after an edit (auto-preview), cancel the previous preview
// of the same card, and never write: the server drops $out/$merge from previews. $out/$merge
// cards are flagged red; Run then goes through the safe-mode gate like any write.
//
// Text mode — the whole pipeline in one editor; disabled stages are kept as `// disabled:`
// comments. Leaving text mode parses the text back into cards (an error keeps you in text
// mode and says where). Run / Explain / Export work in both modes.
//
// Create view — saves the pipeline as a read-only view on this collection (`db.createView`
// through the Shell's gated execute, so the safe mode confirms or blocks it like any DDL), then
// opens the view and refreshes the explorer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Braces,
  Download,
  Eye,
  EyeOff,
  Gauge,
  LayoutList,
  Loader2,
  Play,
  Plus,
  Square,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import type { DataProject, DataQueryResponse } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { ResizeHandle } from '@/components/layout/ResizeHandle'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import {
  newStageId,
  useMongoWorkspaceStore,
  type MongoAggregationState,
  type MongoCollectionTab,
  type MongoStage
} from '@/stores/useMongoWorkspaceStore'
import {
  invalidateCompletionSchema,
  isAtlasProject,
  useMongoCompletionData
} from './completion-data'
import { DocumentResults, DocumentViewToggle } from './DocumentResults'
import { exportMongoSource, saveVisibleDocuments } from './export'
import { MongoCodeEditor } from './MongoCodeEditor'
import { ExplainDialog, type ExplainState } from './MongoDialogs'
import { stageOperatorOptions } from './mongo-completion'
import { formatDuration, isCancelError, mongoErrorText, newQueryId, runGated } from './mongo-ui'
import {
  OUTPUT_STAGES,
  buildPipelineText,
  defaultStageBody,
  outputStageTarget,
  parsePipelineText,
  pipelineEditorText,
  stagePreviewRequest
} from './pipeline'
import { quoteShellString } from './ejson'
import { aggregateShellText, shellFragment, validateCollectionName } from './requests'
import { registerMongoCache } from './tab-caches'
import { refreshMongoCollections } from './useMongoCatalog'

const PREVIEW_DELAY_MS = 700
const PREVIEW_LIMIT = 10
const RUN_LIMITS = [10, 20, 50, 100, 500, 1000] as const

interface PreviewState {
  status: 'loading' | 'ok' | 'error'
  documents: Array<Record<string, unknown>>
  truncated: boolean
  error?: string
  /** The pipeline text the preview ran (re-run only when it changes). */
  signature: string
  durationMs?: number
}

interface RunState {
  status: 'running' | 'ok' | 'error' | 'cancelled'
  documents: Array<Record<string, unknown>>
  truncated: boolean
  durationMs?: number
  error?: string
}

const runCache = new Map<string, RunState>()

/** Tests only. */
export function resetAggregationCache(): void {
  runCache.clear()
}

registerMongoCache(({ tabIds }) => {
  for (const id of tabIds) runCache.delete(id)
})

export function AggregationsView({
  project,
  tab
}: {
  project: DataProject
  tab: MongoCollectionTab
}): React.JSX.Element {
  const { database, collection } = tab
  const agg = tab.aggregation
  const updateAggregation = useMongoWorkspaceStore((s) => s.updateAggregation)
  const updateTab = useMongoWorkspaceStore((s) => s.updateCollectionTab)
  const openShell = useMongoWorkspaceStore((s) => s.openShell)
  const openCollection = useMongoWorkspaceStore((s) => s.openCollection)
  const serverVersion = useDataProjectStore((s) => s.statuses[project.id]?.serverVersion)
  const completionData = useMongoCompletionData(project, database, collection)
  const atlas = isAtlasProject(project)
  const operators = useMemo(
    () => stageOperatorOptions({ serverVersion: serverVersion?.replace(/[^\d.].*$/, ''), atlas }),
    [serverVersion, atlas]
  )

  const update = useCallback(
    (
      u: Partial<MongoAggregationState> | ((prev: MongoAggregationState) => MongoAggregationState)
    ) => updateAggregation(project.id, tab.id, u),
    [updateAggregation, project.id, tab.id]
  )
  const updateStage = (id: string, patch: Partial<MongoStage>): void =>
    update((prev) => ({
      ...prev,
      stages: prev.stages.map((s) => (s.id === id ? { ...s, ...patch } : s))
    }))

  // ---- previews ---------------------------------------------------------------------------------

  const [previews, setPreviews] = useState<Record<string, PreviewState>>({})
  const previewQueries = useRef(new Map<string, string>())

  const runPreview = useCallback(
    async (stages: readonly MongoStage[], index: number): Promise<void> => {
      const stage = stages[index]
      const queryId = newQueryId()
      const request = stagePreviewRequest({
        dataProjectId: project.id,
        database,
        collection,
        queryId,
        stages,
        index,
        limit: PREVIEW_LIMIT
      })
      if (!request) return
      const previous = previewQueries.current.get(stage.id)
      if (previous) void dataProjectsApi.cancel(previous).catch(() => undefined)
      previewQueries.current.set(stage.id, queryId)
      setPreviews((p) => ({
        ...p,
        [stage.id]: {
          status: 'loading',
          documents: p[stage.id]?.documents ?? [],
          truncated: false,
          signature: request.pipeline
        }
      }))
      try {
        const res = await dataProjectsApi.mongo.aggregate(request)
        if (previewQueries.current.get(stage.id) !== queryId) return
        previewQueries.current.delete(stage.id)
        setPreviews((p) => ({
          ...p,
          [stage.id]:
            res.status === 'ok'
              ? {
                  status: 'ok',
                  documents: res.documents,
                  truncated: res.truncated,
                  signature: request.pipeline,
                  durationMs: res.durationMs
                }
              : {
                  status: 'error',
                  documents: [],
                  truncated: false,
                  signature: request.pipeline,
                  error:
                    res.status === 'cancelled'
                      ? 'Preview cancelled'
                      : 'The preview was not allowed to run'
                }
        }))
      } catch (e) {
        if (previewQueries.current.get(stage.id) !== queryId) return
        previewQueries.current.delete(stage.id)
        setPreviews((p) => ({
          ...p,
          [stage.id]: {
            status: 'error',
            documents: [],
            truncated: false,
            signature: request.pipeline,
            error: mongoErrorText(project, e, 'The preview failed')
          }
        }))
      }
    },
    [project, database, collection]
  )

  // Auto-preview: shortly after an edit, re-run the previews whose pipeline changed.
  const previewsRef = useRef(previews)
  previewsRef.current = previews
  useEffect(() => {
    if (agg.textMode || !agg.autoPreview) return
    const timer = setTimeout(() => {
      agg.stages.forEach((stage, index) => {
        if (!stage.enabled || !stage.previewOpen) return
        const request = stagePreviewRequest({
          dataProjectId: project.id,
          database,
          collection,
          queryId: '',
          stages: agg.stages,
          index
        })
        if (request && previewsRef.current[stage.id]?.signature !== request.pipeline)
          void runPreview(agg.stages, index)
      })
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [agg.stages, agg.textMode, agg.autoPreview, project.id, database, collection, runPreview])

  // Cancel in-flight previews when the view goes away.
  useEffect(
    () => () => {
      for (const queryId of previewQueries.current.values())
        void dataProjectsApi.cancel(queryId).catch(() => undefined)
      previewQueries.current.clear()
    },
    []
  )

  // ---- run --------------------------------------------------------------------------------------

  const [run, setRun] = useState<RunState | null>(() => runCache.get(tab.id) ?? null)
  const runQuery = useRef<string | null>(null)
  const [textError, setTextError] = useState<string | null>(null)
  const [explain, setExplain] = useState<ExplainState | null>(null)
  const [resultsFraction, setResultsFraction] = useState(0.45)
  const bodyRef = useRef<HTMLDivElement>(null)

  const pipelineText = agg.textMode ? agg.text : buildPipelineText(agg.stages)
  const outputStages = agg.textMode
    ? /\$(out|merge)\b/.test(agg.text)
    : agg.stages.some((s) => s.enabled && OUTPUT_STAGES.has(s.operator))

  const setRunState = (state: RunState | null): void => {
    setRun(state)
    if (state && state.status !== 'running') runCache.set(tab.id, state)
  }

  const runPipeline = async (): Promise<void> => {
    if (runQuery.current) return
    if (agg.textMode) {
      const parsed = parsePipelineText(agg.text)
      if (!parsed.ok) {
        setTextError(parsed.error)
        return
      }
    }
    const queryId = newQueryId()
    runQuery.current = queryId
    setRunState({ status: 'running', documents: run?.documents ?? [], truncated: false })
    const outcome = await runGated(
      project,
      (confirmToken) =>
        dataProjectsApi.mongo.aggregate({
          dataProjectId: project.id,
          queryId,
          database,
          collection,
          pipeline: pipelineText,
          limit: agg.limit,
          ...(confirmToken ? { confirmToken } : {})
        }),
      'The aggregation failed'
    )
    runQuery.current = null
    switch (outcome.kind) {
      case 'ok':
        setRunState({
          status: 'ok',
          documents: outcome.response.documents,
          truncated: outcome.response.truncated,
          durationMs: outcome.response.durationMs
        })
        break
      case 'cancelled':
        setRunState({ status: 'cancelled', documents: [], truncated: false })
        break
      case 'declined':
        setRunState(run && run.status !== 'running' ? run : null)
        break
      case 'blocked':
        setRunState({
          status: 'error',
          documents: [],
          truncated: false,
          error: `Blocked by the safe mode: ${outcome.reason}`
        })
        break
      case 'error':
        setRunState({
          status: isCancelError(new Error(outcome.message)) ? 'cancelled' : 'error',
          documents: [],
          truncated: false,
          error: outcome.message
        })
        break
    }
  }

  const cancelRun = (): void => {
    if (runQuery.current) void dataProjectsApi.cancel(runQuery.current).catch(() => undefined)
  }

  const runExplain = async (): Promise<void> => {
    setExplain({ title: `Explain pipeline · ${collection}`, loading: true })
    try {
      const res = await dataProjectsApi.mongo.explain({
        dataProjectId: project.id,
        database,
        collection,
        pipeline: pipelineText
      })
      setExplain({ title: `Explain pipeline · ${collection}`, loading: false, result: res })
    } catch (e) {
      setExplain({
        title: `Explain pipeline · ${collection}`,
        loading: false,
        error: mongoErrorText(project, e, 'Explain failed')
      })
    }
  }

  // ---- text mode --------------------------------------------------------------------------------

  const toggleTextMode = (): void => {
    if (!agg.textMode) {
      setTextError(null)
      update({ textMode: true, text: pipelineEditorText(agg.stages) })
      return
    }
    const parsed = parsePipelineText(agg.text)
    if (!parsed.ok) {
      setTextError(`${parsed.error} — fix the text to switch back to stages`)
      return
    }
    setTextError(null)
    update({
      textMode: false,
      stages: parsed.stages.map((s) => ({ ...s, id: newStageId(), previewOpen: true }))
    })
  }

  // ---- stage operations ---------------------------------------------------------------------------

  const addStage = (afterIndex: number): void =>
    update((prev) => {
      const stages = [...prev.stages]
      stages.splice(afterIndex + 1, 0, {
        id: newStageId(),
        operator: '$match',
        body: defaultStageBody('$match'),
        enabled: true,
        previewOpen: true
      })
      return { ...prev, stages }
    })

  const moveStage = (index: number, delta: -1 | 1): void =>
    update((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.stages.length) return prev
      const stages = [...prev.stages]
      ;[stages[index], stages[target]] = [stages[target], stages[index]]
      return { ...prev, stages }
    })

  const removeStage = (id: string): void => {
    update((prev) => ({ ...prev, stages: prev.stages.filter((s) => s.id !== id) }))
    setPreviews((p) => {
      const { [id]: _drop, ...rest } = p
      return rest
    })
  }

  const setOperator = (stage: MongoStage, operator: string): void => {
    const previousDefault = defaultStageBody(
      stage.operator,
      operators.find((o) => o.value === stage.operator)?.snippet
    )
    const untouched =
      !stage.body.trim() ||
      stage.body.trim() === previousDefault.trim() ||
      stage.body.trim() === '{}'
    updateStage(stage.id, {
      operator,
      ...(untouched
        ? { body: defaultStageBody(operator, operators.find((o) => o.value === operator)?.snippet) }
        : {})
    })
  }

  const enabledIndex = (index: number): number =>
    agg.stages.slice(0, index + 1).filter((s) => s.enabled).length

  const running = run?.status === 'running'
  const showResults = run !== null
  const [viewDialog, setViewDialog] = useState(false)

  /** Creates the view; resolves to an error to show in the dialog, or null when created. */
  const createView = async (name: string): Promise<string | null> => {
    if (agg.textMode) {
      const parsed = parsePipelineText(agg.text)
      if (!parsed.ok) return parsed.error
    }
    const text = `db.createView(${quoteShellString(name)}, ${quoteShellString(collection)}, ${shellFragment(pipelineText) || '[]'})`
    const outcome = await runGated(
      project,
      (confirmToken) =>
        dataProjectsApi.execute({
          dataProjectId: project.id,
          queryId: newQueryId(),
          text,
          database,
          limit: null,
          source: 'mongo',
          ...(confirmToken ? { confirmToken } : {})
        }) as Promise<DataQueryResponse>,
      'Could not create the view'
    )
    switch (outcome.kind) {
      case 'ok': {
        const failed = outcome.response.statements.find((st) => st.error)
        if (failed?.error) return failed.error.message
        invalidateCompletionSchema(project.id, database)
        refreshMongoCollections(project.id, database)
        openCollection(project.id, database, name, { collectionType: 'view' })
        toast.success(`Created the view ${name}`)
        return null
      }
      case 'declined':
        return 'Not created: the statement was not confirmed'
      case 'blocked':
        return `Blocked by the safe mode: ${outcome.reason}`
      case 'cancelled':
        return 'Cancelled'
      case 'error':
        return outcome.message
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-project-mongo-aggregations">
      {/* Toolbar: narrow panes (sidebar + explorer + assistant) drop labels to icons first, then
          wrap the run group onto a second row; Run never leaves the pane. */}
      <div className="@container/agg flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        <div className="flex h-7 shrink-0 items-center rounded-[6px] bg-secondary p-0.5">
          {(
            [
              [false, 'Stages', LayoutList],
              [true, 'Text', Braces]
            ] as const
          ).map(([textMode, label, Icon]) => (
            <button
              key={label}
              type="button"
              title={textMode ? 'Edit the pipeline as text' : 'Edit the pipeline as stage cards'}
              onClick={() => agg.textMode !== textMode && toggleTextMode()}
              className={cn(
                'flex h-6 items-center gap-1 rounded-[5px] px-2 text-[12px]',
                agg.textMode === textMode
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              data-testid={`data-project-mongo-agg-mode-${textMode ? 'text' : 'stages'}`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden @[480px]/agg:inline">{label}</span>
            </button>
          ))}
        </div>
        {!agg.textMode && (
          <>
            <Button
              variant="ghost"
              size="sm"
              title="Add a stage at the end"
              onClick={() => addStage(agg.stages.length - 1)}
              data-testid="data-project-mongo-agg-add-stage"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden @[760px]/agg:inline">Add stage</span>
            </Button>
            <label
              className="ml-1 flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground"
              title="Re-run a stage's preview shortly after it changes"
            >
              <Switch
                size="sm"
                checked={agg.autoPreview}
                onCheckedChange={(autoPreview) => update({ autoPreview })}
                data-testid="data-project-mongo-agg-auto-preview"
              />
              <span className="hidden @[760px]/agg:inline">Auto-preview</span>
            </label>
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <select
            value={agg.limit}
            onChange={(e) => update({ limit: Number(e.target.value) })}
            className="h-7 rounded-[6px] border border-input bg-background px-1.5 text-[12px] dark:bg-input/30"
            title="Documents returned by Run"
            data-testid="data-project-mongo-agg-limit"
          >
            {RUN_LIMITS.map((n) => (
              <option key={n} value={n}>
                Limit {n}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            title="Explain the pipeline"
            onClick={() => void runExplain()}
            data-testid="data-project-mongo-agg-explain"
          >
            <Gauge className="h-3.5 w-3.5" />
            <span className="hidden @[860px]/agg:inline">Explain</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                title="Export the results"
                data-testid="data-project-mongo-agg-export"
              >
                <Download className="h-3.5 w-3.5" />
                <span className="hidden @[860px]/agg:inline">Export</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!run?.documents.length}
                onSelect={() =>
                  void saveVisibleDocuments(
                    project,
                    `${collection}-aggregation`,
                    run?.documents ?? []
                  )
                }
                data-testid="data-project-mongo-agg-export-visible"
              >
                Shown results (JSON)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>All pipeline results</DropdownMenuLabel>
              {(['json', 'csv'] as const).map((format) => (
                <DropdownMenuItem
                  key={format}
                  disabled={outputStages}
                  onSelect={() =>
                    void exportMongoSource(
                      project,
                      { kind: 'mongo', database, collection, pipeline: pipelineText },
                      format
                    )
                  }
                  data-testid={`data-project-mongo-agg-export-${format}`}
                >
                  {format.toUpperCase()}…
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Open this pipeline in a shell tab"
            onClick={() =>
              openShell(project.id, {
                database,
                text: aggregateShellText(collection, pipelineText)
              })
            }
            data-testid="data-project-mongo-agg-open-shell"
          >
            <SquareTerminal className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={outputStages}
            title={
              outputStages
                ? 'A view cannot contain $out or $merge'
                : 'Create a read-only view from this pipeline'
            }
            onClick={() => setViewDialog(true)}
            data-testid="data-project-mongo-agg-create-view"
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
          {running ? (
            <Button
              variant="outline"
              size="sm"
              onClick={cancelRun}
              data-testid="data-project-mongo-agg-cancel"
            >
              <Square className="h-3.5 w-3.5" />
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              variant={outputStages ? 'destructive' : 'default'}
              onClick={() => void runPipeline()}
              title={
                outputStages
                  ? 'This pipeline writes ($out/$merge): it will be confirmed'
                  : 'Run the pipeline'
              }
              data-testid="data-project-mongo-agg-run"
            >
              <Play className="h-3.5 w-3.5" />
              {outputStages ? 'Run (writes)' : 'Run'}
            </Button>
          )}
        </div>
      </div>

      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        {/* Pipeline */}
        <div className="min-h-0 flex-1 overflow-auto">
          {agg.textMode ? (
            <div className="flex h-full flex-col gap-2 p-3">
              <MongoCodeEditor
                value={agg.text}
                onChange={(text) => {
                  update({ text })
                  if (textError) setTextError(null)
                }}
                onSubmit={() => void runPipeline()}
                minHeight={200}
                maxHeight={10000}
                completionPrefix={`db.getCollection(${JSON.stringify(collection)}).aggregate(`}
                completionData={completionData}
                invalid={!!textError}
                className="min-h-0 flex-1"
                aria-label="Pipeline"
                data-testid="data-project-mongo-agg-text"
              />
              {textError && (
                <p
                  className="text-[12px] text-destructive"
                  data-testid="data-project-mongo-agg-text-error"
                >
                  {textError}
                </p>
              )}
            </div>
          ) : (
            <div className="@container/stages space-y-2 p-3">
              {agg.stages.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-10 text-[13px] text-muted-foreground">
                  The pipeline is empty: Run returns the collection's documents.
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => addStage(-1)}
                    data-testid="data-project-mongo-agg-first-stage"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add a stage
                  </Button>
                </div>
              )}
              {agg.stages.map((stage, index) => (
                <StageCard
                  key={stage.id}
                  stage={stage}
                  index={index}
                  enabledPosition={enabledIndex(index)}
                  count={agg.stages.length}
                  collection={collection}
                  operators={operators}
                  preview={previews[stage.id]}
                  completionData={completionData}
                  onOperator={(op) => setOperator(stage, op)}
                  onBody={(body) => updateStage(stage.id, { body })}
                  onToggle={(enabled) => updateStage(stage.id, { enabled })}
                  onTogglePreview={() => updateStage(stage.id, { previewOpen: !stage.previewOpen })}
                  onMove={(delta) => moveStage(index, delta)}
                  onRemove={() => removeStage(stage.id)}
                  onAddAfter={() => addStage(index)}
                  onRefreshPreview={() => void runPreview(agg.stages, index)}
                  onRun={() => void runPipeline()}
                />
              ))}
            </div>
          )}
        </div>

        {/* Results */}
        {showResults && (
          <>
            <ResizeHandle
              direction="down"
              onResize={(delta) => {
                const height = bodyRef.current?.clientHeight ?? 600
                setResultsFraction((f) => Math.min(0.85, Math.max(0.15, f + delta / height)))
              }}
            />
            <div
              className="flex min-h-0 flex-col"
              style={{ height: `${resultsFraction * 100}%` }}
              data-testid="data-project-mongo-agg-results"
            >
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-[12px]">
                <span className="font-medium">Results</span>
                {run?.status === 'running' && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Running…
                  </span>
                )}
                {run?.status === 'ok' && (
                  <span
                    className="text-muted-foreground"
                    data-testid="data-project-mongo-agg-summary"
                  >
                    {run.documents.length}
                    {run.truncated ? '+' : ''} document{run.documents.length === 1 ? '' : 's'}
                    {run.truncated ? ` (limit ${agg.limit})` : ''} ·{' '}
                    {formatDuration(run.durationMs)}
                  </span>
                )}
                {run?.status === 'cancelled' && (
                  <span className="text-muted-foreground">Cancelled</span>
                )}
                <div className="ml-auto">
                  <DocumentViewToggle
                    value={tab.aggregationView}
                    onChange={(aggregationView) =>
                      updateTab(project.id, tab.id, { aggregationView })
                    }
                    testIdPrefix="data-project-mongo-agg"
                  />
                </div>
              </div>
              {run?.status === 'error' ? (
                <div
                  className="whitespace-pre-wrap p-3 font-mono text-[12px] text-destructive"
                  data-testid="data-project-mongo-agg-error"
                >
                  {run.error}
                </div>
              ) : (
                <DocumentResults
                  documents={run?.documents ?? []}
                  view={tab.aggregationView}
                  emptyText={
                    run?.status === 'running' ? 'Running…' : 'The pipeline returned no documents'
                  }
                  testIdPrefix="data-project-mongo-agg-result"
                />
              )}
            </div>
          </>
        )}
      </div>
      <ExplainDialog state={explain} onClose={() => setExplain(null)} />
      <CreateViewDialog
        open={viewDialog}
        database={database}
        collection={collection}
        onOpenChange={setViewDialog}
        onCreate={createView}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Create view
// ---------------------------------------------------------------------------------------------

function CreateViewDialog({
  open,
  database,
  collection,
  onOpenChange,
  onCreate
}: {
  open: boolean
  database: string
  collection: string
  onOpenChange: (open: boolean) => void
  /** Resolves to an error message, or null when the view exists (the dialog then closes). */
  onCreate: (name: string) => Promise<string | null>
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(`${collection}_view`)
    setError(null)
    setBusy(false)
  }, [open, collection])

  const submit = async (): Promise<void> => {
    if (busy) return
    const invalid = validateCollectionName(name)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const message = await onCreate(name)
      if (message) setError(message)
      else onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-sm" data-testid="data-project-mongo-agg-view-dialog">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Create view</DialogTitle>
          <DialogDescription className="text-[12px]">
            A read-only view in {database} that runs this pipeline on {collection} whenever it is
            read. Disabled stages are left out.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          aria-label="View name"
          data-testid="data-project-mongo-agg-view-name"
        />
        {error && (
          <p
            className="whitespace-pre-wrap text-[12px] text-destructive"
            data-testid="data-project-mongo-agg-view-error"
          >
            {error}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
            data-testid="data-project-mongo-agg-view-create"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create view
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------
// Stage card
// ---------------------------------------------------------------------------------------------

interface StageCardProps {
  stage: MongoStage
  index: number
  /** 1-based position among enabled stages. */
  enabledPosition: number
  count: number
  collection: string
  operators: ReturnType<typeof stageOperatorOptions>
  preview: PreviewState | undefined
  completionData: ReturnType<typeof useMongoCompletionData>
  onOperator: (operator: string) => void
  onBody: (body: string) => void
  onToggle: (enabled: boolean) => void
  onTogglePreview: () => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
  onAddAfter: () => void
  onRefreshPreview: () => void
  onRun: () => void
}

function StageCard(props: StageCardProps): React.JSX.Element {
  const { stage, index, count, operators, preview } = props
  const output = OUTPUT_STAGES.has(stage.operator)
  const target = output ? outputStageTarget(stage) : null
  const known = operators.some((o) => o.value === stage.operator)
  const description = operators.find((o) => o.value === stage.operator)?.description
  const id = `data-project-mongo-stage-${index}`
  return (
    <div className="group/stage">
      <div
        data-testid={id}
        className={cn(
          // Narrow panes stack the preview under the editor instead of squeezing both.
          'flex min-h-[120px] flex-col gap-0 overflow-hidden rounded-[8px] border bg-card/60 @[640px]/stages:flex-row',
          output && stage.enabled ? 'border-destructive/60' : 'border-border',
          !stage.enabled && 'opacity-60'
        )}
      >
        <div
          className={cn(
            'flex min-w-0 flex-col @[640px]/stages:min-w-[320px]',
            stage.previewOpen ? '@[640px]/stages:w-[46%]' : 'flex-1'
          )}
        >
          <div className="flex h-8 items-center gap-1.5 border-b border-border px-2">
            <span className="w-14 shrink-0 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              Stage {index + 1}
            </span>
            <select
              value={stage.operator}
              onChange={(e) => props.onOperator(e.target.value)}
              title={description}
              className={cn(
                'h-6 min-w-0 max-w-[180px] rounded-[5px] border border-input bg-background px-1 font-mono text-[12px] dark:bg-input/30',
                output && 'text-destructive'
              )}
              data-testid={`${id}-operator`}
            >
              {!known && <option value={stage.operator}>{stage.operator}</option>}
              {operators.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value}
                </option>
              ))}
            </select>
            <Switch
              size="sm"
              checked={stage.enabled}
              onCheckedChange={props.onToggle}
              title={stage.enabled ? 'Disable this stage' : 'Enable this stage'}
              data-testid={`${id}-enabled`}
            />
            <div className="ml-auto flex items-center">
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={index === 0}
                onClick={() => props.onMove(-1)}
                title="Move up"
                data-testid={`${id}-up`}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={index === count - 1}
                onClick={() => props.onMove(1)}
                title="Move down"
                data-testid={`${id}-down`}
              >
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={props.onTogglePreview}
                title={stage.previewOpen ? 'Hide preview' : 'Show preview'}
                data-testid={`${id}-preview-toggle`}
              >
                {stage.previewOpen ? <EyeOff /> : <Eye />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="hover:text-destructive"
                onClick={props.onRemove}
                title="Delete stage"
                data-testid={`${id}-delete`}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          {output && (
            <div className="flex items-center gap-1.5 border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              Writes the results to{' '}
              {target ? <span className="font-mono">{target}</span> : 'a collection'}; Run asks for
              confirmation. Previews skip this stage.
            </div>
          )}
          <div className="flex-1 p-1.5">
            <MongoCodeEditor
              value={stage.body}
              onChange={props.onBody}
              onSubmit={props.onRun}
              minHeight={64}
              maxHeight={360}
              completionPrefix={`db.getCollection(${JSON.stringify(props.collection)}).aggregate([{ ${stage.operator}: `}
              completionData={props.completionData}
              className="h-full"
              aria-label={`Stage ${index + 1} ${stage.operator}`}
              data-testid={`${id}-body`}
            />
          </div>
        </div>
        {stage.previewOpen && (
          <div
            className="flex min-w-0 flex-1 flex-col border-t border-border @[640px]/stages:border-t-0 @[640px]/stages:border-l"
            data-testid={`${id}-preview`}
          >
            <div className="flex h-8 items-center gap-2 border-b border-border px-2 text-[11px] text-muted-foreground">
              {!stage.enabled ? (
                <span>Stage disabled</span>
              ) : !preview ? (
                <span>Preview pending…</span>
              ) : preview.status === 'loading' ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Previewing…
                </span>
              ) : preview.status === 'error' ? (
                <span className="text-destructive">Preview failed</span>
              ) : (
                <span data-testid={`${id}-preview-summary`}>
                  Output after stage {props.enabledPosition}: {preview.documents.length}
                  {preview.truncated ? '+' : ''} document{preview.documents.length === 1 ? '' : 's'}
                  {preview.truncated ? ` (first ${PREVIEW_LIMIT})` : ''}
                  {preview.durationMs !== undefined
                    ? ` · ${formatDuration(preview.durationMs)}`
                    : ''}
                </span>
              )}
              {stage.enabled && (
                <button
                  type="button"
                  className="ml-auto rounded px-1 hover:text-foreground"
                  onClick={props.onRefreshPreview}
                  data-testid={`${id}-preview-refresh`}
                >
                  Refresh
                </button>
              )}
            </div>
            {preview?.status === 'error' ? (
              <div className="whitespace-pre-wrap p-2 font-mono text-[11px] text-destructive">
                {preview.error}
              </div>
            ) : (
              <div className="flex max-h-[360px] min-h-0 flex-1 flex-col overflow-auto">
                {stage.enabled && preview && (
                  <DocumentResults
                    documents={preview.documents}
                    view="list"
                    compact
                    emptyText={preview.status === 'loading' ? '' : 'No documents after this stage'}
                    testIdPrefix={`${id}-preview`}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex h-4 items-center justify-center opacity-0 transition-opacity group-hover/stage:opacity-100">
        <button
          type="button"
          className="flex items-center gap-1 rounded-full border border-border bg-background px-2 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={props.onAddAfter}
          data-testid={`${id}-add-after`}
        >
          <Plus className="h-2.5 w-2.5" /> Add stage
        </button>
      </div>
    </div>
  )
}
