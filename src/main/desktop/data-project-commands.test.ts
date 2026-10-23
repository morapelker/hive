// Electron-main side of the data-project desktop commands with fake safeStorage / dialog:
// the `v1:` ciphertext format, refusal without a usable vault (no plaintext fallback), fixed
// secret-free error texts, and the dialog options per purpose (headless → null).
import { describe, expect, it, vi } from 'vitest'

import {
  isDesktopCommandRequest,
  makeDesktopCommandRequest,
  type DesktopCommandRequest
} from '../../shared/desktop-command'
import {
  isDataProjectDesktopCommand,
  runDataProjectDesktopCommand,
  type DataProjectCommandDeps
} from './data-project-commands'

const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: vi.fn(() => available),
  // Reversible but not plaintext: bytes reversed.
  encryptString: vi.fn((plain: string) => Buffer.from(plain, 'utf8').reverse()),
  decryptString: vi.fn((buffer: Buffer) => {
    if (buffer.length === 0) throw new Error('Error while decrypting the ciphertext provided')
    return Buffer.from(buffer).reverse().toString('utf8')
  })
})

const makeDeps = (overrides: Partial<DataProjectCommandDeps> = {}) => {
  const storage = fakeSafeStorage()
  const dialog = {
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/Users/me/out.csv' })),
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/Users/me/shop.sqlite'] }))
  }
  const parent = {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ width: 1, height: 1 })
  }
  const deps: DataProjectCommandDeps = {
    whenReady: vi.fn(async () => undefined),
    isReady: () => true,
    safeStorage: () => storage,
    dialog,
    parentWindow: () => parent,
    downloadsDir: () => '/Users/me/Downloads',
    homeDir: () => '/Users/me',
    ...overrides
  }
  return { deps, storage, dialog, parent }
}

const run = (request: DesktopCommandRequest, deps: DataProjectCommandDeps, headless = false) => {
  if (!isDataProjectDesktopCommand(request)) throw new Error('not a data project command')
  return runDataProjectDesktopCommand(request, { headless }, deps)
}

describe('data project desktop commands: payload guards', () => {
  it('accepts well-formed requests and rejects malformed ones', () => {
    expect(
      isDesktopCommandRequest(
        makeDesktopCommandRequest('1', 'dataSecretEncrypt', { plaintext: '{}' })
      )
    ).toBe(true)
    expect(
      isDesktopCommandRequest(
        makeDesktopCommandRequest('1', 'dataSecretDecrypt', { ciphertext: 'v1:abc' })
      )
    ).toBe(true)
    expect(
      isDesktopCommandRequest({
        type: 'hive-desktop-command',
        id: '1',
        command: 'dataSecretDecrypt',
        payload: { ciphertext: 'plain' }
      })
    ).toBe(false)
    expect(
      isDesktopCommandRequest({
        type: 'hive-desktop-command',
        id: '1',
        command: 'dataSaveFileDialog',
        payload: { defaultName: 'x', extensions: ['../evil'] }
      })
    ).toBe(false)
    expect(
      isDesktopCommandRequest({
        type: 'hive-desktop-command',
        id: '1',
        command: 'dataOpenFileDialog',
        payload: { purpose: 'anything' }
      })
    ).toBe(false)
    expect(isDesktopCommandRequest(makeDesktopCommandRequest('1', 'dataSecretAvailable'))).toBe(
      true
    )
    expect(isDataProjectDesktopCommand(makeDesktopCommandRequest('1', 'quitApp'))).toBe(false)
  })
})

