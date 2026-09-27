import { describe, it, expect, beforeEach } from 'vitest'
import {
  useScrollTagStore,
  MAX_TAGS_PER_SESSION,
  MAX_SESSIONS,
  type ScrollTag
} from './useScrollTagStore'

function makeTag(overrides: Partial<ScrollTag> = {}): ScrollTag {
  return {
    id: overrides.id ?? `tag-${Math.random().toString(36).slice(2)}`,
    color: overrides.color ?? '#ef4444',
    anchor: overrides.anchor ?? {
      itemKey: 'message:msg_1',
      offsetWithinItem: 42,
      fallbackScrollTop: 1000,
      fallbackScrollHeight: 5000
    },
    fractionHint: overrides.fractionHint ?? 0.2,
    createdAt: overrides.createdAt ?? 1
  }
}

describe('useScrollTagStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useScrollTagStore.setState({ tagsBySession: {} })
  })

  it('adds a tag for a session', () => {
    const tag = makeTag()
    useScrollTagStore.getState().addTag('session-a', tag)
    expect(useScrollTagStore.getState().tagsBySession['session-a']).toEqual([tag])
  })

  it('keeps tags isolated per session', () => {
    const a = makeTag({ id: 'a' })
    const b = makeTag({ id: 'b' })
    useScrollTagStore.getState().addTag('session-a', a)
    useScrollTagStore.getState().addTag('session-b', b)
    expect(useScrollTagStore.getState().tagsBySession['session-a']).toEqual([a])
    expect(useScrollTagStore.getState().tagsBySession['session-b']).toEqual([b])
  })

  it('removes a tag by id', () => {
    const a = makeTag({ id: 'a' })
    const b = makeTag({ id: 'b' })
    useScrollTagStore.getState().addTag('session-a', a)
    useScrollTagStore.getState().addTag('session-a', b)
    useScrollTagStore.getState().removeTag('session-a', 'a')
    expect(useScrollTagStore.getState().tagsBySession['session-a']).toEqual([b])
  })

  it('deletes the session key when the last tag is removed', () => {
    const a = makeTag({ id: 'a' })
    useScrollTagStore.getState().addTag('session-a', a)
    useScrollTagStore.getState().removeTag('session-a', 'a')
    expect('session-a' in useScrollTagStore.getState().tagsBySession).toBe(false)
  })

  it('drops the oldest tag when exceeding the per-session cap', () => {
    for (let i = 0; i < MAX_TAGS_PER_SESSION; i++) {
      useScrollTagStore.getState().addTag('session-a', makeTag({ id: `t${i}`, createdAt: i }))
    }
    useScrollTagStore.getState().addTag('session-a', makeTag({ id: 'newest', createdAt: 999 }))
    const tags = useScrollTagStore.getState().tagsBySession['session-a']
    expect(tags).toHaveLength(MAX_TAGS_PER_SESSION)
    expect(tags.find((t) => t.id === 't0')).toBeUndefined()
    expect(tags[tags.length - 1].id).toBe('newest')
  })

  it('drops the least-recently-touched session when exceeding the session cap', () => {
    for (let i = 0; i < MAX_SESSIONS; i++) {
      useScrollTagStore.getState().addTag(`session-${i}`, makeTag({ id: `t${i}` }))
    }
    // Touch session-0 so it becomes most-recent; session-1 is now oldest.
    useScrollTagStore.getState().addTag('session-0', makeTag({ id: 'touch' }))
    useScrollTagStore.getState().addTag('session-new', makeTag({ id: 'n' }))

    const sessions = useScrollTagStore.getState().tagsBySession
    expect(Object.keys(sessions)).toHaveLength(MAX_SESSIONS)
    expect('session-1' in sessions).toBe(false)
    expect('session-0' in sessions).toBe(true)
    expect('session-new' in sessions).toBe(true)
  })

  it('touchSession moves an existing session to most-recent', () => {
    useScrollTagStore.getState().addTag('session-a', makeTag({ id: 'a' }))
    useScrollTagStore.getState().addTag('session-b', makeTag({ id: 'b' }))
    useScrollTagStore.getState().touchSession('session-a')
    expect(Object.keys(useScrollTagStore.getState().tagsBySession)).toEqual([
      'session-b',
      'session-a'
    ])
  })

  it('a touched session survives eviction over an untouched one', () => {
    for (let i = 0; i < MAX_SESSIONS; i++) {
      useScrollTagStore.getState().addTag(`session-${i}`, makeTag({ id: `t${i}` }))
    }
    // session-0 is oldest; touching it should make session-1 the eviction candidate.
    useScrollTagStore.getState().touchSession('session-0')
    useScrollTagStore.getState().addTag('session-new', makeTag({ id: 'n' }))

    const sessions = useScrollTagStore.getState().tagsBySession
    expect('session-0' in sessions).toBe(true)
    expect('session-1' in sessions).toBe(false)
  })

  it('touchSession is a no-op for an unknown session', () => {
    useScrollTagStore.getState().addTag('session-a', makeTag({ id: 'a' }))
    const before = useScrollTagStore.getState().tagsBySession
    useScrollTagStore.getState().touchSession('session-missing')
    expect(useScrollTagStore.getState().tagsBySession).toBe(before)
  })

  it('persists only tagsBySession under the hive-scroll-tags key', () => {
    useScrollTagStore.getState().addTag('session-a', makeTag({ id: 'a' }))
    const raw = localStorage.getItem('hive-scroll-tags')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string)
    expect(Object.keys(parsed.state)).toEqual(['tagsBySession'])
    expect(parsed.state.tagsBySession['session-a'][0].id).toBe('a')
  })
})
