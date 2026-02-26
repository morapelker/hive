/**
 * ANSI escape sequence utilities for search matching and highlight rendering.
 *
 * Covers SGR (Select Graphic Rendition), OSC (Operating System Command),
 * and general CSI (Control Sequence Introducer) escape sequences.
 */

/** Regex matching SGR, OSC, and CSI ANSI escape sequences. */
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\].*?\x07|\x1b\[[0-9;]*[A-Za-z]/g

/**
 * Remove all ANSI escape sequences from a string.
 * Useful for plain-text search matching against terminal output.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/** A segment of an ANSI string split into raw (with codes) and plain text. */
export interface AnsiSegment {
  /** The original string chunk, possibly containing ANSI codes. */
  raw: string
  /** The plain-text content with ANSI codes stripped. */
  text: string
}

/**
 * Split an ANSI-encoded string into segments of `{ raw, text }`.
 *
 * Each segment boundary falls at an ANSI escape sequence. Segments with
 * non-empty `text` represent visible content; segments where `text` is empty
 * are pure escape sequences (styling resets, etc.).
 *
 * This is designed for highlight rendering: consumers can walk the segments,
 * match against `text`, and wrap matched portions in `<mark>` tags while
 * preserving the original `raw` ANSI codes for styling.
 */
export function parseAnsiSegments(input: string): AnsiSegment[] {
  if (input.length === 0) return []

  const segments: AnsiSegment[] = []
  let lastIndex = 0

  // Reset regex state for each call
  ANSI_RE.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = ANSI_RE.exec(input)) !== null) {
    // Text before this ANSI code
    if (match.index > lastIndex) {
      const raw = input.slice(lastIndex, match.index)
      segments.push({ raw, text: raw })
    }
    // The ANSI escape itself
    segments.push({ raw: match[0], text: '' })
    lastIndex = match.index + match[0].length
  }

  // Trailing text after last ANSI code (or entire string if no codes)
  if (lastIndex < input.length) {
    const raw = input.slice(lastIndex)
    segments.push({ raw, text: raw })
  }

  return segments
}
