import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_SIGN_IN_SETTINGS,
  isAutoSignInUsable,
  isValidAutoSignInUrl,
  normalizeAutoSignInUrl,
  sanitizeAutoSignInSettings
} from '../types/settings'

describe('sanitizeAutoSignInSettings', () => {
  it('returns the defaults for a missing or malformed blob', () => {
    expect(sanitizeAutoSignInSettings(undefined)).toEqual(DEFAULT_AUTO_SIGN_IN_SETTINGS)
    expect(sanitizeAutoSignInSettings('nope')).toEqual(DEFAULT_AUTO_SIGN_IN_SETTINGS)
    expect(sanitizeAutoSignInSettings({ enabled: 'yes', codeTimeoutSeconds: 'soon' })).toEqual(
      DEFAULT_AUTO_SIGN_IN_SETTINGS
    )
  })

  it('normalizes the URL, trims the token and clamps the timeout', () => {
    expect(
      sanitizeAutoSignInSettings({
        enabled: true,
        codeServerUrl: ' http://claudit-dashboard:3000/ ',
        apiToken: ' s3cret ',
        codeTimeoutSeconds: 1000
      })
    ).toEqual({
      enabled: true,
      codeServerUrl: 'http://claudit-dashboard:3000',
      apiToken: 's3cret',
      codeTimeoutSeconds: 300
    })
    expect(sanitizeAutoSignInSettings({ codeTimeoutSeconds: 3 }).codeTimeoutSeconds).toBe(15)
    expect(sanitizeAutoSignInSettings({ codeTimeoutSeconds: 61.6 }).codeTimeoutSeconds).toBe(62)
  })

  it('never reports enabled without a usable server URL', () => {
    expect(sanitizeAutoSignInSettings({ enabled: true, codeServerUrl: '' }).enabled).toBe(false)
    expect(sanitizeAutoSignInSettings({ enabled: true, codeServerUrl: 'ftp://x' }).enabled).toBe(
      false
    )
    expect(
      isAutoSignInUsable(
        sanitizeAutoSignInSettings({ enabled: true, codeServerUrl: 'https://x.y' })
      )
    ).toBe(true)
  })
})

describe('auto sign-in URL helpers', () => {
  it('strips whitespace and trailing slashes', () => {
    expect(normalizeAutoSignInUrl('  http://host:3000///  ')).toBe('http://host:3000')
  })

  it('accepts only http(s) URLs with a host', () => {
    expect(isValidAutoSignInUrl('http://claudit-dashboard:3000')).toBe(true)
    expect(isValidAutoSignInUrl('https://codes.example.com/base')).toBe(true)
    expect(isValidAutoSignInUrl('claudit-dashboard:3000')).toBe(false)
    expect(isValidAutoSignInUrl('file:///tmp')).toBe(false)
    expect(isValidAutoSignInUrl('')).toBe(false)
  })
})
