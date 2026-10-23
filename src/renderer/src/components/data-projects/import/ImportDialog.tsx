// Import dialog (TablePlus "Import from CSV" / Compass "Import data"): a CSV/TSV file into an
// existing SQL table, or a JSON array / NDJSON / CSV file into a MongoDB collection.
//
// Flow: the native open panel appears at once (the context-menu click is the user gesture; a
// file can also be dropped or its path pasted) → the server reads the head of the file and
// detects encoding, format, delimiter and header (each overridable, the detected value is
// marked) → a preview of the first rows whose header row is the mapping: a table column per
// file column (auto by name, or by position without a header; Skip), or for Mongo CSV a field
// name (dots nest) and a type per column (detected types, or everything as strings) → Import.
//
// Import goes through `runWithConfirmation` like every write: read-only refuses (the button is
// disabled with the reason, and the server blocks anyway), half-safe/safe show the confirm dialog
// ("Import N rows from file.csv into table"). While it runs the dialog shows the server's
// progress events (checking the file, then importing N of M) with Cancel, and cannot be closed.
// A clean import closes the dialog with a toast; anything else (skipped rows, a failure, a
// cancel) stays open on a report with the failing rows, which can be copied.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  ClipboardCopy,
  FileUp,
  Info,
  Loader2,
  Upload,
  XCircle
} from 'lucide-react'
import {
  DATA_IMPORT_ENCODINGS,
  DATA_IMPORT_PREVIEW_ROWS,
  MONGO_IMPORT_TYPES,
  MONGO_IMPORT_TYPE_LABELS,
  type DataImportCsvOptions,
  type DataImportEmptyMode,
  type DataImportEncoding,
  type DataImportFormat,
  type DataImportOnError,
  type DataImportPreviewResponse,
  type DataImportProgressEvent,
  type DataImportQuote,
  type DataImportResponse,
  type DataImportTarget
} from '@shared/data-projects/import-types'
import { DATA_ENGINE_INFO, sqlDialectOf, type DataProject } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { getDesktopBridge } from '@/api/desktop-bridge'
import { fileApi } from '@/api/file-api'
import {
  errorMessage,
  isCredentialsRequiredError,
  SAFE_MODE_INFO
} from '@/components/data-projects/data-project-ui'
import { runWithConfirmation } from '@/components/data-projects/shared/confirm'
import { formatBytes, formatDuration } from '@/components/data-projects/shared/format-utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ShortcutHint } from '@/components/ui/shortcut-hint'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useDataWorkspaceStore } from '@/stores/useDataWorkspaceStore'
import {
  autoMapSql,
  autoMongoFields,
  baseName,
  buildStartRequest,
  cellDisplay,
  defaultEmpty,
  defaultOnError,
  DELIMITER_OPTIONS,
  ENCODING_LABELS,
  familyOfTarget,
  fmt,
  FORMAT_LABELS,
  importAccept,
  importedCountText,
  isRequiredColumn,
  mayHaveImported,
  mongoFieldIssues,
  newImportId,
  ON_ERROR_LABELS,
  progressFraction,
  progressText,
  QUOTE_OPTIONS,
  reportText,
  resultTitle,
  rowErrorLabel,
  sqlMappingIssues,
  targetDisplayName,
  unitOf,
  type FinishedResponse,
  type ImportIssue,
  type MongoFieldDraft
} from './import-model'

export interface ImportDialogProps {
  project: DataProject
  /** The table or collection to import into; null = closed. */
  target: DataImportTarget | null
  onClose: () => void
  /** After an import that wrote rows (refresh counts and open views). */
  onImported?: (response: FinishedResponse) => void
  /** "Open" from the result / success toast. */
  onOpenTarget?: () => void
}

export function ImportDialog(props: ImportDialogProps): React.JSX.Element | null {
  if (!props.target) return null
  return <ImportDialogBody key={JSON.stringify(props.target)} {...props} target={props.target} />
}

type Phase = 'pick' | 'options' | 'running' | 'result'

interface Overrides {
  format?: DataImportFormat
  encoding?: DataImportEncoding
  delimiter?: string
  quote?: DataImportQuote
  header?: boolean
}

const SELECT_CLASS =
  'h-7 min-w-0 rounded-md border border-input bg-background px-1.5 text-[12px] text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50'
const OTHER_DELIMITER = '__other__'

/**
 * AppLayout's window-level drop zone attaches dropped files to the active session. While the
 * import dialog is open, file drags stop here instead (and never navigate the window).
 */
function useBlockGlobalFileDrop(): void {
  useEffect(() => {
    const swallow = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
    }
    const events = ['dragenter', 'dragover', 'dragleave', 'drop'] as const
    for (const name of events) document.addEventListener(name, swallow)
    return () => {
      for (const name of events) document.removeEventListener(name, swallow)
    }
  }, [])
}

