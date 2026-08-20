import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isValidDirectory,
  isGitRepository,
  canonicalPath,
  tryCanonicalPath
} from '../fs-path-checks'

// This is imported statically by three RPC domains (project-ops, github-ops) and by
// main/services/project-ops, replacing what used to be three copied definitions.
describe('fs-path-checks', () => {
  let base: string

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-path-checks-')))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  describe('isValidDirectory', () => {
    it('is true for a directory', () => {
      expect(isValidDirectory(base)).toBe(true)
    })

    it('is false for a file', () => {
      const file = join(base, 'file.txt')
      writeFileSync(file, '')
      expect(isValidDirectory(file)).toBe(false)
    })

    it('is false for a path that does not exist', () => {
      expect(isValidDirectory(join(base, 'missing'))).toBe(false)
    })
  })

  describe('isGitRepository', () => {
    it('is true when .git is a directory', () => {
      mkdirSync(join(base, '.git'))
      expect(isGitRepository(base)).toBe(true)
    })

    it('is false when there is no .git', () => {
      expect(isGitRepository(base)).toBe(false)
    })

    it('is false when .git is a file, not a directory', () => {
      // A git worktree links back with a .git *file*, which is not a repo root itself.
      writeFileSync(join(base, '.git'), 'gitdir: /elsewhere')
      expect(isGitRepository(base)).toBe(false)
    })
  })

  describe('canonicalPath', () => {
    beforeEach(() => {
      mkdirSync(join(base, 'repo'))
    })

    it('drops dot segments, repeated separators and a trailing separator', () => {
      const expected = join(base, 'repo')
      expect(canonicalPath(join(base, 'repo', '..', 'repo'))).toBe(expected)
      expect(canonicalPath(`${base}//repo`)).toBe(expected)
      expect(canonicalPath(`${base}/repo/`)).toBe(expected)
    })

    it('resolves a symlink to the real directory', () => {
      symlinkSync(join(base, 'repo'), join(base, 'link'))
      expect(canonicalPath(join(base, 'link'))).toBe(join(base, 'repo'))
    })

    it('leaves an already canonical path alone', () => {
      expect(canonicalPath(join(base, 'repo'))).toBe(join(base, 'repo'))
    })

    it('falls back to the lexical form when the path cannot be resolved', () => {
      // Only safe for comparing. Anything that stores or opens a path uses
      // tryCanonicalPath and handles the null.
      expect(canonicalPath(join(base, 'missing', '..', 'missing'))).toBe(join(base, 'missing'))
    })
  })

  describe('tryCanonicalPath', () => {
    it('resolves a real path', () => {
      mkdirSync(join(base, 'repo'))
      expect(tryCanonicalPath(join(base, 'repo', '..', 'repo'))).toBe(join(base, 'repo'))
    })

    it('returns null instead of guessing when the path cannot be resolved', () => {
      expect(tryCanonicalPath(join(base, 'missing'))).toBeNull()
    })
  })
})
