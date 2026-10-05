import { describe, expect, it } from 'vitest'
import {
  DESKTOP_COMMAND_REQUEST_TYPE,
  isDesktopCommandRequest,
  makeDesktopCommandRequest
} from '../desktop-command'

describe('shell command desktop commands', () => {
  it('builds a terminalRunShellCommand request', () => {
    const request = makeDesktopCommandRequest('run-1', 'terminalRunShellCommand', {
      sessionId: 'session-1',
      cols: 120,
      rows: 32
    })

    expect(request).toEqual({
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id: 'run-1',
      command: 'terminalRunShellCommand',
      payload: { sessionId: 'session-1', cols: 120, rows: 32 }
    })
    expect(isDesktopCommandRequest(request)).toBe(true)
  })

  it('accepts a terminalRunShellCommand request without a size', () => {
    const request = makeDesktopCommandRequest('run-2', 'terminalRunShellCommand', {
      sessionId: 'session-1'
    })

    expect(isDesktopCommandRequest(request)).toBe(true)
  })

  it('builds a terminalAttachShellCommand request', () => {
    const request = makeDesktopCommandRequest('attach-1', 'terminalAttachShellCommand', {
      sessionId: 'session-1'
    })

    expect(request).toEqual({
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id: 'attach-1',
      command: 'terminalAttachShellCommand',
      payload: { sessionId: 'session-1' }
    })
    expect(isDesktopCommandRequest(request)).toBe(true)
  })

  it('refuses to build either request without a payload', () => {
    const make = makeDesktopCommandRequest as unknown as (id: string, command: string) => unknown

    expect(() => make('run-3', 'terminalRunShellCommand')).toThrow(
      'Missing terminalRunShellCommand payload'
    )
    expect(() => make('attach-2', 'terminalAttachShellCommand')).toThrow(
      'Missing terminalAttachShellCommand payload'
    )
  })

  it.each(['terminalRunShellCommand', 'terminalAttachShellCommand'])(
    'rejects a %s request without a sessionId',
    (command) => {
      const base = { type: DESKTOP_COMMAND_REQUEST_TYPE, id: 'x-1', command }

      expect(isDesktopCommandRequest({ ...base, payload: {} })).toBe(false)
      expect(isDesktopCommandRequest({ ...base, payload: { sessionId: 7 } })).toBe(false)
      expect(isDesktopCommandRequest(base)).toBe(false)
    }
  )

  it('rejects a terminalRunShellCommand request with a non-numeric size', () => {
    const base = {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id: 'run-4',
      command: 'terminalRunShellCommand'
    }

    expect(isDesktopCommandRequest({ ...base, payload: { sessionId: 's', cols: '120' } })).toBe(
      false
    )
    expect(isDesktopCommandRequest({ ...base, payload: { sessionId: 's', rows: null } })).toBe(
      false
    )
    expect(isDesktopCommandRequest({ ...base, payload: { sessionId: 's', cols: 80 } })).toBe(true)
  })
})