function OptionField({
  label,
  children,
  className
}: {
  label: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <label className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  )
}

const detectedSuffix = (detected: boolean): string => (detected ? '  (detected)' : '')

function ImportDialogBody({
  project,
  target,
  onClose,
  onImported,
  onOpenTarget
}: ImportDialogProps & { target: DataImportTarget }): React.JSX.Element {
  const family = familyOfTarget(target)
  const dialect = sqlDialectOf(project.engine)
  const targetName = targetDisplayName(target, dialect)
  const canPick = typeof getDesktopBridge()?.getPathForFile === 'function'
  const readOnly = project.safeMode === 'read-only'

  const [phase, setPhase] = useState<Phase>('pick')
  const [filePath, setFilePath] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [pickError, setPickError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [overrides, setOverrides] = useState<Overrides>({})
  const [otherDelimiter, setOtherDelimiter] = useState(false)
  const [preview, setPreview] = useState<DataImportPreviewResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [sqlTargets, setSqlTargets] = useState<Array<string | null>>([])
  const [mongoFields, setMongoFields] = useState<MongoFieldDraft[]>([])
  const [detectTypes, setDetectTypes] = useState(true)
  const [empty, setEmpty] = useState<DataImportEmptyMode>(defaultEmpty(family))
  const [onError, setOnError] = useState<DataImportOnError | null>(null)
  const [progress, setProgress] = useState<DataImportProgressEvent | null>(null)
  const [awaitingConfirm, setAwaitingConfirm] = useState(false)
  /** Cancel was clicked: a MongoDB batch in flight finishes first, a second click kills it. */
  const [cancelRequested, setCancelRequested] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [result, setResult] = useState<FinishedResponse | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importIdRef = useRef<string | null>(null)
  const mappedKeyRef = useRef('')
  const seqRef = useRef(0)
  const autoOpenedRef = useRef(false)
  const pickedRef = useRef(false)
  const mountedRef = useRef(true)

  useBlockGlobalFileDrop()

  const describeError = useCallback(
    (error: unknown, fallback: string): string => {
      const message = errorMessage(error, fallback)
      if (isCredentialsRequiredError(error)) {
        try {
          useDataProjectStore.getState().openCredentialsPrompt(project.id, message)
        } catch {
          // The prompt is a convenience; the message still explains it.
        }
      }
      return message
    },
    [project.id]
  )

  // Leaving while an import runs (the workspace unmounted) cancels it: nobody would see the end.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const id = importIdRef.current
      if (id) void dataProjectsApi.import.cancel(id).catch(() => undefined)
    }
  }, [])

  // The native open panel at once: the menu click that opened the dialog is the user gesture.
  // Dismissing that first panel without a file closes the dialog (like the menu was never used).
  // A callback ref: the dialog's portal mounts its content one render after this component.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const attachFileInput = useCallback(
    (input: HTMLInputElement | null): void => {
      fileInputRef.current = input
      if (!input || autoOpenedRef.current || !canPick) return
      autoOpenedRef.current = true
      input.addEventListener(
        'cancel',
        () => {
          if (!pickedRef.current) onCloseRef.current()
        },
        { once: true }
      )
      try {
        input.click()
      } catch {
        // No picker: the drop zone and the path field remain.
      }
    },
    [canPick]
  )

  const openFile = (path: string): void => {
    pickedRef.current = true
    setPickError(null)
    setFilePath(path)
    setOverrides({})
    setOtherDelimiter(false)
    setPreview(null)
    setPreviewError(null)
    setRunError(null)
    setResult(null)
    mappedKeyRef.current = ''
    setPhase('options')
  }

  const takeFile = (file: File | undefined): void => {
    if (!file) return
    let path = ''
    try {
      path = fileApi.getPathForFile(file)
    } catch {
      path = ''
    }
    if (!path) {
      setPickError('Could not read where that file is. Paste its path instead.')
      return
    }
    openFile(path)
  }

  const submitPath = (): void => {
    const path = pathInput.trim()
    if (!path) return
    if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
      setPickError('Paste an absolute path, such as /Users/you/Downloads/orders.csv.')
      return
    }
    openFile(path)
  }

  // ---- preview --------------------------------------------------------------------------------

  useEffect(() => {
    if (!filePath) return
    const seq = ++seqRef.current
    setLoading(true)
    setPreviewError(null)
    const csv: Partial<DataImportCsvOptions> = {}
    if (overrides.delimiter !== undefined) csv.delimiter = overrides.delimiter
    if (overrides.quote !== undefined) csv.quote = overrides.quote
    if (overrides.header !== undefined) csv.header = overrides.header
    dataProjectsApi.import
      .preview({
        dataProjectId: project.id,
        filePath,
        target,
        ...(overrides.format ? { format: overrides.format } : {}),
        ...(overrides.encoding ? { encoding: overrides.encoding } : {}),
        ...(Object.keys(csv).length > 0 ? { csv } : {}),
        limit: DATA_IMPORT_PREVIEW_ROWS
      })
      .then((res) => {
        if (seq !== seqRef.current || !mountedRef.current) return
        setPreview(res)
        // Re-map only when the file's columns changed (a new delimiter, header toggle, format).
        const key = JSON.stringify([res.format, res.csv?.header ?? null, res.columns])
        if (key !== mappedKeyRef.current) {
          mappedKeyRef.current = key
          const header = res.csv?.header ?? true
          if (family === 'sql')
            setSqlTargets(autoMapSql(res.columns, res.tableColumns ?? [], header))
          else setMongoFields(autoMongoFields(res.columns, res.inferredTypes, header, detectTypes))
        }
      })
      .catch((error: unknown) => {
        if (seq === seqRef.current && mountedRef.current)
          setPreviewError(describeError(error, 'Could not read the file'))
      })
      .finally(() => {
        if (seq === seqRef.current && mountedRef.current) setLoading(false)
      })
    // detectTypes is applied by its own toggle; it must not re-read the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, overrides, project.id, target, family, describeError])

  const setOverride = (patch: Overrides): void => setOverrides((o) => ({ ...o, ...patch }))

  const toggleDetectTypes = (on: boolean): void => {
    setDetectTypes(on)
    setMongoFields((fields) =>
      fields.map((f, i) => ({
        ...f,
        type: on ? (preview?.inferredTypes?.[i] ?? 'string') : 'string'
      }))
    )
  }

  const isCsv = preview?.format === 'csv'
  const tableColumns = useMemo(() => preview?.tableColumns ?? [], [preview])
  const supportsTx = preview?.supportsTransaction ?? false
  const effectiveOnError: DataImportOnError =
    onError && !(onError === 'rollback' && !supportsTx)
      ? onError
      : preview
        ? defaultOnError(preview)
        : 'stop'
  const effectiveEmpty: DataImportEmptyMode = family === 'sql' && empty === 'omit' ? 'null' : empty

  const issues = useMemo((): ImportIssue[] => {
    const out: ImportIssue[] = []
    if (!preview) return out
    if (preview.format === 'csv') {
      if (family === 'sql' && dialect)
        out.push(...sqlMappingIssues(sqlTargets, tableColumns, dialect))
      if (family === 'document') out.push(...mongoFieldIssues(mongoFields))
    }
    if (preview.rows.length === 0 && !preview.more)
      out.push({ level: 'error', text: 'The file has no data rows.' })
    for (const text of preview.warnings) out.push({ level: 'warning', text })
    return out
  }, [preview, family, dialect, sqlTargets, tableColumns, mongoFields])

  const hasErrors = issues.some((i) => i.level === 'error')
  const duplicateTargets = useMemo(() => {
    const seen = new Set<string>()
    const dupes = new Set<string>()
    for (const t of sqlTargets) {
      if (!t) continue
      if (seen.has(t)) dupes.add(t)
      seen.add(t)
    }
    return dupes
  }, [sqlTargets])
  const canImport =
    phase === 'options' && !!preview && !loading && !previewError && !hasErrors && !readOnly

  // ---- run ------------------------------------------------------------------------------------

  const run = async (): Promise<void> => {
    if (!canImport || !preview || !filePath) return
    const importId = newImportId()
    importIdRef.current = importId
    const request = buildStartRequest(project.id, importId, {
      filePath,
      target,
      format: preview.format,
      encoding: preview.encoding,
      csv: preview.csv,
      sqlTargets,
      mongoFields,
      empty: effectiveEmpty,
      onError: effectiveOnError
    })
    setPhase('running')
    setProgress(null)
    setRunError(null)
    setAwaitingConfirm(false)
    setCancelRequested(false)
    const unsubscribe = dataProjectsApi.import.onProgress((event) => {
      if (event.importId === importId && mountedRef.current) setProgress(event)
    })
    try {
      const response = await runWithConfirmation<DataImportResponse>(async (confirmToken) => {
        if (mountedRef.current) setAwaitingConfirm(false)
        const answer = await dataProjectsApi.import.start(
          confirmToken ? { ...request, confirmToken } : request
        )
        if (answer.status === 'confirmation_required' && mountedRef.current)
          setAwaitingConfirm(true)
        return answer
      })
      importIdRef.current = null
      if (!mountedRef.current) return
      setAwaitingConfirm(false)
      if (response.status === 'declined') {
        setPhase('options')
        return
      }
      if (response.status === 'blocked') {
        setRunError(`Blocked by the safe mode: ${response.reason}`)
        setPhase('options')
        return
      }
      if (response.status === 'confirmation_required') {
        setRunError('The server asked for confirmation again; nothing ran.')
        setPhase('options')
        return
      }
      useDataWorkspaceStore.getState().bumpHistory(project.id)
      if (mayHaveImported(response)) {
        // Open table views of this project show the new rows.
        useDataWorkspaceStore.getState().notifyTableDataChanged(project.id)
        onImported?.(response)
      }
      if (response.status === 'ok' && response.errorCount === 0) {
        const n = response.rowsImported
        toast.success(
          `Imported ${fmt(n)} ${unitOf(family, n)} from ${baseName(filePath)} into ${targetName}`,
          onOpenTarget ? { action: { label: 'Open', onClick: onOpenTarget } } : undefined
        )
        onClose()
        return
      }
      setResult(response)
      setPhase('result')
    } catch (error) {
      importIdRef.current = null
      if (!mountedRef.current) return
      setAwaitingConfirm(false)
      setRunError(describeError(error, 'The import failed'))
      setPhase('options')
    } finally {
      unsubscribe()
    }
  }

  const cancelRun = (): void => {
    const id = importIdRef.current
    if (id) void dataProjectsApi.import.cancel(id).catch(() => undefined)
    setCancelRequested(true)
  }

  const requestClose = (): void => {
    if (phase === 'running') return
    onClose()
  }

  // ---- render pieces --------------------------------------------------------------------------

  const fileInput = (
    <input
      ref={attachFileInput}
      type="file"
      accept={importAccept(family)}
      className="hidden"
      data-testid="data-project-import-file-input"
      onChange={(event) => {
        takeFile(event.target.files?.[0])
        event.target.value = ''
      }}
    />
  )

  const stopDrag = (event: React.DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }
  const dropHandlers = {
    onDragEnter: (event: React.DragEvent) => {
      stopDrag(event)
      setDragOver(true)
    },
    onDragOver: (event: React.DragEvent) => {
      stopDrag(event)
      event.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (event: React.DragEvent) => {
      stopDrag(event)
      setDragOver(false)
    },
    onDrop: (event: React.DragEvent) => {
      stopDrag(event)
      setDragOver(false)
      if (phase === 'pick' || phase === 'options' || phase === 'result')
        takeFile(event.dataTransfer.files[0])
    }
  }

  const pickBody = (
    <div className="flex flex-col gap-3" data-testid="data-project-import-pick">
      {canPick && (
        <div
          className={cn(
            'flex flex-col items-center gap-2 rounded-[8px] border border-dashed border-border px-4 py-8 text-center transition-colors',
            dragOver && 'border-ring bg-accent/40'
          )}
          data-testid="data-project-import-drop"
          {...dropHandlers}
        >
          <Upload className="h-5 w-5 text-muted-foreground" />
          <p className="text-[13px]">
            Drop a {family === 'sql' ? 'CSV or TSV' : 'JSON, NDJSON or CSV'} file here
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            data-testid="data-project-import-choose"
          >
            Choose file…
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={pathInput}
          onChange={(e) => {
            setPathInput(e.target.value)
            setPickError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitPath()
            }
          }}
          placeholder="…or paste the file's absolute path"
          spellCheck={false}
          autoFocus={!canPick}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 font-mono text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          data-testid="data-project-import-path"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!pathInput.trim()}
          onClick={submitPath}
          data-testid="data-project-import-path-open"
        >
          Open
        </Button>
      </div>
      {pickError && (
        <p className="text-[12px] text-destructive" data-testid="data-project-import-pick-error">
          {pickError}
        </p>
      )}
    </div>
  )

  const delimiterValue =
    otherDelimiter ||
    (preview?.csv && !DELIMITER_OPTIONS.some((o) => o.value === preview.csv?.delimiter))
      ? OTHER_DELIMITER
      : (preview?.csv?.delimiter ?? ',')

  const optionsBar = preview && (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5"
      data-testid="data-project-import-options"
    >
      {family === 'document' && (
        <OptionField label="Format">
          <select
            className={SELECT_CLASS}
            value={preview.format}
            disabled={loading}
            onChange={(e) => setOverride({ format: e.target.value as DataImportFormat })}
            data-testid="data-project-import-format"
          >
            {(Object.keys(FORMAT_LABELS) as DataImportFormat[]).map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
                {detectedSuffix(f === preview.detected.format)}
              </option>
            ))}
          </select>
        </OptionField>
      )}
      <OptionField label="Encoding">
        <select
          className={SELECT_CLASS}
          value={preview.encoding}
          disabled={loading}
          onChange={(e) => setOverride({ encoding: e.target.value as DataImportEncoding })}
          data-testid="data-project-import-encoding"
        >
          {DATA_IMPORT_ENCODINGS.map((enc) => (
            <option key={enc} value={enc}>
              {ENCODING_LABELS[enc]}
              {detectedSuffix(enc === preview.detected.encoding)}
            </option>
          ))}
        </select>
      </OptionField>
      {isCsv && preview.csv && (
        <>
          <OptionField label="Delimiter">
            <select
              className={SELECT_CLASS}
              value={delimiterValue}
              disabled={loading}
              onChange={(e) => {
                if (e.target.value === OTHER_DELIMITER) {
                  setOtherDelimiter(true)
                  return
                }
                setOtherDelimiter(false)
                setOverride({ delimiter: e.target.value })
              }}
              data-testid="data-project-import-delimiter"
            >
              {DELIMITER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                  {detectedSuffix(o.value === preview.detected.csv?.delimiter)}
                </option>
              ))}
              <option value={OTHER_DELIMITER}>Other…</option>
            </select>
            {delimiterValue === OTHER_DELIMITER && (
              <input
                value={
                  DELIMITER_OPTIONS.some((o) => o.value === preview.csv?.delimiter)
                    ? ''
                    : (preview.csv?.delimiter ?? '')
                }
                maxLength={1}
                placeholder="?"
                aria-label="Delimiter character"
                onChange={(e) => {
                  const ch = e.target.value
                  if (ch.length === 1) setOverride({ delimiter: ch })
                }}
                className="h-7 w-8 rounded-md border border-input bg-transparent text-center font-mono text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                data-testid="data-project-import-delimiter-other"
              />
            )}
          </OptionField>
          <OptionField label="Quote">
            <select
              className={SELECT_CLASS}
              value={preview.csv.quote}
              disabled={loading}
              onChange={(e) => setOverride({ quote: e.target.value as DataImportQuote })}
              data-testid="data-project-import-quote"
            >
              {QUOTE_OPTIONS.map((o) => (
                <option key={o.label} value={o.value}>
                  {o.label}
                  {detectedSuffix(o.value === preview.detected.csv?.quote)}
                </option>
              ))}
            </select>
          </OptionField>
          <label className="flex items-center gap-1.5 text-[12px]">
            <Checkbox
              checked={preview.csv.header}
              disabled={loading}
              onCheckedChange={(checked) => setOverride({ header: checked })}
              data-testid="data-project-import-header"
            />
            First row is the header
            {preview.detected.csv && preview.csv.header === preview.detected.csv.header && (
              <span className="text-[11px] text-muted-foreground">(detected)</span>
            )}
          </label>
          <OptionField label="Empty values">
            <select
              className={SELECT_CLASS}
              value={effectiveEmpty}
              onChange={(e) => setEmpty(e.target.value as DataImportEmptyMode)}
              title='An empty unquoted value. A quoted "" is always an empty string.'
              data-testid="data-project-import-empty"
            >
              {family === 'document' && <option value="omit">Leave the field out</option>}
              <option value="null">{family === 'sql' ? 'NULL' : 'null'}</option>
              <option value="empty">Empty string ""</option>
            </select>
          </OptionField>
          {family === 'document' && (
            <label className="flex items-center gap-1.5 text-[12px]">
              <Checkbox
                checked={detectTypes}
                onCheckedChange={toggleDetectTypes}
                data-testid="data-project-import-detect-types"
              />
              Detect types
              <span className="text-[11px] text-muted-foreground">
                (off: everything as strings)
              </span>
            </label>
          )}
        </>
      )}
      <OptionField label="On error">
        <select
          className={SELECT_CLASS}
          value={effectiveOnError}
          onChange={(e) => setOnError(e.target.value as DataImportOnError)}
          data-testid="data-project-import-on-error"
        >
          {(Object.keys(ON_ERROR_LABELS) as DataImportOnError[]).map((mode) => (
            <option
              key={mode}
              value={mode}
              disabled={mode === 'rollback' && !supportsTx}
              title={mode === 'rollback' && !supportsTx ? preview.transactionNote : undefined}
            >
              {ON_ERROR_LABELS[mode]}
              {mode === 'rollback' && !supportsTx ? ' (not available)' : ''}
            </option>
          ))}
        </select>
      </OptionField>
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
    </div>
  )

  const mappingHeader = (index: number): React.ReactNode => {
    if (!preview || !isCsv) return null
    if (family === 'sql') {
      const value = sqlTargets[index] ?? ''
      return (
        <select
          className={cn(
            SELECT_CLASS,
            'mt-1 w-full font-normal',
            value && duplicateTargets.has(value) && 'border-destructive text-destructive',
            !value && 'text-muted-foreground'
          )}
          value={value}
          disabled={phase !== 'options'}
          onChange={(e) =>
            setSqlTargets((targets) => {
              const next = [...targets]
              next[index] = e.target.value || null
              return next
            })
          }
          aria-label={`Table column for ${preview.columns[index]}`}
          data-testid={`data-project-import-map-${index}`}
        >
          <option value="">Skip</option>
          {tableColumns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} · {c.type}
              {dialect && isRequiredColumn(c, dialect) ? ' *' : ''}
            </option>
          ))}
        </select>
      )
    }
    const field = mongoFields[index]
    if (!field) return null
    const inferred = preview.inferredTypes?.[index]
    const update = (patch: Partial<MongoFieldDraft>): void =>
      setMongoFields((fields) => fields.map((f, i) => (i === index ? { ...f, ...patch } : f)))
    return (
      <div className="mt-1 flex flex-col gap-1 font-normal">
        <div className="flex items-center gap-1">
          <Checkbox
            checked={field.include}
            disabled={phase !== 'options'}
            onCheckedChange={(checked) => update({ include: checked })}
            aria-label={`Import ${preview.columns[index]}`}
            data-testid={`data-project-import-field-include-${index}`}
          />
          <input
            value={field.name}
            disabled={phase !== 'options' || !field.include}
            onChange={(e) => update({ name: e.target.value })}
            spellCheck={false}
            aria-label={`Field name for ${preview.columns[index]}`}
            className="h-6 min-w-0 flex-1 rounded-[5px] border border-input bg-transparent px-1.5 font-mono text-[11.5px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            data-testid={`data-project-import-field-name-${index}`}
          />
        </div>
        <select
          className={cn(SELECT_CLASS, 'h-6 w-full text-[11.5px]')}
          value={field.type}
          disabled={phase !== 'options' || !field.include}
          onChange={(e) => update({ type: e.target.value as MongoFieldDraft['type'] })}
          aria-label={`Type for ${preview.columns[index]}`}
          data-testid={`data-project-import-field-type-${index}`}
        >
          {MONGO_IMPORT_TYPES.map((t) => (
            <option key={t} value={t}>
              {MONGO_IMPORT_TYPE_LABELS[t]}
              {detectTypes && t === inferred ? '  (detected)' : ''}
            </option>
          ))}
        </select>
      </div>
    )
  }

  const columnSkipped = (index: number): boolean =>
    !!isCsv && (family === 'sql' ? !sqlTargets[index] : !(mongoFields[index]?.include ?? true))

  const previewTable = preview && (
    <div
      className="min-h-[160px] flex-1 overflow-auto rounded-[8px] border border-border"
      data-testid="data-project-import-preview"
    >
      {preview.columns.length === 0 ? (
        <div className="p-4 text-center text-[12px] text-muted-foreground">
          No columns found in the first rows.
        </div>
      ) : (
        <table className="w-max min-w-full border-separate border-spacing-0 text-[12px]">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 border-b border-r border-border bg-muted px-2 py-1 text-right align-top text-[10px] font-normal text-muted-foreground">
                #
              </th>
              {preview.columns.map((column, i) => (
                <th
                  key={i}
                  className={cn(
                    'min-w-[150px] max-w-[260px] border-b border-r border-border bg-muted px-2 py-1 text-left align-top font-semibold',
                    columnSkipped(i) && 'text-muted-foreground'
                  )}
                  data-testid={`data-project-import-column-${i}`}
                >
                  <div className="truncate" title={column}>
                    {column}
                  </div>
                  {mappingHeader(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, r) => (
              <tr key={r} className="hover:bg-accent/30">
                <td
                  className="sticky left-0 border-b border-r border-border bg-background px-2 py-0.5 text-right tabular-nums text-[10.5px] text-muted-foreground"
                  title={preview.lines[r] ? `Line ${fmt(preview.lines[r])}` : undefined}
                >
                  {r + 1}
                </td>
                {preview.columns.map((_, i) => {
                  const raw = row[i] ?? null
                  const display = cellDisplay(raw, {
                    family,
                    format: preview.format,
                    empty: effectiveEmpty
                  })
                  return (
                    <td
                      key={i}
                      className={cn(
                        'max-w-[260px] truncate border-b border-r border-border px-2 py-0.5 font-mono text-[11.5px]',
                        display.kind !== 'value' && 'italic text-muted-foreground',
                        columnSkipped(i) && 'opacity-35'
                      )}
                      title={raw ?? undefined}
                    >
                      {display.text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )

  const issueList = (issues.length > 0 || runError || readOnly) && (
    <ul
      className="flex max-h-28 shrink-0 flex-col gap-1 overflow-y-auto"
      data-testid="data-project-import-issues"
    >
      {readOnly && (
        <li className="flex items-start gap-1.5 text-[12px] text-destructive">
          <Ban className="mt-[2px] h-3.5 w-3.5 shrink-0" />
          Read-only mode: this data project refuses imports. Change the safe mode in the toolbar to
          import.
        </li>
      )}
      {runError && (
        <li
          className="flex items-start gap-1.5 text-[12px] text-destructive"
          data-testid="data-project-import-run-error"
        >
          <XCircle className="mt-[2px] h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{runError}</span>
        </li>
      )}
      {issues.map((issue, i) => (
        <li
          key={i}
          className={cn(
            'flex items-start gap-1.5 text-[12px]',
            issue.level === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'
          )}
        >
          <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" />
          <span>{issue.text}</span>
        </li>
      ))}
    </ul>
  )

  const fraction = progressFraction(progress)
  const progressPanel = (
    <div className="flex min-w-0 flex-1 flex-col gap-1" data-testid="data-project-import-progress">
      <div className="flex items-center gap-2 text-[12px]">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        <span className="truncate">
          {awaitingConfirm
            ? 'Waiting for your confirmation…'
            : cancelRequested
              ? family === 'document'
                ? 'Stopping after the batch in flight… (Stop now interrupts it)'
                : 'Stopping…'
              : progressText(progress, family)}
        </span>
        {fraction !== null && !awaitingConfirm && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            {Math.floor(fraction * 100)}%
          </span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-200',
            progress?.phase === 'scanning' ? 'bg-muted-foreground/50' : 'bg-primary'
          )}
          style={{ width: `${Math.round((awaitingConfirm ? 0 : (fraction ?? 0)) * 100)}%` }}
        />
      </div>
    </div>
  )

  const resultPanel =
    result &&
    (() => {
      const { tone, title } = resultTitle(result, family, targetName)
      const Icon = tone === 'ok' ? CheckCircle2 : tone === 'warning' ? AlertTriangle : XCircle
      return (
        <div
          className="flex min-h-0 flex-1 flex-col gap-2"
          data-testid="data-project-import-result"
        >
          <div
            className={cn(
              'flex items-start gap-2 rounded-[8px] px-3 py-2 text-[13px]',
              tone === 'ok' && 'bg-green-500/10 text-green-700 dark:text-green-400',
              tone === 'warning' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
              tone === 'error' && 'bg-destructive/10 text-destructive'
            )}
            data-testid="data-project-import-result-title"
          >
            <Icon className="mt-[2px] h-4 w-4 shrink-0" />
            <span className="whitespace-pre-wrap">{title}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            <span>Read {fmt(result.rowsRead)}</span>
            <span>Imported {importedCountText(result)}</span>
            {result.rowsSkipped > 0 && <span>Skipped {fmt(result.rowsSkipped)}</span>}
            {result.errorCount > 0 && <span>Errors {fmt(result.errorCount)}</span>}
            {result.rolledBack && <span>Rolled back</span>}
            <span>{formatDuration(result.durationMs)}</span>
          </div>
          {result.errors.length > 0 && (
            <div
              className="min-h-0 flex-1 overflow-auto rounded-[8px] border border-border"
              data-testid="data-project-import-errors"
            >
              <table className="w-full border-separate border-spacing-0 text-[12px]">
                <thead className="sticky top-0">
                  <tr>
                    <th className="w-36 border-b border-border bg-muted px-2 py-1 text-left font-semibold">
                      {family === 'sql' ? 'Row' : 'Document'}
                    </th>
                    <th className="border-b border-border bg-muted px-2 py-1 text-left font-semibold">
                      Reason
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map((e, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap border-b border-border px-2 py-1 align-top tabular-nums">
                        {rowErrorLabel(e)}
                      </td>
                      <td className="border-b border-border px-2 py-1 align-top font-mono text-[11.5px]">
                        {e.message}
                      </td>
                    </tr>
                  ))}
                  {result.errorCount > result.errors.length && (
                    <tr>
                      <td colSpan={2} className="px-2 py-1 text-muted-foreground">
                        … and {fmt(result.errorCount - result.errors.length)} more
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )
    })()

  const fileName = filePath ? baseName(filePath) : ''
  const previewErrorBanner = previewError && (
    <div
      className="flex shrink-0 items-start gap-1.5 rounded-[8px] bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
      data-testid="data-project-import-preview-error"
    >
      <XCircle className="mt-[2px] h-3.5 w-3.5 shrink-0" />
      <span className="whitespace-pre-wrap">{previewError}</span>
    </div>
  )
  const summary = preview
    ? `${fmt(preview.rows.length)}${preview.more ? '+' : ''} ${unitOf(family, preview.rows.length)} previewed · ${preview.columns.length} column${preview.columns.length === 1 ? '' : 's'}`
    : ''

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        className="flex max-h-[88vh] flex-col gap-3 sm:max-w-5xl"
        onEscapeKeyDown={(e) => {
          if (phase === 'running') e.preventDefault()
        }}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canImport) {
            e.preventDefault()
            void run()
          }
        }}
        data-testid="data-project-import-dialog"
        {...(phase !== 'pick' ? dropHandlers : {})}
      >
        {fileInput}
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <FileUp className="h-4 w-4 text-muted-foreground" />
            Import into {targetName}
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            {family === 'sql'
              ? 'A CSV or TSV file into the table’s columns.'
              : 'A JSON array, NDJSON or CSV file as documents.'}{' '}
            {DATA_ENGINE_INFO[project.engine].label} · {SAFE_MODE_INFO[project.safeMode].label}
            {project.safeMode === 'half-safe' || project.safeMode === 'safe'
              ? ': you confirm before anything is written.'
              : ''}
          </DialogDescription>
        </DialogHeader>

        {phase === 'pick' && pickBody}

        {phase !== 'pick' && filePath && (
          <div
            className="flex min-w-0 items-center gap-2 text-[12px]"
            data-testid="data-project-import-file"
          >
            <span className="min-w-0 truncate font-medium" title={filePath}>
              {fileName}
            </span>
            {preview && (
              <span className="shrink-0 text-muted-foreground">
                {formatBytes(preview.fileSize)}
              </span>
            )}
            {phase === 'options' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[12px]"
                onClick={() => {
                  if (canPick) fileInputRef.current?.click()
                  else {
                    setPathInput(filePath)
                    setPhase('pick')
                  }
                }}
                data-testid="data-project-import-change-file"
              >
                Change…
              </Button>
            )}
            {preview?.transactionNote && phase !== 'result' && (
              <span className="ml-auto flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                <Info className="h-3 w-3 shrink-0" />
                <span className="truncate" title={preview.transactionNote}>
                  {preview.transactionNote}
                </span>
              </span>
            )}
          </div>
        )}

        {(phase === 'options' || phase === 'running') && (
          <>
            {!preview ? (
              previewError ? (
                previewErrorBanner
              ) : (
                <div className="flex items-center gap-2 py-8 text-[12px] text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Reading {fileName}…
                </div>
              )
            ) : (
              <div
                className={cn(
                  'flex min-h-0 flex-1 flex-col gap-2',
                  phase === 'running' && 'pointer-events-none opacity-60'
                )}
              >
                {optionsBar}
                {previewError && previewErrorBanner}
                {issueList}
                {previewTable}
              </div>
            )}
          </>
        )}

        {phase === 'result' && resultPanel}

        <DialogFooter className="items-center gap-2 sm:space-x-0">
          {phase === 'running' ? (
            <>
              {progressPanel}
              <Button
                variant="outline"
                onClick={cancelRun}
                disabled={awaitingConfirm}
                data-testid="data-project-import-cancel-run"
              >
                {cancelRequested && family === 'document' ? 'Stop now' : 'Cancel import'}
              </Button>
            </>
          ) : phase === 'result' && result ? (
            <>
              <Button
                variant="ghost"
                className="mr-auto"
                onClick={() =>
                  void copyTextToClipboard(reportText(result, family, fileName, targetName)).then(
                    (ok) =>
                      ok ? toast.success('Report copied') : toast.error('Could not copy the report')
                  )
                }
                data-testid="data-project-import-copy-report"
              >
                <ClipboardCopy className="h-4 w-4" /> Copy report
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setResult(null)
                  setPhase('options')
                }}
                data-testid="data-project-import-back"
              >
                <ArrowLeft className="h-4 w-4" /> Back to options
              </Button>
              {onOpenTarget && mayHaveImported(result) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    onOpenTarget()
                    onClose()
                  }}
                  data-testid="data-project-import-open-target"
                >
                  Open {family === 'sql' ? 'table' : 'collection'}
                </Button>
              )}
              <Button onClick={onClose} data-testid="data-project-import-close">
                Close
              </Button>
            </>
          ) : (
            <>
              {phase === 'options' && preview && (
                <span className="mr-auto truncate text-[11px] text-muted-foreground">
                  {summary}
                </span>
              )}
              <Button variant="ghost" onClick={onClose} data-testid="data-project-import-cancel">
                Cancel
              </Button>
              {phase === 'options' && (
                <Button
                  onClick={() => void run()}
                  disabled={!canImport}
                  title={readOnly ? 'Read-only mode refuses imports' : undefined}
                  data-testid="data-project-import-submit"
                >
                  Import
                  <ShortcutHint label="⌘↵" />
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
