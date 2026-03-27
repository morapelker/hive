function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value)
  if (direct) return direct

  if (!Array.isArray(value)) return null

  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null)

  return parts.length > 0 ? parts.join(' ') : null
}

export function extractCommandText(input: unknown): string {
  const direct = normalizeCommandValue(input)
  if (direct) return direct

  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''

  const record = input as Record<string, unknown>

  return (
    normalizeCommandValue(record.command) ??
    normalizeCommandValue(record.cmd) ??
    normalizeCommandValue(record.argv) ??
    ''
  )
}
