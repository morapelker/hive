import type { editor } from 'monaco-editor'

export const HIVE_THEME_NAME = 'hive-dark'

/**
 * Create a Monaco editor theme that matches Hive's CSS variable-based dark UI.
 * Falls back to sensible dark defaults when CSS variables aren't available.
 */
function getCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * Convert an HSL CSS variable value to a hex color for Monaco.
 * Handles formats like "260 15% 8%" or "hsl(260 15% 8%)".
 */
function hslToHex(hslStr: string): string {
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

function resolveColor(cssVarName: string, fallbackHex: string): string {
  const raw = getCssVar(cssVarName, '')
  if (!raw) return fallbackHex
  if (raw.startsWith('#')) return raw
  const hex = hslToHex(raw)
  return hex || fallbackHex
}

export function createHiveThemeData(): editor.IStandaloneThemeData {
  const bg = resolveColor('--background', '#09090b')
  const fg = resolveColor('--foreground', '#fafafa')
  const mutedFg = resolveColor('--muted-foreground', '#71717a')
  const border = resolveColor('--border', '#27272a')
  const cardBg = resolveColor('--card', '#0a0a0c')

  return {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      // Editor background & text
      'editor.background': bg,
      'editor.foreground': fg,
      'editorLineNumber.foreground': mutedFg,
      'editorLineNumber.activeForeground': fg,

      // Diff colors — subtle green/red backgrounds
      'diffEditor.insertedTextBackground': '#2ea04333',
      'diffEditor.removedTextBackground': '#f8514933',
      'diffEditor.insertedLineBackground': '#2ea04322',
      'diffEditor.removedLineBackground': '#f8514922',
      'diffEditorGutter.insertedLineBackground': '#2ea04333',
      'diffEditorGutter.removedLineBackground': '#f8514933',

      // Borders & gutters
      'editorGutter.background': bg,
      'editorOverviewRuler.border': border,

      // Selection & highlight
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#264f7840',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.lineHighlightBorder': '#00000000',

      // Scrollbar
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#ffffff15',
      'scrollbarSlider.hoverBackground': '#ffffff25',
      'scrollbarSlider.activeBackground': '#ffffff35',

      // Widget & dropdown (find, etc)
      'editorWidget.background': cardBg,
      'editorWidget.border': border,

      // Minimap
      'minimap.background': bg
    }
  }
}

/**
 * Register the Hive theme with Monaco. Call once before mounting any editor.
 */
export function registerHiveTheme(monaco: typeof import('monaco-editor')): void {
  monaco.editor.defineTheme(HIVE_THEME_NAME, createHiveThemeData())
}
