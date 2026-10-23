// The document viewer shared by the Documents tab, the Aggregations tab (results and stage
// previews) and the Shell tab:
// - List: one card per document, a collapsible field tree with mongosh-style values
//   (ObjectId('…'), ISODate('…'), NumberDecimal('…')…) coloured by BSON type; per-document
//   Copy / Edit / Clone / Delete (delete asks inline before calling back).
// - JSON: one read-only, highlighted relaxed-EJSON block per document.
// - Table: the union of top-level fields in the shared ResultGrid; nested values as JSON text, a
//   field a document lacks distinct from null.
// Long lists stay cheap: cards use `content-visibility: auto`, nested levels render on expand.

import { memo, useMemo, useState } from 'react'
import {
  Braces,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  CopyPlus,
  List,
  Loader2,
  Pencil,
  Table2,
  Trash2
} from 'lucide-react'
import type { DataCell } from '@shared/data-projects/types'
import { ResultGrid } from '@/components/data-projects/grid'
import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import type { MongoDocumentsView } from '@/stores/useMongoWorkspaceStore'
import { documentsToTable } from './document-table'
import {
  MONGO_TYPE_CLASS,
  MONGO_TYPE_LABEL,
  formatShellDocument,
  formatShellInline,
  formatShellValue,
  mongoValueType,
  shellKey,
  toRelaxedJsonText
} from './ejson'
import { lexShell } from './shell-lexer'

export interface DocumentActions {
  onEdit?: (doc: Record<string, unknown>) => void
  onClone?: (doc: Record<string, unknown>) => void
  /** Called after the inline "Delete this document?" confirmation. */
  onDelete?: (doc: Record<string, unknown>) => Promise<void> | void
}

const FIELDS_PAGE = 25
const STRING_PREVIEW = 400

// ---------------------------------------------------------------------------------------------
// View toggle
// ---------------------------------------------------------------------------------------------

const VIEW_OPTIONS: Array<{ value: MongoDocumentsView; label: string; icon: typeof List }> = [
  { value: 'list', label: 'List', icon: List },
  { value: 'json', label: 'JSON', icon: Braces },
  { value: 'table', label: 'Table', icon: Table2 }
]

