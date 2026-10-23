// Filter drafts of the table Data tab (what the filter bar edits), their conversion to the
// DataFilter list the server turns into a quoted WHERE, and how the rows combine (AND / OR; the
// raw WHERE box is always ANDed with the group server-side).

import type { DataFilter, DataFilterJoin, DataFilterOperator } from '@shared/data-projects/types'

export interface FilterDraft {
  id: number
  column: string
  operator: DataFilterOperator
  value: string
}

/** Operators that take no value. */
export const FILTER_NO_VALUE: ReadonlySet<DataFilterOperator> = new Set(['is null', 'is not null'])

let filterSeq = 1
export const newFilterDraft = (
  column: string,
  operator: DataFilterOperator = '=',
  value = ''
): FilterDraft => ({
  id: filterSeq++,
  column,
  operator,
  value
})

/** Drafts that can be sent (a column, and a value unless the operator takes none). */
export const toDataFilters = (drafts: FilterDraft[]): DataFilter[] =>
  drafts
    .filter((d) => d.column && (FILTER_NO_VALUE.has(d.operator) || d.value !== ''))
    .map((d) =>
      FILTER_NO_VALUE.has(d.operator)
        ? { column: d.column, operator: d.operator }
        : { column: d.column, operator: d.operator, value: d.value }
    )

/** The join that takes effect: OR only means something between two or more sendable filters. */
export const effectiveFilterJoin = (filters: DataFilter[], join: DataFilterJoin): DataFilterJoin =>
  join === 'or' && filters.length > 1 ? 'or' : 'and'

/**
 * The request field for the join (rows / export): sent only when it is OR, so an AND request
 * keeps exactly the shape the server has always received.
 */
export const filterJoinField = (
  filters: DataFilter[],
  join: DataFilterJoin
): { filterJoin?: DataFilterJoin } =>
  effectiveFilterJoin(filters, join) === 'or' ? { filterJoin: 'or' } : {}

/**
 * "Filter by this value" narrows what the grid shows. Added to AND-joined filters (or to a single
 * one, where the join changes nothing yet) it is one more AND; an OR group of two or more would
 * only grow by one more OR'ed row, so the value filter replaces the group (`replaced`).
 */
export function addValueFilter(
  drafts: FilterDraft[],
  join: DataFilterJoin,
  draft: FilterDraft
): { drafts: FilterDraft[]; join: DataFilterJoin; replaced: boolean } {
  if (effectiveFilterJoin(toDataFilters(drafts), join) === 'or')
    return { drafts: [draft], join: 'and', replaced: true }
  return { drafts: [...drafts, draft], join: 'and', replaced: false }
}
