import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalFolderPath, isSameFolder } from '../folder-identity'

/** Whether the volume the temp directory is on treats `Dev` and `dev` as one folder. */
const volumeIgnoresCase = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'folder-identity-case-'))
  try {
    mkdirSync(join(probe, 'CaseProbe'))
    return existsSync(join(probe, 'caseprobe'))
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

/** As `mkdtemp` returns it: on macOS a path through the /var symlink. */
let spelledRoot: string
/** The same directory by its real path (/private/var on macOS). */
let root: string

beforeEach(() => {
  spelledRoot = mkdtempSync(join(tmpdir(), 'folder-identity-'))
  root = realpathSync.native(spelledRoot)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('canonicalFolderPath', () => {
  it('is the path itself for a real directory', () => {
    mkdirSync(join(root, 'Dev'))
    expect(canonicalFolderPath(join(root, 'Dev'))).toBe(join(root, 'Dev'))
    expect(canonicalFolderPath(spelledRoot)).toBe(root)
  })

  it('follows a symlink, also one in the middle of the path', () => {
    mkdirSync(join(root, 'real', 'inner'), { recursive: true })
    symlinkSync(join(root, 'real'), join(root, 'link'))
    expect(canonicalFolderPath(join(root, 'link'))).toBe(join(root, 'real'))
    expect(canonicalFolderPath(join(root, 'link', 'inner'))).toBe(join(root, 'real', 'inner'))
  })

  it('removes dot segments and trailing slashes', () => {
    mkdirSync(join(root, 'Dev'))
    expect(canonicalFolderPath(`${root}/Dev/../Dev/./`)).toBe(join(root, 'Dev'))
  })

  it('accepts a path relative to the working directory', () => {
    mkdirSync(join(root, 'Dev'))
    const fromHere = relative(process.cwd(), join(root, 'Dev'))
    expect(canonicalFolderPath(fromHere)).toBe(join(root, 'Dev'))
  })

  it.skipIf(!volumeIgnoresCase)('is the spelling on disk, not the one asked for', () => {
    mkdirSync(join(root, 'Dev'))
    expect(canonicalFolderPath(join(root, 'dev'))).toBe(join(root, 'Dev'))
    expect(canonicalFolderPath(join(root, 'DEV'))).toBe(join(root, 'Dev'))
  })

  it('is null for what the filesystem cannot resolve', () => {
    writeFileSync(join(root, 'file'), 'x')
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'))
    expect(canonicalFolderPath(join(root, 'missing'))).toBeNull()
    expect(canonicalFolderPath(join(root, 'missing', 'deeper'))).toBeNull()
    expect(canonicalFolderPath(join(root, 'dangling'))).toBeNull()
    expect(canonicalFolderPath(join(root, 'file', 'below'))).toBeNull()
    expect(canonicalFolderPath(`${root}/a\0b`)).toBeNull()
  })

  it('resolves a file too: it does not check what the path is', () => {
    writeFileSync(join(root, 'file'), 'x')
    expect(canonicalFolderPath(join(root, 'file'))).toBe(join(root, 'file'))
  })
})

describe('isSameFolder', () => {
  it('is true for one path, on disk or not', () => {
    mkdirSync(join(root, 'Dev'))
    expect(isSameFolder(join(root, 'Dev'), join(root, 'Dev'))).toBe(true)
    expect(isSameFolder(join(root, 'missing'), join(root, 'missing'))).toBe(true)
  })

  it('is true for two spellings that resolve to one path, on disk or not', () => {
    mkdirSync(join(root, 'Dev'))
    expect(isSameFolder(`${root}/Dev/`, join(root, 'Dev'))).toBe(true)
    expect(isSameFolder(`${root}/x/../Dev`, `${root}/./Dev`)).toBe(true)
    expect(isSameFolder(`${root}/missing/`, `${root}/x/../missing`)).toBe(true)
  })

  it('is true for a symlink and the directory it points at', () => {
    mkdirSync(join(root, 'real', 'inner'), { recursive: true })
    symlinkSync(join(root, 'real'), join(root, 'link'))
    expect(isSameFolder(join(root, 'link'), join(root, 'real'))).toBe(true)
    expect(isSameFolder(join(root, 'real'), join(root, 'link'))).toBe(true)
    expect(isSameFolder(join(root, 'link', 'inner'), join(root, 'real', 'inner'))).toBe(true)
    expect(isSameFolder(spelledRoot, root)).toBe(true)
  })

  it.skipIf(!volumeIgnoresCase)(
    'is true for another letter case on a volume that ignores it',
    () => {
      mkdirSync(join(root, 'Dev'))
      expect(isSameFolder(join(root, 'dev'), join(root, 'Dev'))).toBe(true)
      expect(isSameFolder(join(root, 'DEV'), join(root, 'dev'))).toBe(true)
    }
  )

  it.skipIf(volumeIgnoresCase)('is false for another letter case on a volume that keeps it', () => {
    mkdirSync(join(root, 'Dev'))
    mkdirSync(join(root, 'dev'))
    expect(isSameFolder(join(root, 'dev'), join(root, 'Dev'))).toBe(false)
  })

  it('is false for two directories', () => {
    mkdirSync(join(root, 'one'))
    mkdirSync(join(root, 'two'))
    expect(isSameFolder(join(root, 'one'), join(root, 'two'))).toBe(false)
    expect(isSameFolder(join(root, 'one'), root)).toBe(false)
  })

  it('is false for a directory and a path that is not on disk', () => {
    mkdirSync(join(root, 'one'))
    expect(isSameFolder(join(root, 'one'), join(root, 'missing'))).toBe(false)
    expect(isSameFolder(join(root, 'missing'), join(root, 'one'))).toBe(false)
  })

  it('is false for two different paths that are not on disk', () => {
    expect(isSameFolder(join(root, 'missing'), join(root, 'other'))).toBe(false)
    expect(isSameFolder(join(root, 'missing'), join(root, 'missing', 'below'))).toBe(false)
  })

  it('compares what symlinks point at, not the links', () => {
    mkdirSync(join(root, 'one'))
    mkdirSync(join(root, 'two'))
    symlinkSync(join(root, 'one'), join(root, 'first'))
    symlinkSync(join(root, 'one'), join(root, 'also-first'))
    symlinkSync(join(root, 'two'), join(root, 'second'))
    expect(isSameFolder(join(root, 'first'), join(root, 'also-first'))).toBe(true)
    expect(isSameFolder(join(root, 'first'), join(root, 'second'))).toBe(false)
  })

  it('never throws', () => {
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'))
    expect(isSameFolder(join(root, 'dangling'), join(root, 'nowhere'))).toBe(false)
    expect(isSameFolder(`${root}/a\0b`, root)).toBe(false)
    expect(isSameFolder('', '')).toBe(true)
  })
})
