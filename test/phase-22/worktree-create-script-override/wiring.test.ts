import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * These tests verify that the worktree_create_script override is wired into
 * all three worktree-creation flows in the git layer. They guard against a
 * future refactor accidentally bypassing the override in one of the flows.
 */
describe('worktree_create_script override wiring', () => {
  const layersPath = join(
    __dirname,
    '..',
    '..',
    '..',
    'src',
    'main',
    'effect',
    'git',
    'layers.ts'
  )
  const layers = readFileSync(layersPath, 'utf-8')

  test('layers.ts defines runWorktreeCreateScript with HIVE_* env vars', () => {
    expect(layers).toContain('export const runWorktreeCreateScript')
    expect(layers).toContain('HIVE_PROJECT_PATH:')
    expect(layers).toContain('HIVE_WORKTREE_PATH:')
    expect(layers).toContain('HIVE_BRANCH_NAME:')
    expect(layers).toContain('HIVE_BASE_BRANCH:')
    expect(layers).toContain('HIVE_WORKTREE_MODE:')
    expect(layers).toContain('HIVE_SOURCE_WORKTREE_PATH')
    expect(layers).toContain('HIVE_SOURCE_BRANCH')
  })

  test('worktree.create branches on createScript instead of git worktree add', () => {
    // Crude scope extraction: find the worktree.create block and verify
    // it references both the override and the default `git worktree add` paths.
    const createBlockStart = layers.indexOf('create: (repoPath, projectName, breedType')
    expect(createBlockStart).toBeGreaterThan(-1)
    const createBlock = layers.slice(createBlockStart, createBlockStart + 5000)
    expect(createBlock).toContain('createScript')
    expect(createBlock).toContain('runWorktreeCreateScript')
    expect(createBlock).toContain("mode: 'new'")
  })

  test('worktree.createFromBranch branches on createScript', () => {
    const block = layers.slice(layers.indexOf('createFromBranch: (repoPath'))
    expect(block).toContain('createScript')
    expect(block).toContain('runWorktreeCreateScript')
    expect(block).toContain("mode: 'existing'")
  })

  test('duplicateWorktree branches on createScript and passes source context', () => {
    const block = layers.slice(layers.indexOf('const duplicateWorktree ='))
    expect(block).toContain('createScript')
    expect(block).toContain('runWorktreeCreateScript')
    expect(block).toContain("mode: 'duplicate'")
    expect(block).toContain('sourceWorktreePath')
    expect(block).toContain('sourceBranch')
  })

  test('worktree-ops.ts threads worktree_create_script from the project DB row', () => {
    const opsPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'src',
      'main',
      'services',
      'worktree-ops.ts'
    )
    const ops = readFileSync(opsPath, 'utf-8')
    // All three flows pull worktree_create_script from the project.
    const occurrences = ops.match(/worktree_create_script/g) || []
    expect(occurrences.length).toBeGreaterThanOrEqual(3)
  })
})
