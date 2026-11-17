// Server start with a move to the dev folder still owed, on the real server, the real move
// service and a real database in a temp directory. What the server's own step adds is checked
// here: the note is dealt with by the time the server has started. The steps of a resumed
// move themselves belong to the move service's tests.
// Needs better-sqlite3 for the Electron ABI: run with
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run <file>
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Before anything is loaded: no module of the server may find the real home directory, and
// the process's database (a singleton that falls back to ~/.hive/hive.db) is pinned to a
// throwaway file before the server opens it.
const TEST_DB_DIR = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-start-home-')))
  process.env.HOME = home
  process.env.USERPROFILE = home
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-start-db-'))
  process.env.HIVE_SERVER_DB_PATH = path.join(dbDir, 'hive.db')
  process.env.HIVE_SERVER_BASE_DIR = dbDir
  return dbDir
})

/**
 * Lets a test hold the server's step back, and records what the server handed to the step and
 * to the settings service it made.
 */
const startStep = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  calls: [] as unknown[],
  serviceExtras: [] as unknown[]
}))

// The real step, behind a gate that is open unless a test closes it.
vi.mock('../settings-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../settings-ops')>()
  return {
    ...actual,
    makeLiveSettingsOpsRpcService: (
      ...args: Parameters<typeof actual.makeLiveSettingsOpsRpcService>
    ) => {
      startStep.serviceExtras.push(args[0])
      return actual.makeLiveSettingsOpsRpcService(...args)
    },
    finishInterruptedDevFolderMove: async (
      ...args: Parameters<typeof actual.finishInterruptedDevFolderMove>
    ): Promise<void> => {
      startStep.calls.push(args[0])
      if (startStep.hold) await startStep.hold
      return actual.finishInterruptedDevFolderMove(...args)
    }
  }
})

import { getDatabase } from '../../../../main/db'
import {
  DEV_FOLDER_PENDING_MOVE_KEY,
  type PendingDevFolderMove
} from '../../../../main/services/dev-folder/types'
import { startHiveServer, type StartedHiveServer } from '../../../server'

const startTestServer = (prefix: string): Promise<StartedHiveServer> =>
  Effect.runPromise(
    startHiveServer({
      port: 0,
      baseDir: mkdtempSync(join(tmpdir(), prefix)),
      desktopBootstrapToken: 'desktop-bootstrap-token'
    })
  )

const canRunDatabaseTests = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return true
  } catch {
    return false
  }
}

const describeIf = canRunDatabaseTests() ? describe : describe.skip

/** A port nothing listens on: taken for a moment, then given back. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })

describeIf('server start with a move to the dev folder still owed', () => {
  let server: StartedHiveServer | null = null

  afterEach(async () => {
    startStep.hold = null
    startStep.calls.length = 0
    startStep.serviceExtras.length = 0
    await server?.close()
    server = null
    getDatabase().deleteSetting(DEV_FOLDER_PENDING_MOVE_KEY)
  })

  const noteFor = (projectId: string, toPath: string): PendingDevFolderMove => ({
    projectId,
    fromPath: join(TEST_DB_DIR, 'before', 'api'),
    fromRealPath: join(TEST_DB_DIR, 'before', 'api'),
    toPath,
    relocations: [{ from: [join(TEST_DB_DIR, 'before', 'api')], to: toPath }]
  })

  it('works on the throwaway database, not the one in the home directory', () => {
    expect(getDatabase().getDbPath()).toBe(join(TEST_DB_DIR, 'hive.db'))
  })

  it('starts as usual when no move is owed', async () => {
    expect(getDatabase().getSetting(DEV_FOLDER_PENDING_MOVE_KEY)).toBeNull()
    server = await startTestServer('hive-dev-folder-start-')
    const response = await fetch(`${server.httpBaseUrl}/health`)
    expect(response.status).toBe(200)
    expect(getDatabase().getSetting(DEV_FOLDER_PENDING_MOVE_KEY)).toBeNull()
  })

  it('has dropped the note about a project that is gone by the time it has started', async () => {
    const db = getDatabase()
    db.setSetting(
      DEV_FOLDER_PENDING_MOVE_KEY,
      JSON.stringify(noteFor('a-project-that-is-gone', join(TEST_DB_DIR, 'after', 'api')))
    )

    server = await startTestServer('hive-dev-folder-start-')

    expect(db.getSetting(DEV_FOLDER_PENDING_MOVE_KEY)).toBeNull()
    expect((await fetch(`${server.httpBaseUrl}/health`)).status).toBe(200)
  })

  it('has dropped the note about a project that is no longer where the note says', async () => {
    const db = getDatabase()
    const elsewhere = mkdtempSync(join(tmpdir(), 'hive-dev-folder-elsewhere-'))
    const project = db.createProject({ name: 'api', path: elsewhere })
    try {
      db.setSetting(
        DEV_FOLDER_PENDING_MOVE_KEY,
        JSON.stringify(noteFor(project.id, join(TEST_DB_DIR, 'after', 'api')))
      )

      server = await startTestServer('hive-dev-folder-start-')

      expect(db.getSetting(DEV_FOLDER_PENDING_MOVE_KEY)).toBeNull()
      // The project itself is as it was: the note was about a place it no longer has.
      expect(db.getProject(project.id)?.path).toBe(elsewhere)
    } finally {
      db.deleteProject(project.id)
    }
  })

  it('does not listen before the step has finished, and hands it what the window reports', async () => {
    const port = await freePort()
    let release = (): void => undefined
    startStep.hold = new Promise<void>((resolve) => {
      release = resolve
    })

    const starting = Effect.runPromise(
      startHiveServer({
        port,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-dev-folder-start-')),
        desktopBootstrapToken: 'desktop-bootstrap-token'
      })
    )
    try {
      await vi.waitFor(() => expect(startStep.calls).toHaveLength(1))
      // Everything else about the start has had time to run: nothing answers on the port.
      await new Promise((resolve) => setTimeout(resolve, 100))
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
    } finally {
      release()
      server = await starting
    }

    expect(server.port).toBe(port)
    expect((await fetch(`${server.httpBaseUrl}/health`)).status).toBe(200)
    expect(startStep.calls).toHaveLength(1)
    const extras = startStep.calls[0] as { activity?: { runningSessionIds?: () => unknown } }
    expect(extras.activity?.runningSessionIds?.()).toEqual([])
  })

  it('makes the settings service with the same report of running sessions', async () => {
    server = await startTestServer('hive-dev-folder-start-')

    // One service, made by the server itself: the router did not fall back to one without it.
    expect(startStep.serviceExtras).toHaveLength(1)
    const service = startStep.serviceExtras[0] as { activity?: { runningSessionIds?: unknown } }
    const step = startStep.calls[0] as { activity?: unknown }
    expect(typeof service.activity?.runningSessionIds).toBe('function')
    expect(service.activity).toBe(step.activity)
  })

  it('starts all the same when the note cannot be read', async () => {
    const db = getDatabase()
    db.setSetting(DEV_FOLDER_PENDING_MOVE_KEY, 'not a note')

    server = await startTestServer('hive-dev-folder-start-')

    expect((await fetch(`${server.httpBaseUrl}/health`)).status).toBe(200)
  })
})
