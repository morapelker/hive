// A run copied into a directory of its own (a duplicate of an "Implement document" run) keeps
// the original's absolute paths only as text — inside a run's description lines or
// blocks.json. This helper replaces those occurrences with the copy's paths.
//
// Why exact strings and not a regex or `split/join`: the map can hold a prefix and a longer
// path that starts with it (`/runs/r1` and `/runs/r1/document.md`), so the longest key must win
// at every position; and `/tmp/a/run` must not touch `/tmp/a/run2/x` or `/tmp/a/run.md`, so a
// match has to end (and start) at a segment boundary. Pure, no Node imports.

/** Old path → new path. Keys are search strings, values are what replaces them. */
export type PathRewriteMap = Readonly<Record<string, string>>

/**
 * Characters that continue a path or a file name: a match followed or preceded by one of these
 * is a partial segment (`/a/run` inside `/a/run2`, `/a/doc` inside `/a/doc.md`, `/tmp/x`
 * inside `/Users/me/tmp/x`) and is left alone. A separator before the key is fine — that is how
 * `file:///tmp/x` carries `/tmp/x`.
 */
const PATH_CONTINUATION = /[A-Za-z0-9_.~%+@-]/

const isBoundary = (char: string | undefined): boolean =>
  char === undefined || !PATH_CONTINUATION.test(char)

/**
 * The boundary after a match: a `.` only continues the path when something path-like follows
 * it (`/a/doc.md`); a sentence-ending `/a/doc.` is a whole path.
 */
const isBoundaryAfter = (text: string, index: number): boolean => {
  const char = text[index]
  if (char === '.') return isBoundary(text[index + 1]) || text[index + 1] === '.'
  return isBoundary(char)
}

interface RewriteEntry {
  readonly search: string
  readonly replace: string
}

/**
 * Every spelling of a map entry worth matching: the path as given and, when it differs, its
 * percent-encoded form (`file://` urls encode spaces and other reserved characters). Sorted
 * longest search string first so the most specific path wins at a position.
 */
const entriesOf = (map: PathRewriteMap): RewriteEntry[] => {
  const entries: RewriteEntry[] = []
  for (const [search, replace] of Object.entries(map)) {
    if (search.length === 0 || search === replace) continue
    entries.push({ search, replace })
    const encodedSearch = safeEncodeUri(search)
    if (encodedSearch !== null && encodedSearch !== search) {
      entries.push({ search: encodedSearch, replace: safeEncodeUri(replace) ?? replace })
    }
  }
  return entries.sort((a, b) => b.search.length - a.search.length)
}

const safeEncodeUri = (value: string): string | null => {
  try {
    return encodeURI(value)
  } catch {
    return null
  }
}

/**
 * Replace every whole-path occurrence of a map key in `text` by its value, longest key first.
 * Replacements never cascade (a value is not searched again), so a map that swaps two paths is
 * safe. Text without any key is returned unchanged (same reference).
 */
export const rewritePaths = (text: string, map: PathRewriteMap): string => {
  const entries = entriesOf(map)
  if (entries.length === 0 || text.length === 0) return text

  let output = ''
  let cursor = 0
  let changed = false
  while (cursor < text.length) {
    let matched: RewriteEntry | null = null
    for (const entry of entries) {
      if (!text.startsWith(entry.search, cursor)) continue
      if (!isBoundary(text[cursor - 1]) || !isBoundaryAfter(text, cursor + entry.search.length))
        continue
      matched = entry
      break
    }
    if (matched) {
      output += matched.replace
      cursor += matched.search.length
      changed = true
    } else {
      output += text[cursor]
      cursor += 1
    }
  }
  return changed ? output : text
}

/**
 * The attachments array of a ticket with every `url` rewritten through `rewritePaths`. Entries
 * that are not objects with a string `url` are kept as they are; the array is always a copy.
 */
export const rewriteAttachmentUrls = (
  attachments: readonly unknown[],
  map: PathRewriteMap
): unknown[] =>
  attachments.map((attachment) => {
    if (!attachment || typeof attachment !== 'object') return attachment
    const url = (attachment as { url?: unknown }).url
    if (typeof url !== 'string') return attachment
    const rewritten = rewritePaths(url, map)
    return rewritten === url ? attachment : { ...attachment, url: rewritten }
  })
