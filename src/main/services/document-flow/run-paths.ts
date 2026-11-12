// A duplicated run is a copy in a run directory of its own, and the original's absolute paths
// — its source document, run directory and `document.md` — sit in three run columns, in every
// item's description (the "- Full text:" / "- Original document:" lines `extraction.ts
// describeTicket` writes), in figure paths and in `blocks.json`'s figure `src`. The copy gets
// its own paths and treats the original's as plain search strings. The matching itself is the
// shared `rewritePaths`: exact strings, longest first, and only where the match starts and ends
// at a path boundary, so `/x/run` never touches `/x/run2`, `/x/run.md`, `/Volumes/bk/x/run` or
// `/x/run%2Fy`. What this module adds is the run-shaped walk over the columns, items and
// blocks file.
import { z } from 'zod'
import type { PreprocessedDocument } from '@shared/document-flow/preprocess'
import { rewritePaths } from '@shared/lib/path-rewrite'

/** Old path → new path. Keys are search strings only, never destinations. */
export type RunPathMap = Readonly<Record<string, string>>

/** A path with its trailing separators dropped (`/` alone is kept), so `/a/b/` and `/a/b` are one key. */
const normalizeKey = (path: string): string => {
  const trimmed = path.replace(/[/\\]+$/, '')
  return trimmed === '' ? path.slice(0, 1) : trimmed
}

/**
 * `text` with every occurrence of a map key replaced, longest key first, whole paths only —
 * also inside `file:` URLs, raw or percent-encoded (`rewritePaths` tries the encoded spelling
 * of every key). Empty and identity keys are ignored; the first spelling of a key wins when
 * two differ only by a trailing separator.
 */
export function rewritePathsInText(text: string, map: RunPathMap): string {
  if (text.length === 0) return text
  const normalized: Record<string, string> = {}
  for (const [rawFrom, rawTo] of Object.entries(map)) {
    const from = normalizeKey(rawFrom)
    if (!from.trim() || from in normalized) continue
    normalized[from] = normalizeKey(rawTo)
  }
  return rewritePaths(text, normalized)
}

/** The run columns that hold paths. */
export interface RewritableRunColumns {
  source_path: string
  run_dir: string
  document_path: string | null
}

/** The item fields an old path can appear in. */
export interface RewritableItem {
  title: string
  summary: string
  description: string
  open_questions: string[]
  figures: { id: string; path: string; label: string }[]
}

/**
 * The run and its items with every old path rewritten: the three path columns, the
 * description (its two spec-file lines and anything else that quotes a path), title, summary,
 * open questions, and each figure's path. Other fields are returned as they are.
 */
export function rewriteRunPaths<R extends RewritableRunColumns, I extends RewritableItem>(
  detail: { run: R; items: readonly I[] },
  map: RunPathMap
): { run: R; items: I[] } {
  const text = (value: string): string => rewritePathsInText(value, map)
  return {
    run: {
      ...detail.run,
      source_path: text(detail.run.source_path),
      run_dir: text(detail.run.run_dir),
      document_path: detail.run.document_path === null ? null : text(detail.run.document_path)
    },
    items: detail.items.map((item) => ({
      ...item,
      title: text(item.title),
      summary: text(item.summary),
      description: text(item.description),
      open_questions: item.open_questions.map(text),
      figures: item.figures.map((figure) => ({ ...figure, path: text(figure.path) }))
    }))
  }
}

// ── blocks.json ─────────────────────────────────────────────────────────────────────────

const DocumentBlockSchema = z.object({
  id: z.number().int(),
  type: z.enum(['heading', 'paragraph', 'list-item', 'table-row', 'figure', 'code']),
  level: z.number().int().optional(),
  anchor: z.string().nullable().optional(),
  text: z.string()
})

const DocumentFigureDataSchema = z.object({
  id: z.string(),
  alt: z.string(),
  mime: z.string().nullable(),
  base64: z.string().nullable(),
  src: z.string().nullable()
})

/**
 * What `writeRunFiles` puts in `blocks.json`: the pre-processed document without image
 * payloads. Unknown keys are dropped rather than refused, so a file from a newer app still
 * imports; anything that is not this shape is not a blocks file.
 */
export const PreprocessedDocumentSchema = z.object({
  title: z.string(),
  format: z.enum(['html', 'markdown', 'text']),
  blocks: z.array(DocumentBlockSchema),
  figures: z.array(DocumentFigureDataSchema),
  text: z.string()
})

export type RewriteBlocksJsonResult =
  { ok: true; json: string; doc: PreprocessedDocument } | { ok: false; error: string }

/**
 * A received `blocks.json`, validated and with the figures' `src` (the only place a path can
 * live: the original `<img src>`) rewritten and their payloads cleared. Invalid JSON or a
 * foreign shape is reported, not stored.
 */
export function rewriteBlocksJson(text: string, map: RunPathMap): RewriteBlocksJsonResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `blocks.json is not JSON: ${(error as Error).message}` }
  }
  const result = PreprocessedDocumentSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    return { ok: false, error: `blocks.json has an unexpected shape${where}` }
  }
  const doc: PreprocessedDocument = {
    ...result.data,
    figures: result.data.figures.map((figure) => ({
      ...figure,
      base64: null,
      src: figure.src === null ? null : rewritePathsInText(figure.src, map)
    }))
  }
  return { ok: true, json: JSON.stringify(doc), doc }
}
