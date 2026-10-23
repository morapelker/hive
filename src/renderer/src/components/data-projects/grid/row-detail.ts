// Row detail panel helpers: the text a field edits and what committing it stages, plus the
// panel's per-viewer preferences (open or closed, width). The cell inspector shares the JSON
// handling.
//
// A field edits the same value the grid's inline editor does and stages it the same way
// (`resolveCellEdit`: numbers stay numeric, booleans parse, an untouched draft changes nothing),
// with JSON handling on top: a JSON object/array is edited pretty-printed and stored compact
// again, and a JSON column (json / jsonb / JSON, not jsonpath or json[]) refuses text that is not
// JSON (the database would reject the whole commit otherwise).
//
// JSON text is never parsed and re-serialised: JSON.parse would round integers above 2^53 and
// respell numbers (1.0 → 1, 1e2 → 100), string escapes ("\u00e9" → "é") and duplicate keys,
// and the panel would then show — and stage — values the database does not hold. Pretty-printing
// and compacting work on the tokens instead (`formatJsonText`), so they only ever change the
// whitespace between tokens; JSON.parse only says whether the text is JSON. What gets staged is
// the user's own tokens, and only when they differ from the value's (a reformat is no change).

import { useCallback, useState } from 'react'
import type { DataCell } from '@shared/data-projects/types'
import { cellToText, resolveCellEdit } from './cell-format'

/** Longest value a field shows or edits in place; longer ones go through the cell inspector. */
export const ROW_DETAIL_TEXT_LIMIT = 20_000

// ---- JSON text, token by token ----------------------------------------------------------------

/** A JSON string (unrolled: no backtracking on long strings), punctuation, or a bare literal. */
const JSON_TOKEN = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"|[{}[\]:,]|[^\s{}[\]:,"]+/g

