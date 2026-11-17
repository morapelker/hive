import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createLogger } from './logger'

const log = createLogger({ component: 'PortRegistry' })

const REGISTRY_PATH = join(homedir(), '.playwright-mcp-ports.json')
const START_PORT = 3011

type Registry = Record<string, number>

function loadRegistry(): Registry {
  try {
    if (existsSync(REGISTRY_PATH)) {
      const raw = readFileSync(REGISTRY_PATH, 'utf-8')
      return JSON.parse(raw) as Registry
    }
  } catch (error) {
    log.warn('Failed to load port registry, starting fresh', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
  return {}
}

function saveRegistry(registry: Registry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
}

function cleanupRegistry(registry: Registry): Registry {
  const cleaned: Registry = {}
  for (const [dir, port] of Object.entries(registry)) {
    try {
      const stat = statSync(dir)
      if (stat.isDirectory()) {
        cleaned[dir] = port
      }
    } catch {
      // Directory doesn't exist, skip it
    }
  }
  return cleaned
}

function findNextPort(registry: Registry): number {
  const used = new Set(Object.values(registry))
  let port = START_PORT
  while (used.has(port)) {
    port++
  }
  return port
}

/**
 * Assign a port for the given directory path.
 * If already registered, returns the existing port.
 * If not, assigns the next available port starting from 3011.
 * Cleans up stale entries (directories that no longer exist).
 */
export function assignPort(directoryPath: string): number {
  const registry = cleanupRegistry(loadRegistry())

  if (registry[directoryPath] !== undefined) {
    log.info('Port already assigned', { directoryPath, port: registry[directoryPath] })
    return registry[directoryPath]
  }

  const port = findNextPort(registry)
  registry[directoryPath] = port
  saveRegistry(registry)
  log.info('Assigned new port', { directoryPath, port })
  return port
}

/**
 * Release a port assignment for a directory.
 * Called when a worktree is archived/deleted.
 */
export function releasePort(directoryPath: string): void {
  const registry = loadRegistry()
  if (registry[directoryPath] !== undefined) {
    delete registry[directoryPath]
    saveRegistry(registry)
    log.info('Released port', { directoryPath })
  }
}

/**
 * A directory was moved: its port goes with it, so its dev server keeps the address it had.
 * The old key is always dropped (the next `assignPort` would drop it anyway, as a directory
 * that no longer exists). The new key gets the port only when it has none yet and no other
 * directory holds that port. Returns true when the port now belongs to the new path. Never
 * throws: a registry that cannot be read or written leaves the directory to get a new port.
 */
export function movePort(fromDirectoryPath: string, toDirectoryPath: string): boolean {
  if (fromDirectoryPath === toDirectoryPath) return false
  try {
    const registry = loadRegistry()
    const port = registry[fromDirectoryPath]
    if (port === undefined) return false
    delete registry[fromDirectoryPath]
    const moved = registry[toDirectoryPath] === undefined && !Object.values(registry).includes(port)
    if (moved) registry[toDirectoryPath] = port
    saveRegistry(registry)
    log.info('Moved port', { fromDirectoryPath, toDirectoryPath, port, moved })
    return moved
  } catch (error) {
    log.warn('Failed to move port', {
      fromDirectoryPath,
      toDirectoryPath,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

/**
 * Get the currently assigned port for a directory, or null if none.
 */
export function getAssignedPort(directoryPath: string): number | null {
  const registry = loadRegistry()
  return registry[directoryPath] ?? null
}
