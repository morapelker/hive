/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const handlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    })
  },
  BrowserWindow: class {},
  shell: { showItemInFolder: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('../../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LoggerService: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
}))

import { registerFileHandlers } from '../../file-handlers'
import { __resetRuntimeRegistryForTests } from '../../../effect/_shared/runtime'

const mockEvent = {} as any

describe('migrated file: handlers (defineHandler slice)', () => {
  let tmpDir: string

  beforeEach(() => {
    handlers.clear()
    __resetRuntimeRegistryForTests()
    tmpDir = mkdtempSync(join(tmpdir(), 'hive-ipc-test-'))
    registerFileHandlers()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('file:readImageAsBase64 returns success envelope with base64 data', async () => {
    const filePath = join(tmpDir, 'test.png')
    // 1x1 transparent PNG
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex'
    )
    writeFileSync(filePath, png)

    const result = await handlers.get('file:readImageAsBase64')!(mockEvent, filePath)
    expect(result.success).toBe(true)
    expect(result.value.data).toBe(png.toString('base64'))
    expect(result.value.mimeType).toBe('image/png')
  })

  it('file:readImageAsBase64 returns FileReadFailed envelope for missing file', async () => {
    const result = await handlers.get('file:readImageAsBase64')!(
      mockEvent,
      join(tmpDir, 'missing.png')
    )
    expect(result).toMatchObject({
      success: false,
      errorCode: 'FileReadFailed',
      details: { reason: expect.stringMatching(/does not exist/i) }
    })
  })

  it('file:readImageAsBase64 returns ZodDecodeError envelope for empty path', async () => {
    const result = await handlers.get('file:readImageAsBase64')!(mockEvent, '')
    expect(result).toMatchObject({ success: false, errorCode: 'ZodDecodeError' })
  })

  it('file:write writes content and returns success envelope', async () => {
    const filePath = join(tmpDir, 'out.txt')
    writeFileSync(filePath, 'old')
    const result = await handlers.get('file:write')!(mockEvent, filePath, 'new content')
    expect(result).toEqual({ success: true, value: null })
    expect(readFileSync(filePath, 'utf-8')).toBe('new content')
  })

  it('file:write returns FileWriteFailed envelope for missing file', async () => {
    const result = await handlers.get('file:write')!(mockEvent, join(tmpDir, 'missing.txt'), 'x')
    expect(result).toMatchObject({ success: false, errorCode: 'FileWriteFailed' })
    expect(existsSync(join(tmpDir, 'missing.txt'))).toBe(false)
  })
})
