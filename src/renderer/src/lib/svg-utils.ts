/**
 * Convert SVG text content to a data URI suitable for use as an <img> src.
 *
 * Uses TextEncoder for reliable UTF-8 → bytes conversion instead of the
 * deprecated `unescape(encodeURIComponent(...))` pattern.
 *
 * Returns `null` if encoding fails for any reason (malformed content, etc.).
 */
export function svgToDataUri(svgText: string): string | null {
  try {
    const encoder = new TextEncoder()
    const bytes = encoder.encode(svgText)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return `data:image/svg+xml;base64,${btoa(binary)}`
  } catch {
    return null
  }
}
