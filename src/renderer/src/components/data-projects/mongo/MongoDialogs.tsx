// Dialogs of the Mongo workspace that are not tied to one tab: the document editor (Add / Edit /
// Clone), the explain result, and the type-the-name confirmation used before dropping a
// collection, a view or a database. Writes are sent by the caller (which goes through the safe
// mode gate); the dialogs stay open on failure and show the server's message. An edit that hits
// a document changed since it was loaded keeps the user's text and offers Reload / Overwrite.

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import type { MongoExplainResponse } from '@shared/data-projects/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { HighlightedCode } from './DocumentResults'
import { toRelaxedJsonText } from './ejson'
import type { MongoCompletionData } from './mongo-completion'
import {
  MongoCodeEditor,
  escapeClosesCompletionFirst,
  type MongoCodeEditorHandle
} from './MongoCodeEditor'
import { formatCount } from './mongo-ui'

// ---------------------------------------------------------------------------------------------
// Document editor
// ---------------------------------------------------------------------------------------------

export type DocumentEditorMode = 'insert' | 'edit'

export interface DocumentEditorState {
  mode: DocumentEditorMode
  title: string
  text: string
  /** Edit: the document as loaded (the replaceOne matches only this version). */
  original?: Record<string, unknown>
}

/** Edit: the document changed since it was loaded, so nothing was saved. */
export interface DocumentSaveConflict {
  message: string
  /** Loads the current version into the editor; resolves to an error message or null. */
  reload: () => Promise<string | null>
  /** Saves `text` over whatever the document is now. */
  overwrite: (text: string) => Promise<DocumentSaveOutcome>
}

/** null = saved (the caller closes the dialog); a string = an error to show. */
export type DocumentSaveOutcome = string | DocumentSaveConflict | null

export function DocumentEditorDialog({
  state,
  collection,
  completionData,
  onClose,
  onSave
}: {
  state: DocumentEditorState | null
  collection: string
  completionData?: () => MongoCompletionData
  onClose: () => void
  /** Resolves to an error message or a conflict to show, or null when saved (it then closes). */
  onSave: (text: string, state: DocumentEditorState) => Promise<DocumentSaveOutcome>
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<DocumentSaveConflict | null>(null)
  const [busy, setBusy] = useState(false)
  const editorRef = useRef<MongoCodeEditorHandle>(null)

  useEffect(() => {
    if (state) {
      setText(state.text)
      setError(null)
      setConflict(null)
      setBusy(false)
    }
  }, [state])

  const settle = async (pending: Promise<DocumentSaveOutcome>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await pending
      if (typeof outcome === 'string') setError(outcome)
      else if (outcome) setConflict(outcome)
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!state || busy) return
    if (!text.trim()) {
      setError('The document is empty')
      return
    }
    setConflict(null)
    await settle(onSave(text, state))
  }

  const reload = async (): Promise<void> => {
    if (!conflict || busy) return
    // Success replaces `state`, which resets the editor (and clears the conflict).
    await settle(conflict.reload())
  }

  const overwrite = async (): Promise<void> => {
    if (!conflict || busy) return
    const pending = conflict.overwrite(text)
    setConflict(null)
    await settle(pending)
  }

  const prefix =
    state?.mode === 'edit'
      ? `db.getCollection(${JSON.stringify(collection)}).replaceOne({}, `
      : `db.getCollection(${JSON.stringify(collection)}).insertOne(`

  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] max-w-3xl flex-col gap-3"
        data-testid="data-project-mongo-doc-dialog"
        onEscapeKeyDown={escapeClosesCompletionFirst}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          editorRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-[15px]">{state?.title}</DialogTitle>
          <DialogDescription className="text-[12px]">
            Shell syntax: ObjectId('…'), ISODate('…'), NumberLong('…'), NumberDecimal('…'),
            UUID('…'), /regex/.{' '}
            {state?.mode === 'insert'
              ? 'An array inserts several documents.'
              : 'The document is replaced as a whole, unless it changed since it was loaded.'}
          </DialogDescription>
        </DialogHeader>
        <MongoCodeEditor
          ref={editorRef}
          value={text}
          onChange={(v) => {
            setText(v)
            if (error) setError(null)
          }}
          onSubmit={() => void save()}
          minHeight={260}
          maxHeight={520}
          completionPrefix={prefix}
          completionData={completionData}
          invalid={!!error}
          aria-label="Document"
          data-testid="data-project-mongo-doc-dialog-editor"
        />
        {error && (
          <p
            className="whitespace-pre-wrap text-[12px] text-destructive"
            data-testid="data-project-mongo-doc-dialog-error"
          >
            {error}
          </p>
        )}
        {conflict && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-[6px] border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-800 dark:text-amber-200"
            data-testid="data-project-mongo-doc-dialog-conflict"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{conflict.message}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void reload()}
              data-testid="data-project-mongo-doc-dialog-reload"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void overwrite()}
              title="Replace the document as it is now with your text"
              data-testid="data-project-mongo-doc-dialog-overwrite"
            >
              Overwrite
            </Button>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={busy}
            data-testid="data-project-mongo-doc-dialog-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy}
            data-testid="data-project-mongo-doc-dialog-save"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {state?.mode === 'edit' ? 'Replace document' : 'Insert'}
            <span className="ml-1 text-[11px] opacity-60">⌘↵</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------------------------

