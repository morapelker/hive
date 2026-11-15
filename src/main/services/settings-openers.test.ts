import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }))
}))

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: mocks.spawn
}))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'darwin'
}))
vi.mock('../db', () => ({ getDatabase: vi.fn() }))
vi.mock('./telemetry-service', () => ({ telemetryService: { track: vi.fn() } }))

import { openPathWithTerminal } from './settings-openers'

describe('openPathWithTerminal on macOS', () => {
  beforeEach(() => {
    mocks.spawn.mockClear()
  })

  it('opens Rex by bundle id, so the "Rex Beta" preview build is found too', () => {
    const path = tmpdir()

    expect(openPathWithTerminal(path, 'rex')).toEqual({ success: true })

    expect(mocks.spawn).toHaveBeenCalledWith('open', ['-b', 'com.superlogical.rex', path], {
      detached: true
    })
  })

  it('refuses a path that does not exist', () => {
    expect(openPathWithTerminal('/no/such/hive-path', 'rex')).toEqual({
      success: false,
      error: 'Path does not exist'
    })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
