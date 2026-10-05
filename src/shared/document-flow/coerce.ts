// Coercion of loosely-typed model output (parsed JSON, footer lines) into the shapes the
// document flow stores. Models asked for one spelling regularly answer with another.

export type JsonRecord = Record<string, unknown>

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toSnakeCase = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/** The first of `names` the record has a value for; each name also matches its snake_case twin. */
export function pickField(source: JsonRecord, ...names: string[]): unknown {
  for (const name of names) {
    for (const candidate of [name, toSnakeCase(name)]) {
      const value = source[candidate]
      if (value !== undefined && value !== null) return value
    }
  }
  return undefined
}

export function toText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** "none", "n/a", "-" and friends: how a model (or an agent's footer) writes an empty value. */
export function isNoneLike(text: string): boolean {
  const bare = text
    .trim()
    .replace(/^["'`(]+|["'`).]+$/g, '')
    .toLowerCase()
  return bare === '' || /^(none|n\/a|na|nil|null|nothing|-+|–|—)$/.test(bare)
}

/** A list of non-empty strings from an array, a single string, or a "none"-like placeholder. */
export function toStringList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value]
  const list: string[] = []
  for (const entry of entries) {
    const text = toText(entry)
    if (!isNoneLike(text) && !list.includes(text)) list.push(text)
  }
  return list
}

export function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return typeof value === 'string' && /^(true|yes|y|1)$/i.test(value.trim())
}

/** Control characters become spaces: they break single-line fields and XML-ish attributes. */
export function stripControlChars(text: string): string {
  return text.replace(/\p{Cc}+/gu, ' ')
}