/** True when `text` is one JSON value (any type), surrounding whitespace allowed. */
export function isJsonText(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const isJsonContainerText = (text: string): boolean => {
  const t = text.trimStart()
  return (t[0] === '{' || t[0] === '[') && isJsonText(text)
}

/**
 * Re-spaces JSON text without touching a token: `indent` null drops the whitespace between
 * tokens, '  ' lays it out like JSON.stringify(value, null, 2). Numbers, string escapes, key
 * order and duplicate keys stay exactly as written. `text` must be valid JSON.
 */
export function formatJsonText(text: string, indent: string | null): string {
  const out: string[] = []
  let depth = 0
  let opened = false
  const newline = (): string => `\n${(indent ?? '').repeat(depth)}`
  for (const match of text.matchAll(JSON_TOKEN)) {
    const token = match[0]
    if (indent === null) {
      out.push(token)
      continue
    }
    if (token === '}' || token === ']') {
      depth--
      if (opened)
        out.push(token) // {} and [] stay on one line
      else out.push(newline(), token)
      opened = false
      continue
    }
    if (opened) {
      out.push(newline())
      opened = false
    }
    if (token === '{' || token === '[') {
      out.push(token)
      depth++
      opened = true
    } else if (token === ',') out.push(',', newline())
    else if (token === ':') out.push(': ')
    else out.push(token)
  }
  return out.join('')
}

/** A JSON object/array text pretty-printed (tokens unchanged), or null for anything else. */
export function prettyJsonText(text: string): string | null {
  if (!isJsonContainerText(text)) return null
  try {
    return formatJsonText(text, '  ')
  } catch {
    return null // never expected: the caller edits the raw text then
  }
}

/** A JSON object/array text without insignificant whitespace (tokens unchanged), or null. */
export function compactJsonText(text: string): string | null {
  if (!isJsonContainerText(text)) return null
  try {
    return formatJsonText(text, null)
  } catch {
    return null
  }
}

/**
 * A column holding JSON documents: json / jsonb (PostgreSQL, MySQL, SQLite declared types),
 * ClickHouse JSON with its Nullable() / settings. Not jsonpath, json[] / jsonb[] arrays or other
 * types whose name merely contains "json": their values are not JSON text.
 */
export function isJsonColumnType(type: string | undefined): boolean {
  let t = (type ?? '').trim().toLowerCase()
  for (;;) {
    const wrapped = /^nullable\((.*)\)$/s.exec(t)
    if (!wrapped) break
    t = wrapped[1].trim()
  }
  t = t.replace(/^pg_catalog\./, '').replace(/\s*\(.*\)$/s, '')
  return t === 'json' || t === 'jsonb'
}

// ---- field drafts --------------------------------------------------------------------------------

export interface FieldDraft {
  text: string
  /** The text is the value's JSON pretty-printed (stored compact again on commit). */
  pretty: boolean
}

/** The text a row detail field starts from: NULL as '', JSON objects/arrays pretty-printed. */
export function fieldDraft(value: DataCell | undefined): FieldDraft {
  if (value === null || value === undefined) return { text: '', pretty: false }
  if (typeof value === 'string') {
    const pretty = prettyJsonText(value)
    if (pretty !== null) return { text: pretty, pretty: true }
  }
  return { text: cellToText(value), pretty: false }
}

export type FieldCommit =
  { kind: 'unchanged' } | { kind: 'value'; value: DataCell } | { kind: 'invalid'; message: string }

/** What committing a field's draft stages (nothing when the draft is the value it started from). */
export function resolveFieldDraft(
  draft: string,
  base: FieldDraft,
  original: DataCell | undefined,
  columnType?: string
): FieldCommit {
  if (draft === base.text) return { kind: 'unchanged' }
  if (base.pretty) {
    // Edited pretty-printed: stored compact, and only when a token changed.
    const compact = compactJsonText(draft)
    if (compact !== null) {
      const before = typeof original === 'string' ? compactJsonText(original) : null
      return compact === before ? { kind: 'unchanged' } : { kind: 'value', value: compact }
    }
  }
  if (isJsonColumnType(columnType) && !isJsonText(draft)) {
    return {
      kind: 'invalid',
      message: draft.trim() ? 'Not valid JSON' : 'Not valid JSON (Set NULL clears the value)'
    }
  }
  const { changed, value } = resolveCellEdit(draft, false, original)
  return changed ? { kind: 'value', value } : { kind: 'unchanged' }
}

/**
 * What the cell inspector's Apply stages, or undefined when nothing changed: NULL, the edited
 * JSON compacted when it was shown pretty-printed (tokens as typed; a whitespace-only change is
 * no change), else the text as typed.
 */
export function inspectorApplyValue({
  value,
  text,
  pretty,
  draft,
  draftNull
}: {
  value: DataCell | undefined
  /** The value as text ('' for NULL). */
  text: string
  /** The value pretty-printed when it is a JSON object/array. */
  pretty: string | null
  draft: string
  draftNull: boolean
}): DataCell | undefined {
  const isNull = value === null || value === undefined
  if (draftNull) return value === null ? undefined : null
  if (!isNull && draft === (pretty ?? text)) return undefined
  if (pretty !== null) {
    const compact = compactJsonText(draft)
    if (compact !== null) return compact === compactJsonText(text) ? undefined : compact
  }
  return !isNull && draft === text ? undefined : draft
}

// ---- row identity -------------------------------------------------------------------------------

/**
 * The identity a row's field drafts belong to: the caller's `rowKey`, else the row's primary-key
 * values, else (no key, a staged insert without one) its position. `stable` when it names the
 * row itself rather than where it sits: only then may a draft outlive a change of the value
 * underneath it.
 */
export function rowIdentity(
  rowKey: string | null | undefined,
  row: readonly (DataCell | undefined)[] | null,
  rowIndex: number | null,
  inserted: boolean,
  columns: ReadonlyArray<{ name: string }>,
  keyColumns: readonly string[] | undefined
): { key: string; stable: boolean } {
  if (rowKey) return { key: `key:${rowKey}`, stable: true }
  if (row === null || rowIndex === null) return { key: 'none', stable: false }
  const position = { key: `${inserted ? 'new' : 'at'}:${rowIndex}`, stable: false }
  if (inserted || !keyColumns || keyColumns.length === 0) return position
  const values: Array<DataCell | undefined> = []
  for (const name of keyColumns) {
    const col = columns.findIndex((c) => c.name === name)
    if (col < 0) return position
    const value = row[col]
    if (value === null || value === undefined) return position
    values.push(value)
  }
  return { key: `pk:${JSON.stringify(values)}`, stable: true }
}

// ---- preferences (per viewer, best effort: storage can be missing or full) ----------------------

const PREFS_KEY = 'hive-data-row-detail'
export const ROW_DETAIL_DEFAULT_WIDTH = 320
export const ROW_DETAIL_MIN_WIDTH = 220
export const ROW_DETAIL_MAX_WIDTH = 900

interface RowDetailPrefs {
  open: boolean
  width: number
}

export const clampRowDetailWidth = (width: number): number =>
  Math.round(Math.max(ROW_DETAIL_MIN_WIDTH, Math.min(ROW_DETAIL_MAX_WIDTH, width)))

export function readRowDetailPrefs(): RowDetailPrefs {
  const prefs: RowDetailPrefs = { open: false, width: ROW_DETAIL_DEFAULT_WIDTH }
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<
      Record<keyof RowDetailPrefs, unknown>
    > | null
    if (raw && typeof raw.open === 'boolean') prefs.open = raw.open
    if (raw && typeof raw.width === 'number' && Number.isFinite(raw.width))
      prefs.width = clampRowDetailWidth(raw.width)
  } catch {
    // unreadable storage: defaults
  }
  return prefs
}

export function writeRowDetailPrefs(patch: Partial<RowDetailPrefs>): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readRowDetailPrefs(), ...patch }))
  } catch {
    // storage unavailable: the preference lasts for this view only
  }
}

/** Open state of a view's row detail panel, starting from the viewer's last choice. */
export function useRowDetailOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => readRowDetailPrefs().open)
  const update = useCallback((next: boolean) => {
    setOpen(next)
    writeRowDetailPrefs({ open: next })
  }, [])
  return [open, update]
}
