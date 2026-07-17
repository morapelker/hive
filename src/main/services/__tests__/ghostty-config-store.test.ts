import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseGhosttyConfig, resolveGhosttyConfigPath } from '../ghostty-config'
import {
  clearGhosttyConfigMemo,
  getGhosttyConfigPathOnce,
  getGhosttyTerminalConfig,
  warmUpGhosttyConfig
} from '../ghostty-config-store'

vi.mock('../ghostty-config', () => ({
  parseGhosttyConfig: vi.fn(() => ({})),
  resolveGhosttyConfigPath: vi.fn(() => undefined)
}))

const parseGhosttyConfigMock = vi.mocked(parseGhosttyConfig)
const resolveGhosttyConfigPathMock = vi.mocked(resolveGhosttyConfigPath)

describe('ghostty config store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearGhosttyConfigMemo()
  })

  it('reads from disk once and serves the memo afterwards', () => {
    parseGhosttyConfigMock.mockReturnValue({ fontFamily: 'TX-02' })

    const first = getGhosttyTerminalConfig()
    const second = getGhosttyTerminalConfig()

    expect(first).toEqual({ fontFamily: 'TX-02' })
    expect(second).toEqual({ fontFamily: 'TX-02' })
    expect(parseGhosttyConfigMock).toHaveBeenCalledTimes(1)
    expect(parseGhosttyConfigMock).toHaveBeenCalledWith({ includeAppSupport: true })
  })

  it('re-reads from disk on refresh and updates the memo', () => {
    parseGhosttyConfigMock.mockReturnValueOnce({ fontSize: 10 })
    getGhosttyTerminalConfig()

    parseGhosttyConfigMock.mockReturnValueOnce({ fontSize: 15 })
    const refreshed = getGhosttyTerminalConfig({ refresh: true })

    expect(refreshed).toEqual({ fontSize: 15 })
    expect(parseGhosttyConfigMock).toHaveBeenCalledTimes(2)

    // Subsequent non-refresh calls serve the refreshed memo.
    expect(getGhosttyTerminalConfig()).toEqual({ fontSize: 15 })
    expect(parseGhosttyConfigMock).toHaveBeenCalledTimes(2)
  })

  it('resolves the config path once, even when it is undefined', () => {
    resolveGhosttyConfigPathMock.mockReturnValue(undefined)

    expect(getGhosttyConfigPathOnce()).toBeUndefined()
    expect(getGhosttyConfigPathOnce()).toBeUndefined()

    expect(resolveGhosttyConfigPathMock).toHaveBeenCalledTimes(1)
    expect(resolveGhosttyConfigPathMock).toHaveBeenCalledWith({ includeAppSupport: true })
  })

  it('re-resolves the config path on refresh', () => {
    resolveGhosttyConfigPathMock.mockReturnValueOnce('/old/config')
    expect(getGhosttyConfigPathOnce()).toBe('/old/config')

    resolveGhosttyConfigPathMock.mockReturnValueOnce('/new/config')
    expect(getGhosttyConfigPathOnce({ refresh: true })).toBe('/new/config')
    expect(getGhosttyConfigPathOnce()).toBe('/new/config')
    expect(resolveGhosttyConfigPathMock).toHaveBeenCalledTimes(2)
  })

  it('warms up both the path and config memos so later calls never hit disk', () => {
    parseGhosttyConfigMock.mockReturnValue({ background: '#1e1e2e' })
    resolveGhosttyConfigPathMock.mockReturnValue('/path/config')

    warmUpGhosttyConfig()

    parseGhosttyConfigMock.mockClear()
    resolveGhosttyConfigPathMock.mockClear()

    expect(getGhosttyTerminalConfig()).toEqual({ background: '#1e1e2e' })
    expect(getGhosttyConfigPathOnce()).toBe('/path/config')
    expect(parseGhosttyConfigMock).not.toHaveBeenCalled()
    expect(resolveGhosttyConfigPathMock).not.toHaveBeenCalled()
  })
})
