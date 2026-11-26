import { describe, expect, it } from 'vitest'
import { parseNavigateDeepLink } from './deep-link-events'

describe('parseNavigateDeepLink', () => {
  it('parses worktree and connection links', () => {
    expect(parseNavigateDeepLink('hive://worktree/abc-123')).toEqual({
      kind: 'worktree',
      id: 'abc-123'
    })
    expect(parseNavigateDeepLink('hive://connection/c1')).toEqual({ kind: 'connection', id: 'c1' })
  })

  it('accepts a trailing slash', () => {
    expect(parseNavigateDeepLink('hive://worktree/abc/')).toEqual({ kind: 'worktree', id: 'abc' })
  })

  it('parses new-connection links with base members and the pull switch', () => {
    expect(parseNavigateDeepLink('hive://connection/new?projects=p1,p2:base,p1&pull=0')).toEqual({
      kind: 'new-connection',
      members: [
        { projectId: 'p1', useBase: false },
        { projectId: 'p2', useBase: true }
      ],
      pull: false
    })
    expect(parseNavigateDeepLink('hive://connection/new?projects=p1')).toEqual({
      kind: 'new-connection',
      members: [{ projectId: 'p1', useBase: false }]
    })
  })

  it('rejects malformed new-connection links', () => {
    expect(parseNavigateDeepLink('hive://connection/new')).toBeNull()
    expect(parseNavigateDeepLink('hive://connection/new?projects=')).toBeNull()
    expect(parseNavigateDeepLink('hive://connection/new?projects=p1:main')).toBeNull()
    expect(parseNavigateDeepLink('hive://connection/new?projects=p1&pull=yes')).toBeNull()
  })

  it('rejects other routes, schemes and malformed links', () => {
    expect(parseNavigateDeepLink('hive://share-account?key=x')).toBeNull()
    expect(parseNavigateDeepLink('hive://worktree')).toBeNull()
    expect(parseNavigateDeepLink('hive://worktree/a/b')).toBeNull()
    expect(parseNavigateDeepLink('https://worktree/abc')).toBeNull()
    expect(parseNavigateDeepLink('not a url')).toBeNull()
  })
})
