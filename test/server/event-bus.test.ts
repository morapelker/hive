import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus, getEventBus, resetEventBus } from '../../src/server/event-bus'

describe('EventBus', () => {
  let bus: EventBus

  beforeEach(() => {
    resetEventBus()
    bus = new EventBus()
  })

  it('emits and receives opencode:stream events with correct shape', () => {
    const received: unknown[] = []
    const event = {
      type: 'message.created',
      sessionId: 'sess-1',
      data: { text: 'hello' },
    }

    bus.on('opencode:stream', (e) => {
      received.push(e)
    })
    bus.emit('opencode:stream', event)

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(event)
  })

  it('emits and receives terminal:data events with two arguments', () => {
    let capturedWorktreeId: string | undefined
    let capturedData: string | undefined

    bus.on('terminal:data', (worktreeId, data) => {
      capturedWorktreeId = worktreeId
      capturedData = data
    })
    bus.emit('terminal:data', 'wt-123', 'ls -la\n')

    expect(capturedWorktreeId).toBe('wt-123')
    expect(capturedData).toBe('ls -la\n')
  })

  it('emits and receives script:output events with two arguments', () => {
    let capturedChannel: string | undefined
    let capturedEvent: unknown

    const outputEvent = {
      type: 'output' as const,
      data: 'building...',
    }

    bus.on('script:output', (channel, event) => {
      capturedChannel = channel
      capturedEvent = event
    })
    bus.emit('script:output', 'script:run:wt-1', outputEvent)

    expect(capturedChannel).toBe('script:run:wt-1')
    expect(capturedEvent).toEqual(outputEvent)
  })

  it('emits and receives git:statusChanged events', () => {
    const received: unknown[] = []
    const payload = { worktreePath: '/home/user/project' }

    bus.on('git:statusChanged', (data) => {
      received.push(data)
    })
    bus.emit('git:statusChanged', payload)

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(payload)
  })

  it('off() removes a specific listener', () => {
    const received: string[] = []
    const listener = (data: { worktreePath: string }) => {
      received.push(data.worktreePath)
    }

    bus.on('git:statusChanged', listener)
    bus.emit('git:statusChanged', { worktreePath: '/first' })
    expect(received).toHaveLength(1)

    bus.off('git:statusChanged', listener)
    bus.emit('git:statusChanged', { worktreePath: '/second' })
    expect(received).toHaveLength(1)
    expect(received[0]).toBe('/first')
  })

  it('removeAllListeners() clears all listeners for all events', () => {
    const streamReceived: unknown[] = []
    const statusReceived: unknown[] = []

    bus.on('opencode:stream', (e) => streamReceived.push(e))
    bus.on('git:statusChanged', (d) => statusReceived.push(d))

    bus.removeAllListeners()

    bus.emit('opencode:stream', { type: 'test', sessionId: 's1', data: null })
    bus.emit('git:statusChanged', { worktreePath: '/path' })

    expect(streamReceived).toHaveLength(0)
    expect(statusReceived).toHaveLength(0)
  })

  it('multiple listeners on same event all receive the event', () => {
    const firstReceived: unknown[] = []
    const secondReceived: unknown[] = []
    const payload = { worktreePath: '/repo' }

    bus.on('git:statusChanged', (d) => firstReceived.push(d))
    bus.on('git:statusChanged', (d) => secondReceived.push(d))

    bus.emit('git:statusChanged', payload)

    expect(firstReceived).toHaveLength(1)
    expect(firstReceived[0]).toEqual(payload)
    expect(secondReceived).toHaveLength(1)
    expect(secondReceived[0]).toEqual(payload)
  })

  it('listeners for different events do not interfere', () => {
    const streamReceived: unknown[] = []
    const statusReceived: unknown[] = []

    bus.on('opencode:stream', (e) => streamReceived.push(e))
    bus.on('git:statusChanged', (d) => statusReceived.push(d))

    bus.emit('git:statusChanged', { worktreePath: '/only-status' })

    expect(streamReceived).toHaveLength(0)
    expect(statusReceived).toHaveLength(1)
  })
})

describe('resetEventBus()', () => {
  it('creates a fresh instance after reset', () => {
    const first = getEventBus()
    const sameRef = getEventBus()
    expect(first).toBe(sameRef)

    resetEventBus()

    const second = getEventBus()
    expect(second).not.toBe(first)
  })
})