describe('data project desktop commands: safeStorage', () => {
  it('round-trips through v1: base64 ciphertext after app ready', async () => {
    const { deps, storage } = makeDeps()
    const encrypted = (await run(
      makeDesktopCommandRequest('1', 'dataSecretEncrypt', { plaintext: '{"password":"pw"}' }),
      deps
    )) as { ciphertext: string }
    expect(deps.whenReady).toHaveBeenCalled()
    expect(encrypted.ciphertext.startsWith('v1:')).toBe(true)
    expect(encrypted.ciphertext).not.toContain('pw')
    expect(storage.encryptString).toHaveBeenCalledWith('{"password":"pw"}')

    await expect(
      run(makeDesktopCommandRequest('2', 'dataSecretDecrypt', encrypted), deps)
    ).resolves.toEqual({ plaintext: '{"password":"pw"}' })
  })

  it('refuses without a usable vault instead of storing plaintext', async () => {
    const { deps } = makeDeps({ safeStorage: () => fakeSafeStorage(false) })
    await expect(
      run(makeDesktopCommandRequest('1', 'dataSecretEncrypt', { plaintext: 'secret' }), deps)
    ).rejects.toThrow('Secure storage (safeStorage) is not available on this system')
    const missing = makeDeps({ safeStorage: () => undefined }).deps
    await expect(
      run(makeDesktopCommandRequest('1', 'dataSecretEncrypt', { plaintext: 'secret' }), missing)
    ).rejects.toThrow(/not available/)
  })

  it('reports a decryption failure with a fixed message that leaks nothing', async () => {
    const { deps } = makeDeps()
    const error = await run(
      makeDesktopCommandRequest('1', 'dataSecretDecrypt', { ciphertext: 'v1:' }),
      deps
    ).catch((e: Error) => e)
    expect((error as Error).message).toBe('Unsupported secret format')

    const throwing = makeDeps()
    throwing.storage.decryptString.mockImplementation(() => {
      throw new Error(
        'Error while decrypting the ciphertext provided to safeStorage.decryptString.'
      )
    })
    await expect(
      run(
        makeDesktopCommandRequest('1', 'dataSecretDecrypt', { ciphertext: 'v1:c2VjcmV0' }),
        throwing.deps
      )
    ).rejects.toThrow('The stored secret could not be decrypted on this machine')
  })

  it('reports availability without waiting for ready', async () => {
    await expect(
      run(makeDesktopCommandRequest('1', 'dataSecretAvailable'), makeDeps().deps)
    ).resolves.toEqual({
      available: true
    })
    await expect(
      run(
        makeDesktopCommandRequest('1', 'dataSecretAvailable'),
        makeDeps({ isReady: () => false }).deps
      )
    ).resolves.toEqual({ available: false })
  })
})

describe('data project desktop commands: dialogs', () => {
  it('opens a save dialog in Downloads with the extension filters, parented', async () => {
    const { deps, dialog, parent } = makeDeps()
    await expect(
      run(
        makeDesktopCommandRequest('1', 'dataSaveFileDialog', {
          defaultName: 'orders.csv',
          extensions: ['csv']
        }),
        deps
      )
    ).resolves.toEqual({ filePath: '/Users/me/out.csv' })
    const [parentArg, options] = dialog.showSaveDialog.mock.calls[0] as unknown as [
      unknown,
      { defaultPath: string; filters: Array<{ extensions: string[] }> }
    ]
    expect(parentArg).toBe(parent)
    expect(options.defaultPath).toBe('/Users/me/Downloads/orders.csv')
    expect(options.filters[0].extensions).toEqual(['csv'])
  })

  it('filters SQLite files, offers a save dialog to create one, and starts SSH keys in ~/.ssh', async () => {
    const { deps, dialog } = makeDeps({ parentWindow: () => null })
    await run(makeDesktopCommandRequest('1', 'dataOpenFileDialog', { purpose: 'sqlite' }), deps)
    const [sqliteOptions] = dialog.showOpenDialog.mock.calls[0] as unknown as [
      { filters: Array<{ extensions: string[] }> }
    ]
    expect(sqliteOptions.filters[0].extensions).toEqual(['db', 'sqlite', 'sqlite3', 'db3'])
    expect(sqliteOptions.filters[1].extensions).toEqual(['*'])

    await expect(
      run(
        makeDesktopCommandRequest('2', 'dataOpenFileDialog', {
          purpose: 'sqlite',
          allowCreate: true
        }),
        deps
      )
    ).resolves.toEqual({ filePath: '/Users/me/out.csv' })
    expect(dialog.showSaveDialog).toHaveBeenCalledTimes(1)

    await run(makeDesktopCommandRequest('3', 'dataOpenFileDialog', { purpose: 'ssh-key' }), deps)
    const [sshOptions] = dialog.showOpenDialog.mock.calls[1] as unknown as [{ defaultPath: string }]
    expect(sshOptions.defaultPath).toBe('/Users/me/.ssh')
  })

  it('returns null when cancelled or headless', async () => {
    const { deps, dialog } = makeDeps()
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(
      run(makeDesktopCommandRequest('1', 'dataOpenFileDialog', { purpose: 'certificate' }), deps)
    ).resolves.toEqual({ filePath: null })
    await expect(
      run(
        makeDesktopCommandRequest('2', 'dataSaveFileDialog', { defaultName: 'x', extensions: [] }),
        deps,
        true
      )
    ).resolves.toEqual({ filePath: null })
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  })
})
