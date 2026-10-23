// Indexes of the structure editor: the described ones (drop is staged and can be undone; the
// primary key and indexes an engine cannot drop say why), then the staged new ones (green; click
// to edit in the index dialog). PostgreSQL indexes behind a UNIQUE / EXCLUDE constraint are marked:
// they go with ALTER TABLE … DROP CONSTRAINT.

import { AlertTriangle, Pencil, RotateCcw, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes } from '../../shared/format-utils'
import { Mono } from './sections'
import {
  columnChoices,
  removeIndex,
  toggleDropIndex,
  type IndexDraft,
  type StagedStructure,
  type StructureIssue,
  type StructureModel
} from './structure-model'

const iconButton =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

export interface IndexesTableProps {
  model: StructureModel
  staged: StagedStructure
  onChange: (fn: (s: StagedStructure) => StagedStructure) => void
  issues: StructureIssue[]
  /** Why index editing is off; null = editable. */
  lockReason: string | null
  onEdit: (draft: IndexDraft) => void
}

export function IndexesTable({
  model,
  staged,
  onChange,
  issues,
  lockReason,
  onEdit
}: IndexesTableProps): React.JSX.Element {
  const choices = columnChoices(staged, model)
  const nameOf = (key: string): string => choices.find((c) => c.key === key)?.name ?? '?'
  const issueOf = (index: string): StructureIssue | undefined =>
    issues.find((i) => i.index === index && i.level === 'error') ??
    issues.find((i) => i.index === index)
  const headers = ['Name', 'Columns', 'Unique', 'Type', 'Size', 'Definition', '']
  const cell = 'px-2 py-1'

  if (model.indexes.length === 0 && staged.addIndexes.length === 0)
    return <p className="text-[12px] text-muted-foreground">No indexes.</p>

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table
        className="w-full border-collapse text-[12px]"
        data-testid="data-project-structure-indexes"
      >
        <thead className="bg-card">
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className="whitespace-nowrap border-b border-border px-2 py-1 text-left font-medium text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.indexes.map((ix) => {
            const name = ix.info.name
            const dropped = staged.dropIndexes.includes(name)
            const problem = dropped ? issueOf(name) : undefined
            return (
              <tr
                key={`b:${name}`}
                className={cn(
                  'border-b border-border/60 align-top last:border-0',
                  dropped &&
                    'bg-red-500/10 text-muted-foreground line-through decoration-red-500/60'
                )}
                data-testid={`data-project-structure-index-${name}`}
                data-state={dropped ? 'dropped' : undefined}
              >
                <td className={cell}>
                  <span className="font-mono">{name}</span>
                  {ix.info.primary && (
                    <span className="ml-1 text-[10px] text-amber-600 no-underline dark:text-amber-400">
                      PRIMARY
                    </span>
                  )}
                  {ix.constraint && (
                    <span
                      className="ml-1 text-[10px] text-muted-foreground"
                      title="Backs a constraint: dropped with ALTER TABLE … DROP CONSTRAINT"
                    >
                      constraint
                    </span>
                  )}
                  {problem && (
                    <AlertTriangle
                      className="ml-1 inline h-3 w-3 text-red-500"
                      aria-label={problem.message}
                    />
                  )}
                </td>
                <td className={cell}>
                  <Mono text={ix.info.columns.join(', ')} />
                </td>
                <td className={cell}>{ix.info.unique ? 'yes' : 'no'}</td>
                <td className={cell}>
                  <Mono text={ix.info.type ?? null} />
                </td>
                <td className={cn(cell, 'whitespace-nowrap')}>
                  {ix.info.sizeBytes ? formatBytes(ix.info.sizeBytes) : ''}
                </td>
                <td className={cn(cell, 'max-w-[420px] break-words')}>
                  <Mono text={ix.info.definition ?? null} />
                </td>
                <td className="w-14 px-1 py-0.5">
                  {!lockReason && (
                    <div className="flex justify-end">
                      {dropped ? (
                        <button
                          type="button"
                          className={iconButton}
                          title="Keep this index"
                          onClick={() => onChange((s) => toggleDropIndex(s, name))}
                          data-testid="data-project-structure-index-revert"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={cn(iconButton, 'hover:text-red-600')}
                          disabled={!!ix.dropLock}
                          title={ix.dropLock ?? 'Drop this index (staged)'}
                          onClick={() => onChange((s) => toggleDropIndex(s, name))}
                          data-testid="data-project-structure-index-drop"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
          {staged.addIndexes.map((ix) => {
            const problem = issueOf(ix.id)
            const columns = ix.expression?.trim() || ix.columns.map((c) => nameOf(c.key)).join(', ')
            return (
              <tr
                key={`n:${ix.id}`}
                className={cn(
                  'border-b border-border/60 bg-emerald-500/10 align-top last:border-0',
                  problem?.level === 'error' && 'shadow-[inset_2px_0_0_rgb(239_68_68)]'
                )}
                data-testid={`data-project-structure-new-index-${ix.name || ix.id}`}
                data-state="added"
                title={problem?.message}
              >
                <td className={cell}>
                  <button
                    type="button"
                    className="font-mono hover:underline"
                    onClick={() => onEdit(ix)}
                    disabled={!!lockReason}
                  >
                    {ix.name || <span className="text-muted-foreground">(unnamed)</span>}
                  </button>
                  {problem && (
                    <AlertTriangle
                      className={cn(
                        'ml-1 inline h-3 w-3',
                        problem.level === 'error' ? 'text-red-500' : 'text-amber-500'
                      )}
                      aria-label={problem.message}
                    />
                  )}
                </td>
                <td className={cell}>
                  <Mono text={columns || null} />
                </td>
                <td className={cell}>
                  {model.caps.uniqueIndexes ? (ix.unique ? 'yes' : 'no') : ''}
                </td>
                <td className={cell}>
                  <Mono text={ix.skipType ?? ix.method ?? null} />
                </td>
                <td className={cell} />
                <td className={cn(cell, 'text-[11px] text-emerald-700 dark:text-emerald-300')}>
                  new index
                </td>
                <td className="w-14 px-1 py-0.5">
                  {!lockReason && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className={iconButton}
                        title="Edit this new index"
                        onClick={() => onEdit(ix)}
                        data-testid="data-project-structure-index-edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className={iconButton}
                        title="Remove this new index"
                        onClick={() => onChange((s) => removeIndex(s, ix.id))}
                        data-testid="data-project-structure-index-remove"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
