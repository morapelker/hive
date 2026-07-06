import { execFile, type ExecFileException } from 'child_process'
import { platform, userInfo } from 'os'
import { createLogger } from './logger'

const log = createLogger({ component: 'Keychain' })

/**
 * `security`'s documented exit code for errSecItemNotFound. Preferred over
 * the message regex below, which is fragile to macOS wording drift across
 * OS versions/locales.
 */
const ERR_SEC_ITEM_NOT_FOUND_CODE = 44

function isItemNotFoundError(error: unknown): boolean {
  const code = (error as ExecFileException | undefined)?.code
  if (code === ERR_SEC_ITEM_NOT_FOUND_CODE) return true

  const message = error instanceof Error ? error.message : String(error)
  return /could not be found/i.test(message)
}

function runSecurity(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('security', args, { timeout: 5000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.trim())
    })
  })
}

/**
 * Read a secret from the macOS Keychain's generic password store.
 * Returns null when not on macOS, the item isn't found, or any other error
 * occurs.
 */
export async function keychainRead(service: string): Promise<string | null> {
  if (platform() !== 'darwin') return null
  try {
    const stdout = await runSecurity(['find-generic-password', '-s', service, '-w'])
    return stdout || null
  } catch {
    return null
  }
}

/**
 * Write (or overwrite) a secret in the macOS Keychain's generic password
 * store. Throws on non-macOS platforms and when the underlying `security`
 * CLI call fails.
 */
export async function keychainWrite(service: string, secret: string): Promise<void> {
  if (platform() !== 'darwin') {
    throw new Error('Keychain is only available on macOS')
  }
  const account = process.env.USER ?? userInfo().username
  try {
    await runSecurity(['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Keychain write failed', { service, error: message })
    throw error
  }
}

/**
 * Delete a secret from the macOS Keychain's generic password store.
 * Throws on non-macOS platforms. Deleting an item that doesn't exist is not
 * treated as an error; other `security` CLI failures are re-thrown.
 */
export async function keychainDelete(service: string): Promise<void> {
  if (platform() !== 'darwin') {
    throw new Error('Keychain is only available on macOS')
  }
  try {
    await runSecurity(['delete-generic-password', '-s', service])
  } catch (error) {
    if (isItemNotFoundError(error)) return
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Keychain delete failed', { service, error: message })
    throw error
  }
}
