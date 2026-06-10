/**
 * Font resolution for the xterm.js terminal backend.
 *
 * The user's Ghostty config can name fonts that Chromium cannot resolve as a
 * CSS font-family (Ghostty does its own font discovery). If such a name were
 * passed to xterm.js as the entire font stack, the browser would silently fall
 * back to a proportional font and break the terminal's cell metrics. These
 * helpers validate Ghostty families via canvas measurement and always append
 * a known-good monospace stack.
 */

/** Default monospace stack. JetBrains Mono is bundled via @font-face in globals.css. */
export const DEFAULT_XTERM_FONT_STACK = '"JetBrains Mono", Menlo, Monaco, Consolas, monospace'

/** JetBrains Mono variants preloaded so xterm.js measures cells with the real font. */
const BUNDLED_FONT_VARIANTS = [
  '13px "JetBrains Mono"',
  'bold 13px "JetBrains Mono"',
  'italic 13px "JetBrains Mono"',
  'bold italic 13px "JetBrains Mono"'
]

function defaultFonts(): FontFaceSet | undefined {
  return typeof document !== 'undefined' ? document.fonts : undefined
}

/** Wrap a family name in double quotes, stripping any existing surrounding quotes. */
export function quoteFontFamily(name: string): string {
  const stripped = name.trim().replace(/^"(.*)"$/, '$1').trim()
  return `"${stripped}"`
}

/**
 * Clamp a Ghostty font-size to a range xterm.js renders sanely. Ghostty
 * point sizes and CSS px are both logical pixels on macOS (1:1 at any
 * backing scale), so the value passes through unconverted.
 */
export function clampTerminalFontSize(size: number | undefined): number | undefined {
  if (size === undefined) return undefined
  return Math.min(32, Math.max(6, size))
}

export interface ResolvedTerminalFont {
  /** Full CSS font-family value to hand to xterm.js */
  fontFamily: string
  /** Primary Ghostty family, if any was configured */
  primary: string | null
  /** Whether the primary family resolved in the browser */
  primaryResolved: boolean
  /** Ghostty families dropped because the browser cannot resolve them */
  dropped: string[]
}

let measureContext: CanvasRenderingContext2D | null | undefined

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement('canvas').getContext('2d')
    } catch {
      measureContext = null
    }
  }
  return measureContext
}

/**
 * Whether the browser can resolve a font family by name. Canvas measurement
 * is used because `document.fonts.check()` returns true for ANY unknown
 * system family — it only reports loadability of registered @font-face fonts.
 * A family exists iff pairing it with a generic fallback changes the measured
 * text width relative to the generic alone, for at least one generic. Fails
 * open (returns true) when canvas measurement is unavailable — the appended
 * default stack still protects cell metrics. Must run after
 * ensureTerminalFontsLoaded() so bundled webfonts measure correctly.
 */
export function isFontResolvable(family: string): boolean {
  const ctx = getMeasureContext()
  if (!ctx) return true
  const sample = 'mmmmllliiWW@#10 terminal'
  for (const generic of ['monospace', 'serif']) {
    ctx.font = `16px ${generic}`
    const base = ctx.measureText(sample).width
    ctx.font = `16px ${quoteFontFamily(family)}, ${generic}`
    if (ctx.measureText(sample).width !== base) return true
  }
  return false
}

/**
 * Build the xterm.js font stack from the Ghostty config's font-family list.
 * Unresolvable families are dropped; the default monospace stack is always
 * appended so the terminal can never end up on a proportional fallback.
 */
export function resolveTerminalFontFamily(
  ghosttyFamilies: string[] | undefined,
  isResolvable: (family: string) => boolean = isFontResolvable
): ResolvedTerminalFont {
  const families = (ghosttyFamilies ?? []).map((name) => name.trim()).filter(Boolean)
  const primary = families[0] ?? null
  const kept: string[] = []
  const dropped: string[] = []

  for (const family of families) {
    let resolvable = true
    try {
      resolvable = isResolvable(family)
    } catch {
      resolvable = true
    }
    if (resolvable) {
      kept.push(quoteFontFamily(family))
    } else {
      dropped.push(family)
    }
  }

  return {
    fontFamily: [...kept, DEFAULT_XTERM_FONT_STACK].join(', '),
    primary,
    primaryResolved: primary !== null && !dropped.includes(primary),
    dropped
  }
}

/**
 * Load the bundled JetBrains Mono variants before the terminal is created.
 * xterm.js measures cell dimensions at construction time and cannot be forced
 * to re-measure with the same options, so fonts must be ready first. Bounded
 * by a timeout so a stuck load can never block terminal startup.
 */
export async function ensureTerminalFontsLoaded(
  fonts: Pick<FontFaceSet, 'load'> | undefined = defaultFonts(),
  timeoutMs = 2000
): Promise<void> {
  if (!fonts) return

  const loads = Promise.allSettled(
    BUNDLED_FONT_VARIANTS.map((variant) => Promise.resolve().then(() => fonts.load(variant)))
  ).then(() => undefined)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })

  try {
    await Promise.race([loads, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
