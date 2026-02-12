import { describe, expect, test, vi, beforeEach } from 'vitest'

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-app')
  }
}))

// Mock logger
vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Use the module-level mock pattern matching pty-service.test.ts
const existsSyncMock = vi.fn()
const readFileSyncMock = vi.fn()

vi.mock('fs', () => {
  const existsSync = (...args: unknown[]): unknown => existsSyncMock(...args)
  const readFileSync = (...args: unknown[]): unknown => readFileSyncMock(...args)
  return {
    existsSync,
    readFileSync,
    default: {
      existsSync,
      readFileSync,
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
      readdirSync: vi.fn().mockReturnValue([]),
      statSync: vi.fn(),
      unlinkSync: vi.fn()
    },
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn(),
    unlinkSync: vi.fn()
  }
})

// Import the functions under test
import {
  parseGhosttyConfigContent,
  parseGhosttyConfig
} from '../../src/main/services/ghostty-config'

describe('GhosttyConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    existsSyncMock.mockReturnValue(false)
    readFileSyncMock.mockImplementation(() => {
      throw new Error('File not found')
    })
  })

  describe('parseGhosttyConfigContent', () => {
    test('parses font-family', () => {
      const config = parseGhosttyConfigContent('font-family = JetBrains Mono')
      expect(config.fontFamily).toBe('JetBrains Mono')
    })

    test('parses font-size', () => {
      const config = parseGhosttyConfigContent('font-size = 16')
      expect(config.fontSize).toBe(16)
    })

    test('parses fractional font-size', () => {
      const config = parseGhosttyConfigContent('font-size = 13.5')
      expect(config.fontSize).toBe(13.5)
    })

    test('ignores invalid font-size', () => {
      const config = parseGhosttyConfigContent('font-size = abc')
      expect(config.fontSize).toBeUndefined()
    })

    test('ignores negative font-size', () => {
      const config = parseGhosttyConfigContent('font-size = -5')
      expect(config.fontSize).toBeUndefined()
    })

    test('parses background color with #', () => {
      const config = parseGhosttyConfigContent('background = #1e1e2e')
      expect(config.background).toBe('#1e1e2e')
    })

    test('parses background color without #', () => {
      const config = parseGhosttyConfigContent('background = 1e1e2e')
      expect(config.background).toBe('#1e1e2e')
    })

    test('parses 3-char shorthand color', () => {
      const config = parseGhosttyConfigContent('background = #fff')
      expect(config.background).toBe('#ffffff')
    })

    test('ignores invalid color values', () => {
      const config = parseGhosttyConfigContent('background = not-a-color')
      expect(config.background).toBeUndefined()
    })

    test('parses foreground color', () => {
      const config = parseGhosttyConfigContent('foreground = #cdd6f4')
      expect(config.foreground).toBe('#cdd6f4')
    })

    test('parses cursor-style block', () => {
      const config = parseGhosttyConfigContent('cursor-style = block')
      expect(config.cursorStyle).toBe('block')
    })

    test('parses cursor-style bar', () => {
      const config = parseGhosttyConfigContent('cursor-style = bar')
      expect(config.cursorStyle).toBe('bar')
    })

    test('parses cursor-style underline', () => {
      const config = parseGhosttyConfigContent('cursor-style = underline')
      expect(config.cursorStyle).toBe('underline')
    })

    test('parses cursor-style ibeam as bar', () => {
      const config = parseGhosttyConfigContent('cursor-style = ibeam')
      expect(config.cursorStyle).toBe('bar')
    })

    test('ignores invalid cursor-style', () => {
      const config = parseGhosttyConfigContent('cursor-style = dotted')
      expect(config.cursorStyle).toBeUndefined()
    })

    test('parses cursor-color', () => {
      const config = parseGhosttyConfigContent('cursor-color = #f5e0dc')
      expect(config.cursorColor).toBe('#f5e0dc')
    })

    test('parses command as shell', () => {
      const config = parseGhosttyConfigContent('command = /bin/fish')
      expect(config.shell).toBe('/bin/fish')
    })

    test('parses scrollback-limit', () => {
      const config = parseGhosttyConfigContent('scrollback-limit = 50000')
      expect(config.scrollbackLimit).toBe(50000)
    })

    test('parses scrollback-limit of 0', () => {
      const config = parseGhosttyConfigContent('scrollback-limit = 0')
      expect(config.scrollbackLimit).toBe(0)
    })

    test('ignores invalid scrollback-limit', () => {
      const config = parseGhosttyConfigContent('scrollback-limit = abc')
      expect(config.scrollbackLimit).toBeUndefined()
    })

    test('parses selection-background', () => {
      const config = parseGhosttyConfigContent('selection-background = #585b70')
      expect(config.selectionBackground).toBe('#585b70')
    })

    test('parses selection-foreground', () => {
      const config = parseGhosttyConfigContent('selection-foreground = #cdd6f4')
      expect(config.selectionForeground).toBe('#cdd6f4')
    })

    test('parses palette entries', () => {
      const content = [
        'palette = 0=#45475a',
        'palette = 1=#f38ba8',
        'palette = 8=#585b70',
        'palette = 15=#a6adc8'
      ].join('\n')
      const config = parseGhosttyConfigContent(content)
      expect(config.palette).toEqual({
        0: '#45475a',
        1: '#f38ba8',
        8: '#585b70',
        15: '#a6adc8'
      })
    })

    test('parses palette with spaces around =', () => {
      const config = parseGhosttyConfigContent('palette = 5 = f5c2e7')
      expect(config.palette?.[5]).toBe('#f5c2e7')
    })

    test('ignores palette entries with invalid index', () => {
      const config = parseGhosttyConfigContent('palette = 256=#ffffff')
      expect(config.palette?.[256]).toBeUndefined()
    })

    test('ignores palette entries with invalid color', () => {
      const config = parseGhosttyConfigContent('palette = 0=not-a-color')
      expect(config.palette).toBeUndefined()
    })

    test('skips empty lines', () => {
      const content = 'font-size = 16\n\nfont-family = Fira Code'
      const config = parseGhosttyConfigContent(content)
      expect(config.fontSize).toBe(16)
      expect(config.fontFamily).toBe('Fira Code')
    })

    test('skips comment lines', () => {
      const content = '# This is a comment\nfont-size = 14'
      const config = parseGhosttyConfigContent(content)
      expect(config.fontSize).toBe(14)
    })

    test('skips lines without = sign', () => {
      const content = 'invalid line\nfont-size = 14'
      const config = parseGhosttyConfigContent(content)
      expect(config.fontSize).toBe(14)
    })

    test('silently ignores unknown keys', () => {
      const content = 'unknown-key = value\nfont-size = 14'
      const config = parseGhosttyConfigContent(content)
      expect(config.fontSize).toBe(14)
    })

    test('handles key=value without spaces', () => {
      const config = parseGhosttyConfigContent('font-size=16')
      expect(config.fontSize).toBe(16)
    })

    test('handles extra spaces around key and value', () => {
      const config = parseGhosttyConfigContent('  font-size  =  16  ')
      expect(config.fontSize).toBe(16)
    })

    test('handles values with = in them', () => {
      // e.g. palette = 0=#RRGGBB has a second = sign
      const config = parseGhosttyConfigContent('palette = 0=#45475a')
      expect(config.palette?.[0]).toBe('#45475a')
    })

    test('parses a complete Ghostty config', () => {
      const content = `
# Ghostty config
font-family = JetBrains Mono
font-size = 14
background = #1e1e2e
foreground = #cdd6f4
cursor-style = bar
cursor-color = #f5e0dc
command = /usr/local/bin/fish
scrollback-limit = 20000
selection-background = #585b70
selection-foreground = #cdd6f4

# ANSI colors
palette = 0=#45475a
palette = 1=#f38ba8
palette = 2=#a6e3a1
palette = 3=#f9e2af
palette = 4=#89b4fa
palette = 5=#f5c2e7
palette = 6=#94e2d5
palette = 7=#bac2de
palette = 8=#585b70
palette = 9=#f38ba8
palette = 10=#a6e3a1
palette = 11=#f9e2af
palette = 12=#89b4fa
palette = 13=#f5c2e7
palette = 14=#94e2d5
palette = 15=#a6adc8
`
      const config = parseGhosttyConfigContent(content)
      expect(config.fontFamily).toBe('JetBrains Mono')
      expect(config.fontSize).toBe(14)
      expect(config.background).toBe('#1e1e2e')
      expect(config.foreground).toBe('#cdd6f4')
      expect(config.cursorStyle).toBe('bar')
      expect(config.cursorColor).toBe('#f5e0dc')
      expect(config.shell).toBe('/usr/local/bin/fish')
      expect(config.scrollbackLimit).toBe(20000)
      expect(config.selectionBackground).toBe('#585b70')
      expect(config.selectionForeground).toBe('#cdd6f4')
      expect(config.palette).toBeDefined()
      expect(Object.keys(config.palette!)).toHaveLength(16)
      expect(config.palette![0]).toBe('#45475a')
      expect(config.palette![15]).toBe('#a6adc8')
    })

    test('later values override earlier ones', () => {
      const content = 'font-size = 14\nfont-size = 18'
      const config = parseGhosttyConfigContent(content)
      expect(config.fontSize).toBe(18)
    })

    test('handles empty value gracefully', () => {
      const content = 'font-family ='
      const config = parseGhosttyConfigContent(content)
      expect(config.fontFamily).toBeUndefined()
    })
  })

  describe('config-file includes', () => {
    test('processes config-file includes', () => {
      const mainContent = 'font-size = 14\nconfig-file = /included.conf'
      const includedContent = 'font-family = Fira Code'
      const resolveInclude = (path: string): string | undefined => {
        if (path === '/included.conf') return includedContent
        return undefined
      }

      const config = parseGhosttyConfigContent(mainContent, {}, resolveInclude)
      expect(config.fontSize).toBe(14)
      expect(config.fontFamily).toBe('Fira Code')
    })

    test('included files can override parent values', () => {
      const mainContent = 'font-size = 14\nconfig-file = /override.conf'
      const overrideContent = 'font-size = 18'
      const resolveInclude = (path: string): string | undefined => {
        if (path === '/override.conf') return overrideContent
        return undefined
      }

      const config = parseGhosttyConfigContent(mainContent, {}, resolveInclude)
      expect(config.fontSize).toBe(18)
    })

    test('handles cycle detection in includes', () => {
      const mainContent = 'config-file = /a.conf'
      const resolveInclude = (path: string): string | undefined => {
        if (path === '/a.conf') return 'config-file = /b.conf\nfont-size = 14'
        if (path === '/b.conf') return 'config-file = /a.conf\nfont-family = Mono'
        return undefined
      }

      // Should not infinite loop
      const config = parseGhosttyConfigContent(mainContent, {}, resolveInclude)
      expect(config.fontSize).toBe(14)
      expect(config.fontFamily).toBe('Mono')
    })

    test('handles missing include files gracefully', () => {
      const mainContent = 'font-size = 14\nconfig-file = /nonexistent.conf'
      const resolveInclude = (): string | undefined => undefined

      const config = parseGhosttyConfigContent(mainContent, {}, resolveInclude)
      expect(config.fontSize).toBe(14)
    })

    test('includes are skipped when no resolver is provided', () => {
      const mainContent = 'config-file = /some/file\nfont-size = 14'
      const config = parseGhosttyConfigContent(mainContent)
      expect(config.fontSize).toBe(14)
    })
  })

  describe('parseGhosttyConfig (file-based)', () => {
    test('returns empty config when no config file exists', () => {
      existsSyncMock.mockReturnValue(false)
      const config = parseGhosttyConfig()
      expect(config).toEqual({})
    })

    test('reads from first found config path', () => {
      // Simulate that the macOS Application Support path exists
      existsSyncMock.mockImplementation((path: unknown) => {
        return String(path).includes('com.mitchellh.ghostty/config.ghostty')
      })
      readFileSyncMock.mockReturnValue('font-size = 16')

      const config = parseGhosttyConfig()
      expect(config.fontSize).toBe(16)
    })

    test('falls back to XDG config path', () => {
      // Only the .config/ghostty/config path exists
      existsSyncMock.mockImplementation((path: unknown) => {
        return String(path).includes('.config/ghostty/config')
      })
      readFileSyncMock.mockReturnValue('font-family = Hack')

      const config = parseGhosttyConfig()
      expect(config.fontFamily).toBe('Hack')
    })

    test('handles unreadable config file gracefully', () => {
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockImplementation(() => {
        throw new Error('Permission denied')
      })

      const config = parseGhosttyConfig()
      expect(config).toEqual({})
    })

    test('handles malformed config lines gracefully', () => {
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockReturnValue(
        [
          'this is not valid',
          'also not: valid',
          '= empty key',
          'font-size = 16',
          '# comment line',
          '',
          'font-family = Valid Font'
        ].join('\n')
      )

      const config = parseGhosttyConfig()
      expect(config.fontSize).toBe(16)
      expect(config.fontFamily).toBe('Valid Font')
    })
  })

  describe('color normalization edge cases', () => {
    test('handles uppercase hex colors', () => {
      const config = parseGhosttyConfigContent('background = #FF00AA')
      expect(config.background).toBe('#ff00aa')
    })

    test('handles mixed case hex colors', () => {
      const config = parseGhosttyConfigContent('background = #FfAa00')
      expect(config.background).toBe('#ffaa00')
    })

    test('handles 3-char shorthand without #', () => {
      const config = parseGhosttyConfigContent('background = abc')
      expect(config.background).toBe('#aabbcc')
    })

    test('rejects colors with wrong length', () => {
      const config = parseGhosttyConfigContent('background = #12345')
      expect(config.background).toBeUndefined()
    })

    test('rejects colors with invalid characters', () => {
      const config = parseGhosttyConfigContent('background = #gghhii')
      expect(config.background).toBeUndefined()
    })
  })
})
