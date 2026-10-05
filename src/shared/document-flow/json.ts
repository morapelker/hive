/**
 * Pull one JSON object out of a model reply that may wrap it in prose or a code fence.
 * Tries, in order: the whole trimmed reply; the outermost `{ … }` slice; a fenced block.
 * (The fence comes last: ticket text legitimately contains ``` inside JSON strings.)
 * Returns undefined when nothing parses to a plain object.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | undefined {
  const text = raw.replace(/^\uFEFF/, '').trim()
  if (!text) return undefined

  const whole = parseObject(text)
  if (whole) return whole

  const sliced = parseBraceSlice(text)
  if (sliced) return sliced

  for (const body of fencedBodies(text)) {
    const fenced = parseObject(body) ?? parseBraceSlice(body)
    if (fenced) return fenced
  }

  return firstBalancedObject(text)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseStrict(candidate: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(candidate)
    if (isPlainObject(parsed)) return parsed
    // Some models double-encode: the reply is a JSON string that holds the object.
    if (typeof parsed === 'string' && parsed.trimStart().startsWith('{')) {
      const inner: unknown = JSON.parse(parsed)
      if (isPlainObject(inner)) return inner
    }
  } catch {
    // Not JSON
  }
  return undefined
}

function parseObject(candidate: string): Record<string, unknown> | undefined {
  const strict = parseStrict(candidate)
  if (strict) return strict
  // Small models leave a comma before a closing bracket often enough to be worth one retry.
  const repaired = removeTrailingCommas(candidate)
  return repaired === candidate ? undefined : parseStrict(repaired)
}

function parseBraceSlice(text: string): Record<string, unknown> | undefined {
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first === -1 || last <= first) return undefined
  return parseObject(text.slice(first, last + 1))
}

/**
 * Bodies of fenced blocks, most inclusive first: from the first fence to the last one (a
 * fenced JSON reply whose strings contain ``` themselves), then each pair in turn.
 */
function fencedBodies(text: string): string[] {
  const fences: number[] = []
  for (let at = text.indexOf('```'); at !== -1; at = text.indexOf('```', at + 3)) fences.push(at)
  if (fences.length < 2) return []

  const body = (open: number, close: number): string => {
    const inner = text.slice(open + 3, close)
    const lineEnd = inner.indexOf('\n')
    // Drop the info string ("json") when the fence has one.
    return lineEnd !== -1 && !inner.slice(0, lineEnd).includes('{')
      ? inner.slice(lineEnd + 1)
      : inner
  }

  const bodies = [body(fences[0], fences[fences.length - 1])]
  if (fences.length > 2) {
    for (let index = 0; index + 1 < fences.length; index += 2) {
      bodies.push(body(fences[index], fences[index + 1]))
    }
  }
  return bodies
}

const MAX_BALANCED_CANDIDATES = 25

/** The first `{ … }` with balanced braces (string-aware) that parses: prose around it may hold braces too. */
function firstBalancedObject(text: string): Record<string, unknown> | undefined {
  let candidates = 0
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    if (++candidates > MAX_BALANCED_CANDIDATES) break
    const end = matchingBrace(text, start)
    if (end === -1) continue
    const parsed = parseObject(text.slice(start, end + 1))
    if (parsed) return parsed
  }
  return undefined
}

function matchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (inString) {
      if (code === 92) index++
      else if (code === 34) inString = false
    } else if (code === 34) {
      inString = true
    } else if (code === 123) {
      depth++
    } else if (code === 125) {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function removeTrailingCommas(text: string): string {
  let out = ''
  let copied = 0
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (inString) {
      if (code === 92) index++
      else if (code === 34) inString = false
      continue
    }
    if (code === 34) {
      inString = true
    } else if (code === 44) {
      let next = index + 1
      while (next < text.length && isJsonWhitespace(text.charCodeAt(next))) next++
      const closer = text.charCodeAt(next)
      if (closer === 125 || closer === 93) {
        out += text.slice(copied, index)
        copied = index + 1
      }
    }
  }
  return copied === 0 ? text : out + text.slice(copied)
}

const isJsonWhitespace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13
