// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  CancelledError,
  IpcSerializationError,
  TimeoutError,
  UnexpectedDefect,
  ZodDecodeError
} from '../errors'
import { ZodDecodeError as ReExportedZodDecodeError } from '../zod-adapter'

describe('shared Effect errors', () => {
  it('keeps ZodDecodeError tagged fields and class identity stable', () => {
    const issues = [
      {
        code: 'custom' as const,
        message: 'invalid input',
        path: ['field']
      }
    ]
    const error = new ZodDecodeError({ issues, schemaName: 'ProbeSchema' })

    expect(error._tag).toBe('ZodDecodeError')
    expect(error.issues).toBe(issues)
    expect(error.schemaName).toBe('ProbeSchema')
    expect(error).toBeInstanceOf(ZodDecodeError)
    expect(error).toBeInstanceOf(ReExportedZodDecodeError)
  })

  it('keeps IpcSerializationError tagged fields and instanceof behavior', () => {
    const cause = new Error('serialize failed')
    const error = new IpcSerializationError({ channel: 'probe:channel', cause })

    expect(error._tag).toBe('IpcSerializationError')
    expect(error.channel).toBe('probe:channel')
    expect(error.cause).toBe(cause)
    expect(error).toBeInstanceOf(IpcSerializationError)
  })

  it('keeps TimeoutError tagged fields and instanceof behavior', () => {
    const error = new TimeoutError({ operation: 'probe', durationMs: 2500 })

    expect(error._tag).toBe('TimeoutError')
    expect(error.operation).toBe('probe')
    expect(error.durationMs).toBe(2500)
    expect(error).toBeInstanceOf(TimeoutError)
  })

  it('keeps CancelledError tagged fields and instanceof behavior', () => {
    const error = new CancelledError({ operation: 'probe' })

    expect(error._tag).toBe('CancelledError')
    expect(error.operation).toBe('probe')
    expect(error).toBeInstanceOf(CancelledError)
  })

  it('keeps UnexpectedDefect tagged fields and instanceof behavior', () => {
    const cause = { reason: 'boom' }
    const error = new UnexpectedDefect({ cause })

    expect(error._tag).toBe('UnexpectedDefect')
    expect(error.cause).toBe(cause)
    expect(error).toBeInstanceOf(UnexpectedDefect)
  })
})
