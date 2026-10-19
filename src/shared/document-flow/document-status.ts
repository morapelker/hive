import type {
  DocumentRun,
  DocumentRunItem,
  DocumentRunItemStatus,
  DocumentRunReport,
  DocumentUpdateReport,
  DocumentUpdateStatus,
  DocumentVerificationMethod
} from '../types/document-flow'
import type { DocumentFormat } from './preprocess'

// The run status summary the app writes into the source document when a run finishes: one
// block at the top of the document, between markers, with a row per selected task. It is
// generated from the run's own records (no model), and a later run on the same document
// replaces the block instead of stacking another one. Everything outside the markers is left
// exactly as it was; the session that updated each task's own section did the rest.
//
// Pure: the server reads and writes the file (`finalize` in document-flow-service.ts).

/** Markers around the block. HTML and Markdown share a comment, which neither renders. */
export const RUN_STATUS_MARKERS: Record<DocumentFormat, { start: string; end: string }> = {
  html: { start: '<!-- tedooo-run-status:start -->', end: '<!-- tedooo-run-status:end -->' },
  markdown: { start: '<!-- tedooo-run-status:start -->', end: '<!-- tedooo-run-status:end -->' },
  text: {
    start: '==== tedooo run status (generated) ====',
    end: '==== end of tedooo run status ===='
  }
}

/**
 * Start of the `status_detail` the orchestrator gives a ticket it merged although its agent did
 * not call it done (runner.ts `MERGED_AS_IS_PREFIX`). Matched anywhere in the detail: a merge
 * adopted at the end of the run puts its own note in front.
 */
const MERGED_AS_IS_MARK = 'Merged as it stood.'

const HEADING = 'Implementation status'
const LEGEND = '✅ Done · ⚠️ Partial / merged as it stood · ⏭️ Skipped · ❌ Not merged'
/** A cell nothing is known for. */
const UNKNOWN = '—'
const COLUMNS = ['Task', 'Status', 'Verified', 'Follow-ups', 'Document'] as const

/** One selected task of the run, as the summary needs it. */
export interface RunStatusTask {
  key: string
  title: string
  status: DocumentRunItemStatus
  statusDetail: string | null
  /** The verification methods the agent was asked to use ([] while verification is off). */
  verification: readonly DocumentVerificationMethod[]
  documentUpdate: DocumentUpdateStatus | null
  documentUpdateDetail: string | null
  /** What the agent said in its DOCUMENT footer, when it updated the document. */
  report: DocumentUpdateReport | null
}

/** Everything the summary shows: plain data, built from the run by `runStatusInput`. */
export interface RunStatusInput {
  /** ISO time the block is generated at. */
  generatedAt: string
  integrationBranch: string
  /** Integration branch HEAD; '' when it could not be read. */
  headSha: string
  /** The selected tasks, in document order. */
  tasks: RunStatusTask[]
  /** The checks run on the integration branch after the merges; null when none are set. */
  verify: { command: string; ok: boolean } | null
  manualSteps: string[]
  migrations: string[]
}

