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

import { deleteAttachment, saveAttachment } from './attachment-storage'

const tempHomes: string[] = []

describe('attachment storage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const tempHome of tempHomes.splice(0)) {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it('saves and deletes images under the Node home directory', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'hive-attachment-home-'))
    tempHomes.push(tempHome)
    vi.stubEnv('HOME', tempHome)
    const buffer = Buffer.from('fake image bytes')

    const result = await saveAttachment(buffer, 'screenshot.png')

    expect(result).toMatchObject({ success: true, filePath: expect.any(String) })
    expect(result.filePath?.startsWith(join(tempHome, '.hive', 'attachments'))).toBe(true)
    expect(result.filePath?.endsWith('.png')).toBe(true)
    expect(readFileSync(result.filePath as string)).toEqual(buffer)

    await expect(deleteAttachment(result.filePath as string)).resolves.toEqual({ success: true })
    expect(existsSync(result.filePath as string)).toBe(false)
  })
})
