import type { editor } from 'monaco-editor'
import { resolveCssColor } from '@/lib/css-color'

export const HIVE_THEME_NAME = 'hive-dark'

export function createHiveThemeData(): editor.IStandaloneThemeData {
  const bg = resolveCssColor('--background', '#09090b')
  const fg = resolveCssColor('--foreground', '#fafafa')
  const mutedFg = resolveCssColor('--muted-foreground', '#71717a')
  const border = resolveCssColor('--border', '#27272a')
  const cardBg = resolveCssColor('--card', '#0a0a0c')

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
