import { describe, test, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/mock-home') }
}))

import { runWorktreeCreateScript } from '../../../src/main/effect/git/layers'

describe('runWorktreeCreateScript', () => {
  test('exports HIVE_* env vars to the script in `new` mode', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hive-test-'))
    const envFile = join(tmp, 'env.out')
    try {
      const result = await runWorktreeCreateScript({
        script: `printenv | grep '^HIVE_' | sort > "${envFile}"`,
        projectPath: tmp,
        worktreePath: '/tmp/synthetic-worktree-path',
        branchName: 'synthetic-feature',
        baseBranch: 'synthetic-main',
        mode: 'new'
      })

      expect(result.success).toBe(true)
      const env = readFileSync(envFile, 'utf-8')
      expect(env).toContain('HIVE_BASE_BRANCH=synthetic-main')
      expect(env).toContain('HIVE_BRANCH_NAME=synthetic-feature')
      expect(env).toContain(`HIVE_PROJECT_PATH=${tmp}`)
      expect(env).toContain('HIVE_WORKTREE_MODE=new')
      expect(env).toContain('HIVE_WORKTREE_PATH=/tmp/synthetic-worktree-path')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('includes HIVE_SOURCE_* env vars in `duplicate` mode', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hive-test-'))
    const envFile = join(tmp, 'env.out')
    try {
      const result = await runWorktreeCreateScript({
        script: `printenv | grep '^HIVE_' | sort > "${envFile}"`,
        projectPath: tmp,
        worktreePath: '/tmp/dup-target',
        branchName: 'feature-v2',
        baseBranch: 'feature',
        mode: 'duplicate',
        sourceWorktreePath: '/tmp/dup-source',
        sourceBranch: 'feature'
      })

      expect(result.success).toBe(true)
      const env = readFileSync(envFile, 'utf-8')
      expect(env).toContain('HIVE_SOURCE_BRANCH=feature')
      expect(env).toContain('HIVE_SOURCE_WORKTREE_PATH=/tmp/dup-source')
      expect(env).toContain('HIVE_WORKTREE_MODE=duplicate')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('omits HIVE_SOURCE_* env vars outside duplicate mode', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hive-test-'))
    const envFile = join(tmp, 'env.out')
    try {
      await runWorktreeCreateScript({
        script: `printenv | grep '^HIVE_' > "${envFile}" || true`,
        projectPath: tmp,
        worktreePath: '/tmp/foo',
        branchName: 'feature',
        baseBranch: 'main',
        mode: 'new'
      })

      const env = readFileSync(envFile, 'utf-8')
      expect(env).not.toContain('HIVE_SOURCE_WORKTREE_PATH')
      expect(env).not.toContain('HIVE_SOURCE_BRANCH')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('returns success with captured stdout when script exits 0', async () => {
    const result = await runWorktreeCreateScript({
      script: 'echo "hello from script"',
      projectPath: tmpdir(),
      worktreePath: '/tmp/foo',
      branchName: 'feature',
      baseBranch: 'main',
      mode: 'new'
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('hello from script')
  })

  test('returns failure with stderr captured when script exits non-zero', async () => {
    const result = await runWorktreeCreateScript({
      script: 'echo "boom" >&2; exit 7',
      projectPath: tmpdir(),
      worktreePath: '/tmp/foo',
      branchName: 'feature',
      baseBranch: 'main',
      mode: 'new'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('exited with code 7')
    expect(result.output).toContain('boom')
  })

  test('runs the script in the project path as cwd', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hive-test-'))
    const pwdFile = join(tmp, 'pwd.out')
    try {
      const result = await runWorktreeCreateScript({
        script: `pwd > "${pwdFile}"`,
        projectPath: tmp,
        worktreePath: '/tmp/foo',
        branchName: 'feature',
        baseBranch: 'main',
        mode: 'new'
      })

      expect(result.success).toBe(true)
      const pwd = readFileSync(pwdFile, 'utf-8').trim()
      // Resolve potential macOS /private/ prefix on tmpdir paths
      expect(pwd === tmp || pwd === `/private${tmp}`).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
