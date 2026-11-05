import { useState } from 'react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { isTicketRun, type DocumentRun, type DocumentRunItem } from '@shared/types/document-flow'
import { dependencyReaches } from './document-flow-launch'

const LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export interface RunItemDependencyEditorProps {
  run: Pick<DocumentRun, 'id' | 'source_kind'>
  item: DocumentRunItem
  /** Every item of the run, in run order. */
  items: readonly DocumentRunItem[]
  /** Shown but not editable (the item launched, or the run no longer takes edits). */
  disabled?: boolean
  /** Why it is disabled, shown under the pills. */
  disabledReason?: string | null
}

/**
 * "Starts after": one pill per other item of the run, pressed when this item waits for it. A
 * pill that would close a cycle is disabled and says why; a key that names no item of the run
 * is red, and clicking it removes it. The list is kept in run order.
 *
 * Where the choice goes depends on the run. A document run writes the item's own `depends_on`
 * (preview only, as before). A run made from board tickets writes the BOARD's dependencies
 * between the tickets (`setItemDependencies`), which the run follows: the board is the source
 * of truth, so the board's "Blocked by" and the run always agree. The server checks the whole
 * graph again and refuses a cycle or an item that launched meanwhile; the refusal is a toast.
 */
export function RunItemDependencyEditor({
  run,
  item,
  items,
  disabled = false,
  disabledReason = null
}: RunItemDependencyEditorProps): React.JSX.Element | null {
  const updateItem = useDocumentFlowStore((s) => s.updateItem)
  const setItemDependencies = useDocumentFlowStore((s) => s.setItemDependencies)
  // A board write on its way: the pills wait for it rather than stacking edits on a stale
  // list (the server answers with the graph it kept, which may not be the one asked for).
  const [saving, setSaving] = useState(false)
  const ticketRun = isTicketRun(run)
  const others = items.filter((candidate) => candidate.id !== item.id)
  const knownKeys = new Set(others.map((candidate) => candidate.key))
  const danglingKeys = item.depends_on.filter((key) => !knownKeys.has(key))

  if (others.length === 0 && danglingKeys.length === 0) return null

  const toggleDependency = (key: string): void => {
    const wanted = new Set(item.depends_on)
    if (!wanted.delete(key)) wanted.add(key)
    // Keep the list in run order, with keys that match no ticket at the end.
    const next = [
      ...others.map((other) => other.key).filter((candidate) => wanted.has(candidate)),
      ...danglingKeys.filter((candidate) => wanted.has(candidate))
    ]
    if (!ticketRun) {
      updateItem(run.id, item.id, { depends_on: next }).catch((cause: unknown) => {
        toast.error(`Could not save your edit: ${errorMessage(cause)}`)
      })
      return
    }
    setSaving(true)
    setItemDependencies(run.id, item.id, next)
      .catch((cause: unknown) => {
        toast.error(`Could not change what ${item.key} starts after: ${errorMessage(cause)}`)
      })
      .finally(() => setSaving(false))
  }

  const locked = disabled || saving

  return (
    <div className="space-y-1.5" data-testid={`docflow-item-deps-${item.key}`}>
      <p className={LABEL_CLASS}>Starts after</p>
      <div className="flex flex-wrap gap-1">
        {others.map((other) => {
          const active = item.depends_on.includes(other.key)
          // Adding it would make the two wait for each other forever.
          const circular = !active && dependencyReaches(other.key, item.key, items)
          return (
            <button
              key={other.id}
              type="button"
              aria-pressed={active}
              disabled={circular || locked}
              title={circular ? `${other.key} already starts after ${item.key}` : other.title}
              data-testid={`docflow-item-dep-toggle-${item.key}-${other.key}`}
              className={cn(
                'rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent/50'
              )}
              onClick={() => toggleDependency(other.key)}
            >
              {other.key}
            </button>
          )
        })}
        {danglingKeys.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed
            disabled={locked}
            title={`There is no ticket ${key} in this run. Click to remove.`}
            data-testid={`docflow-item-dep-toggle-${item.key}-${key}`}
            className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 font-mono text-[10px] text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => toggleDependency(key)}
          >
            {key}
          </button>
        ))}
      </div>
      {disabled && disabledReason ? (
        <p className="text-[11px] leading-snug text-muted-foreground">{disabledReason}</p>
      ) : (
        ticketRun && (
          <p className="text-[11px] leading-snug text-muted-foreground">
            Saved as the tickets&apos; dependencies on the board.
          </p>
        )
      )}
    </div>
  )
}
