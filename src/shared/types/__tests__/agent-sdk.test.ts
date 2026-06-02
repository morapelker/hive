import { describe, expect, it } from 'vitest'
import { AGENT_SDK_VALUES, toHandoffAgentSdk } from '../agent-sdk'

describe('toHandoffAgentSdk', () => {
  it('returns every known non-terminal SDK unchanged', () => {
    const handoffSdks = AGENT_SDK_VALUES.filter((sdk) => sdk !== 'terminal')

    for (const sdk of handoffSdks) {
      expect(toHandoffAgentSdk(sdk)).toBe(sdk)
    }
  })

  it('returns null for terminal, unknown, and empty values', () => {
    expect(toHandoffAgentSdk('terminal')).toBeNull()
    expect(toHandoffAgentSdk('unknown-sdk')).toBeNull()
    expect(toHandoffAgentSdk(null)).toBeNull()
    expect(toHandoffAgentSdk(undefined)).toBeNull()
  })
})
