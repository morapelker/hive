import { describe, expect, it, vi } from 'vitest'

const isWindows = vi.hoisted(() => vi.fn(() => false))

vi.mock('@/lib/platform', () => ({ isWindows }))

const { diffTabAbsolutePath, isSameFilePath } = await import('@/stores/useFileViewerStore')

describe('diffTabAbsolutePath', () => {
  it('joins with a forward slash off Windows', () => {
    isWindows.mockReturnValue(false)
    expect(diffTabAbsolutePath({ worktreePath: '/wt', filePath: 'src/a.ts' })).toBe('/wt/src/a.ts')
  })

  it('builds a native path on Windows', () => {
    isWindows.mockReturnValue(true)
    // Git hands us "src/a.ts" on every platform, so the separators need converting.
    expect(diffTabAbsolutePath({ worktreePath: 'C:\\wt', filePath: 'src/a.ts' })).toBe(
      'C:\\wt\\src\\a.ts'
    )
  })

  it('does not double the separator for a worktree at the filesystem root', () => {
    // path.join gives the rows "/src/a.ts", so this has to match it.
    isWindows.mockReturnValue(false)
    expect(diffTabAbsolutePath({ worktreePath: '/', filePath: 'src/a.ts' })).toBe('/src/a.ts')

    isWindows.mockReturnValue(true)
    expect(diffTabAbsolutePath({ worktreePath: 'C:\\', filePath: 'src/a.ts' })).toBe(
      'C:\\src\\a.ts'
    )
  })
})

describe('isSameFilePath', () => {
  it('accepts either separator for the same file on Windows', () => {
    isWindows.mockReturnValue(true)
    expect(isSameFilePath('C:\\wt\\src\\a.ts', 'C:\\wt/src/a.ts')).toBe(true)
  })

  it('ignores casing on Windows, including the drive letter', () => {
    isWindows.mockReturnValue(true)
    expect(isSameFilePath('C:\\wt\\src\\Foo.ts', 'c:\\wt\\src\\foo.ts')).toBe(true)
  })

  it('keeps casing significant off Windows', () => {
    isWindows.mockReturnValue(false)
    // Two different files on a case-sensitive volume.
    expect(isSameFilePath('/wt/src/Foo.ts', '/wt/src/foo.ts')).toBe(false)
  })

  // Worktrees stored before paths were canonicalized can still carry these shapes,
  // and the rows come from path.join, so the comparison has to match its semantics.
  // Verified against Node across 27 path shapes on both platforms.
  it('treats a run of separators as one, like path.join does', () => {
    isWindows.mockReturnValue(false)
    expect(isSameFilePath('/tmp//repo/src/a.ts', '/tmp/repo/src/a.ts')).toBe(true)
  })

  it('resolves dot segments the way path.join does', () => {
    isWindows.mockReturnValue(false)
    expect(isSameFilePath('/tmp/base/../repo/src/a.ts', '/tmp/repo/src/a.ts')).toBe(true)
    expect(isSameFilePath('/tmp/./repo/src/a.ts', '/tmp/repo/src/a.ts')).toBe(true)
    // ".." cannot climb above the root, same as path.join
    expect(isSameFilePath('/a/../../b/src/a.ts', '/b/src/a.ts')).toBe(true)
  })

  it('never lets ".." climb past a Windows root', () => {
    isWindows.mockReturnValue(true)
    expect(isSameFilePath('C:\\..\\repo\\src\\a.ts', 'C:\\repo\\src\\a.ts')).toBe(true)
    expect(
      isSameFilePath('\\\\srv\\share\\..\\repo\\src\\a.ts', '\\\\srv\\share\\repo\\src\\a.ts')
    ).toBe(true)
    // A drive letter can sit in front of a relative path, as in C:foo
    expect(isSameFilePath('C:foo\\..\\bar\\src\\a.ts', 'C:bar\\src\\a.ts')).toBe(true)
  })

  it('keeps a leading ".." on a drive relative path', () => {
    isWindows.mockReturnValue(true)
    // path.win32.join keeps the ".." in C:..\repo, because a drive prefix is not
    // an absolute root, so these are two different locations.
    expect(isSameFilePath('C:..\\repo\\src\\a.ts', 'C:repo\\src\\a.ts')).toBe(false)
  })

  it('keeps different Windows roots apart', () => {
    isWindows.mockReturnValue(true)
    expect(isSameFilePath('C:\\repo\\src\\a.ts', 'D:\\repo\\src\\a.ts')).toBe(false)
    expect(isSameFilePath('\\\\srv\\one\\src\\a.ts', '\\\\srv\\two\\src\\a.ts')).toBe(false)
  })

  it('does not treat a dot inside a name as a segment', () => {
    isWindows.mockReturnValue(false)
    expect(isSameFilePath('/tmp/repo./src/a.ts', '/tmp/repo/src/a.ts')).toBe(false)
  })

  it('keeps backslash filenames distinct off Windows', () => {
    isWindows.mockReturnValue(false)
    // A backslash is a valid filename character on macOS and Linux, so these
    // are two different files and must not be treated as one.
    expect(isSameFilePath('/wt/a\\b.ts', '/wt/a/b.ts')).toBe(false)
  })

  it('matches identical paths on any platform', () => {
    isWindows.mockReturnValue(false)
    expect(isSameFilePath('/wt/src/a.ts', '/wt/src/a.ts')).toBe(true)
  })

  it('still tells different files apart', () => {
    isWindows.mockReturnValue(true)
    expect(isSameFilePath('/wt/src/a.ts', '/wt/src/b.ts')).toBe(false)
  })
})
