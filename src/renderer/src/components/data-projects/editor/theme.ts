// Token-based CodeMirror theme for the data-project editors, light and dark, built from the app's
// CSS variables so it follows every theme preset (the file viewer's editors hard-code oneDark,
// which is wrong under the light presets).
//
// Syntax colours: `@lezer/highlight` (where `tags` lives) is not a direct dependency of the app,
// so instead of a HighlightStyle this module ships a tiny Highlighter that maps a token's tag
// NAMES (Tag#toString(): "keyword", "string", "standard(name)", ...) to `cm-dp-tok-*` classes,
// and the theme colours those classes through `--dp-syn-*` variables set per light/dark. Walking
// `tag.set` (the tag and its parents) means `lineComment` falls back to `comment`, `bool` to
// `literal`, and so on, exactly like a HighlightStyle would.

import { syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

type Highlighter = Parameters<typeof syntaxHighlighting>[0]
type HighlightTag = Parameters<Highlighter['style']>[0][number]

// Most specific first: the first name of a tag's set that appears here decides its class.
const TAG_CLASSES: ReadonlyArray<readonly [string, string]> = [
  ['standard(name)', 'builtin'],
  ['function(variableName)', 'function'],
  ['function(propertyName)', 'function'],
  ['special(name)', 'variable'],
  ['special(string)', 'quoted'],
  ['definition(propertyName)', 'property'],
  ['definition(variableName)', 'definition'],
  ['keyword', 'keyword'],
  ['operatorKeyword', 'keyword'],
  ['controlKeyword', 'keyword'],
  ['definitionKeyword', 'keyword'],
  ['moduleKeyword', 'keyword'],
  ['typeName', 'type'],
  ['className', 'type'],
  ['comment', 'comment'],
  ['string', 'string'],
  ['regexp', 'string'],
  ['escape', 'string'],
  ['number', 'number'],
  ['bool', 'atom'],
  ['null', 'atom'],
  ['atom', 'atom'],
  ['literal', 'number'],
  ['propertyName', 'property'],
  ['operator', 'operator'],
  ['punctuation', 'punctuation'],
  ['invalid', 'invalid'],
  ['meta', 'meta']
]
const CLASS_BY_TAG = new Map(TAG_CLASSES)

const classForTag = (tag: HighlightTag): string | null => {
  // `set` holds the tag itself first, then its parents in decreasing specificity.
  for (const candidate of tag.set) {
    const cls = CLASS_BY_TAG.get(candidate.toString())
    if (cls) return cls
  }
  return null
}

/** Maps highlight tags to `cm-dp-tok-<kind>` classes (see the file header). */
export const dataEditorHighlighter: Highlighter = {
  style(tags) {
    const classes = new Set<string>()
    for (const tag of tags) {
      const cls = classForTag(tag)
      if (cls) classes.add(`cm-dp-tok-${cls}`)
    }
    return classes.size ? [...classes].join(' ') : null
  }
}

/** The class a tag name resolves to; exported for tests. */
export const tokenClassForTagName = (name: string): string | null => CLASS_BY_TAG.get(name) ?? null

// Palettes: tuned to read on the app's neutral greyscale surfaces (Orca), not a full IDE theme.
const DARK_SYNTAX: Record<string, string> = {
  keyword: '#c792ea',
  builtin: '#82aaff',
  function: '#82aaff',
  type: '#ffcb6b',
  string: '#c3e88d',
  quoted: '#f2c48d',
  number: '#f78c6c',
  atom: '#f78c6c',
  comment: '#7f8a99',
  operator: '#89ddff',
  punctuation: '#9aa4b2',
  property: '#9cdcfe',
  variable: '#f07178',
  definition: '#e6e6e6',
  invalid: '#ff5370',
  meta: '#9aa4b2'
}
const LIGHT_SYNTAX: Record<string, string> = {
  keyword: '#7c3aed',
  builtin: '#1d4ed8',
  function: '#1d4ed8',
  type: '#b45309',
  string: '#15803d',
  quoted: '#9a3412',
  number: '#c2410c',
  atom: '#c2410c',
  comment: '#6b7280',
  operator: '#0e7490',
  punctuation: '#52525b',
  property: '#0369a1',
  variable: '#be123c',
  definition: '#18181b',
  invalid: '#dc2626',
  meta: '#52525b'
}

const syntaxVars = (palette: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(palette).map(([k, v]) => [`--dp-syn-${k}`, v]))

const tokenRules = Object.fromEntries(
  Object.keys(DARK_SYNTAX).map((kind) => [
    `.cm-dp-tok-${kind}`,
    kind === 'comment'
      ? { color: `var(--dp-syn-${kind})`, fontStyle: 'italic' }
      : kind === 'invalid'
        ? { color: `var(--dp-syn-${kind})`, textDecoration: 'underline wavy' }
        : { color: `var(--dp-syn-${kind})` }
  ])
)

const baseRules = (dark: boolean): Parameters<typeof EditorView.theme>[0] => ({
  '&': {
    ...syntaxVars(dark ? DARK_SYNTAX : LIGHT_SYNTAX),
    height: '100%',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    fontSize: '12.5px'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
    overflow: 'auto'
  },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-gutters': {
    backgroundColor: 'var(--card)',
    color: 'color-mix(in srgb, var(--muted-foreground) 70%, transparent)',
    borderRight: '1px solid var(--border)'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '32px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--foreground) 3.5%, transparent)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--foreground) 5%, transparent)',
    color: 'var(--foreground)'
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    {
      backgroundColor: dark
        ? 'color-mix(in srgb, #60a5fa 30%, transparent)'
        : 'color-mix(in srgb, #3b82f6 22%, transparent)'
    },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, #eab308 18%, transparent)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--foreground) 12%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--foreground) 25%, transparent)'
  },
  '.cm-placeholder': { color: 'var(--muted-foreground)', fontStyle: 'italic' },
  // The statement Cmd+Enter would run (only drawn when the text holds several statements).
  '.cm-dp-current-statement': {
    backgroundColor: dark
      ? 'color-mix(in srgb, #60a5fa 7%, transparent)'
      : 'color-mix(in srgb, #3b82f6 6%, transparent)'
  },
  '.cm-dp-current-statement.cm-activeLine': {
    backgroundColor: dark
      ? 'color-mix(in srgb, #60a5fa 11%, transparent)'
      : 'color-mix(in srgb, #3b82f6 9%, transparent)'
  },
  // Server error position (QueryEditor `errorRange`).
  '.cm-dp-error': {
    textDecoration: 'underline wavy #ef4444',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
    backgroundColor: 'color-mix(in srgb, #ef4444 10%, transparent)'
  },
  '.cm-dp-error-tooltip': {
    padding: '4px 8px',
    maxWidth: '480px',
    fontSize: '12px',
    color: dark ? '#fecaca' : '#991b1b',
    whiteSpace: 'pre-wrap'
  },
  // Tooltips/completions above z-50 dialogs and the app chrome; glass surface like menus.
  '.cm-tooltip': {
    zIndex: '60',
    border: dark ? '1px solid rgba(255,255,255,0.14)' : '1px solid rgba(0,0,0,0.14)',
    borderRadius: '8px',
    backgroundColor: dark ? 'rgba(20,20,22,0.96)' : 'rgba(255,255,255,0.97)',
    color: 'var(--popover-foreground)',
    boxShadow: '0 16px 36px rgba(0,0,0,0.24)',
    overflow: 'hidden'
  },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    maxHeight: '280px',
    minWidth: '240px'
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px !important', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: dark ? 'rgba(96,165,250,0.28)' : 'rgba(59,130,246,0.16)',
    color: 'var(--foreground)'
  },
  '.cm-completionDetail': {
    marginLeft: '10px',
    fontStyle: 'normal',
    color: 'var(--muted-foreground)',
    fontSize: '11px'
  },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  '.cm-completionSection': {
    padding: '3px 8px 2px',
    fontFamily: 'var(--font-sans)',
    fontSize: '10px',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--muted-foreground)',
    borderBottom: '1px solid var(--border)'
  },
  '.cm-completionInfo': {
    padding: '6px 8px',
    fontSize: '12px',
    maxWidth: '360px'
  },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--foreground)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, #eab308 28%, transparent)',
    outline: '1px solid color-mix(in srgb, #eab308 45%, transparent)'
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, #f97316 35%, transparent)'
  },
  '.cm-textfield': {
    backgroundColor: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: '5px',
    color: 'var(--foreground)',
    fontSize: '12px'
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--secondary)',
    border: '1px solid var(--border)',
    borderRadius: '5px',
    color: 'var(--foreground)',
    fontSize: '12px'
  },
  ...tokenRules
})

const DARK_THEME = EditorView.theme(baseRules(true), { dark: true })
const LIGHT_THEME = EditorView.theme(baseRules(false), { dark: false })
const HIGHLIGHTING = syntaxHighlighting(dataEditorHighlighter)

/** Theme + syntax colours for one mode; reconfigure it when the app theme changes. */
export const dataEditorTheme = (dark: boolean): Extension => [
  dark ? DARK_THEME : LIGHT_THEME,
  HIGHLIGHTING
]
