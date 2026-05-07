const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g
const TRAILING_PUNCT_CHARS = new Set([')', '.', ',', ';', ':', '!', '?', ']', "'", '"', '`'])

export function trimTrailingPunct(url: string): string {
  let out = url

  while (out.length > 0) {
    const last = out[out.length - 1]
    if (!TRAILING_PUNCT_CHARS.has(last)) break

    if (last === ')') {
      const withoutLast = out.slice(0, -1)
      const opens = (withoutLast.match(/\(/g) || []).length
      const closes = (withoutLast.match(/\)/g) || []).length
      if (opens > closes) break
    }

    out = out.slice(0, -1)
  }

  return out
}

export type LineChunk =
  | { type: 'text'; content: string }
  | { type: 'url'; content: string; url: string }

export function splitLineByUrls(line: string): LineChunk[] {
  URL_RE.lastIndex = 0

  const chunks: LineChunk[] = []
  const pushText = (content: string): void => {
    const previous = chunks[chunks.length - 1]
    if (previous?.type === 'text') {
      previous.content += content
      return
    }
    chunks.push({ type: 'text', content })
  }
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = URL_RE.exec(line)) !== null) {
    const rawUrl = match[0]
    const url = trimTrailingPunct(rawUrl)

    pushText(line.slice(lastIndex, match.index))

    if (url.length > 0) {
      chunks.push({ type: 'url', content: url, url })
    }

    const trailingStart = match.index + url.length
    const trailingEnd = match.index + rawUrl.length
    if (trailingStart < trailingEnd) {
      pushText(line.slice(trailingStart, trailingEnd))
    }

    lastIndex = trailingEnd
  }

  if (chunks.length === 0) {
    return [{ type: 'text', content: line }]
  }

  pushText(line.slice(lastIndex))
  return chunks
}
