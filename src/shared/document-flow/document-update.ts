import type { DocumentUpdateReport } from '../types/document-flow'
import { isNoneLike } from './coerce'

// The DOCUMENT footer a merged ticket's session ends its document update with (see
// `buildDocumentUpdatePrompt` in prompts.ts):
//
//   DOCUMENT: UPDATED | UNCHANGED | FAILED
//   VERIFIED: one line — how the task was verified (methods and results), or "not verified"
//   FOLLOW-UPS: none, or a semicolon-separated list
//   NOTES: one sentence on what you changed in the document, or why you could not
//
// The footer is what the agent says; whether the document really changed is decided by the
// runner from the file's hash. The report only words the status and the run summary.

const OUTCOME_PATTERN = /^(UPDATED|UNCHANGED|FAILED)[^\p{L}\p{N}]*$/iu

/** Footer labels, normalized: upper case without spaces, dashes or underscores. */
const LABELS: Record<string, keyof DocumentUpdateReport | 'document'> = {
  DOCUMENT: 'document',
  VERIFIED: 'verified',
  VERIFICATION: 'verified',
  FOLLOWUPS: 'followUps',
  FOLLOWUP: 'followUps',
  NOTES: 'notes',
  NOTE: 'notes'
}

type FooterField = (typeof LABELS)[string]

/**
 * A footer line as `[field, value]`, or null. Agents decorate the block they were asked for:
 * "**DOCUMENT:** UPDATED", "`NOTES: …`", "- Follow-ups: none", "## Document: updated".
 */
function readFooterLine(line: string): [FooterField, string] | null {
  const plain = line.replace(/[*`]/g, '')
  const match = /^[-+>#\s]*_*([A-Za-z][A-Za-z _-]{1,20}?)_*\s*:\s*(.*)$/.exec(plain)
  if (!match) return null
  const field = LABELS[match[1].toUpperCase().replace(/[\s_-]+/g, '')]
  return field ? [field, match[2].replace(/^_+|_+$/g, '').trim()] : null
}

/** One footer value: null when the agent left it empty or wrote "none". */
const optionalValue = (value: string | undefined): string | null =>
  value === undefined || isNoneLike(value) ? null : value

/**
 * Read the agent's DOCUMENT footer from its final message, or null when the message has none.
 * Tolerant of case and markdown decoration; when the block appears more than once (the agent
 * quoted the format, then filled it in), the last one wins. The template line itself
 * ("UPDATED | UNCHANGED | FAILED") is not an outcome. Follow-ups are split on semicolons, and a
 * bulleted list under the FOLLOW-UPS line is read as more of them.
 */
export function parseDocumentUpdateFooter(text: string): DocumentUpdateReport | null {
  const lines = text.split(/\r?\n/)
  let start = -1
  let outcome: DocumentUpdateReport['outcome'] | null = null
  for (let index = lines.length - 1; index >= 0; index--) {
    const footer = readFooterLine(lines[index])
    const written = footer?.[0] === 'document' ? OUTCOME_PATTERN.exec(footer[1]) : null
    if (written) {
      start = index
      outcome = written[1].toLowerCase() as DocumentUpdateReport['outcome']
      break
    }
  }
  if (start === -1 || outcome === null) return null

  const values = new Map<FooterField, string>()
  let followUps: string[] = []
  let inFollowUps = false
  for (const line of lines.slice(start + 1)) {
    const footer = readFooterLine(line)
    if (footer) {
      const [field, value] = footer
      // A later DOCUMENT line (the template quoted again) ends the block.
      if (field === 'document') break
      inFollowUps = field === 'followUps'
      values.set(field, value)
      if (inFollowUps) followUps = splitFollowUps(value)
      continue
    }
    const bullet = /^\s*(?:[-*•]|\d{1,3}[.)])\s+(.+)$/.exec(line)
    if (inFollowUps && bullet) {
      if (!isNoneLike(bullet[1])) followUps.push(bullet[1].replace(/[*`]/g, '').trim())
    } else if (line.trim() !== '') {
      inFollowUps = false
    }
  }
  // An agent that wrote the other lines above the DOCUMENT line, in the same block.
  for (let index = start - 1; index >= 0; index--) {
    const footer = readFooterLine(lines[index])
    if (!footer || footer[0] === 'document') break
    if (values.has(footer[0])) continue
    values.set(footer[0], footer[1])
    if (footer[0] === 'followUps') followUps = splitFollowUps(footer[1])
  }

  return {
    outcome,
    verified: optionalValue(values.get('verified')),
    followUps,
    notes: optionalValue(values.get('notes'))
  }
}

/** "none", or a semicolon-separated list. */
function splitFollowUps(value: string): string[] {
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => !isNoneLike(entry))
}
