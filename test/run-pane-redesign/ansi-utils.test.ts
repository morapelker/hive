import { stripAnsi, parseAnsiSegments } from '../../src/renderer/src/lib/ansi-utils'
import type { AnsiSegment } from '../../src/renderer/src/lib/ansi-utils'

// =====================================================
// stripAnsi
// =====================================================
describe('stripAnsi', () => {
  test('removes SGR color codes', () => {
    // \x1b[31m = red, \x1b[0m = reset
    expect(stripAnsi('\x1b[31mhello\x1b[0m')).toBe('hello')
  })

  test('removes SGR bold/underline codes', () => {
    // \x1b[1m = bold, \x1b[4m = underline
    expect(stripAnsi('\x1b[1mbold\x1b[0m \x1b[4munderline\x1b[0m')).toBe('bold underline')
  })

  test('removes compound SGR codes (e.g. bold+red)', () => {
    // \x1b[1;31m = bold red
    expect(stripAnsi('\x1b[1;31mwarning\x1b[0m')).toBe('warning')
  })

  test('removes OSC sequences (e.g. terminal title)', () => {
    // OSC to set terminal title: \x1b]0;title\x07
    expect(stripAnsi('\x1b]0;My Terminal\x07output here')).toBe('output here')
  })

  test('removes CSI cursor movement sequences', () => {
    // \x1b[2A = cursor up 2, \x1b[3B = cursor down 3
    expect(stripAnsi('\x1b[2Ahello\x1b[3Bworld')).toBe('helloworld')
  })

  test('removes CSI erase sequences', () => {
    // \x1b[2J = clear screen, \x1b[K = erase to end of line
    expect(stripAnsi('\x1b[2J\x1b[Kvisible')).toBe('visible')
  })

  test('removes multiple mixed ANSI codes', () => {
    const input = '\x1b[1;32m✓\x1b[0m test passed \x1b[90m(2ms)\x1b[0m'
    expect(stripAnsi(input)).toBe('✓ test passed (2ms)')
  })

  test('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
    expect(stripAnsi('no ansi here at all')).toBe('no ansi here at all')
  })

  test('returns empty string unchanged', () => {
    expect(stripAnsi('')).toBe('')
  })

  test('handles string that is only ANSI codes', () => {
    expect(stripAnsi('\x1b[31m\x1b[0m')).toBe('')
  })
})

// =====================================================
// parseAnsiSegments
// =====================================================
describe('parseAnsiSegments', () => {
  test('returns empty array for empty string', () => {
    expect(parseAnsiSegments('')).toEqual([])
  })

  test('handles plain text with no ANSI codes', () => {
    const result = parseAnsiSegments('hello world')
    expect(result).toEqual([{ raw: 'hello world', text: 'hello world' }])
  })

  test('splits into correct segments for colored text', () => {
    const input = '\x1b[31mhello\x1b[0m'
    const result = parseAnsiSegments(input)

    expect(result).toEqual<AnsiSegment[]>([
      { raw: '\x1b[31m', text: '' },
      { raw: 'hello', text: 'hello' },
      { raw: '\x1b[0m', text: '' }
    ])
  })

  test('handles text before and after ANSI codes', () => {
    const input = 'before\x1b[1mbolded\x1b[0mafter'
    const result = parseAnsiSegments(input)

    expect(result).toEqual<AnsiSegment[]>([
      { raw: 'before', text: 'before' },
      { raw: '\x1b[1m', text: '' },
      { raw: 'bolded', text: 'bolded' },
      { raw: '\x1b[0m', text: '' },
      { raw: 'after', text: 'after' }
    ])
  })

  test('handles multiple consecutive ANSI codes', () => {
    // bold + red + text + reset
    const input = '\x1b[1m\x1b[31mtext\x1b[0m'
    const result = parseAnsiSegments(input)

    expect(result).toEqual<AnsiSegment[]>([
      { raw: '\x1b[1m', text: '' },
      { raw: '\x1b[31m', text: '' },
      { raw: 'text', text: 'text' },
      { raw: '\x1b[0m', text: '' }
    ])
  })

  test('handles OSC sequences', () => {
    const input = '\x1b]0;title\x07content'
    const result = parseAnsiSegments(input)

    expect(result).toEqual<AnsiSegment[]>([
      { raw: '\x1b]0;title\x07', text: '' },
      { raw: 'content', text: 'content' }
    ])
  })

  test('handles CSI sequences', () => {
    const input = '\x1b[2Jhello'
    const result = parseAnsiSegments(input)

    expect(result).toEqual<AnsiSegment[]>([
      { raw: '\x1b[2J', text: '' },
      { raw: 'hello', text: 'hello' }
    ])
  })

  test('segments text values join to match stripAnsi output', () => {
    const input = '\x1b[1;32m✓\x1b[0m test \x1b[90m(2ms)\x1b[0m'
    const segments = parseAnsiSegments(input)
    const joinedText = segments.map((s) => s.text).join('')
    expect(joinedText).toBe(stripAnsi(input))
  })

  test('segments raw values join to match original input', () => {
    const input = '\x1b[1;32m✓\x1b[0m test \x1b[90m(2ms)\x1b[0m'
    const segments = parseAnsiSegments(input)
    const joinedRaw = segments.map((s) => s.raw).join('')
    expect(joinedRaw).toBe(input)
  })

  test('handles string that is only ANSI codes', () => {
    const input = '\x1b[31m\x1b[0m'
    const result = parseAnsiSegments(input)

    expect(result).toEqual<AnsiSegment[]>([
      { raw: '\x1b[31m', text: '' },
      { raw: '\x1b[0m', text: '' }
    ])
  })

  test('handles compound SGR parameters', () => {
    const input = '\x1b[1;4;31mformatted\x1b[0m'
    const result = parseAnsiSegments(input)

    expect(result).toEqual<AnsiSegment[]>([
      { raw: '\x1b[1;4;31m', text: '' },
      { raw: 'formatted', text: 'formatted' },
      { raw: '\x1b[0m', text: '' }
    ])
  })
})