export interface ExplainState {
  title: string
  loading: boolean
  error?: string
  result?: MongoExplainResponse
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-[8px] border border-border bg-card/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.05em] text-muted-foreground">{label}</div>
      <div className="font-mono text-[14px] text-foreground">{value}</div>
    </div>
  )
}

export function ExplainDialog({
  state,
  onClose
}: {
  state: ExplainState | null
  onClose: () => void
}): React.JSX.Element {
  const summary = state?.result?.summary
  const collscan = summary?.stages.includes('COLLSCAN')
  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] max-w-3xl flex-col gap-3"
        data-testid="data-project-mongo-explain"
      >
        <DialogHeader>
          <DialogTitle className="text-[15px]">{state?.title ?? 'Explain'}</DialogTitle>
          <DialogDescription className="text-[12px]">
            Winning plan from explain("executionStats"); nothing was modified.
          </DialogDescription>
        </DialogHeader>
        {state?.loading && (
          <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Running explain…
          </div>
        )}
        {state?.error && (
          <p
            className="whitespace-pre-wrap text-[12px] text-destructive"
            data-testid="data-project-mongo-explain-error"
          >
            {state.error}
          </p>
        )}
        {summary && (
          <div className="flex min-h-0 flex-col gap-3">
            <div
              className="flex flex-wrap items-center gap-1 font-mono text-[12px]"
              data-testid="data-project-mongo-explain-stages"
            >
              {summary.stages.length === 0 && (
                <span className="text-muted-foreground">No plan stages reported</span>
              )}
              {summary.stages.map((stage, i) => (
                <span key={`${stage}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground">→</span>}
                  <span
                    className={
                      stage === 'COLLSCAN'
                        ? 'rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300'
                        : 'rounded bg-secondary px-1.5 py-0.5'
                    }
                  >
                    {stage}
                  </span>
                </span>
              ))}
            </div>
            {collscan && (
              <div className="flex items-center gap-2 text-[12px] text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                Collection scan: no index supports this query.
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="Returned" value={formatCount(summary.nReturned)} />
              <Stat label="Docs examined" value={formatCount(summary.docsExamined)} />
              <Stat label="Keys examined" value={formatCount(summary.keysExamined)} />
              <Stat
                label="Time"
                value={
                  summary.executionTimeMs === null || summary.executionTimeMs === undefined
                    ? '—'
                    : `${summary.executionTimeMs} ms`
                }
              />
              <Stat label="Index" value={summary.indexName ?? '—'} />
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-[8px] border border-border bg-card/40 p-3">
              <HighlightedCode
                text={toRelaxedJsonText(state?.result?.raw ?? {})}
                data-testid="data-project-mongo-explain-raw"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} data-testid="data-project-mongo-explain-close">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------------------------
// Type the name to confirm
// ---------------------------------------------------------------------------------------------

export interface ConfirmNameState {
  title: string
  description: string
  /** The text the user must type. */
  name: string
  confirmLabel: string
  run: () => Promise<string | null>
}

export function ConfirmNameDialog({
  state,
  onClose
}: {
  state: ConfirmNameState | null
  onClose: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setTyped('')
    setError(null)
    setBusy(false)
  }, [state])
  const matches = !!state && typed === state.name
  const confirm = async (): Promise<void> => {
    if (!state || !matches || busy) return
    setBusy(true)
    setError(null)
    const message = await state.run()
    setBusy(false)
    if (message) setError(message)
    else onClose()
  }
  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-md" data-testid="data-project-mongo-confirm-name">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{state?.title}</DialogTitle>
          <DialogDescription className="text-[12px]">{state?.description}</DialogDescription>
        </DialogHeader>
        <label className="space-y-1.5 text-[12px]">
          <span className="text-muted-foreground">
            Type <span className="font-mono text-foreground">{state?.name}</span> to confirm
          </span>
          <Input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirm()
            }}
            spellCheck={false}
            data-testid="data-project-mongo-confirm-name-input"
          />
        </label>
        {error && <p className="whitespace-pre-wrap text-[12px] text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!matches || busy}
            onClick={() => void confirm()}
            data-testid="data-project-mongo-confirm-name-submit"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {state?.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
