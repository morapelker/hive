import { beforeEach, describe, expect, it } from 'vitest'

import { resolveDefaultUsageProvider, resolveUsageProvider } from '../useUsageStore'
import { useSettingsStore } from '../useSettingsStore'

const PROVIDERS = [
  { id: 'cp-openai', name: 'Claudex', command: 'claudex', usageProvider: 'openai' as const },
  { id: 'cp-claude', name: 'Claude Proxy', command: 'claudep', usageProvider: 'claude' as const },
  { id: 'cp-none', name: 'Local', command: 'claudel', usageProvider: 'none' as const }
]

describe('usage provider resolution for custom claude-cli providers', () => {
  beforeEach(() => {
    useSettingsStore.setState({ customProviders: PROVIDERS })
  })

  it('attributes sessions to the custom provider usage setting', () => {
    expect(
      resolveUsageProvider({ agent_sdk: 'claude-code-cli', custom_provider_id: 'cp-openai' })
    ).toBe('openai')
    expect(
      resolveUsageProvider({ agent_sdk: 'claude-code-cli', custom_provider_id: 'cp-claude' })
    ).toBe('anthropic')
    expect(
      resolveUsageProvider({ agent_sdk: 'claude-code-cli', custom_provider_id: 'cp-none' })
    ).toBeNull()
  })

  it('falls back to claude-family attribution when the provider was deleted', () => {
    expect(
      resolveUsageProvider({ agent_sdk: 'claude-code-cli', custom_provider_id: 'deleted-id' })
    ).toBe('anthropic')
  })

  it('falls back when the provider command was blanked (spawn degrades to plain claude)', () => {
    useSettingsStore.setState({
      customProviders: [{ id: 'cp-blank', name: 'Blank', command: '  ', usageProvider: 'openai' }]
    })
    expect(
      resolveUsageProvider({ agent_sdk: 'claude-code-cli', custom_provider_id: 'cp-blank' })
    ).toBe('anthropic')
    expect(resolveDefaultUsageProvider('claude-code-cli', 'cp-blank')).toBe('anthropic')
  })

  it('keeps plain sessions on their existing attribution', () => {
    expect(resolveUsageProvider({ agent_sdk: 'claude-code-cli' })).toBe('anthropic')
    expect(resolveUsageProvider({ agent_sdk: 'codex', model_provider_id: 'openai' })).toBe('openai')
    expect(resolveUsageProvider({ agent_sdk: 'opencode', model_id: 'gpt-5' })).toBe('openai')
  })

  it('resolves launch-time defaults through the custom provider id', () => {
    expect(resolveDefaultUsageProvider('claude-code-cli', 'cp-openai')).toBe('openai')
    expect(resolveDefaultUsageProvider('claude-code-cli', 'cp-none')).toBeNull()
    expect(resolveDefaultUsageProvider('claude-code-cli')).toBe('anthropic')
    expect(resolveDefaultUsageProvider('codex')).toBe('openai')
    expect(resolveDefaultUsageProvider('claude-code-cli', 'deleted-id')).toBe('anthropic')
  })
})
