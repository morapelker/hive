// @vitest-environment node
// How "a Claude account's organization was stored" reaches the main process from either process.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetClaudeOrganizationSignalForTests,
  emitClaudeOrganizationLearned,
  receiveClaudeOrganizationLearned,
  setClaudeOrganizationLearnedPublisher,
  subscribeClaudeOrganizationLearned
} from '../claude-organization-signal'

afterEach(() => {
  __resetClaudeOrganizationSignalForTests()
})

describe('the organization-learned signal', () => {
  it('in the main process (no publisher) goes straight to the listeners', () => {
    const listener = vi.fn()
    subscribeClaudeOrganizationLearned(listener)
    emitClaudeOrganizationLearned('team@acme.test')
    expect(listener).toHaveBeenCalledExactlyOnceWith('team@acme.test')
  })

  it('in the server child goes to the publisher and to no listener there', () => {
    const listener = vi.fn()
    const publisher = vi.fn()
    subscribeClaudeOrganizationLearned(listener)
    setClaudeOrganizationLearnedPublisher(publisher)
    emitClaudeOrganizationLearned('team@acme.test')
    expect(publisher).toHaveBeenCalledExactlyOnceWith('team@acme.test')
    expect(listener).not.toHaveBeenCalled()
  })

  it('what the child sent reaches the listeners when main receives it', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = subscribeClaudeOrganizationLearned(first)
    subscribeClaudeOrganizationLearned(second)
    receiveClaudeOrganizationLearned('team@acme.test')
    unsubscribe()
    receiveClaudeOrganizationLearned('other@acme.test')
    expect(first.mock.calls).toEqual([['team@acme.test']])
    expect(second.mock.calls).toEqual([['team@acme.test'], ['other@acme.test']])
  })

  it('never throws into the code that stored it: a failing publisher or listener is swallowed', async () => {
    setClaudeOrganizationLearnedPublisher(() => {
      throw new Error('channel closed')
    })
    expect(() => emitClaudeOrganizationLearned('team@acme.test')).not.toThrow()
    setClaudeOrganizationLearnedPublisher(() => Promise.reject(new Error('channel closed')))
    expect(() => emitClaudeOrganizationLearned('team@acme.test')).not.toThrow()
    await Promise.resolve()

    setClaudeOrganizationLearnedPublisher(null)
    const after = vi.fn()
    subscribeClaudeOrganizationLearned(() => {
      throw new Error('listener broke')
    })
    subscribeClaudeOrganizationLearned(after)
    expect(() => emitClaudeOrganizationLearned('team@acme.test')).not.toThrow()
    expect(after).toHaveBeenCalledExactlyOnceWith('team@acme.test')
  })

  it('says nothing without an email', () => {
    const listener = vi.fn()
    subscribeClaudeOrganizationLearned(listener)
    emitClaudeOrganizationLearned('')
    expect(listener).not.toHaveBeenCalled()
  })
})
