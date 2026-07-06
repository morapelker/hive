// @vitest-environment node
import { mkdir, mkdtemp, rm, stat, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteJson, readJsonFile } from '../../src/main/services/atomic-json'

describe('atomic-json', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hive-atomic-json-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips a value through atomicWriteJson and readJsonFile', async () => {
    const file = join(dir, 'data.json')
    const value = { hello: 'world', count: 3 }

    await atomicWriteJson(file, value)

    await expect(readJsonFile(file)).resolves.toEqual(value)
  })

  it('pretty-prints with 2-space indentation when opts.pretty is set', async () => {
    const file = join(dir, 'pretty.json')

    await atomicWriteJson(file, { a: 1 }, { pretty: true })

    const raw = await readFile(file, 'utf-8')
    expect(raw).toBe(JSON.stringify({ a: 1 }, null, 2))
  })

  it('defaults to mode 0600', async () => {
    const file = join(dir, 'mode-default.json')

    await atomicWriteJson(file, { a: 1 })

    const stats = await stat(file)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('honors an explicit mode', async () => {
    const file = join(dir, 'mode-explicit.json')

    await atomicWriteJson(file, { a: 1 }, { mode: 0o644 })

    const stats = await stat(file)
    expect(stats.mode & 0o777).toBe(0o644)
  })

  it('creates missing parent directories recursively', async () => {
    const file = join(dir, 'nested', 'deeper', 'data.json')

    await atomicWriteJson(file, { nested: true })

    await expect(readJsonFile(file)).resolves.toEqual({ nested: true })
  })

  it('does not leave a .tmp.hive file behind after a successful write', async () => {
    const file = join(dir, 'data.json')

    await atomicWriteJson(file, { a: 1 })

    await expect(stat(`${file}.tmp.hive`)).rejects.toThrow()
  })

  it('cleans up the .tmp.hive file (best-effort) when the rename fails', async () => {
    // A non-empty directory at the destination path makes the final rename
    // fail — the tmp file (already written + chmod'd) must not be left behind.
    const target = join(dir, 'target')
    await mkdir(join(target, 'child'), { recursive: true })

    await expect(atomicWriteJson(target, { a: 1 })).rejects.toThrow()

    await expect(stat(`${target}.tmp.hive`)).rejects.toThrow()
  })

  it('returns null from readJsonFile when the file is missing', async () => {
    await expect(readJsonFile(join(dir, 'missing.json'))).resolves.toBeNull()
  })

  it('returns null from readJsonFile when the file contents are corrupt', async () => {
    const file = join(dir, 'corrupt.json')
    await writeFile(file, '{ not valid json')

    await expect(readJsonFile(file)).resolves.toBeNull()
  })
})