export function DocumentViewToggle({
  value,
  onChange,
  testIdPrefix,
  labelClassName
}: {
  value: MongoDocumentsView
  onChange: (view: MongoDocumentsView) => void
  testIdPrefix: string
  /** Classes for the text labels (e.g. container-query hiding in narrow toolbars). */
  labelClassName?: string
}): React.JSX.Element {
  return (
    <div
      className="flex h-7 items-center rounded-[6px] bg-secondary p-0.5"
      role="radiogroup"
      aria-label="View"
    >
      {VIEW_OPTIONS.map(({ value: v, label, icon: Icon }) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          title={`${label} view`}
          data-testid={`${testIdPrefix}-view-${v}`}
          onClick={() => onChange(v)}
          className={cn(
            'flex h-6 items-center gap-1 rounded-[5px] px-2 text-[12px] transition-colors',
            value === v
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          <span className={labelClassName}>{label}</span>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Highlighted code (JSON view, value outputs)
// ---------------------------------------------------------------------------------------------

const ATOMS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])

/** Read-only syntax colouring of shell/JSON text with the lexer (no editor needed). */
export const HighlightedCode = memo(function HighlightedCode({
  text,
  className,
  'data-testid': testId
}: {
  text: string
  className?: string
  'data-testid'?: string
}): React.JSX.Element {
  const parts = useMemo(() => {
    // Very large blocks: plain text keeps scrolling smooth.
    if (text.length > 200_000) return null
    const tokens = lexShell(text)
    const out: React.ReactNode[] = []
    let pos = 0
    tokens.forEach((t, i) => {
      if (t.start > pos) out.push(text.slice(pos, t.start))
      let cls = ''
      const next = tokens[i + 1]
      if (t.type === 'string')
        cls = next?.text === ':' ? 'text-sky-800 dark:text-sky-300' : MONGO_TYPE_CLASS.string
      else if (t.type === 'number') cls = MONGO_TYPE_CLASS.double
      else if (t.type === 'regex') cls = MONGO_TYPE_CLASS.regex
      else if (t.type === 'comment') cls = 'text-muted-foreground italic'
      else if (t.type === 'ident') {
        if (ATOMS.has(t.text)) cls = MONGO_TYPE_CLASS.boolean
        else if (next?.text === '(') cls = MONGO_TYPE_CLASS.objectId
        else if (next?.text === ':') cls = 'text-sky-800 dark:text-sky-300'
      } else if (t.type === 'punct') cls = 'text-muted-foreground'
      out.push(
        cls ? (
          <span key={t.start} className={cls}>
            {t.text}
          </span>
        ) : (
          t.text
        )
      )
      pos = t.end
    })
    if (pos < text.length) out.push(text.slice(pos))
    return out
  }, [text])
  return (
    <pre
      data-testid={testId}
      className={cn(
        'whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55]',
        className
      )}
    >
      {parts ?? text}
    </pre>
  )
})

// ---------------------------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------------------------

function ScalarValue({ value }: { value: unknown }): React.JSX.Element {
  const type = mongoValueType(value)
  const [full, setFull] = useState(false)
  let text = formatShellValue(value, { mode: 'display' })
  const long = text.length > STRING_PREVIEW
  if (long && !full) text = `${text.slice(0, STRING_PREVIEW)}…`
  return (
    <span className={cn('break-all', MONGO_TYPE_CLASS[type])} title={MONGO_TYPE_LABEL[type]}>
      {text}
      {long && (
        <button
          type="button"
          className="ml-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setFull((f) => !f)}
        >
          {full ? 'less' : 'more'}
        </button>
      )}
    </span>
  )
}

interface FieldRowProps {
  name: string
  value: unknown
  depth: number
  expandAll: boolean | null
  isIndex?: boolean
}

function FieldRow({ name, value, depth, expandAll, isIndex }: FieldRowProps): React.JSX.Element {
  const type = mongoValueType(value)
  const container = type === 'object' || type === 'array'
  const [openLocal, setOpenLocal] = useState(false)
  const open = container && (expandAll ?? openLocal)
  const entries = useMemo((): Array<[string, unknown, boolean]> => {
    if (!open) return []
    if (Array.isArray(value)) return value.map((v, i) => [String(i), v, true])
    return Object.keys(value as Record<string, unknown>).map((k) => [
      k,
      (value as Record<string, unknown>)[k],
      false
    ])
  }, [open, value])
  const [shown, setShown] = useState(FIELDS_PAGE * 4)
  const count = container
    ? Array.isArray(value)
      ? value.length
      : Object.keys(value as Record<string, unknown>).length
    : 0
  return (
    <div>
      <div
        className="flex min-w-0 items-start gap-1 py-[1px] font-mono text-[12px] leading-[1.55]"
        style={{ paddingLeft: depth * 16 }}
      >
        {container ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpenLocal(!open)}
            className="mt-[3px] shrink-0 rounded text-muted-foreground hover:text-foreground"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span
          className={cn(
            'shrink-0',
            isIndex ? 'text-muted-foreground' : 'text-sky-800 dark:text-sky-300'
          )}
        >
          {isIndex ? name : shellKey(name)}
        </span>
        <span className="shrink-0 text-muted-foreground">:</span>
        {container ? (
          <span className="min-w-0 truncate text-muted-foreground">
            {open ? (
              <span>
                {type === 'array'
                  ? `Array (${count})`
                  : `Object (${count} field${count === 1 ? '' : 's'})`}
              </span>
            ) : (
              <button
                type="button"
                className="truncate text-left hover:text-foreground"
                onClick={() => setOpenLocal(true)}
                title={type === 'array' ? `Array (${count})` : `Object (${count} fields)`}
              >
                {formatShellInline(value, 140)}
              </button>
            )}
          </span>
        ) : (
          <ScalarValue value={value} />
        )}
      </div>
      {open && (
        <>
          {entries.slice(0, shown).map(([k, v, idx]) => (
            <FieldRow
              key={k}
              name={k}
              value={v}
              depth={depth + 1}
              expandAll={expandAll}
              isIndex={idx}
            />
          ))}
          {entries.length > shown && (
            <button
              type="button"
              className="py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              style={{ paddingLeft: (depth + 1) * 16 + 16 }}
              onClick={() => setShown((s) => s + FIELDS_PAGE * 4)}
            >
              Show {Math.min(FIELDS_PAGE * 4, entries.length - shown)} more of{' '}
              {entries.length - shown}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function DocumentHeaderActions({
  doc,
  index,
  actions,
  testIdPrefix,
  copyText,
  expandAll,
  onToggleExpand
}: {
  doc: Record<string, unknown>
  index: number
  actions?: DocumentActions | null
  testIdPrefix: string
  copyText: () => string
  expandAll?: boolean | null
  onToggleExpand?: () => void
}): React.JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const id = `${testIdPrefix}-doc-${index}`
  if (confirmDelete) {
    return (
      <div className="flex items-center gap-1.5 rounded-[6px] bg-destructive/10 px-2 py-0.5 text-[12px]">
        <span className="text-destructive">Delete this document?</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2"
          disabled={deleting}
          onClick={() => setConfirmDelete(false)}
          data-testid={`${id}-delete-cancel`}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="h-6 px-2"
          disabled={deleting}
          data-testid={`${id}-delete-confirm`}
          onClick={async () => {
            setDeleting(true)
            try {
              await actions?.onDelete?.(doc)
            } finally {
              setDeleting(false)
              setConfirmDelete(false)
            }
          }}
        >
          {deleting && <Loader2 className="h-3 w-3 animate-spin" />}
          Delete
        </Button>
      </div>
    )
  }
  const btn = 'size-6 text-muted-foreground hover:text-foreground'
  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      {onToggleExpand && (
        <Button
          variant="ghost"
          size="icon-xs"
          className={btn}
          title={expandAll ? 'Collapse all' : 'Expand all'}
          onClick={onToggleExpand}
          data-testid={`${id}-expand-all`}
        >
          {expandAll ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className={btn}
        title="Copy document"
        data-testid={`${id}-copy`}
        onClick={async () => {
          const ok = await copyTextToClipboard(copyText())
          if (ok) toast.success('Document copied')
          else toast.error('Could not copy to the clipboard')
        }}
      >
        <Copy />
      </Button>
      {actions?.onEdit && (
        <Button
          variant="ghost"
          size="icon-xs"
          className={btn}
          title="Edit document"
          data-testid={`${id}-edit`}
          onClick={() => actions.onEdit?.(doc)}
        >
          <Pencil />
        </Button>
      )}
      {actions?.onClone && (
        <Button
          variant="ghost"
          size="icon-xs"
          className={btn}
          title="Clone document"
          data-testid={`${id}-clone`}
          onClick={() => actions.onClone?.(doc)}
        >
          <CopyPlus />
        </Button>
      )}
      {actions?.onDelete && (
        <Button
          variant="ghost"
          size="icon-xs"
          className={cn(btn, 'hover:text-destructive')}
          title="Delete document"
          data-testid={`${id}-delete`}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  )
}

const DocumentCard = memo(function DocumentCard({
  doc,
  index,
  actions,
  compact,
  testIdPrefix
}: {
  doc: Record<string, unknown>
  index: number
  actions?: DocumentActions | null
  compact?: boolean
  testIdPrefix: string
}): React.JSX.Element {
  const [expandAll, setExpandAll] = useState<boolean | null>(null)
  const [shown, setShown] = useState(compact ? 12 : FIELDS_PAGE)
  const keys = Object.keys(doc)
  return (
    <div
      data-testid={`${testIdPrefix}-doc-${index}`}
      className={cn(
        'group relative rounded-[8px] border border-border bg-card/60 [contain-intrinsic-size:auto_160px] [content-visibility:auto]',
        compact ? 'px-2 py-1.5' : 'px-3 py-2'
      )}
    >
      <div className="absolute right-2 top-1.5 z-10">
        <DocumentHeaderActions
          doc={doc}
          index={index}
          actions={actions}
          testIdPrefix={testIdPrefix}
          copyText={() => formatShellDocument(doc, 'edit')}
          expandAll={expandAll}
          onToggleExpand={() => setExpandAll((e) => (e ? null : true))}
        />
      </div>
      {keys.length === 0 && (
        <div className="font-mono text-[12px] text-muted-foreground">{'{}'}</div>
      )}
      {keys.slice(0, shown).map((key) => (
        <FieldRow key={key} name={key} value={doc[key]} depth={0} expandAll={expandAll} />
      ))}
      {keys.length > shown && (
        <button
          type="button"
          className="mt-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setShown(keys.length)}
          data-testid={`${testIdPrefix}-doc-${index}-more`}
        >
          Show {keys.length - shown} more field{keys.length - shown === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
})

const JsonDocument = memo(function JsonDocument({
  doc,
  index,
  actions,
  testIdPrefix
}: {
  doc: Record<string, unknown>
  index: number
  actions?: DocumentActions | null
  testIdPrefix: string
}): React.JSX.Element {
  const text = useMemo(() => toRelaxedJsonText(doc), [doc])
  return (
    <div
      data-testid={`${testIdPrefix}-doc-${index}`}
      className="group relative rounded-[8px] border border-border bg-card/60 px-3 py-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div className="absolute right-2 top-1.5 z-10">
        <DocumentHeaderActions
          doc={doc}
          index={index}
          actions={actions}
          testIdPrefix={testIdPrefix}
          copyText={() => text}
        />
      </div>
      <HighlightedCode text={text} />
    </div>
  )
})

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/** Card identity: position + _id, so expansion state never jumps to another document. */
const docKey = (doc: Record<string, unknown>, index: number): string =>
  `${index}:${'_id' in doc ? JSON.stringify(doc._id) : ''}`

export interface DocumentResultsProps {
  documents: ReadonlyArray<Record<string, unknown>>
  view: MongoDocumentsView
  actions?: DocumentActions | null
  /** Smaller cards for stage previews. */
  compact?: boolean
  /** Row numbers in the Table view start after this (pagination). */
  rowNumberOffset?: number
  emptyText?: string
  testIdPrefix?: string
  className?: string
}

export function DocumentResults({
  documents,
  view,
  actions,
  compact,
  rowNumberOffset,
  emptyText = 'No documents',
  testIdPrefix = 'data-project-mongo-docs',
  className
}: DocumentResultsProps): React.JSX.Element {
  const table = useMemo(
    () => (view === 'table' ? documentsToTable(documents) : null),
    [view, documents]
  )
  if (documents.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-1 items-center justify-center p-6 text-[13px] text-muted-foreground',
          className
        )}
        data-testid={`${testIdPrefix}-empty`}
      >
        {emptyText}
      </div>
    )
  }
  if (view === 'table' && table) {
    return (
      <div
        className={cn('flex min-h-0 flex-1 flex-col', className)}
        data-testid={`${testIdPrefix}-table`}
      >
        <ResultGrid
          columns={table.columns}
          // undefined cells are fields the document does not have (the grid renders them apart
          // from NULL); the cell type of ResultGrid predates that distinction.
          rows={table.rows as DataCell[][]}
          rowNumberOffset={rowNumberOffset}
          emptyMessage={emptyText}
          className="flex-1"
          data-testid={`${testIdPrefix}-grid`}
        />
        {table.hiddenColumns > 0 && (
          <div className="border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
            {table.hiddenColumns} more fields are not shown as columns; use the List or JSON view.
          </div>
        )}
      </div>
    )
  }
  return (
    <div
      className={cn(
        'min-h-0 flex-1 overflow-auto',
        compact ? 'space-y-1.5 p-1.5' : 'space-y-2 p-3',
        className
      )}
      data-testid={`${testIdPrefix}-${view}`}
    >
      {documents.map((doc, i) =>
        view === 'json' ? (
          <JsonDocument
            key={docKey(doc, i)}
            doc={doc}
            index={i}
            actions={actions}
            testIdPrefix={testIdPrefix}
          />
        ) : (
          <DocumentCard
            key={docKey(doc, i)}
            doc={doc}
            index={i}
            actions={actions}
            compact={compact}
            testIdPrefix={testIdPrefix}
          />
        )
      )}
    </div>
  )
}
