// Cell inspector: the full value of one grid cell, as text, pretty-printed JSON (objects/arrays)
// or a hex dump (binary). When the grid is editable the text can be changed (or set to NULL) and
// applied as a staged edit; nothing is written to the database from here.
//
// JSON is re-spaced token by token, never parsed and re-serialised (row-detail.ts): numbers past
// 2^53, 1.0, escapes and duplicate keys show and stay exactly as stored. Apply stages only a real
// change — the edited JSON compacted when it was shown pretty-printed, and nothing when the draft
// is the value or only its whitespace changed. A JSON column (json / jsonb, not jsonpath or
// json[]) refuses text that is not JSON.

import { useEffect, useMemo, useState } from 'react'
import { Braces, Copy, FileText, Binary } from 'lucide-react'
import { isBinaryCell, type DataCell, type DataColumnMeta } from '@shared/data-projects/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { cellToText, hexDump, isCompleteBinary } from './cell-format'
import { inspectorApplyValue, isJsonColumnType, isJsonText, prettyJsonText } from './row-detail'

type InspectorView = 'text' | 'json' | 'hex'

export interface CellInspectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  column: DataColumnMeta | null
  value: DataCell | undefined
  /** Editable grids: apply the edited value (staged, committed later). */
  onApply?: (value: DataCell) => void
}

export function CellInspector({
  open,
  onOpenChange,
  column,
  value,
  onApply
}: CellInspectorProps): React.JSX.Element {
  const binary = isBinaryCell(value) ? value : null
  const text = value === null || value === undefined ? '' : binary ? '' : String(value)
  const pretty = useMemo(() => (binary ? null : prettyJsonText(text)), [binary, text])
  const defaultView: InspectorView = binary ? 'hex' : pretty !== null ? 'json' : 'text'
  /** What the editor starts from (JSON pretty-printed). */
  const initialDraft = pretty ?? text
  const [view, setView] = useState<InspectorView>(defaultView)
  const [draft, setDraft] = useState(initialDraft)
  const [draftNull, setDraftNull] = useState(value === null)
  const editable = !!onApply && !binary

  useEffect(() => {
    if (!open) return
    setView(defaultView)
    setDraft(initialDraft)
    setDraftNull(value === null)
  }, [open, value]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown =
    value === null || value === undefined
      ? 'NULL'
      : binary
        ? view === 'hex'
          ? hexDump(binary.hex)
          : cellToText(binary)
        : view === 'json' && pretty !== null
          ? pretty
          : text
  const jsonColumn = isJsonColumnType(column?.type)
  const draftInvalidJson =
    editable && jsonColumn && !draftNull && draft.trim() !== '' && !isJsonText(draft)

  const copy = async (): Promise<void> => {
    const ok = await copyTextToClipboard(value === null || value === undefined ? '' : shown)
    if (ok) toast.success('Value copied')
    else toast.error('Could not copy to the clipboard')
  }

  const apply = (): void => {
    if (!onApply) return
    const next = inspectorApplyValue({ value, text, pretty, draft, draftNull })
    if (next !== undefined) onApply(next)
    onOpenChange(false)
  }

  const size = binary
    ? `${binary.len.toLocaleString()} bytes${isCompleteBinary(binary) ? '' : ` (first ${(binary.hex.length / 2).toLocaleString()} shown)`}`
    : value === null || value === undefined
      ? 'NULL'
      : `${text.length.toLocaleString()} characters`

  const viewButton = (
    id: InspectorView,
    label: string,
    Icon: typeof FileText,
    enabled: boolean
  ) => (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => setView(id)}
      data-testid={`data-project-cell-inspector-view-${id}`}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-[5px] px-2 text-[12px] transition-colors disabled:opacity-40',
        view === id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[80vh] max-w-2xl flex-col gap-3"
        data-testid="data-project-cell-inspector"
      >
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {column?.name ?? 'Value'}
            {column?.type && (
              <span className="ml-2 font-mono text-[12px] font-normal text-muted-foreground">
                {column.type}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-[12px]">{size}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1">
          {viewButton('text', 'Text', FileText, !binary)}
          {viewButton('json', 'JSON', Braces, pretty !== null)}
          {viewButton('hex', 'Hex', Binary, !!binary)}
        </div>
        {editable ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <textarea
              value={draftNull ? '' : draft}
              disabled={draftNull}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={draftNull ? 'NULL' : ''}
              spellCheck={false}
              data-testid="data-project-cell-inspector-editor"
              className="min-h-[240px] flex-1 resize-none rounded-md border border-input bg-transparent p-2 font-mono text-[12px] leading-[1.5] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  if (!draftInvalidJson) apply()
                }
              }}
            />
            <div className="flex items-center gap-3 text-[12px]">
              <label className="inline-flex items-center gap-1.5 text-muted-foreground">
                <input
                  type="checkbox"
                  checked={draftNull}
                  onChange={(e) => setDraftNull(e.target.checked)}
                  data-testid="data-project-cell-inspector-null"
                />
                NULL
              </label>
              {draftInvalidJson && <span className="text-amber-500">Not valid JSON</span>}
            </div>
          </div>
        ) : (
          <pre
            className={cn(
              'min-h-[120px] flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-2 font-mono text-[12px] leading-[1.5]',
              (value === null || value === undefined) && 'italic text-muted-foreground'
            )}
            data-testid="data-project-cell-inspector-value"
          >
            {shown}
          </pre>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copy()}
            data-testid="data-project-cell-inspector-copy"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </Button>
          {editable && (
            <Button
              size="sm"
              onClick={apply}
              disabled={draftInvalidJson}
              data-testid="data-project-cell-inspector-apply"
            >
              Apply
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
