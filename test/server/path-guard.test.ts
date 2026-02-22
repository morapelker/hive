import { describe, it, expect, beforeEach } from 'vitest'
import { PathGuard } from '../../src/server/plugins/path-guard'

describe('PathGuard', () => {
  let guard: PathGuard

  beforeEach(() => {
    guard = new PathGuard(['/home/user/projects', '/tmp/hive'])
  })

  it('accepts valid path under allowed root', () => {
    expect(guard.validatePath('/home/user/projects/myapp/src/index.ts')).toBe(true)
  })

  it('accepts path exactly matching root', () => {
    expect(guard.validatePath('/home/user/projects')).toBe(true)
  })

  it('accepts deeply nested valid path', () => {
    expect(guard.validatePath('/home/user/projects/a/b/c/d/e/f.txt')).toBe(true)
  })

  it('rejects path with ../ escaping root', () => {
    expect(guard.validatePath('/home/user/projects/../../../etc/passwd')).toBe(false)
  })

  it('rejects absolute path outside all roots', () => {
    expect(guard.validatePath('/etc/passwd')).toBe(false)
  })

  it('rejects empty path', () => {
    expect(guard.validatePath('')).toBe(false)
  })

  it('rejects whitespace-only path', () => {
    expect(guard.validatePath('   ')).toBe(false)
  })

  it('accepts path under second root', () => {
    expect(guard.validatePath('/tmp/hive/data.json')).toBe(true)
  })

  it('addRoot allows new paths', () => {
    expect(guard.validatePath('/opt/newroot/file.txt')).toBe(false)
    guard.addRoot('/opt/newroot')
    expect(guard.validatePath('/opt/newroot/file.txt')).toBe(true)
  })
})