/** The summary's input for a finished run: its selected items, in document order, and its report. */
export function runStatusInput(
  run: Pick<DocumentRun, 'config'>,
  items: readonly DocumentRunItem[],
  report: DocumentRunReport
): RunStatusInput {
  return {
    generatedAt: report.generatedAt,
    integrationBranch: report.integrationBranch,
    headSha: report.headSha,
    tasks: items
      .filter((item) => item.selected)
      .sort((a, b) => a.position - b.position)
      .map((item) => ({
        key: item.key,
        title: item.title,
        status: item.status,
        statusDetail: item.status_detail,
        verification: run.config.verificationDisabled ? [] : item.verification,
        documentUpdate: item.document_update_status,
        documentUpdateDetail: item.document_update_detail,
        report: item.document_update_report
      })),
    verify: report.verify ? { command: report.verify.command, ok: report.verify.ok } : null,
    manualSteps: report.manualSteps,
    migrations: report.migrations
  }
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** A task's row with every cell worded; the formats differ only in how they lay it out. */
interface RunStatusRow {
  key: string
  title: string
  status: string
  verified: string
  followUps: string
  document: string
}

function statusCell(task: RunStatusTask): string {
  if (task.status === 'merged') {
    return task.statusDetail?.includes(MERGED_AS_IS_MARK) ? '⚠️ Partial' : '✅ Done'
  }
  // Only a ticket the run closed as already implemented (its branch had nothing new) gets a
  // document update; one the user skipped never does.
  if (task.status === 'skipped') {
    return task.documentUpdate !== null ? '✅ Done (already implemented)' : '⏭️ Skipped'
  }
  return `❌ Not merged (${task.status.replace(/_/g, ' ')})`
}

/**
 * How the task was verified, as its agent said in its footer. Without that, the methods it was
 * asked to use are only that: never worded as checks that ran, and not at all for a task that
 * was never merged.
 */
function verifiedCell(task: RunStatusTask): string {
  if (task.report?.verified) return task.report.verified
  if (task.status !== 'merged' || task.verification.length === 0) return UNKNOWN
  return `Not confirmed (asked for ${task.verification.join(', ')})`
}

function rowOf(task: RunStatusTask): RunStatusRow {
  const { report } = task
  const detail = task.documentUpdateDetail?.trim()
  return {
    key: task.key,
    title: task.title,
    status: statusCell(task),
    verified: verifiedCell(task),
    // The footer says "none" when there are none; without a footer nothing is known.
    followUps: report
      ? report.followUps.length > 0
        ? report.followUps.join('; ')
        : 'None'
      : UNKNOWN,
    document:
      task.documentUpdate === 'done' ? 'Updated' : detail ? `Not updated: ${detail}` : 'Not updated'
  }
}

/** "2026-10-19 13:41 UTC"; null when the value is not a date. */
function formatGeneratedAt(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const shortSha = (sha: string): string => sha.slice(0, 7)

/** Collapses a value onto one line: a cell or list entry never breaks the layout. */
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** The "Generated …" line, with `code` wrapping the branch and the commit. */
function generatedLine(input: RunStatusInput, code: (value: string) => string): string {
  const at = formatGeneratedAt(input.generatedAt)
  let line = at ? `Generated ${at} by the document run` : 'Generated by the document run'
  if (input.integrationBranch) {
    line += ` · integration branch ${code(input.integrationBranch)}`
    if (input.headSha) line += ` @ ${code(shortSha(input.headSha))}`
  }
  return line
}

const verifyLine = (
  verify: NonNullable<RunStatusInput['verify']>,
  code: (value: string) => string
): string => `Checks after the merges: ${code(verify.command)} ${verify.ok ? 'passed' : 'failed'}`

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * The status block for a document of `format`, markers included, with `\n` line endings and no
 * trailing newline. `upsertRunStatusBlock` puts it into the document.
 */
export function renderRunStatusBlock(format: DocumentFormat, input: RunStatusInput): string {
  const { start, end } = RUN_STATUS_MARKERS[format]
  const rows = input.tasks.map(rowOf)
  const body =
    format === 'html'
      ? renderHtml(input, rows)
      : format === 'markdown'
        ? renderMarkdown(input, rows)
        : renderText(input, rows)
  return [start, ...body, end].join('\n')
}

/** A Markdown code span that survives backticks in the value. */
function markdownCode(value: string): string {
  const text = oneLine(value)
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`
}

/**
 * Markdown text on one line. `<` is written as an entity, so a value can neither open an HTML
 * tag nor close the block's marker comment; `|` is escaped for the table.
 */
const markdownText = (value: string): string =>
  oneLine(value).replace(/</g, '&lt;').replace(/\|/g, '\\|')

function renderMarkdown(input: RunStatusInput, rows: RunStatusRow[]): string[] {
  const lines = [`## ${HEADING}`, '', generatedLine(input, markdownCode), '', LEGEND, '']
  lines.push(`| ${COLUMNS.join(' | ')} |`, `|${COLUMNS.map(() => ' --- |').join('')}`)
  for (const row of rows) {
    const cells = [
      `**${markdownText(row.key)}** · ${markdownText(row.title)}`,
      row.status,
      markdownText(row.verified),
      markdownText(row.followUps),
      markdownText(row.document)
    ]
    lines.push(`| ${cells.join(' | ')} |`)
  }
  if (input.verify) lines.push('', verifyLine(input.verify, markdownCode))
  for (const [label, entries] of listsOf(input)) {
    lines.push('', `**${label}**`, '', ...entries.map((entry) => `- ${markdownText(entry)}`))
  }
  return lines
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

const escapeHtml = (value: string): string =>
  oneLine(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char])

const htmlCode = (value: string): string => `<code>${escapeHtml(value)}</code>`

/** Minimal inline styles: the block reads on its own without taking over the document's look. */
const CELL_STYLE = 'border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top'

function renderHtml(input: RunStatusInput, rows: RunStatusRow[]): string[] {
  const cell = (tag: 'th' | 'td', content: string): string =>
    `<${tag} style="${CELL_STYLE}">${content}</${tag}>`
  const lines = [
    '<section style="border:1px solid #d0d7de;border-radius:6px;padding:12px 16px;margin:16px 0">',
    `<h2 style="margin:0 0 4px">${HEADING}</h2>`,
    `<p style="margin:0 0 8px;color:#57606a">${generatedLine(input, htmlCode)}</p>`,
    `<p style="margin:0 0 8px">${LEGEND}</p>`,
    '<table style="border-collapse:collapse;width:100%">',
    `<thead><tr>${COLUMNS.map((column) => cell('th', column)).join('')}</tr></thead>`,
    '<tbody>'
  ]
  for (const row of rows) {
    const cells = [
      `<strong>${escapeHtml(row.key)}</strong> · ${escapeHtml(row.title)}`,
      row.status,
      escapeHtml(row.verified),
      escapeHtml(row.followUps),
      escapeHtml(row.document)
    ]
    lines.push(`<tr>${cells.map((content) => cell('td', content)).join('')}</tr>`)
  }
  lines.push('</tbody>', '</table>')
  if (input.verify)
    lines.push(`<p style="margin:8px 0 0">${verifyLine(input.verify, htmlCode)}</p>`)
  for (const [label, entries] of listsOf(input)) {
    lines.push(
      `<p style="margin:8px 0 0"><strong>${label}</strong></p>`,
      `<ul>${entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>`
    )
  }
  lines.push('</section>')
  return lines
}

/** Plain text on one line, without a run of `=` that could pass for one of the markers. */
const plainText = (value: string): string => oneLine(value).replace(/={4,}/g, '==')

/** Label column of the text layout: the values line up under each other. */
const TEXT_LABEL_WIDTH = 'Follow-ups: '.length

function renderText(input: RunStatusInput, rows: RunStatusRow[]): string[] {
  const lines = [HEADING, generatedLine(input, plainText), `Legend: ${LEGEND}`]
  const field = (label: string, value: string): string =>
    `  ${`${label}:`.padEnd(TEXT_LABEL_WIDTH)}${plainText(value)}`
  for (const row of rows) {
    lines.push(
      '',
      `${plainText(row.key)} · ${plainText(row.title)}`,
      field('Status', row.status),
      field('Verified', row.verified),
      field('Follow-ups', row.followUps),
      field('Document', row.document)
    )
  }
  if (input.verify) lines.push('', verifyLine(input.verify, plainText))
  for (const [label, entries] of listsOf(input)) {
    lines.push('', `${label}:`, ...entries.map((entry) => `  - ${plainText(entry)}`))
  }
  return lines
}

/** The lists shown after the table, only when they have entries. */
function listsOf(input: RunStatusInput): [string, string[]][] {
  const lists: [string, string[]][] = [
    ['Manual steps', input.manualSteps],
    ['Migrations', input.migrations]
  ]
  return lists.filter(([, entries]) => entries.length > 0)
}

// ── Placing the block ───────────────────────────────────────────────────────

/**
 * `text` with `block` (from `renderRunStatusBlock`) in it. A block an earlier run wrote (see
 * `findRunStatusBlock`) is replaced, so writing the same block twice changes nothing.
 * Otherwise it goes at the top: in Markdown after a leading YAML front matter and after the
 * document's `# ` title when it starts with one, in HTML right after `<body…>` (else after a
 * leading doctype). The block takes the document's line endings; nothing outside it is
 * changed.
 */
export function upsertRunStatusBlock(text: string, format: DocumentFormat, block: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const body = block.replace(/\r?\n/g, eol)
  const found = findRunStatusBlock(text, format)
  if (found) return text.slice(0, found.from) + body + text.slice(found.to)

  const at = insertionPoint(text, format)
  const before = text.slice(0, at)
  const after = text.slice(at)
  // The block sits on lines of its own; in Markdown and text also with a blank line on either
  // side, to stay a separate paragraph. A line break already there counts towards that.
  const gap = format === 'html' ? '' : eol
  const lead = before === '' ? '' : (before.endsWith('\n') ? '' : eol) + gap
  const trail = after === '' ? eol : /^\r?\n/.test(after) ? gap : eol + gap
  return before + lead + body + trail + after
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The block an earlier run wrote: a start marker and the end marker after it, each alone on its
 * own line (as `renderRunStatusBlock` writes them), and in Markdown outside a fenced code block.
 * A marker quoted in the text, in a code span or in a code example is the user's content, and
 * so is everything between two of those. `to` is the end of the end marker; null when there is
 * no such pair.
 */
function findRunStatusBlock(
  text: string,
  format: DocumentFormat
): { from: number; to: number } | null {
  const { start, end } = RUN_STATUS_MARKERS[format]
  const fenced = format === 'markdown' ? fencedRanges(text) : []
  const markerLines = (marker: string): number[] => {
    const pattern = new RegExp(`^[ \\t]*(${escapeRegExp(marker)})[ \\t]*\\r?$`, 'gm')
    const found: number[] = []
    for (const match of text.matchAll(pattern)) {
      const at = match.index + match[0].indexOf(marker)
      if (!fenced.some(([from, to]) => at >= from && at < to)) found.push(at)
    }
    return found
  }
  const from = markerLines(start)[0]
  if (from === undefined) return null
  const to = markerLines(end).find((at) => at > from)
  return to === undefined ? null : { from, to: to + end.length }
}

/** Index ranges of the Markdown fenced code blocks (``` or ~~~) in `text`; an open one runs to the end. */
function fencedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = []
  let open: { at: number; fence: string } | null = null
  let at = 0
  for (const line of text.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (!open) open = { at, fence }
      else if (fence[0] === open.fence[0] && fence.length >= open.fence.length) {
        ranges.push([open.at, at + line.length])
        open = null
      }
    }
    at += line.length + 1
  }
  if (open) ranges.push([open.at, text.length])
  return ranges
}

/** Where a new block goes: an index into `text`. */
function insertionPoint(text: string, format: DocumentFormat): number {
  if (format === 'html') {
    const body = /<body\b[^>]*>/i.exec(text)
    if (body) return body.index + body[0].length
    const prolog = /^\s*(?:<\?xml[^>]*\?>\s*)?<!doctype[^>]*>/i.exec(text)
    return prolog ? prolog[0].length : 0
  }
  if (format === 'text') return 0
  let at = 0
  // YAML front matter opens with `---` and a `key:` (or a comment) on the very next line; a
  // `---` followed by a blank line or prose is a thematic break, and the document starts there.
  const frontMatter =
    /^---[ \t]*\r?\n(?=#|[\w"'-][^\r\n]*:)[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)
  if (frontMatter) at = frontMatter[0].length
  const title = /^(?:[ \t]*\r?\n)*# [^\r\n]*(?:\r?\n|$)/.exec(text.slice(at))
  if (title) at += title[0].length
  return at
}
