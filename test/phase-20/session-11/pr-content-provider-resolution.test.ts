import { describe, expect, it } from 'vitest'

import { resolvePRContentProvider } from '../../../src/renderer/src/lib/pr-content-provider'

describe('resolvePRContentProvider', () => {
  it('keeps a generating preferred provider when available state is unknown', () => {
    expect(resolvePRContentProvider('codex', null)).toBe('codex')
  })

  it('maps terminal to the first available AI provider', () => {
    expect(
      resolvePRContentProvider('terminal', {
        opencode: true,
        claude: true,
        codex: true
      })
    ).toBe('claude-code')
  })

  it('falls back when the preferred provider is unavailable', () => {
    expect(
      resolvePRContentProvider('codex', {
        opencode: true,
        claude: true,
        codex: false
      })
    ).toBe('claude-code')
  })

  it('returns null when no AI provider is available', () => {
    expect(
      resolvePRContentProvider('terminal', {
        opencode: false,
        claude: false,
        codex: false
      })
    ).toBeNull()
  })
})
