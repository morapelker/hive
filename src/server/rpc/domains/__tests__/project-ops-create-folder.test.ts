import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeLiveProjectOpsRpcService } from '../project-ops'

// The projects of the app, which the service reads before it removes a folder it made, and a
// way to make `git init` fail. No test here may open the database of the machine it runs on.
const app = vi.hoisted(() => ({
  projectPaths: [] as string[],
  databaseIsBroken: false,
  /** When set, `git init` fails, after this ran with the folder it was asked to initialise. */
  beforeInitFails: null as ((path: string) => void) | null
}))

vi.mock('../../../../main/db', () => ({
  getDatabase: () => {
    if (app.databaseIsBroken) throw new Error('the database cannot be opened')
    return {
      getAllProjects: () =>
        app.projectPaths.map((path, index) => ({ id: `project-${index}`, name: 'project', path }))
    }
  }
}))

vi.mock('../../../../main/services/git-repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../main/services/git-repository')>()
  return {
    ...original,
    initRepository: (path: string) => {
      if (!app.beforeInitFails) return original.initRepository(path)
      app.beforeInitFails(path)
      return { success: false, error: 'git is not installed' }
    }
  }
})

const tempDirs: string[] = []

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-create-folder-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  app.projectPaths.length = 0
  app.databaseIsBroken = false
  app.beforeInitFails = null
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('projectOps.createProjectFolder', () => {
  const service = makeLiveProjectOpsRpcService()

  it('creates the folder and initializes a git repository', async () => {
    const parent = makeTempDir()

    const result = await Effect.runPromise(service.createProjectFolder(parent, 'my-app'))

    expect(result.success).toBe(true)
    expect(result.path).toBe(join(parent, 'my-app'))
    expect(statSync(join(parent, 'my-app', '.git')).isDirectory()).toBe(true)
  })

  it('rejects invalid names', async () => {
    const parent = makeTempDir()

    for (const name of ['..', 'a/b', 'a\\b', 'CON', 'trailing.', 'wild*card']) {
      const result = await Effect.runPromise(service.createProjectFolder(parent, name))
      expect(result.success, `name: ${name}`).toBe(false)
      expect(result.error).toContain('invalid characters')
    }
  })

  it('rejects a nonexistent parent directory', async () => {
    const result = await Effect.runPromise(
      service.createProjectFolder('/nonexistent-hive-parent', 'my-app')
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('not a valid directory')
  })

  it('rejects an existing folder with user content', async () => {
    const parent = makeTempDir()
    mkdirSync(join(parent, 'my-app'))
    writeFileSync(join(parent, 'my-app', 'notes.txt'), 'hello')

    const result = await Effect.runPromise(service.createProjectFolder(parent, 'my-app'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('already exists')
    expect(existsSync(join(parent, 'my-app', 'notes.txt'))).toBe(true)
  })

  it('resumes an existing empty folder and a folder left by a previous attempt', async () => {
    const parent = makeTempDir()
    mkdirSync(join(parent, 'my-app'))

    // Empty folder: safe to reuse — git init runs in it.
    const first = await Effect.runPromise(service.createProjectFolder(parent, 'my-app'))
    expect(first.success).toBe(true)
    expect(statSync(join(parent, 'my-app', '.git')).isDirectory()).toBe(true)

    // Folder containing only the .git we created: also safe to reuse.
    const second = await Effect.runPromise(service.createProjectFolder(parent, 'my-app'))
    expect(second.success).toBe(true)
    expect(second.path).toBe(join(parent, 'my-app'))
  })
})

describe('projectOps.createProjectFolder, when git init fails', () => {
  const service = makeLiveProjectOpsRpcService()

  it('removes the folder it made', async () => {
    const parent = makeTempDir()
    app.projectPaths.push('/somewhere/else/my-app')
    app.beforeInitFails = () => {}

    const result = await Effect.runPromise(service.createProjectFolder(parent, 'my-app'))

    expect(result).toEqual({ success: false, error: 'git is not installed' })
    expect(existsSync(join(parent, 'my-app'))).toBe(false)
  })

  it('keeps a folder that was there before', async () => {
    const parent = makeTempDir()
    mkdirSync(join(parent, 'my-app'))
    app.beforeInitFails = () => {}

    const result = await Effect.runPromise(service.createProjectFolder(parent, 'my-app'))

    expect(result.success).toBe(false)
    expect(existsSync(join(parent, 'my-app'))).toBe(true)
  })

  it('keeps the folder when a project is registered there by then', async () => {
    const parent = makeTempDir()
    const path = join(parent, 'my-app')
    // A project was moved to the path in the meantime: its files and its row.
    app.beforeInitFails = (folder) => {
      writeFileSync(join(folder, 'work.txt'), 'not committed anywhere\n')
      app.projectPaths.push(folder)
    }

    const result = await Effect.runPromise(service.createProjectFolder(parent, 'my-app'))

    expect(result).toEqual({ success: false, error: 'git is not installed' })
    expect(readdirSync(path)).toEqual(['work.txt'])
  })

  it('keeps it when that project is registered under another spelling of the path', async () => {
    const parent = makeTempDir()
    const link = `${parent}-link`
    symlinkSync(parent, link)
    tempDirs.push(link)
    app.beforeInitFails = () => {
      app.projectPaths.push(join(link, 'my-app'))
    }

    const result = await Effect.runPromise(service.createProjectFolder(parent, 'my-app'))

    expect(result.success).toBe(false)
    expect(existsSync(join(parent, 'my-app'))).toBe(true)
  })

  it('keeps the folder, and still reports the failure, when the projects cannot be read', async () => {
    const parent = makeTempDir()
    app.beforeInitFails = () => {
      app.databaseIsBroken = true
    }

    const result = await Effect.runPromise(service.createProjectFolder(parent, 'my-app'))

    expect(result).toEqual({ success: false, error: 'git is not installed' })
    expect(existsSync(join(parent, 'my-app'))).toBe(true)
  })
})
