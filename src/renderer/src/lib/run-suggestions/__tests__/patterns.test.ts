import { describe, expect, it } from 'vitest'

import { detectSuggestion } from '../patterns'

describe('run suggestion patterns', () => {
  it('detects Next.js kill guidance', () => {
    const suggestion = detectSuggestion('Run kill 31076 to stop it.')

    expect(suggestion).toMatchObject({
      signature: 'killPid:31076',
      label: 'kill 31076',
      description: 'Another dev server is using the expected port.',
      action: { kind: 'killPid', pid: 31076 }
    })
  })

  it('ignores unrelated lines', () => {
    expect(detectSuggestion('Some random log line')).toBeNull()
  })

  it('ignores non-numeric PIDs', () => {
    expect(detectSuggestion('Run kill foo to stop it.')).toBeNull()
  })

  it('returns distinct suggestions for distinct PIDs', () => {
    const first = detectSuggestion('Run kill 31076 to stop it.')
    const second = detectSuggestion('Run kill 31077 to stop it.')

    expect(first?.signature).toBe('killPid:31076')
    expect(second?.signature).toBe('killPid:31077')
  })
})
