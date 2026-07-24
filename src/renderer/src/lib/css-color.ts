/** Read a CSS custom property from :root. */
export function getCssVar(name: string, fallback = ''): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** Convert HSL ("260 15% 8%" or hsl(...)) to #rrggbb. */
export function hslToHex(hslStr: string): string {
  const cleaned = hslStr.replace(/hsl\(|\)/g, '').trim()
  const parts = cleaned.split(/[\s,]+/).map((p) => parseFloat(p))
  if (parts.length < 3 || parts.some(isNaN)) return ''

  const h = parts[0] / 360
  const s = parts[1] / 100
  const l = parts[2] / 100

  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }

  let r: number, g: number, b: number
  if (s === 0) {
    r = g = b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }

  const toHex = (c: number): string =>
    Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/** Resolve a CSS variable to hex (# or hsl() values). */
export function resolveCssColor(cssVarName: string, fallbackHex: string): string {
  const raw = getCssVar(cssVarName, '')
  if (!raw) return fallbackHex
  if (raw.startsWith('#')) return raw
  const hex = hslToHex(raw)
  return hex || fallbackHex
}

/** Parse rgb()/rgba() from getComputedStyle to #rrggbb (alpha ignored). */
export function rgbStringToHex(rgb: string): string | null {
  const match = rgb.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!match) return null
  const toHex = (n: string): string => Number(n).toString(16).padStart(2, '0')
  return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`
}

/** Read an element's painted text color as hex. */
export function computedColorToHex(element: Element | null, fallbackHex: string): string {
  if (!element || typeof window === 'undefined') return fallbackHex
  return rgbStringToHex(getComputedStyle(element).color) ?? fallbackHex
}
