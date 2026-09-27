/**
 * Wispelker's hotkey grammar: lowercase, split on "+", one key plus any
 * modifiers. `option+space`, `cmd+shift+d`, `ctrl+f5`, `f19` are all valid.
 * The parsed spec is rendered both for humans ("⌥Space") and as an Electron
 * accelerator ("Alt+Space") so the same string drives the menu shortcut.
 */

export type HotkeyModifier = 'cmd' | 'shift' | 'option' | 'ctrl'

export interface HotkeySpec {
  readonly modifiers: readonly HotkeyModifier[]
  /** Canonical key token, e.g. "space", "d", "f5". */
  readonly key: string
  /** Human-readable form: "⌥Space", "⌘⇧D". */
  readonly display: string
  /** Electron accelerator: "Alt+Space", "CommandOrControl+Shift+D". */
  readonly accelerator: string
}

export class HotkeyParseError extends Error {
  readonly kind: 'empty' | 'unknownToken' | 'noKey' | 'multipleKeys'

  constructor(kind: HotkeyParseError['kind'], message: string) {
    super(message)
    this.name = 'HotkeyParseError'
    this.kind = kind
  }
}

const MODIFIER_TOKENS: Record<string, HotkeyModifier> = {
  cmd: 'cmd',
  command: 'cmd',
  shift: 'shift',
  option: 'option',
  opt: 'option',
  alt: 'option',
  ctrl: 'ctrl',
  control: 'ctrl'
}

const MODIFIER_SYMBOLS: Record<HotkeyModifier, string> = {
  cmd: '⌘',
  shift: '⇧',
  option: '⌥',
  ctrl: '⌃'
}

const MODIFIER_ACCELERATORS: Record<HotkeyModifier, string> = {
  cmd: 'CommandOrControl',
  shift: 'Shift',
  option: 'Alt',
  ctrl: 'Control'
}

const MODIFIER_WORDS: Record<HotkeyModifier, string> = {
  cmd: 'Ctrl',
  shift: 'Shift',
  option: 'Alt',
  ctrl: 'Ctrl'
}

interface KeyToken {
  readonly canonical: string
  readonly label: string
  readonly accelerator: string
}

const KEY_TOKENS = new Map<string, KeyToken>()

function registerKey(names: string[], label: string, accelerator: string): void {
  const canonical = names[0]
  for (const name of names) {
    KEY_TOKENS.set(name, { canonical, label, accelerator })
  }
}

for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
  registerKey([letter], letter.toUpperCase(), letter.toUpperCase())
}
for (const digit of '0123456789') {
  registerKey([digit], digit, digit)
}
registerKey(['space'], 'Space', 'Space')
registerKey(['tab'], '⇥', 'Tab')
registerKey(['return', 'enter'], '↩', 'Return')
registerKey(['escape', 'esc'], '⎋', 'Escape')
registerKey(['delete', 'backspace'], '⌫', 'Backspace')
registerKey(['grave', '`'], '`', '`')
registerKey(['minus', '-'], '-', '-')
registerKey(['equal', '='], '=', '=')
registerKey(['comma', ','], ',', ',')
registerKey(['period', '.'], '.', '.')
registerKey(['slash', '/'], '/', '/')
registerKey(['semicolon', ';'], ';', ';')
registerKey(['quote', "'"], "'", "'")
registerKey(['backslash', '\\'], '\\', '\\')
registerKey(['leftbracket', '['], '[', '[')
registerKey(['rightbracket', ']'], ']', ']')
registerKey(['left'], '←', 'Left')
registerKey(['right'], '→', 'Right')
registerKey(['down'], '↓', 'Down')
registerKey(['up'], '↑', 'Up')
registerKey(['home'], '↖', 'Home')
registerKey(['end'], '↘', 'End')
registerKey(['pageup'], '⇞', 'PageUp')
registerKey(['pagedown'], '⇟', 'PageDown')
for (let n = 1; n <= 20; n++) {
  registerKey([`f${n}`], `F${n}`, `F${n}`)
}

export interface ParseHotkeyOptions {
  /** 'darwin' renders ⌘⌥⇧⌃ symbols; anything else renders "Ctrl+Alt+…". */
  readonly platform?: string
}

/**
 * Parse a Wispelker hotkey string. Throws `HotkeyParseError` with the same
 * messages as the reference app so Settings can show them verbatim.
 */
export function parseHotkey(raw: string, options: ParseHotkeyOptions = {}): HotkeySpec {
  const tokens = raw
    .toLowerCase()
    .split('+')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  if (tokens.length === 0) {
    throw new HotkeyParseError('empty', 'hotkey is empty')
  }

  const modifiers: HotkeyModifier[] = []
  let key: KeyToken | null = null
  let keyName: string | null = null

  for (const token of tokens) {
    const modifier = MODIFIER_TOKENS[token]
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier)
      continue
    }
    const keyToken = KEY_TOKENS.get(token)
    if (keyToken) {
      if (key && keyName !== null) {
        throw new HotkeyParseError(
          'multipleKeys',
          `hotkey has two keys: "${keyName}" and "${token}"`
        )
      }
      key = keyToken
      keyName = token
      continue
    }
    throw new HotkeyParseError('unknownToken', `unknown hotkey token "${token}"`)
  }

  if (!key) {
    throw new HotkeyParseError('noKey', 'hotkey has modifiers but no key')
  }

  const isMac = (options.platform ?? 'darwin') === 'darwin'
  const display = isMac
    ? `${modifiers.map((m) => MODIFIER_SYMBOLS[m]).join('')}${key.label}`
    : [...modifiers.map((m) => MODIFIER_WORDS[m]), key.label].join('+')
  const accelerator = [...modifiers.map((m) => MODIFIER_ACCELERATORS[m]), key.accelerator].join('+')

  return { modifiers, key: key.canonical, display, accelerator }
}

/** Validate without throwing; returns the error message for inline UI feedback. */
export function validateHotkey(
  raw: string,
  options: ParseHotkeyOptions = {}
): { spec: HotkeySpec; error: null } | { spec: null; error: string } {
  try {
    return { spec: parseHotkey(raw, options), error: null }
  } catch (error) {
    return {
      spec: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
