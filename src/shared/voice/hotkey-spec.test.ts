import { describe, expect, it } from 'vitest'
import { HotkeyParseError, parseHotkey, validateHotkey } from './hotkey-spec'

describe('parseHotkey', () => {
  it('parses the default option+space', () => {
    const spec = parseHotkey('option+space')
    expect(spec.key).toBe('space')
    expect(spec.modifiers).toEqual(['option'])
    expect(spec.display).toBe('⌥Space')
    expect(spec.accelerator).toBe('Alt+Space')
  })

  it('parses multiple modifiers and a letter', () => {
    const spec = parseHotkey('cmd+shift+d')
    expect(spec.key).toBe('d')
    expect(spec.modifiers).toEqual(['cmd', 'shift'])
    expect(spec.display).toBe('⌘⇧D')
    expect(spec.accelerator).toBe('CommandOrControl+Shift+D')
  })

  it('treats aliases, whitespace and case alike', () => {
    const a = parseHotkey('Alt + Space')
    const b = parseHotkey('opt+space')
    const c = parseHotkey('OPTION+SPACE')
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('parses function keys', () => {
    const spec = parseHotkey('ctrl+f5')
    expect(spec.key).toBe('f5')
    expect(spec.modifiers).toEqual(['ctrl'])
    expect(spec.accelerator).toBe('Control+F5')
  })

  it('allows a bare key without modifiers', () => {
    const spec = parseHotkey('f19')
    expect(spec.modifiers).toEqual([])
    expect(spec.display).toBe('F19')
    expect(spec.accelerator).toBe('F19')
  })

  it('keeps modifier symbols in first-seen order', () => {
    expect(parseHotkey('shift+cmd+d').display).toBe('⇧⌘D')
  })

  it('renders non-mac displays with words', () => {
    expect(parseHotkey('cmd+shift+d', { platform: 'win32' }).display).toBe('Ctrl+Shift+D')
    expect(parseHotkey('option+space', { platform: 'linux' }).display).toBe('Alt+Space')
  })

  it('reports errors with the reference messages', () => {
    expect(() => parseHotkey('')).toThrowError('hotkey is empty')
    expect(() => parseHotkey('option+banana')).toThrowError('unknown hotkey token "banana"')
    expect(() => parseHotkey('cmd+option')).toThrowError('hotkey has modifiers but no key')
    expect(() => parseHotkey('cmd+a+b')).toThrowError('hotkey has two keys: "a" and "b"')
    try {
      parseHotkey('')
    } catch (error) {
      expect(error).toBeInstanceOf(HotkeyParseError)
      expect((error as HotkeyParseError).kind).toBe('empty')
    }
  })

  it('validateHotkey never throws', () => {
    expect(validateHotkey('option+space').error).toBeNull()
    expect(validateHotkey('nope').error).toBe('unknown hotkey token "nope"')
  })
})
