/**
 * If the input is a JSON string containing a "title" field, extract and return it.
 * Otherwise return the input unchanged. Safe to call on any string.
 */
export function maybeExtractJsonTitle(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return raw
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed?.title === 'string' && parsed.title.trim()) {
      return parsed.title.trim()
    }
  } catch {
    // Not valid JSON
  }
  return raw
}
