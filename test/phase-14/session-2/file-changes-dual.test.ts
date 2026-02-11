import { describe, test, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

// Replicate the processing logic from GitService.getFileStatuses()
// to test the dual-entry behavior in isolation
interface GitFileStatus {
  path: string
  relativePath: string
  status: 'M' | 'A' | 'D' | '?' | 'C' | ''
  staged: boolean
}

interface SimpleGitStatus {
  modified: string[]
  staged: string[]
  created: string[]
  deleted: string[]
  not_added: string[]
  conflicted: string[]
}

/**
 * Mirrors the file processing logic from GitService.getFileStatuses()
 * so we can unit-test the categorization without needing the full class.
 */
function processFileStatuses(repoPath: string, status: SimpleGitStatus): GitFileStatus[] {
  const files: GitFileStatus[] = []

  // Process modified files (not staged)
  for (const file of status.modified) {
    files.push({
      path: join(repoPath, file),
      relativePath: file,
      status: 'M',
      staged: false
    })
  }

  // Process staged files
  for (const file of status.staged) {
    const existing = files.find((f) => f.relativePath === file)
    if (existing) {
      // File has both staged and unstaged changes — keep BOTH entries
      files.push({
        path: join(repoPath, file),
        relativePath: file,
        status: 'M',
        staged: true
      })
    } else {
      files.push({
        path: join(repoPath, file),
        relativePath: file,
        status: 'A',
        staged: true
      })
    }
  }

  // Process created/added files (not yet tracked, staged)
  for (const file of status.created) {
    const existing = files.find((f) => f.relativePath === file)
    if (!existing) {
      files.push({
        path: join(repoPath, file),
        relativePath: file,
        status: 'A',
        staged: true
      })
    }
  }

  // Process deleted files
  for (const file of status.deleted) {
    files.push({
      path: join(repoPath, file),
      relativePath: file,
      status: 'D',
      staged: false
    })
  }

  // Process untracked files
  for (const file of status.not_added) {
    files.push({
      path: join(repoPath, file),
      relativePath: file,
      status: '?',
      staged: false
    })
  }

  // Process conflicted files
  for (const file of status.conflicted) {
    files.push({
      path: join(repoPath, file),
      relativePath: file,
      status: 'C',
      staged: false
    })
  }

  return files
}

const REPO_PATH = '/test/repo'

describe('Session 2: File Changes Dual Display', () => {
  test('file in both modified and staged produces two entries', () => {
    const status: SimpleGitStatus = {
      modified: ['src/app.ts'],
      staged: ['src/app.ts'],
      created: [],
      deleted: [],
      not_added: [],
      conflicted: []
    }

    const files = processFileStatuses(REPO_PATH, status)

    // Should have two entries for the same file
    const appEntries = files.filter((f) => f.relativePath === 'src/app.ts')
    expect(appEntries).toHaveLength(2)

    // One unstaged, one staged
    const unstaged = appEntries.find((f) => !f.staged)
    const staged = appEntries.find((f) => f.staged)
    expect(unstaged).toBeDefined()
    expect(staged).toBeDefined()
  })

  test('file only in modified produces one unstaged entry', () => {
    const status: SimpleGitStatus = {
      modified: ['src/utils.ts'],
      staged: [],
      created: [],
      deleted: [],
      not_added: [],
      conflicted: []
    }

    const files = processFileStatuses(REPO_PATH, status)

    expect(files).toHaveLength(1)
    expect(files[0].relativePath).toBe('src/utils.ts')
    expect(files[0].staged).toBe(false)
    expect(files[0].status).toBe('M')
  })

  test('file only in staged produces one staged entry', () => {
    const status: SimpleGitStatus = {
      modified: [],
      staged: ['src/config.ts'],
      created: [],
      deleted: [],
      not_added: [],
      conflicted: []
    }

    const files = processFileStatuses(REPO_PATH, status)

    expect(files).toHaveLength(1)
    expect(files[0].relativePath).toBe('src/config.ts')
    expect(files[0].staged).toBe(true)
    expect(files[0].status).toBe('A')
  })

  test('unstaged entry preserves original status M', () => {
    const status: SimpleGitStatus = {
      modified: ['src/app.ts'],
      staged: ['src/app.ts'],
      created: [],
      deleted: [],
      not_added: [],
      conflicted: []
    }

    const files = processFileStatuses(REPO_PATH, status)
    const unstaged = files.find((f) => f.relativePath === 'src/app.ts' && !f.staged)

    expect(unstaged).toBeDefined()
    expect(unstaged!.status).toBe('M')
    expect(unstaged!.staged).toBe(false)
  })

  test('staged entry has status M', () => {
    const status: SimpleGitStatus = {
      modified: ['src/app.ts'],
      staged: ['src/app.ts'],
      created: [],
      deleted: [],
      not_added: [],
      conflicted: []
    }

    const files = processFileStatuses(REPO_PATH, status)
    const staged = files.find((f) => f.relativePath === 'src/app.ts' && f.staged)

    expect(staged).toBeDefined()
    expect(staged!.status).toBe('M')
    expect(staged!.staged).toBe(true)
  })

  test('categorization: dual entries appear in both staged and changes panels', () => {
    const status: SimpleGitStatus = {
      modified: ['src/app.ts'],
      staged: ['src/app.ts', 'src/only-staged.ts'],
      created: [],
      deleted: [],
      not_added: ['new-file.ts'],
      conflicted: []
    }

    const files = processFileStatuses(REPO_PATH, status)

    // Categorize as the UI component would
    const stagedFiles = files.filter((f) => f.staged)
    const changesFiles = files.filter((f) => !f.staged && (f.status === 'M' || f.status === 'D'))
    const untrackedFiles = files.filter((f) => f.status === '?' && !f.staged)

    // src/app.ts staged + src/only-staged.ts = 2 staged entries
    expect(stagedFiles).toHaveLength(2)
    // src/app.ts unstaged = 1 change entry
    expect(changesFiles).toHaveLength(1)
    // new-file.ts = 1 untracked
    expect(untrackedFiles).toHaveLength(1)
  })

  test('multiple files with dual status all produce two entries each', () => {
    const status: SimpleGitStatus = {
      modified: ['src/a.ts', 'src/b.ts'],
      staged: ['src/a.ts', 'src/b.ts'],
      created: [],
      deleted: [],
      not_added: [],
      conflicted: []
    }

    const files = processFileStatuses(REPO_PATH, status)

    expect(files).toHaveLength(4)
    expect(files.filter((f) => f.relativePath === 'src/a.ts')).toHaveLength(2)
    expect(files.filter((f) => f.relativePath === 'src/b.ts')).toHaveLength(2)
    expect(files.filter((f) => f.staged)).toHaveLength(2)
    expect(files.filter((f) => !f.staged)).toHaveLength(2)
  })

  test('untracked files are unaffected by dual display logic', () => {
    const status: SimpleGitStatus = {
      modified: [],
      staged: [],
      created: [],
      deleted: [],
      not_added: ['new-file.ts', 'another-new.ts'],
      conflicted: []
    }

    const files = processFileStatuses(REPO_PATH, status)

    expect(files).toHaveLength(2)
    expect(files.every((f) => f.status === '?' && !f.staged)).toBe(true)
  })

  test('deleted files are unaffected by dual display logic', () => {
    const status: SimpleGitStatus = {
      modified: [],
      staged: [],
      created: [],
      deleted: ['old-file.ts'],
      not_added: [],
      conflicted: []
    }

    const files = processFileStatuses(REPO_PATH, status)

    expect(files).toHaveLength(1)
    expect(files[0].status).toBe('D')
    expect(files[0].staged).toBe(false)
  })

  test('path is constructed correctly for dual entries', () => {
    const status: SimpleGitStatus = {
      modified: ['src/app.ts'],
      staged: ['src/app.ts'],
      created: [],
      deleted: [],
      not_added: [],
      conflicted: []
    }

    const files = processFileStatuses(REPO_PATH, status)

    for (const file of files) {
      expect(file.path).toBe(join(REPO_PATH, 'src/app.ts'))
      expect(file.relativePath).toBe('src/app.ts')
    }
  })
})
