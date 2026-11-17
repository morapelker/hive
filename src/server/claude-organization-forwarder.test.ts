import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL,
  __resetClaudeOrganizationSignalForTests,
  emitClaudeOrganizationLearned
} from '../main/services/usage/claude-organization-signal'

import {
  DESKTOP_COMMAND_REQUEST_TYPE,
  isDesktopCommandRequest,
  type DesktopCommandRequest
} from '../shared/desktop-command'
import {
  __resetClaudeOrganizationForwarderForTests,
  connectClaudeOrganizationLearningInServer,
  forwardClaudeOrganizationLearnedToDesktop,
  type ClaudeOrganizationIpc
} from './claude-organization-forwarder'
import { makeEventBus } from './events/event-bus'

/** A stand-in for the child's `process`: records what was sent to main. */
class FakeIpc implements ClaudeOrganizationIpc {
  readonly sent: DesktopCommandRequest[] = []
  readonly refused: unknown[] = []
  sendError: Error | null = null
  send?: ClaudeOrganizationIpc['send'] = (message, callback) => {
    if (isDesktopCommandRequest(message)) this.sent.push(message)
    else this.refused.push(message)
    callback(this.sendError)
    return true
  }
}

describe('forwardClaudeOrganizationLearnedToDesktop', () => {
  let ipc: FakeIpc

  beforeEach(() => {
    ipc = new FakeIpc()
    __resetClaudeOrganizationForwarderForTests(ipc)
  })

  afterEach(() => {
    __resetClaudeOrganizationForwarderForTests()
  })

  it('sends the email as a claudeOrganizationLearned command main accepts, each with its own id', () => {
    forwardClaudeOrganizationLearnedToDesktop('team@acme.test')
    forwardClaudeOrganizationLearnedToDesktop('other@acme.test')

    expect(ipc.refused).toEqual([])
    expect(
      ipc.sent.map((request) =>
        request.command === 'claudeOrganizationLearned' ? request.payload : request.command
      )
    ).toEqual([{ email: 'team@acme.test' }, { email: 'other@acme.test' }])
    expect(new Set(ipc.sent.map((request) => request.id)).size).toBe(2)
  })

  it('does not throw when main refuses or the channel fails', () => {
    ipc.sendError = new Error('channel closed')
    expect(() => forwardClaudeOrganizationLearnedToDesktop('team@acme.test')).not.toThrow()

    ipc.send = () => {
      throw new Error('ERR_IPC_CHANNEL_CLOSED')
    }
    expect(() => forwardClaudeOrganizationLearnedToDesktop('team@acme.test')).not.toThrow()
  })

  it('sends nothing without an IPC channel (the server run on its own)', () => {
    ipc.send = undefined
    expect(() => forwardClaudeOrganizationLearnedToDesktop('team@acme.test')).not.toThrow()
    expect(ipc.sent).toEqual([])
  })

  it('is only accepted by main with an email', () => {
    const request = (payload: unknown): unknown => ({
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id: 'x',
      command: 'claudeOrganizationLearned',
      payload
    })
    expect(isDesktopCommandRequest(request({ email: 'team@acme.test' }))).toBe(true)
    expect(isDesktopCommandRequest(request({ email: '' }))).toBe(false)
    expect(isDesktopCommandRequest(request({}))).toBe(false)
    expect(isDesktopCommandRequest(request(undefined))).toBe(false)
  })
})

describe('connectClaudeOrganizationLearningInServer', () => {
  let ipc: FakeIpc

  beforeEach(() => {
    ipc = new FakeIpc()
    __resetClaudeOrganizationForwarderForTests(ipc)
    __resetClaudeOrganizationSignalForTests()
  })

  afterEach(() => {
    __resetClaudeOrganizationForwarderForTests()
    __resetClaudeOrganizationSignalForTests()
  })

  const publish = (bus: ReturnType<typeof makeEventBus>, channel: string): void =>
    Effect.runSync(bus.publish({ channel, payload: {} }))

  it('asks for learning each time main publishes "organizations needed", and for nothing else', () => {
    const bus = makeEventBus()
    const requestLearning = vi.fn()
    connectClaudeOrganizationLearningInServer(bus, requestLearning)

    publish(bus, 'usage:claudeLive')
    expect(requestLearning).not.toHaveBeenCalled()

    publish(bus, CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL)
    publish(bus, CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL)
    expect(requestLearning).toHaveBeenCalledTimes(2)
  })

  it('sends an organization stored in this process to main', () => {
    connectClaudeOrganizationLearningInServer(makeEventBus(), vi.fn())

    emitClaudeOrganizationLearned('team@acme.test')

    expect(
      ipc.sent.map((request) =>
        request.command === 'claudeOrganizationLearned' ? request.payload : request.command
      )
    ).toEqual([{ email: 'team@acme.test' }])
  })

  it('keeps a failing learner out of the event bus', () => {
    const bus = makeEventBus()
    connectClaudeOrganizationLearningInServer(bus, () => {
      throw new Error('learner broke')
    })

    expect(() => publish(bus, CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL)).not.toThrow()
  })

  it('does nothing by default where account maintenance is not running', () => {
    const bus = makeEventBus()
    connectClaudeOrganizationLearningInServer(bus)

    expect(() => publish(bus, CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL)).not.toThrow()
  })

  it('stops both ways once disconnected', () => {
    const bus = makeEventBus()
    const requestLearning = vi.fn()
    const disconnect = connectClaudeOrganizationLearningInServer(bus, requestLearning)

    disconnect()
    publish(bus, CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL)
    emitClaudeOrganizationLearned('team@acme.test')

    expect(requestLearning).not.toHaveBeenCalled()
    expect(ipc.sent).toEqual([])
    expect(bus.subscriberCount(CLAUDE_ORGANIZATIONS_NEEDED_CHANNEL)).toBe(0)
  })
})
