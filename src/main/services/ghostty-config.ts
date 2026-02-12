import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger'

const log = createLogger({ component: 'GhosttyConfig' })

export interface GhosttyConfig {
  fontFamily?: string
  fontSize?: number
  background?: string
  foreground?: string
  cursorStyle?: 'block' | 'bar' | 'underline'
  cursorColor?: string
  shell?: string
  scrollbackLimit?: number
  // ANSI color palette (0-15)
  palette?: Record<number, string>
  // Selection colors
  selectionBackground?: string
  selectionForeground?: string
}

/** Cursor style mapping from Ghostty names to our interface */
const CURSOR_STYLE_MAP: Record<string, GhosttyConfig['cursorStyle']> = {
  block: 'block',
  bar: 'bar',
  underline: 'underline',
  // Ghostty also supports these aliases
  ibeam: 'bar',
  block_hollow: 'block'
}

/**
 * Config file search order matching Ghostty's own resolution.
 * Returns the first config file path that exists, or undefined.
 */
function findConfigFile(): string | undefined {
  const home = homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, '.config')

  const candidates = [
    join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty', 'config.ghostty'),
    join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty', 'config'),
    join(xdgConfig, 'ghostty', 'config.ghostty'),
    join(xdgConfig, 'ghostty', 'config'),
    join(home, '.config', 'ghostty', 'config')
  ]

  for (const path of candidates) {
    if (existsSync(path)) {
      return path
    }
  }

  return undefined
}

/**
 * Normalize a hex color value.
 * Ghostty supports formats like: #RRGGBB, RRGGBB, #RGB
 */
function normalizeColor(value: string): string | undefined {
  let hex = value.trim()

  // Strip leading # if present
  if (hex.startsWith('#')) {
    hex = hex.slice(1)
  }

  // Expand 3-char shorthand (#RGB -> #RRGGBB)
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  }

  // Validate 6-char hex
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return '#' + hex.toLowerCase()
  }

  return undefined
}

/**
 * Parse the content of a Ghostty config file.
 * Handles comments, key=value pairs, config-file includes (with cycle detection).
 */
export function parseGhosttyConfigContent(
  content: string,
  config: GhosttyConfig = {},
  resolveInclude?: (path: string) => string | undefined,
  visited: Set<string> = new Set()
): GhosttyConfig {
  const lines = content.split('\n')

  for (const rawLine of lines) {
    const line = rawLine.trim()

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue

    // Parse key = value (Ghostty uses `key = value` or `key=value`)
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue

    const key = line.slice(0, eqIndex).trim()
    const value = line.slice(eqIndex + 1).trim()

    if (!key || value === '') continue

    switch (key) {
      case 'font-family':
        config.fontFamily = value
        break

      case 'font-size':
        {
          const size = parseFloat(value)
          if (!isNaN(size) && size > 0) {
            config.fontSize = size
          }
        }
        break

      case 'background':
        {
          const color = normalizeColor(value)
          if (color) config.background = color
        }
        break

      case 'foreground':
        {
          const color = normalizeColor(value)
          if (color) config.foreground = color
        }
        break

      case 'cursor-style':
        {
          const style = CURSOR_STYLE_MAP[value.toLowerCase()]
          if (style) config.cursorStyle = style
        }
        break

      case 'cursor-color':
        {
          const color = normalizeColor(value)
          if (color) config.cursorColor = color
        }
        break

      case 'command':
        // Ghostty uses "command" for the shell program
        config.shell = value
        break

      case 'scrollback-limit':
        {
          const limit = parseInt(value, 10)
          if (!isNaN(limit) && limit >= 0) {
            config.scrollbackLimit = limit
          }
        }
        break

      case 'palette':
        {
          // Ghostty palette format: `palette = N=#RRGGBB` or `palette = N=RRGGBB`
          const paletteMatch = value.match(/^(\d+)\s*=\s*(.+)$/)
          if (paletteMatch) {
            const index = parseInt(paletteMatch[1], 10)
            const color = normalizeColor(paletteMatch[2])
            if (index >= 0 && index <= 255 && color) {
              if (!config.palette) config.palette = {}
              config.palette[index] = color
            }
          }
        }
        break

      case 'selection-background':
        {
          const color = normalizeColor(value)
          if (color) config.selectionBackground = color
        }
        break

      case 'selection-foreground':
        {
          const color = normalizeColor(value)
          if (color) config.selectionForeground = color
        }
        break

      case 'config-file':
        {
          // Recursive include with cycle detection
          if (resolveInclude && !visited.has(value)) {
            visited.add(value)
            const includeContent = resolveInclude(value)
            if (includeContent !== undefined) {
              parseGhosttyConfigContent(includeContent, config, resolveInclude, visited)
            }
          }
        }
        break

      default:
        // Unknown keys are silently ignored
        break
    }
  }

  return config
}

/**
 * Read a file's content, returning undefined if it doesn't exist or can't be read.
 */
function readFileSafe(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return undefined
  }
}

/**
 * Resolve an included config file path.
 * Handles both absolute paths and paths relative to the config directory.
 */
function createIncludeResolver(baseConfigDir: string): (includePath: string) => string | undefined {
  return (includePath: string) => {
    // Expand ~ to home directory
    let resolved = includePath
    if (resolved.startsWith('~')) {
      resolved = join(homedir(), resolved.slice(1))
    }

    // If not absolute, resolve relative to the config file's directory
    if (!resolved.startsWith('/')) {
      resolved = join(baseConfigDir, resolved)
    }

    return readFileSafe(resolved)
  }
}

/**
 * Parse the user's Ghostty config file.
 * Searches standard locations, returns parsed config or empty defaults.
 */
export function parseGhosttyConfig(): GhosttyConfig {
  const configPath = findConfigFile()

  if (!configPath) {
    log.info('No Ghostty config file found, using defaults')
    return {}
  }

  log.info('Found Ghostty config', { path: configPath })

  const content = readFileSafe(configPath)
  if (!content) {
    log.warn('Could not read Ghostty config file', { path: configPath })
    return {}
  }

  try {
    const configDir = configPath.substring(0, configPath.lastIndexOf('/'))
    const visited = new Set<string>([configPath])
    const config = parseGhosttyConfigContent(content, {}, createIncludeResolver(configDir), visited)

    log.info('Parsed Ghostty config', {
      fontFamily: config.fontFamily,
      fontSize: config.fontSize,
      shell: config.shell,
      hasPalette: config.palette ? Object.keys(config.palette).length : 0
    })

    return config
  } catch (error) {
    log.error(
      'Error parsing Ghostty config',
      error instanceof Error ? error : new Error(String(error)),
      { path: configPath }
    )
    return {}
  }
}
