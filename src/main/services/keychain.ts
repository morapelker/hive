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
  const subcommand = args[0] ?? 'security'
  return new Promise((resolve, reject) => {
    // `-w <secret>` passes the secret as an argv element, so it is briefly
    // visible in the process table. ccswitch does the same; this is an accepted
    // tradeoff for Keychain-CLI parity (there is no stdin variant of
    // `add-generic-password` that also does an in-place `-U` update).
    //
    // Critically, we MUST NOT surface execFile's raw ExecFileException: its
    // `message` embeds the full command line — INCLUDING the `-w <secret>`
    // credential. That message would otherwise propagate to log.warn, the
    // saved_usage_accounts.last_error column, switchAccount error results, and
    // renderer toasts. Reject instead with only the subcommand name, the exit
    // code, and security's stderr (which never echoes `-w` values).
    execFile('security', args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        const rawCode = (error as ExecFileException).code
        const trimmedStderr = typeof stderr === 'string' ? stderr.trim() : ''
        const notFound = isItemNotFoundError(error) || /could not be found/i.test(trimmedStderr)

        const parts = [`security ${subcommand} failed`]
        if (rawCode !== undefined) parts.push(`(exit ${rawCode})`)
        if (trimmedStderr) parts.push(`- ${trimmedStderr}`)

        const sanitized = new Error(parts.join(' ')) as Error & { code?: number | string }
        // Preserve not-found detection: attach the exit code so the code-44
        // check in isItemNotFoundError still fires on the sanitized error.
        const resolvedCode = rawCode ?? (notFound ? ERR_SEC_ITEM_NOT_FOUND_CODE : undefined)
        if (resolvedCode !== undefined) sanitized.code = resolvedCode
        reject(sanitized)
      } else {
        resolve(stdout.trim())
      }
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
