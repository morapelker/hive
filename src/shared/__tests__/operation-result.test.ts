import { describe, expect, it } from 'vitest'

import { requireSuccess } from '../operation-result'

describe('requireSuccess', () => {
  it('does nothing when the operation succeeded', () => {
    expect(() => requireSuccess({ success: true }, 'fallback')).not.toThrow()
  })

  it('throws the error the operation reported', () => {
    expect(() => requireSuccess({ success: false, error: 'no remote' }, 'fallback')).toThrow(
      'no remote'
    )
  })

  it('falls back when the operation failed without a message', () => {
    expect(() => requireSuccess({ success: false }, 'fallback')).toThrow('fallback')
    expect(() => requireSuccess({ success: false, error: '' }, 'fallback')).toThrow('fallback')
  })
})
