import { spawn, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, extname, join } from 'path'
import type { LspServerDefinition, LspServerHandle } from './lsp-types'

/**
 * Walk up from `path.dirname(file)` to `stopDir`, looking for any marker file.
 * Returns the directory containing the first marker found, or `stopDir` as fallback.
 */
export function findProjectRoot(
  file: string,
  rootMarkers: string[],
  stopDir: string
): string {
  let dir = dirname(file)

  while (true) {
    for (const marker of rootMarkers) {
      if (existsSync(join(dir, marker))) {
        return dir
      }
    }

    // Reached the stop directory — use it as fallback
    if (dir === stopDir || dir === dirname(dir)) {
      return stopDir
    }

    dir = dirname(dir)
  }
}

/**
 * Check if a binary is available on the system PATH.
 */
function binaryExists(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Spawn a process with stdio pipes, returning a server handle or undefined if
 * the process fails to start.
 *
 * Uses the 'spawn' / 'error' events to reliably detect whether the process
 * actually started — unlike a synchronous `proc.pid` check, this handles
 * async ENOENT errors that arrive on the next tick.
 */
function spawnServer(
  command: string,
  args: string[],
  root: string
): Promise<LspServerHandle | undefined> {
  const proc = spawn(command, args, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  return new Promise((resolve) => {
    proc.on('spawn', () => {
      // Process started successfully — attach a persistent error handler
      // so later failures (e.g. unexpected exit) don't become unhandled.
      proc.on('error', (err) => {
        console.error(`[LSP] ${command} error after spawn: ${err.message}`)
      })
      resolve({ process: proc })
    })

    proc.on('error', (err) => {
      console.error(`[LSP] Failed to spawn ${command}: ${err.message}`)
      resolve(undefined)
    })
  })
}

export const TypescriptServer: LspServerDefinition = {
  id: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
  rootMarkers: [
    'tsconfig.json',
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock'
  ],
  async spawn(root: string): Promise<LspServerHandle | undefined> {
    try {
      if (binaryExists('typescript-language-server')) {
        return await spawnServer('typescript-language-server', ['--stdio'], root)
      }
      // Fall back to npx
      return await spawnServer('npx', ['typescript-language-server', '--stdio'], root)
    } catch {
      return undefined
    }
  }
}

export const GoplsServer: LspServerDefinition = {
  id: 'gopls',
  extensions: ['.go'],
  rootMarkers: ['go.mod', 'go.sum'],
  async spawn(root: string): Promise<LspServerHandle | undefined> {
    try {
      if (!binaryExists('gopls')) {
        return undefined
      }
      return await spawnServer('gopls', ['serve'], root)
    } catch {
      return undefined
    }
  }
}

export const PyrightServer: LspServerDefinition = {
  id: 'pyright',
  extensions: ['.py', '.pyi'],
  rootMarkers: [
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
    'Pipfile'
  ],
  async spawn(root: string): Promise<LspServerHandle | undefined> {
    try {
      if (binaryExists('pyright-langserver')) {
        return await spawnServer('pyright-langserver', ['--stdio'], root)
      }
      // Fall back to npx
      return await spawnServer('npx', ['pyright-langserver', '--stdio'], root)
    } catch {
      return undefined
    }
  }
}

export const RustAnalyzerServer: LspServerDefinition = {
  id: 'rust-analyzer',
  extensions: ['.rs'],
  rootMarkers: ['Cargo.toml'],
  async spawn(root: string): Promise<LspServerHandle | undefined> {
    try {
      if (!binaryExists('rust-analyzer')) {
        return undefined
      }
      return await spawnServer('rust-analyzer', [], root)
    } catch {
      return undefined
    }
  }
}

/**
 * All registered language server definitions.
 */
export const ALL_SERVERS: LspServerDefinition[] = [
  TypescriptServer,
  GoplsServer,
  PyrightServer,
  RustAnalyzerServer
]

/**
 * Return all server definitions whose extensions include the file's extension.
 */
export function getServersForFile(filePath: string): LspServerDefinition[] {
  const ext = extname(filePath)
  if (!ext) return []
  return ALL_SERVERS.filter((server) => server.extensions.includes(ext))
}
