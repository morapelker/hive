import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { validateProject } from '../project-ops'

// A project path is stored as given, and everything downstream joins onto it with
// path.join, so it has to come out of validation canonical.
describe('validateProject path canonicalization', () => {
  let base: string

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'hive-validate-')))
    mkdirSync(join(base, 'repo', '.git'), { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('drops dot segments', () => {
    const result = validateProject(join(base, 'repo', '..', 'repo'))
    expect(result.success).toBe(true)
    expect(result.path).toBe(join(base, 'repo'))
    expect(result.name).toBe('repo')
  })

  it('drops a trailing separator and repeated separators', () => {
    expect(validateProject(join(base, 'repo') + '/').path).toBe(join(base, 'repo'))
    expect(validateProject(base + '//repo').path).toBe(join(base, 'repo'))
  })

  it('resolves a symlinked path to the real directory', () => {
    symlinkSync(join(base, 'repo'), join(base, 'link'))
    expect(validateProject(join(base, 'link')).path).toBe(join(base, 'repo'))
  })

  it('keeps the name the user picked when adding through a symlink', () => {
    // /projects/customer-app -> /repos/monorepo should stay "customer-app".
    symlinkSync(join(base, 'repo'), join(base, 'customer-app'))
    const result = validateProject(join(base, 'customer-app'))

    expect(result.name).toBe('customer-app')
    expect(result.path).toBe(join(base, 'repo'))
  })

  it('rejects a path whose ".." crosses a symlink, rather than storing a guess', () => {
    // Built by hand because path.join would collapse the ".." before the filesystem
    // sees it. On macOS realpath resolves such a path lexically and reports ENOENT,
    // even though opening it works, so there is no canonical answer to store.
    mkdirSync(join(base, 'inner'))
    symlinkSync(join(base, 'repo'), join(base, 'inner', 'link'))
    mkdirSync(join(base, 'repo', 'sibling', '.git'), { recursive: true })

    expect(validateProject(`${base}/inner/link/../repo/sibling`).success).toBe(false)
  })

  it('rejects rather than accepting a different repo the lexical path happens to hit', () => {
    // inner/link points at repo, so the filesystem reads link/.. as base. Resolving
    // it lexically instead lands on base/inner, and if a repo sits there the old
    // fallback would have stored that unrelated repository.
    mkdirSync(join(base, 'inner', 'decoy', '.git'), { recursive: true })
    symlinkSync(join(base, 'repo'), join(base, 'inner', 'link'))

    expect(validateProject(`${base}/inner/link/../decoy`).success).toBe(false)
  })

  it('leaves an already canonical path alone', () => {
    expect(validateProject(join(base, 'repo')).path).toBe(join(base, 'repo'))
  })

  it('still rejects a directory that is not a git repository', () => {
    mkdirSync(join(base, 'plain'))
    expect(validateProject(join(base, 'plain')).success).toBe(false)
  })
})
