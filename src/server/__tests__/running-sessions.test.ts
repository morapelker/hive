// Which sessions this Mac's window reports as running: whose report counts, and until when.
import { describe, expect, it } from 'vitest'
import { createRunningSessionsTracker } from '../running-sessions'

describe('running sessions tracker', () => {
  it('knows nothing before a window reported', () => {
    expect(createRunningSessionsTracker().runningSessionIds()).toEqual([])
  })

  it('keeps the last set a window reported: a new report replaces the one before', () => {
    const tracker = createRunningSessionsTracker()
    tracker.report('socket-1', ['s1', 's2'])
    expect([...tracker.runningSessionIds()].sort()).toEqual(['s1', 's2'])
    tracker.report('socket-1', ['s2'])
    expect(tracker.runningSessionIds()).toEqual(['s2'])
    tracker.report('socket-1', [])
    expect(tracker.runningSessionIds()).toEqual([])
  })

  it('lists a session two windows report once', () => {
    const tracker = createRunningSessionsTracker()
    tracker.report('socket-1', ['s1', 's2'])
    tracker.report('socket-2', ['s2', 's3'])
    expect([...tracker.runningSessionIds()].sort()).toEqual(['s1', 's2', 's3'])
  })

  it('forgets what a window reported when its socket closes, and only that', () => {
    const tracker = createRunningSessionsTracker()
    tracker.report('socket-1', ['s1'])
    tracker.report('socket-2', ['s2'])
    tracker.releaseSocket('socket-1')
    expect(tracker.runningSessionIds()).toEqual(['s2'])
  })

  it('drops a report that arrives after its socket closed', () => {
    const tracker = createRunningSessionsTracker()
    tracker.releaseSocket('socket-1')
    tracker.report('socket-1', ['s1'])
    expect(tracker.runningSessionIds()).toEqual([])
  })

  it('takes a report that came through no socket', () => {
    const tracker = createRunningSessionsTracker()
    tracker.report(null, ['s1'])
    tracker.report(null, ['s2'])
    expect(tracker.runningSessionIds()).toEqual(['s2'])
  })

  it('does not follow the array it was handed', () => {
    const tracker = createRunningSessionsTracker()
    const ids = ['s1']
    tracker.report('socket-1', ids)
    ids.push('s2')
    expect(tracker.runningSessionIds()).toEqual(['s1'])
  })
})
