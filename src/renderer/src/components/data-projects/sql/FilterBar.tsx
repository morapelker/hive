// Filter bar of the table Data tab: rows of `column ▾ operator ▾ value` joined with AND or OR
// (the AND | OR switch and the connector word on each row, from two rows on) plus an optional raw
// WHERE clause, which is always ANDed with the rows. Nothing is applied while typing: Enter or
// Apply runs it (the server builds the WHERE with quoted literals; a raw WHERE is classified like
// any statement before it runs).
//
// Narrow panes (assistant open): the column picker and the value field shrink instead of keeping
// fixed widths, so the value and its remove button never slide out of reach.

import { Plus, X } from 'lucide-react'
import {
  DATA_FILTER_OPERATORS,
  type DataFilterJoin,
  type DataFilterOperator
} from '@shared/data-projects/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { FILTER_NO_VALUE, newFilterDraft, type FilterDraft } from './filters'

export interface FilterBarProps {
  columns: string[]
  filters: FilterDraft[]
  onFiltersChange: (filters: FilterDraft[]) => void
  /** How the filter rows combine (the raw WHERE is ANDed with them either way). */
  join?: DataFilterJoin
  /** Offers the AND | OR switch; without it the rows are ANDed. */
  onJoinChange?: (join: DataFilterJoin) => void
  where: string
  onWhereChange: (where: string) => void
  showWhere: boolean
  onShowWhereChange: (show: boolean) => void
  onApply: () => void
  onClear: () => void
  /** Drafts differ from what the grid shows. */
  dirty: boolean
}

const selectClass = 'h-7 rounded-md border border-input bg-background px-1.5 text-[12px]'
const inputClass =
  'h-7 rounded-md border border-input bg-transparent px-2 font-mono text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
const connectorClass =
  'w-10 shrink-0 text-right font-mono text-[11px] font-semibold uppercase text-muted-foreground'

export function FilterBar({
  columns,
  filters,
  onFiltersChange,
  join = 'and',
  onJoinChange,
  where,
  onWhereChange,
  showWhere,
  onShowWhereChange,
  onApply,
  onClear,
  dirty
}: FilterBarProps): React.JSX.Element {
  const update = (id: number, patch: Partial<FilterDraft>): void =>
    onFiltersChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onApply()
    }
  }
  const active = filters.length > 0 || showWhere
  // From two rows on each row reads like the clause it becomes: WHERE a / OR b / AND <raw>.
  const joined = !!onJoinChange && filters.length > 1
  const flip = (): void => onJoinChange?.(join === 'and' ? 'or' : 'and')
  return (
    <div
      className={cn('shrink-0 border-b border-border px-2', active ? 'py-1.5' : 'py-1')}
      data-testid="data-project-filter-bar"
      data-filter-join={joined ? join : undefined}
    >
      {filters.map((f, i) => (
        <div
          key={f.id}
          className="mb-1 flex min-w-0 items-center gap-1.5"
          data-testid={`data-project-filter-row-${f.id}`}
        >
          {joined &&
            (i === 0 ? (
              <span className={connectorClass}>where</span>
            ) : (
              <button
                type="button"
                onClick={flip}
                title={`Rows are ${join === 'and' ? 'all required (AND)' : 'alternatives (OR)'}: click to switch`}
                className={cn(
                  connectorClass,
                  'rounded hover:text-foreground',
                  join === 'or' && 'text-sky-600 dark:text-sky-400'
                )}
                data-testid="data-project-filter-connector"
              >
                {join}
              </button>
            ))}
          <select
            value={f.column}
            onChange={(e) => update(f.id, { column: e.target.value })}
            className={cn(selectClass, 'min-w-[64px] max-w-[200px] shrink')}
            data-testid="data-project-filter-column"
          >
            {columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={f.operator}
            onChange={(e) => update(f.id, { operator: e.target.value as DataFilterOperator })}
            className={cn(selectClass, 'shrink-0')}
            data-testid="data-project-filter-operator"
          >
            {DATA_FILTER_OPERATORS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          {!FILTER_NO_VALUE.has(f.operator) && (
            <input
              value={f.value}
              onChange={(e) => update(f.id, { value: e.target.value })}
              onKeyDown={onKey}
              placeholder={f.operator === 'in' || f.operator === 'not in' ? 'a, b, c' : 'value'}
              className={cn(inputClass, 'min-w-[60px] max-w-72 flex-1')}
              data-testid="data-project-filter-value"
            />
          )}
          <button
            type="button"
            onClick={() => onFiltersChange(filters.filter((x) => x.id !== f.id))}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Remove filter"
            data-testid="data-project-filter-remove"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {showWhere && (
        <div className="mb-1 flex items-center gap-1.5">
          {joined ? (
            <span
              className={connectorClass}
              title="The raw WHERE is always ANDed with the filter rows"
            >
              and
            </span>
          ) : (
            <span className="font-mono text-[12px] font-semibold text-muted-foreground">WHERE</span>
          )}
          <input
            value={where}
            onChange={(e) => onWhereChange(e.target.value)}
            onKeyDown={onKey}
            placeholder="status = 'paid' AND total > 100"
            title={
              filters.length ? 'Raw SQL condition, ANDed with the filter rows' : 'Raw SQL condition'
            }
            className={cn(inputClass, 'min-w-0 flex-1')}
            data-testid="data-project-filter-where"
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[12px]"
          disabled={!columns.length}
          onClick={() => onFiltersChange([...filters, newFilterDraft(columns[0] ?? '')])}
          data-testid="data-project-filter-add"
        >
          <Plus className="h-3 w-3" />
          Filter
        </Button>
        <Button
          variant={showWhere ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 px-2 font-mono text-[12px]"
          onClick={() => onShowWhereChange(!showWhere)}
          data-testid="data-project-filter-where-toggle"
        >
          WHERE…
        </Button>
        {joined && (
          <div
            role="radiogroup"
            aria-label="Combine the filter rows with"
            className="flex h-6 items-center rounded-md border border-input p-px"
            data-testid="data-project-filter-join"
          >
            {(['and', 'or'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={join === value}
                onClick={() => join !== value && onJoinChange?.(value)}
                title={
                  value === 'and'
                    ? 'Match all filter rows (AND)'
                    : 'Match any filter row (OR); the raw WHERE still applies to every row'
                }
                className={cn(
                  'h-full rounded-[4px] px-1.5 font-mono text-[11px] font-semibold uppercase transition-colors',
                  join === value
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                data-testid={`data-project-filter-join-${value}`}
              >
                {value}
              </button>
            ))}
          </div>
        )}
        {active && (
          <>
            <Button
              size="sm"
              className="h-6 px-2 text-[12px]"
              onClick={onApply}
              disabled={!dirty}
              data-testid="data-project-filter-apply"
            >
              Apply
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[12px]"
              onClick={onClear}
              data-testid="data-project-filter-clear"
            >
              Clear
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
