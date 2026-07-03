import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFile } from './file-ops'

describe('createFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-file-ops-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a new file with the given content', () => {
    const filePath = join(dir, 'PLAN_test.md')
    const result = createFile(filePath, '# Plan\n\ncontent')

    expect(result).toEqual({ success: true })
    expect(readFileSync(filePath, 'utf-8')).toBe('# Plan\n\ncontent')
  })

  it('fails when the file already exists and keeps the original content', () => {
    const filePath = join(dir, 'existing.md')
    writeFileSync(filePath, 'original', 'utf-8')

    const result = createFile(filePath, 'replacement')

    expect(result.success).toBe(false)
    expect(readFileSync(filePath, 'utf-8')).toBe('original')
  })

  it('fails when the parent directory does not exist', () => {
    const result = createFile(join(dir, 'missing-dir', 'PLAN_test.md'), 'content')

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('rejects an empty file path', () => {
    expect(createFile('', 'content')).toEqual({ success: false, error: 'Invalid file path' })
  })
})
