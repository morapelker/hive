/**
 * Importing the live bindings of the move service must load nothing heavy. Settings asks for
 * the count of projects left behind every time it opens, and imports `live-query-deps.ts` for
 * it; `live-deps.ts` is imported by the server at start. Git, the watchers, the terminals, the
 * boards and the connections are only loaded once a move or a plan is asked for.
 *
 * Every heavy module is replaced by a factory that records its name and throws, so a module
 * that is loaded too early fails the import itself.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { loaded, heavy } = vi.hoisted(() => {
  const loaded: string[] = []
  const heavy = (name: string) => (): never => {
    loaded.push(name)
    throw new Error(`${name} was loaded`)
  }
  return { loaded, heavy }
})

// The modules `createLiveMoveProjectsDeps` loads when it is called.
vi.mock('effect', heavy('effect'))
vi.mock('../../logger', heavy('logger'))
vi.mock('../../pty-service', heavy('pty-service'))
vi.mock('../../script-runner', heavy('script-runner'))
vi.mock('../../../../server/rpc/domains/session-profiler-ops', heavy('session-profiler-ops'))
vi.mock('../../../../server/rpc/domains/bash', heavy('bash'))
vi.mock('../../markdown-kanban-watcher', heavy('markdown-kanban-watcher'))
vi.mock('../../kanban-backend', heavy('kanban-backend'))
vi.mock('../../connection-ops', heavy('connection-ops'))
vi.mock('../../port-registry', heavy('port-registry'))
vi.mock('../../worktree-ops', heavy('worktree-ops'))
vi.mock('../claude-state', heavy('claude-state'))
vi.mock('../../claude-trust', heavy('claude-trust'))
vi.mock('../../env-vars', heavy('env-vars'))
vi.mock('../../branch-watcher', heavy('branch-watcher'))
vi.mock('../../worktree-watcher', heavy('worktree-watcher'))
vi.mock('../../db-change-events', heavy('db-change-events'))
vi.mock('../git-ports', heavy('git-ports'))
// What those modules are heavy for.
vi.mock('node-pty', heavy('node-pty'))
vi.mock('chokidar', heavy('chokidar'))
vi.mock('../../git-service', heavy('git-service'))
vi.mock('../../git-exec', heavy('git-exec'))
// Not loaded when the bindings are made either: only the step after a move that closes the
// connection of a SQLite data project asks for the data engine.
vi.mock('../../data-projects/engine-service', heavy('data-engine'))
// The setting module reaches the database module; nothing here may open a database.
vi.mock('../../../db', () => ({
  getDatabase: () => {
    throw new Error('no database in this test')
  }
}))

const LOADED_ON_FIRST_USE = [
  'effect',
  'logger',
  'pty-service',
  'script-runner',
  'session-profiler-ops',
  'bash',
  'markdown-kanban-watcher',
  'kanban-backend',
  'connection-ops',
  'port-registry',
  'worktree-ops',
  'claude-state',
  'claude-trust',
  'env-vars',
  'branch-watcher',
  'worktree-watcher',
  'db-change-events',
  'git-ports'
]

/** The modules a source file imports for their values (type-only imports load nothing). */
const valueImportsOf = (file: string): string[] => {
  const source = readFileSync(join(__dirname, '..', file), 'utf8')
  const found: string[] = []
  for (const match of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)) {
    found.push(match[1])
  }
  return found.sort()
}

describe('importing the live bindings of the move service', () => {
  it('loads no heavy module', async () => {
    const queryDeps = await import('../live-query-deps')
    const busyProbe = await import('../busy-probe')
    const liveDeps = await import('../live-deps')

    expect(typeof queryDeps.createLiveMoveQueryDeps).toBe('function')
    expect(typeof queryDeps.createMoveProjectsDbPort).toBe('function')
    expect(typeof busyProbe.takeBusyReading).toBe('function')
    expect(typeof liveDeps.createLiveMoveProjectsDeps).toBe('function')
    expect(loaded).toEqual([])
  })

  it('loads them when the bindings are made (so the check above watches the right modules)', async () => {
    const { createLiveMoveProjectsDeps } = await import('../live-deps')

    await expect(createLiveMoveProjectsDeps()).rejects.toThrow()

    // Every import was started at once, and the first one to fail ended the call: the others
    // are still on their way.
    await vi.waitFor(
      () => expect([...new Set(loaded)].sort()).toEqual([...LOADED_ON_FIRST_USE].sort()),
      { timeout: 10_000, interval: 20 }
    )
  })

  it('keeps the static imports of each module to the small ones', () => {
    expect(valueImportsOf('live-query-deps.ts')).toEqual(['./dev-folder-settings', './fs-ports'])
    expect(valueImportsOf('busy-probe.ts')).toEqual(['../path-utils', 'node:child_process'])
    expect(valueImportsOf('live-deps.ts')).toEqual([
      '../../../shared/document-flow-events',
      '../path-utils',
      './busy-probe',
      './folder-identity',
      './live-query-deps',
      'node:fs',
      'node:os',
      'node:path'
    ])
  })
})
