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
    const result = createFile(dir, 'PLAN_test.md', '# Plan\n\ncontent', false)

    expect(result).toEqual({ success: true })
    expect(readFileSync(join(dir, 'PLAN_test.md'), 'utf-8')).toBe('# Plan\n\ncontent')
  })

  it('fails when the file already exists and overwrite is false', () => {
    const filePath = join(dir, 'existing.md')
    writeFileSync(filePath, 'original', 'utf-8')

    const result = createFile(dir, 'existing.md', 'replacement', false)

    expect(result).toMatchObject({ success: false, code: 'FileAlreadyExists' })
    expect(readFileSync(filePath, 'utf-8')).toBe('original')
  })

  it('replaces an existing file when overwrite is true', () => {
    const filePath = join(dir, 'existing.md')
    writeFileSync(filePath, 'original', 'utf-8')

    const result = createFile(dir, 'existing.md', 'replacement', true)

    expect(result).toEqual({ success: true })
    expect(readFileSync(filePath, 'utf-8')).toBe('replacement')
  })

  it('fails when the directory does not exist', () => {
    const result = createFile(join(dir, 'missing-dir'), 'PLAN_test.md', 'content', false)

    expect(result).toMatchObject({ success: false, code: 'DirectoryNotFound' })
  })

  it('rejects an empty directory path', () => {
    expect(createFile('', 'PLAN_test.md', 'content', false)).toEqual({
      success: false,
      error: 'Invalid directory path',
      code: 'DirectoryNotFound'
    })
  })

  it('rejects invalid file names', () => {
    for (const fileName of ['', 'nested/name.md', 'nested\\name.md', '.', '..']) {
      expect(createFile(dir, fileName, 'content', false)).toEqual({
        success: false,
        error: 'Invalid file name',
        code: 'InvalidFileName'
      })
    }
  })
})
