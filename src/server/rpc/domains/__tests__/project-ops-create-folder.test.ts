import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { makeLiveProjectOpsRpcService } from '../project-ops'

const tempDirs: string[] = []

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-create-folder-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
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
