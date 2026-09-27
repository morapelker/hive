import { describe, expect, it, vi } from 'vitest'

const gitApiMocks = vi.hoisted(() => ({
  getBranchDiffFiles: vi.fn(),
  getBranchFileDiff: vi.fn(),
  getDiffStat: vi.fn(),
  getFileStatuses: vi.fn(),
  getDiff: vi.fn()
}))

vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))

import {
  changedFilesTotals,
  filterChangedFiles,
  isLargeDiff,
  loadChangedFileDiff,
  loadChangedFiles,
  normalizeStatus,
  numstatDestinationPath,
  splitPath,
  unquoteGitPath
} from './changed-files'

describe('unquoteGitPath', () => {
  it('leaves plain paths alone', () => {
    expect(unquoteGitPath('src/app.ts')).toBe('src/app.ts')
    expect(unquoteGitPath('"')).toBe('"')
  })

  it('decodes C-quoted UTF-8 octal escapes', () => {
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe('café.txt')
    expect(unquoteGitPath('"docs/\\346\\227\\245\\346\\234\\254.md"')).toBe('docs/日本.md')
  })

  it('decodes simple escapes', () => {
    expect(unquoteGitPath('"a\\tb"')).toBe('a\tb')
    expect(unquoteGitPath('"say \\"hi\\""')).toBe('say "hi"')
    expect(unquoteGitPath('"back\\\\slash"')).toBe('back\\slash')
  })
})

describe('numstatDestinationPath', () => {
  it('keeps ordinary paths', () => {
    expect(numstatDestinationPath('src/app.ts')).toBe('src/app.ts')
  })

  it('resolves braced and plain rename forms to the new path', () => {
    expect(numstatDestinationPath('src/{old => new}/index.ts')).toBe('src/new/index.ts')
    expect(numstatDestinationPath('{a => b}.ts')).toBe('b.ts')
    expect(numstatDestinationPath('old.ts => new.ts')).toBe('new.ts')
  })
})

describe('small helpers', () => {
  it('normalises status letters', () => {
    expect(normalizeStatus('A')).toBe('A')
    expect(normalizeStatus('C')).toBe('U')
    expect(normalizeStatus('R')).toBe('')
    expect(normalizeStatus(undefined)).toBe('')
  })

  it('splits paths and sums totals', () => {
    expect(splitPath('a/b/c.ts')).toEqual({ dir: 'a/b/', name: 'c.ts' })
    expect(splitPath('c.ts')).toEqual({ dir: '', name: 'c.ts' })
    const files = [
      { path: 'a', status: 'M' as const, additions: 2, deletions: 1, binary: false },
      { path: 'b', status: 'A' as const, additions: 3, deletions: 0, binary: true }
    ]
    expect(changedFilesTotals(files)).toEqual({ files: 2, additions: 5, deletions: 1 })
    expect(filterChangedFiles(files, ' B ')).toEqual([files[1]])
    expect(isLargeDiff({ ...files[0], additions: 1501 })).toBe(true)
    expect(isLargeDiff({ ...files[1], additions: 5000 })).toBe(false)
  })
})

describe('loadChangedFiles (worktree source)', () => {
  it('merges numstat rows with status letters, decoding quoted and renamed paths', async () => {
    gitApiMocks.getDiffStat.mockResolvedValue({
      success: true,
      files: [
        { path: '"caf\\303\\251.txt"', additions: 1, deletions: 0, binary: false },
        { path: 'src/{old => new}.ts', additions: 4, deletions: 4, binary: false },
        { path: 'plain.ts', additions: 2, deletions: 2, binary: false }
      ]
    })
    gitApiMocks.getFileStatuses.mockResolvedValue({
      success: true,
      files: [
        { path: '/w/café.txt', relativePath: 'café.txt', status: '?', staged: false },
        { path: '/w/src/new.ts', relativePath: 'src/new.ts', status: 'A', staged: true },
        { path: '/w/plain.ts', relativePath: 'plain.ts', status: 'M', staged: true },
        { path: '/w/plain.ts', relativePath: 'plain.ts', status: 'M', staged: false }
      ]
    })

    const result = await loadChangedFiles({ kind: 'worktree', worktreePath: '/w' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map((f) => [f.path, f.status])).toEqual([
      ['café.txt', '?'],
      ['plain.ts', 'M'],
      ['src/new.ts', 'A']
    ])
  })

  it('still lists files when statuses cannot be read', async () => {
    gitApiMocks.getDiffStat.mockResolvedValue({
      success: true,
      files: [{ path: 'a.ts', additions: 1, deletions: 1, binary: false }]
    })
    gitApiMocks.getFileStatuses.mockRejectedValue(new Error('nope'))

    const result = await loadChangedFiles({ kind: 'worktree', worktreePath: '/w' })

    expect(result).toEqual({
      ok: true,
      value: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 1, binary: false }]
    })
  })
})

describe('loadChangedFileDiff', () => {
  it('routes each source to the right git call', async () => {
    gitApiMocks.getBranchFileDiff.mockResolvedValue({ success: true, diff: 'branch' })
    gitApiMocks.getDiff.mockResolvedValue({ success: true, diff: 'untracked' })
    const file = { path: 'a.ts', status: 'M' as const, additions: 1, deletions: 0, binary: false }

    await expect(
      loadChangedFileDiff({ kind: 'branch', worktreePath: '/w', baseBranch: 'main' }, file)
    ).resolves.toEqual({ ok: true, value: 'branch' })
    expect(gitApiMocks.getBranchFileDiff).toHaveBeenLastCalledWith('/w', 'main', 'a.ts')

    await expect(
      loadChangedFileDiff({ kind: 'worktree', worktreePath: '/w' }, file)
    ).resolves.toEqual({ ok: true, value: 'branch' })
    expect(gitApiMocks.getBranchFileDiff).toHaveBeenLastCalledWith('/w', 'HEAD', 'a.ts')

    await expect(
      loadChangedFileDiff({ kind: 'worktree', worktreePath: '/w' }, { ...file, status: '?' })
    ).resolves.toEqual({ ok: true, value: 'untracked' })
    expect(gitApiMocks.getDiff).toHaveBeenCalledWith('/w', 'a.ts', false, true)
  })

  it('surfaces git errors', async () => {
    gitApiMocks.getBranchFileDiff.mockResolvedValue({ success: false, error: 'boom' })
    await expect(
      loadChangedFileDiff(
        { kind: 'branch', worktreePath: '/w', baseBranch: 'main' },
        { path: 'a.ts', status: 'M', additions: 1, deletions: 0, binary: false }
      )
    ).resolves.toEqual({ ok: false, error: 'boom' })
  })
})
