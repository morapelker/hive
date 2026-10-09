// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSetting: vi.fn() }))
vi.mock('../../db', () => ({ getDatabase: () => ({ getSetting: mocks.getSetting }) }))

import { parseAutoSignInSettings, readAutoSignInSettings } from '../auto-sign-in-settings'

describe('auto sign-in settings in the server child', () => {
  it('reads the autoSignIn slot of the app_settings blob, sanitized', () => {
    mocks.getSetting.mockReturnValue(
      JSON.stringify({
        theme: 'dark',
        autoSignIn: {
          enabled: true,
          codeServerUrl: 'http://claudit-dashboard:3000/',
          codeTimeoutSeconds: 45
        }
      })
    )
    expect(readAutoSignInSettings()).toEqual({
      enabled: true,
      codeServerUrl: 'http://claudit-dashboard:3000',
      apiToken: '',
      codeTimeoutSeconds: 45
    })
    expect(mocks.getSetting).toHaveBeenCalledWith('app_settings')
  })

  it('falls back to the defaults (automation off) for a missing, broken or pre-feature blob', () => {
    expect(parseAutoSignInSettings(null).enabled).toBe(false)
    expect(parseAutoSignInSettings('{not json').enabled).toBe(false)
    expect(parseAutoSignInSettings(JSON.stringify({ theme: 'dark' })).enabled).toBe(false)
    mocks.getSetting.mockImplementation(() => {
      throw new Error('db closed')
    })
    expect(readAutoSignInSettings().enabled).toBe(false)
  })
})
