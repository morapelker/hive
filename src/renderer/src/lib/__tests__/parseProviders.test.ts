import { describe, expect, it } from 'vitest'
import { getVariantKeysForSdk, isUltraVariant, ULTRACODE_VARIANT } from '../parseProviders'

// Opus/Fable-tier models expose xhigh/max; Sonnet/Haiku cap at high.
const opusLike = { variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} } }
const sonnetLike = { variants: { low: {}, medium: {}, high: {} } }

describe('getVariantKeysForSdk', () => {
  it('appends ultracode (last) for claude-code-cli high-tier models that expose xhigh', () => {
    const keys = getVariantKeysForSdk(opusLike, 'claude-code-cli')
    expect(keys).toContain(ULTRACODE_VARIANT)
    expect(keys[keys.length - 1]).toBe(ULTRACODE_VARIANT)
  })

  it('does not offer ultracode for claude-code-cli models without xhigh (Sonnet/Haiku)', () => {
    expect(getVariantKeysForSdk(sonnetLike, 'claude-code-cli')).not.toContain(ULTRACODE_VARIANT)
  })

  it('never offers ultracode for the non-CLI claude-code SDK', () => {
    expect(getVariantKeysForSdk(opusLike, 'claude-code')).not.toContain(ULTRACODE_VARIANT)
  })

  it('never offers ultracode for other SDKs or when the SDK is unknown', () => {
    expect(getVariantKeysForSdk(opusLike, 'opencode')).not.toContain(ULTRACODE_VARIANT)
    expect(getVariantKeysForSdk(opusLike, 'codex')).not.toContain(ULTRACODE_VARIANT)
    expect(getVariantKeysForSdk(opusLike, null)).not.toContain(ULTRACODE_VARIANT)
  })

  it('returns base variant keys unchanged when the model has no variants', () => {
    expect(getVariantKeysForSdk({}, 'claude-code-cli')).toEqual([])
  })
})

describe('isUltraVariant', () => {
  it('is true for the claude ultracode and codex ultra variants', () => {
    expect(isUltraVariant(ULTRACODE_VARIANT)).toBe(true)
    expect(isUltraVariant('ultra')).toBe(true)
  })

  it('is false for ordinary efforts and missing variants', () => {
    expect(isUltraVariant('xhigh')).toBe(false)
    expect(isUltraVariant('max')).toBe(false)
    expect(isUltraVariant(null)).toBe(false)
    expect(isUltraVariant(undefined)).toBe(false)
  })
})
