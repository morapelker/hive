// Pure helpers of the console panel: source labels and colours, the filter, time and count
// formatting, what can be opened in an editor, and the text "Copy" puts on the clipboard.

import type { DataConsoleEntry, DataConsoleSource } from '@shared/data-projects/console-types'
import { formatCount, formatDuration } from '../shared/format-utils'

/**
 * Entry flags the server sets that console-types.ts may not declare yet. `masked`: literals in
 * the text were masked ('***') like history: it is not the statement that ran.
 */
export type ConsoleEntryFlags = { masked?: boolean }

/** Literals in the entry's text were masked ('***'): it cannot be run as it is. */
export const isMaskedConsoleEntry = (entry: DataConsoleEntry): boolean =>
  (entry as DataConsoleEntry & ConsoleEntryFlags).masked === true

/** A driver's own statement whose bind values had no literal: listed after it, placeholders left. */
const UNBOUND_PARAMS = /\n-- params: /

export const CONSOLE_SOURCE_LABEL: Record<DataConsoleSource, string> = {
  query: 'Query',
  table: 'Table',
  edit: 'Edit',
  structure: 'Structure',
  export: 'Export',
  import: 'Import',
  mongo: 'Mongo',
  admin: 'Admin',
  assistant: 'AI',
  metadata: 'Meta',
  other: 'App'
}

/** What each source means (badge tooltip, source menu). */
export const CONSOLE_SOURCE_HINT: Record<DataConsoleSource, string> = {
  query: 'Run from a query or Shell tab',
  table: 'Table browser pages and row counts',
  edit: 'Saved grid edits (with their transaction)',
  structure: 'Schema actions',
  export: 'Full exports',
  import: 'File imports',
  mongo: 'Documents, aggregations, indexes and collection actions',
  admin: 'Kills and cancels',
  assistant: 'The AI assistant’s reads',
  metadata: 'Catalog, introspection and session statements',
  other: 'Sent by the app'
}

export const CONSOLE_SOURCE_CLASS: Record<DataConsoleSource, string> = {
  query: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  table: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  edit: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  structure: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  export: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  import: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  mongo: 'bg-green-500/15 text-green-700 dark:text-green-300',
  admin: 'bg-red-500/15 text-red-700 dark:text-red-300',
  assistant: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
  metadata: 'bg-muted text-muted-foreground',
  other: 'bg-slate-500/15 text-slate-700 dark:text-slate-300'
}

/** Sources offered in the source menu, in display order ('metadata' has its own toggle). */
export const CONSOLE_SOURCE_FILTERS: readonly DataConsoleSource[] = [
  'query',
  'table',
  'edit',
  'structure',
  'export',
  'import',
  'mongo',
  'admin',
  'assistant',
  'other'
]

export interface ConsoleFilter {
  /** Case-insensitive substring of the text, error, database or source label. */
  text: string
  /** One source only, or every source. */
  source: DataConsoleSource | 'all'
  /** Show catalog / introspection / session statements too. */
  metadata: boolean
  errorsOnly: boolean
}

export const DEFAULT_CONSOLE_FILTER: ConsoleFilter = {
  text: '',
  source: 'all',
  metadata: false,
  errorsOnly: false
}

export function matchesConsoleFilter(entry: DataConsoleEntry, filter: ConsoleFilter): boolean {
  if (entry.source === 'metadata' && !filter.metadata) return false
  if (filter.source !== 'all' && entry.source !== filter.source && entry.source !== 'metadata')
    return false
  if (filter.errorsOnly && entry.status !== 'error') return false
  const needle = filter.text.trim().toLowerCase()
  if (!needle) return true
  return (
    entry.text.toLowerCase().includes(needle) ||
    (entry.error ?? '').toLowerCase().includes(needle) ||
    (entry.database ?? '').toLowerCase().includes(needle) ||
    CONSOLE_SOURCE_LABEL[entry.source].toLowerCase() === needle
  )
}

/** "14:03:07.215" (local time, milliseconds: statements often share a second). */
export function formatConsoleTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
}

/** INSERT / UPDATE / DELETE …: "0 affected" means something only for these. */
const DML =
  /^\s*(?:with\b[\s\S]*?\)\s*)?(?:insert|update|delete|replace|merge|upsert|db\.runCommand\(\{\s*(?:insert|update|delete|findAndModify)\b)/i

/** "20 rows", "3 affected", "1 doc"… ('' when the driver reported nothing worth showing). */
export function formatConsoleCounts(entry: DataConsoleEntry): string {
  const parts: string[] = []
  if (entry.rows !== null) {
    // A summary's count is of what the call returned (databases, objects, columns…).
    const unit = entry.summary ? 'result' : entry.language === 'mongo' ? 'doc' : 'row'
    parts.push(`${formatCount(entry.rows)} ${unit}${entry.rows === 1 ? '' : 's'}`)
  }
  if (entry.affected !== null && (entry.affected > 0 || DML.test(entry.text)))
    parts.push(`${formatCount(entry.affected)} affected`)
  return parts.join(' · ')
}

/** Why an entry cannot be opened in an editor, or null when it can. */
export function consoleOpenBlocker(entry: DataConsoleEntry): string | null {
  if (entry.summary) return 'A summary of an introspection call, not a statement'
  if (entry.truncated) return 'Too long: the console keeps only the beginning of it'
  // Running it would write the mask ('***') where the secret was, or fail on it.
  if (isMaskedConsoleEntry(entry))
    return 'Secrets in it were masked (***): copy it and put the real values back to run it'
  if ((entry.source === 'metadata' || entry.source === 'admin') && UNBOUND_PARAMS.test(entry.text))
    return 'It has bind parameters ($1, ?): their values are listed below it'
  return null
}

/** One entry as a commented block of SQL / mongosh (for Copy with details and Copy all). */
export function consoleEntryBlock(entry: DataConsoleEntry): string {
  const comment = entry.language === 'mongo' ? '//' : '--'
  const details = [
    formatConsoleTime(entry.at),
    CONSOLE_SOURCE_LABEL[entry.source],
    entry.database,
    entry.durationMs !== null ? formatDuration(entry.durationMs) : null,
    formatConsoleCounts(entry) || null,
    entry.status === 'cancelled' ? 'cancelled' : null
  ].filter(Boolean)
  const lines = [`${comment} ${details.join(' · ')}`]
  if (entry.error) lines.push(`${comment} error: ${entry.error.replace(/\s*\n\s*/g, ' ')}`)
  const text = entry.text.trim()
  const terminated =
    entry.language === 'sql' && !entry.summary && !/;\s*$/.test(text) ? `${text};` : text
  lines.push(terminated)
  return lines.join('\n')
}

export const consoleLogText = (entries: readonly DataConsoleEntry[]): string =>
  entries.map(consoleEntryBlock).join('\n\n')
