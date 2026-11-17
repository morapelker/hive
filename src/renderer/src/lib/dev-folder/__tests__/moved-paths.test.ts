import { describe, expect, it } from 'vitest'
import { isSameOrInsidePath, movedPathFor, parentFolderOf } from '../moved-paths'

describe('isSameOrInsidePath', () => {
  it('holds for the folder itself and for everything inside it', () => {
    expect(isSameOrInsidePath('/x/app', '/x/app')).toBe(true)
    expect(isSameOrInsidePath('/x/app/src', '/x/app')).toBe(true)
    expect(isSameOrInsidePath('/x/app/src/deep/file.ts', '/x/app')).toBe(true)
  })

  it('does not hold for a folder that only starts with the same characters', () => {
    expect(isSameOrInsidePath('/x/app2', '/x/app')).toBe(false)
    expect(isSameOrInsidePath('/x/app-feature', '/x/app')).toBe(false)
    expect(isSameOrInsidePath('/x/app.bak/src', '/x/app')).toBe(false)
    expect(isSameOrInsidePath('/x/ap', '/x/app')).toBe(false)
    expect(isSameOrInsidePath('/x', '/x/app')).toBe(false)
    expect(isSameOrInsidePath('/y/x/app', '/x/app')).toBe(false)
  })

  it('reads a folder written with a trailing separator as the folder', () => {
    expect(isSameOrInsidePath('/x/app', '/x/app/')).toBe(true)
    expect(isSameOrInsidePath('/x/app/src', '/x/app/')).toBe(true)
    expect(isSameOrInsidePath('/x/app2', '/x/app/')).toBe(false)
  })

  it('never treats a root or an empty folder as one that holds a path', () => {
    expect(isSameOrInsidePath('/x/app', '/')).toBe(false)
    expect(isSameOrInsidePath('/x/app', '')).toBe(false)
    expect(isSameOrInsidePath('', '')).toBe(false)
  })

  it('splits a POSIX path at the slash only: a backslash is part of a name there', () => {
    expect(isSameOrInsidePath('/x/app\\notes', '/x/app')).toBe(false)
  })

  it('splits a Windows path at either separator', () => {
    expect(isSameOrInsidePath('C:\\code\\app\\src', 'C:\\code\\app')).toBe(true)
    expect(isSameOrInsidePath('C:\\code\\app/src', 'C:\\code\\app')).toBe(true)
    expect(isSameOrInsidePath('C:\\code\\app2', 'C:\\code\\app')).toBe(false)
  })
})

describe('parentFolderOf', () => {
  it('answers the folder a path sits in', () => {
    expect(parentFolderOf('/x/app')).toBe('/x')
    expect(parentFolderOf('/x/app/src/index.ts')).toBe('/x/app/src')
    expect(parentFolderOf('/x/app/')).toBe('/x')
  })

  it('gives two folders that sit next to each other the same answer', () => {
    expect(parentFolderOf('/x/app-feature')).toBe(parentFolderOf('/x/app'))
    expect(parentFolderOf('/x/app/.worktrees/fix')).not.toBe(parentFolderOf('/x/app'))
    expect(parentFolderOf('/y/app')).not.toBe(parentFolderOf('/x/app'))
  })

  it('answers nothing for a path that is not inside a folder', () => {
    expect(parentFolderOf('/')).toBe('')
    expect(parentFolderOf('/app')).toBe('')
    expect(parentFolderOf('app')).toBe('')
    expect(parentFolderOf('')).toBe('')
  })

  it('splits a POSIX path at the slash only, and a Windows path at either separator', () => {
    expect(parentFolderOf('/x/app\\notes')).toBe('/x')
    expect(parentFolderOf('C:\\code\\app')).toBe('C:\\code')
    expect(parentFolderOf('C:\\code/app')).toBe('C:\\code')
  })
})

describe('movedPathFor', () => {
  const moves = [{ from: '/old/app', to: '/new/app' }]

  it('swaps the moved folder for its new place and keeps the rest of the path', () => {
    expect(movedPathFor('/old/app', moves)).toBe('/new/app')
    expect(movedPathFor('/old/app/src/index.ts', moves)).toBe('/new/app/src/index.ts')
  })

  it('answers null for a path no moved folder holds', () => {
    expect(movedPathFor('/old/app2', moves)).toBeNull()
    expect(movedPathFor('/old/app2/src', moves)).toBeNull()
    expect(movedPathFor('/old', moves)).toBeNull()
    expect(movedPathFor('/new/app', moves)).toBeNull()
    expect(movedPathFor('/old/app', [])).toBeNull()
  })

  it('lets the deepest moved folder decide, whatever the order of the list', () => {
    const nested = [
      { from: '/old/app', to: '/new/app' },
      { from: '/old/app/wt/feature', to: '/elsewhere/feature' }
    ]
    expect(movedPathFor('/old/app/wt/feature/src', nested)).toBe('/elsewhere/feature/src')
    expect(movedPathFor('/old/app/wt/feature/src', [...nested].reverse())).toBe(
      '/elsewhere/feature/src'
    )
    expect(movedPathFor('/old/app/wt/other', nested)).toBe('/new/app/wt/other')
  })

  it('keeps a worktree that sat next to the project apart from the project', () => {
    const siblings = [
      { from: '/old/app', to: '/new/app' },
      { from: '/old/app-feature', to: '/new/app-feature' }
    ]
    expect(movedPathFor('/old/app-feature/src', siblings)).toBe('/new/app-feature/src')
    expect(movedPathFor('/old/app/src', siblings)).toBe('/new/app/src')
  })

  it('does not double a separator when a folder is written with a trailing one', () => {
    expect(movedPathFor('/old/app/src', [{ from: '/old/app/', to: '/new/app/' }])).toBe(
      '/new/app/src'
    )
  })
})
