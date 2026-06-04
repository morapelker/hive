import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'vitest'

describe('syncWorktreesOp main checkout import guard', () => {
  test('skips git worktree list entries marked as the main checkout', () => {
    const source = readFileSync(
      join(__dirname, '../../src/main/services/worktree-ops.ts'),
      'utf8'
    )
    const importLoopStart = source.indexOf('for (const gitWorktree of normalizedGitWorktrees)')
    const importLoopEnd = source.indexOf('const gitBranchByPath', importLoopStart)
    const importLoop = source.slice(importLoopStart, importLoopEnd)

    expect(importLoop).toContain('gitWorktree.isMain')
  })

  test('archives previously imported non-default rows for the main checkout', () => {
    const source = readFileSync(
      join(__dirname, '../../src/main/services/worktree-ops.ts'),
      'utf8'
    )
    const archiveLoopStart = source.indexOf('for (const dbWorktree of dbWorktrees)')
    const archiveLoopEnd = source.indexOf('const gitBranch = gitBranchByPath', archiveLoopStart)
    const archiveLoop = source.slice(archiveLoopStart, archiveLoopEnd)

    expect(archiveLoop).toContain('gitMainPathSet.has(normalizedDbWorktreePath)')
    expect(archiveLoop).toContain('worktreeRepo.archive(dbWorktree.id)')
  })
})
