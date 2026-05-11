import { describe, expect, it } from 'vitest'

import { classifyGitError } from '../classifier'

const ctx = {
  worktreePath: '/tmp/repo',
  command: 'git test'
}

const err = (message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), extra)

describe('classifyGitError', () => {
  it.each([
    ['git conflicts array', err('merge failed', { git: { conflicts: ['a.ts', 'b.ts'] } }), ['a.ts', 'b.ts']],
    ['merge conflict substring', err('fatal: merge conflict in file'), []],
    ['content conflict substring', err('CONFLICT (content): Merge conflict in a.txt'), []],
    ['rename conflict substring', err('CONFLICT (rename/delete): renamed a.txt'), []],
    ['automatic merge failed', err('Automatic merge failed; fix conflicts and then commit the result.'), []],
    ['could not apply', err('error: could not apply abc123'), []],
    ['after resolving conflicts', err('after resolving the conflicts, mark the corrected paths'), []],
    ['hunk apply failure', err('error: patch failed: a.txt:1\nerror: hunk #1 FAILED at 1'), []]
  ])('classifies %s as GitMergeConflict', (_name, input, conflicts) => {
    const classified = classifyGitError(input, { ...ctx, operation: 'apply' })
    expect(classified._tag).toBe('GitMergeConflict')
    if (classified._tag === 'GitMergeConflict') {
      if (conflicts.length) expect(classified.conflicts).toEqual(conflicts)
      expect(classified.operation).toBe('apply')
    }
  })

  it.each([
    ['EACCES code', err('permission issue', { code: 'EACCES' })],
    ['EPERM code', err('permission issue', { code: 'EPERM' })],
    ['authentication failed', err('remote: Authentication failed')],
    ['ssh public key denied', err('Permission denied (publickey).')],
    ['plain permission denied', err('fatal: permission denied')],
    ['403 forbidden', err('The requested URL returned error: 403 Forbidden')],
    ['could not read username', err('could not read Username for https://github.com')],
    ['terminal prompts disabled', err('terminal prompts disabled')]
  ])('classifies %s as GitPermissionDenied', (_name, input) => {
    expect(classifyGitError(input, ctx)._tag).toBe('GitPermissionDenied')
  })

  it('prefers permission denied over network for ssh publickey failures', () => {
    const input = err('Could not read from remote repository. Permission denied (publickey).')
    expect(classifyGitError(input, ctx)._tag).toBe('GitPermissionDenied')
  })

  it.each([
    ['ETIMEDOUT code', err('timeout', { code: 'ETIMEDOUT' })],
    ['ECONNRESET code', err('reset', { code: 'ECONNRESET' })],
    ['ENETUNREACH code', err('unreachable', { code: 'ENETUNREACH' })],
    ['EAI_AGAIN code', err('dns', { code: 'EAI_AGAIN' })],
    ['remote repository', err('Could not read from remote repository.')],
    ['resolve host', err('Could not resolve host: github.com')],
    ['connection timed out', err('Connection timed out')],
    ['remote hung up', err('The remote end hung up unexpectedly')],
    ['unable to access', err("fatal: unable to access 'https://github.com/x/y.git/'")],
    ['failed to connect', err('Failed to connect to github.com port 443')]
  ])('classifies %s as GitNetworkError', (_name, input) => {
    expect(classifyGitError(input, ctx)._tag).toBe('GitNetworkError')
  })

  it.each([
    ['uncommitted changes', err('error: Your local changes would be overwritten by checkout')],
    ['overwritten by checkout', err('would be overwritten by checkout')],
    ['overwritten by merge', err('would be overwritten by merge')],
    ['commit or stash', err('Please commit your changes or stash them before you merge.')],
    ['local changes files', err('Your local changes to the following files would be overwritten by merge:\n\ta.txt\n\tb.txt')],
    ['untracked files', err('The following untracked working tree files would be overwritten by checkout')]
  ])('classifies %s as GitDirty', (_name, input) => {
    expect(classifyGitError(input, ctx)._tag).toBe('GitDirty')
  })

  it('extracts dirty affected paths from overwrite blocks', () => {
    const input = err(
      'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts\n\tsrc/b.ts\nPlease commit your changes or stash them before you merge.'
    )
    const classified = classifyGitError(input, ctx)
    expect(classified._tag).toBe('GitDirty')
    if (classified._tag === 'GitDirty') {
      expect(classified.affectedPaths).toEqual(['src/a.ts', 'src/b.ts'])
    }
  })

  it.each([
    ['not a git repository', err('fatal: not a git repository (or any of the parent directories): .git')],
    ['not in git dir', err('fatal: not in a git directory')],
    ['outside repository', err('is outside repository at /tmp/repo')]
  ])('classifies %s as GitNotARepository', (_name, input) => {
    expect(classifyGitError(input, ctx)._tag).toBe('GitNotARepository')
  })

  it('falls back to GitUnknown for unrecognized errors', () => {
    expect(classifyGitError(err('something surprising'), ctx)._tag).toBe('GitUnknown')
  })

  it('limits stderrExcerpt to 500 characters', () => {
    const classified = classifyGitError(err('x'.repeat(600)), ctx)
    expect(classified.stderrExcerpt).toHaveLength(500)
  })
})
