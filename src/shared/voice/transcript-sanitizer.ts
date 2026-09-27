/**
 * Defensive post-processing of the AI cleanup output, ported from Wispelker's
 * TranscriptSanitizer. The model is told to reply with the cleaned text only;
 * when it wraps, labels, quotes or "answers" instead, the raw transcript is
 * pasted so text always lands.
 *
 * Improvements over the reference: unclosed reasoning blocks are stripped
 * too, a leading "Result:" label is only removed when the speaker did not
 * dictate it, and an output that shares too few words with the transcript
 * (the model answered instead of cleaning) falls back as well.
 */

const THINK_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi
const UNCLOSED_THINK_BLOCK = /^\s*<(think|thinking|reasoning)>[\s\S]*$/i
const ECHO_TAGS = ['transcript', 'cleaned'] as const
const LEADING_LABEL = /^(Cleaned(?: text| transcript)?|Output|Result):\s*/i
const ASSISTANT_OPENER =
  /^(I'm sorry|I can(?:not|'t)|As an AI|Sure[,!]|Here(?:'s| is)\b|Certainly[,!]|Of course[,!]|I'd be happy to|I apologi[sz]e)/i

const FILLER_TOKENS = new Set([
  'um',
  'uh',
  'er',
  'ah',
  'like',
  'you',
  'know',
  'sort',
  'kind',
  'of',
  'so',
  'yeah',
  'okay',
  'ok',
  'the',
  'a',
  'an',
  'and',
  'to'
])
const CONTENT_DRIFT_MIN_TOKENS = 8
const CONTENT_DRIFT_MIN_OVERLAP = 0.5

function charCount(value: string): number {
  return Array.from(value).length
}

function isAlphanumericLine(line: string): boolean {
  return Array.from(line).every((ch) => /[\p{L}\p{N}]/u.test(ch))
}

/** Lowercase, letters/digits/spaces only (any script), spaces collapsed. */
export function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/ +/g, ' ')
    .trim()
}

export function sanitizeTranscriptOutput(output: string, rawTranscript = ''): string {
  let text = output.replace(THINK_BLOCK, '')
  if (UNCLOSED_THINK_BLOCK.test(text)) text = ''
  text = text.trim()

  // A single wrapping code fence (optionally with a language tag line).
  if (text.startsWith('```') && text.endsWith('```') && charCount(text) > 6) {
    const inner = text.slice(3, -3)
    if (!inner.includes('```')) {
      let unwrapped = inner
      const newline = inner.indexOf('\n')
      if (newline !== -1) {
        const firstLine = inner.slice(0, newline)
        if (isAlphanumericLine(firstLine)) {
          unwrapped = inner.slice(newline + 1)
        }
      }
      text = unwrapped.trim()
    }
  }

  for (const tag of ECHO_TAGS) {
    const open = `<${tag}>`
    const close = `</${tag}>`
    if (
      text.startsWith(open) &&
      text.endsWith(close) &&
      text.length >= open.length + close.length
    ) {
      text = text.slice(open.length, text.length - close.length).trim()
    }
  }

  const label = LEADING_LABEL.exec(text)
  if (label) {
    const labelWord = normalizeForComparison(label[1]).split(' ')[0]
    const rawStart = normalizeForComparison(rawTranscript)
    const dictated = rawStart === labelWord || rawStart.startsWith(`${labelWord} `)
    if (!dictated) text = text.slice(label[0].length)
  }

  const rawFirst = Array.from(rawTranscript)[0]
  const rawStartsWithQuote = rawFirst === '"' || rawFirst === '“'
  if (!rawStartsWithQuote) {
    for (const [open, close] of [
      ['"', '"'],
      ['“', '”']
    ] as const) {
      const chars = Array.from(text)
      if (chars.length < 2) continue
      if (chars[0] !== open || chars[chars.length - 1] !== close) continue
      const inner = chars.slice(1, -1).join('')
      if (inner.includes(open) || inner.includes(close)) continue
      text = inner
      break
    }
  }

  return text.trim()
}

export type FallbackReason =
  'emptyOutput' | 'runawayLength' | 'suspectedSummarization' | 'assistantVoice' | 'contentDrift'

export const FALLBACK_REASON_DESCRIPTIONS: Record<FallbackReason, string> = {
  emptyOutput: 'model returned empty output',
  runawayLength: 'output much longer than transcript',
  suspectedSummarization: 'output much shorter than transcript',
  assistantVoice: 'output looks like an assistant reply',
  contentDrift: 'output does not match the transcript'
}

function contentTokens(value: string): string[] {
  return normalizeForComparison(value)
    .split(' ')
    .filter((token) => token.length > 0 && !FILLER_TOKENS.has(token))
}

/** Decide whether the sanitised model output is trustworthy; null means "use it". */
export function cleanupFallbackReason(raw: string, sanitized: string): FallbackReason | null {
  const rawTrimmed = raw.trim()
  const rawLength = charCount(rawTrimmed)
  const sanitizedLength = charCount(sanitized)

  if (sanitized.length === 0 && rawTrimmed.length > 0) return 'emptyOutput'
  if (sanitizedLength > 3 * rawLength + 120) return 'runawayLength'
  if (rawLength > 50 && sanitizedLength < Math.floor(rawLength / 4)) return 'suspectedSummarization'

  const opener = ASSISTANT_OPENER.exec(sanitized)
  if (opener) {
    const openerNormalized = normalizeForComparison(opener[0])
    const rawStart = normalizeForComparison(rawTrimmed)
    const rawHasSameOpener =
      rawStart === openerNormalized || rawStart.startsWith(`${openerNormalized} `)
    if (!rawHasSameOpener) return 'assistantVoice'
  }

  // An answer of similar length to the question shares few of its words.
  const rawTokens = contentTokens(rawTrimmed)
  if (rawTokens.length >= CONTENT_DRIFT_MIN_TOKENS) {
    const outputTokens = new Set(contentTokens(sanitized))
    const overlap = rawTokens.filter((token) => outputTokens.has(token)).length / rawTokens.length
    if (overlap < CONTENT_DRIFT_MIN_OVERLAP) return 'contentDrift'
  }

  return null
}
