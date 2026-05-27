import { describe, test, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
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
        baseRef: 'synthetic-main',
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
        baseRef: 'feature',
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
        baseRef: 'main',
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
      baseRef: 'main',
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
      baseRef: 'main',
      mode: 'new'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('exited with code 7')
    expect(result.output).toContain('boom')
  })

  test('kills the script and returns failure when it exceeds the timeout', async () => {
    const result = await runWorktreeCreateScript({
      script: 'sleep 30',
      projectPath: tmpdir(),
      worktreePath: '/tmp/foo',
      branchName: 'feature',
      baseBranch: 'main',
      baseRef: 'main',
      mode: 'new',
      timeoutMs: 200
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out after 200ms')
  })

  test('kills foreground children, not just the wrapper shell', async () => {
    // Spawn a child process that outlives an `exec`-style replacement of the
    // shell. If the timeout only signals the shell, the `sleep` child keeps
    // running. With `detached: true` + `-pid` kill, the whole process group
    // dies. We assert by checking that the marker file (which would be
    // written by `sleep && touch`) never appears.
    const tmp = mkdtempSync(join(tmpdir(), 'hive-test-'))
    const marker = join(tmp, 'finished.marker')
    try {
      const result = await runWorktreeCreateScript({
        script: `sleep 5 && touch "${marker}"`,
        projectPath: tmp,
        worktreePath: '/tmp/foo',
        branchName: 'feature',
        baseBranch: 'main',
        baseRef: 'main',
        mode: 'new',
        timeoutMs: 200
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('timed out')
      // Give the would-be-orphan a generous window to misbehave
      await new Promise((r) => setTimeout(r, 1000))
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('respects a #!/usr/bin/env bash shebang for bash-specific syntax', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hive-test-'))
    const marker = join(tmp, 'arrays-worked.marker')
    try {
      // Bash arrays + `[[` are not POSIX; dash would reject this.
      const result = await runWorktreeCreateScript({
        script: `#!/usr/bin/env bash
set -euo pipefail
arr=(one two three)
if [[ "\${arr[1]}" == "two" ]]; then
  touch "${marker}"
fi`,
        projectPath: tmp,
        worktreePath: '/tmp/foo',
        branchName: 'feature',
        baseBranch: 'main',
        baseRef: 'main',
        mode: 'new'
      })

      expect(result.success).toBe(true)
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('waits for SIGKILL to actually exit the script before resolving', async () => {
    // Script traps SIGTERM and keeps running, forcing the SIGKILL fallback.
    // The resolve must wait for the child to actually exit, otherwise callers
    // race with cleanup against a still-running script.
    const start = Date.now()
    const result = await runWorktreeCreateScript({
      script: "trap '' TERM; sleep 10",
      projectPath: tmpdir(),
      worktreePath: '/tmp/foo',
      branchName: 'feature',
      baseBranch: 'main',
      baseRef: 'main',
      mode: 'new',
      timeoutMs: 100
    })
    const elapsed = Date.now() - start

    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out after 100ms')
    // 100ms timeout + 500ms grace before SIGKILL = ~600ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(500)
  })

  test('passes through HIVE_BASE_REF distinct from HIVE_BASE_BRANCH', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hive-test-'))
    const envFile = join(tmp, 'env.out')
    try {
      const result = await runWorktreeCreateScript({
        script: `printenv | grep -E '^HIVE_BASE' | sort > "${envFile}"`,
        projectPath: tmp,
        worktreePath: '/tmp/foo',
        branchName: 'feature',
        baseBranch: 'pull-request-42',
        baseRef: 'FETCH_HEAD',
        mode: 'existing'
      })

      expect(result.success).toBe(true)
      const env = readFileSync(envFile, 'utf-8')
      expect(env).toContain('HIVE_BASE_BRANCH=pull-request-42')
      expect(env).toContain('HIVE_BASE_REF=FETCH_HEAD')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
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
        baseRef: 'main',
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
