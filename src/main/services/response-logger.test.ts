import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { appendResponseLog, createResponseLog } from './response-logger'

const tempHomes: string[] = []

describe('response logger', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const tempHome of tempHomes.splice(0)) {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it('creates and appends response logs under the Node home directory', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'hive-response-logger-home-'))
    tempHomes.push(tempHome)
    vi.stubEnv('HOME', tempHome)

    const filePath = createResponseLog('session-1')

    expect(filePath.startsWith(join(tempHome, '.hive', 'logs', 'responses', 'session-1-'))).toBe(
      true
    )
    expect(filePath.endsWith('.jsonl')).toBe(true)
    expect(existsSync(filePath)).toBe(true)

    appendResponseLog(filePath, { type: 'message', value: 1 })

    const lines = readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(lines[0]).toMatchObject({
      type: 'session_start',
      sessionId: 'session-1',
      timestamp: expect.any(String)
    })
    expect(lines[1]).toMatchObject({
      type: 'message',
      value: 1,
      timestamp: expect.any(String)
    })
  })
})
