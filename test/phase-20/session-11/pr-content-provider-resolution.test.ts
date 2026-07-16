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

  it('resolves codex-cli to the codex provider when only the CLI is available', () => {
    // codex false (no app-server) but codexCli true — `codex exec` still works.
    expect(
      resolvePRContentProvider('codex-cli', {
        opencode: false,
        claude: false,
        codex: false,
        codexCli: true
      })
    ).toBe('codex')
  })

  it('maps claude-code-cli to claude-code for PR content', () => {
    expect(
      resolvePRContentProvider('claude-code-cli', {
        opencode: false,
        claude: true,
        codex: false
      })
    ).toBe('claude-code')
  })

  it('treats codex as available for PR content when only codexCli is set (falling back from terminal)', () => {
    expect(
      resolvePRContentProvider('terminal', {
        opencode: false,
        claude: false,
        codex: false,
        codexCli: true
      })
    ).toBe('codex')
  })
})
