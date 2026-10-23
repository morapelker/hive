// SSH local port forwarding for SQL engines (drivers.md §7). One tunnel per open data project:
// an ssh2 client to the bastion plus a 127.0.0.1:<random> TCP server whose every accepted socket
// becomes a `forwardOut` channel to the database host. Every connection of the project (sticky
// session, control connection, KILL/cancel side connections, export streams) goes through the
// same local port, and the connection manager closes the tunnel with the last driver.
//
// Host keys are checked against two known_hosts files: the user's ~/.ssh/known_hosts (read only)
// and the app's own `<data dir>/data-projects/known_hosts`, where keys trusted on first use are
// saved. Like OpenSSH:
//   - a key listed for the host is accepted silently;
//   - when the host is listed at all, the handshake only offers the host key algorithms of the
//     listed key types, and a key that matches none of the entries (another key of the same
//     type, or a key of another type) is refused before any authentication: possible
//     man-in-the-middle. A @revoked key is refused too;
//   - a host listed nowhere is accepted on first use with a notice carrying the SHA256
//     fingerprint (shown in the wizard's Test step and next to the connection status), and the
//     key is appended to the app's file so every later connection, also after a restart, must
//     present the same key. If the file cannot be written, the key is remembered for the app
//     session only and the notice says so.
//   - that notice must reach the user even when the attempt that saved the key fails later (a
//     wrong SSH password, or the database behind the tunnel refusing the login): a tunnel that
//     fails after saving carries the notice on its error (`sshNotice`, and in the message), and
//     every later tunnel to that host repeats it for the rest of the app session until a caller
//     calls `acknowledgeNotice()` after showing it.
//
// Tests never touch the developer's real files: under VITEST, a known_hosts path that would
// fall back to ~/.ssh or ~/.hive is refused, so a test must inject temp paths.
//
// Auth: password (+ keyboard-interactive answering with the same password), private key file
// (+ passphrase), or the user's ssh-agent via SSH_AUTH_SOCK (1Password/Secretive agents too).

import { createHash, createHmac } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import net from 'node:net'
import type { Client as SshClient, ConnectConfig, ServerHostKeyAlgorithm } from 'ssh2'
import type { DataSecrets, DataSshConfig } from '../../../shared/data-projects/types'
import { credentialsRequiredError, connectionFailedError, errorMessage } from './redact'

/** '~' / '~/x' → absolute path in the user's home. */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

export interface SshTunnel {
  readonly localHost: string
  readonly localPort: number
  /** SHA256 fingerprint of the server's host key (OpenSSH format). */
  readonly hostKeyFingerprint: string
  /**
   * Trust-on-first-use warning with the fingerprint, null when the key was already known (and
   * any first-use notice of it was acknowledged).
   */
  readonly notice: string | null
  /**
   * The caller has shown `notice` to the user: later tunnels to this host stop repeating it.
   * Optional so stand-in tunnels need not implement it.
   */
  acknowledgeNotice?(): void
  isOpen(): boolean
  /** Called once when the SSH connection or the local server goes away. */
  onClose(listener: (reason: string | null) => void): () => void
  close(): Promise<void>
}

export interface OpenSshTunnelInput {
  ssh: DataSshConfig
  secrets: DataSecrets
  /** Database host and port as seen from the SSH server. */
  dstHost: string
  dstPort: number
  redact: (text: string) => string
  /** Overrides ~/.ssh/known_hosts (tests). */
  knownHostsPath?: string
  /** Overrides the app's known_hosts, where first-use keys are saved (tests). */
  appKnownHostsPath?: string
  /** SSH handshake timeout, ms (default 15 s). */
  readyTimeoutMs?: number
}

// ---------------------------------------------------------------------------------------------
// known_hosts
// ---------------------------------------------------------------------------------------------

export type KnownHostStatus = 'match' | 'mismatch' | 'revoked' | 'unknown'

/** OpenSSH-style fingerprint: `SHA256:<unpadded base64>`. */
export const sshFingerprint = (keyBlob: Buffer): string =>
  `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`

/** The algorithm name at the start of an SSH public key blob ("ssh-ed25519", ...). */
export function keyBlobType(keyBlob: Buffer): string | null {
  if (keyBlob.length < 4) return null
  const len = keyBlob.readUInt32BE(0)
  if (len <= 0 || len > 64 || 4 + len > keyBlob.length) return null
  return keyBlob.subarray(4, 4 + len).toString('latin1')
}

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split('')
      .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
    'i'
  )

function hostPatternMatches(pattern: string, hostEntry: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|')
    if (!salt || !hash) return false
    try {
      const digest = createHmac('sha1', Buffer.from(salt, 'base64'))
        .update(hostEntry)
        .digest('base64')
      return digest === hash
    } catch {
      return false
    }
  }
  return globToRegExp(pattern).test(hostEntry)
}

/** Does the comma-separated host field match (OpenSSH semantics incl. `!negation`)? */
function hostFieldMatches(field: string, hostEntries: string[]): boolean {
  let matched = false
  for (const raw of field.split(',')) {
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw
    if (!pattern) continue
    if (hostEntries.some((entry) => hostPatternMatches(pattern, entry))) {
      if (negated) return false
      matched = true
    }
  }
  return matched
}

interface KnownHostEntry {
  marker: string | null
  keyType: string
  blob: Buffer
}

/**
 * The entries of known_hosts text that apply to `host`:`port` (@cert-authority lines skipped:
 * ssh2 has no host certificates). OpenSSH looks names up in lower case, and writes a non-22
 * port as `[host]:port`.
 */
function knownHostEntries(text: string, host: string, port: number): KnownHostEntry[] {
  const name = host.toLowerCase()
  const lookups = port === 22 ? [name, `[${name}]:22`] : [`[${name}]:${port}`]
  const out: KnownHostEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    let marker: string | null = null
    if (fields[0]?.startsWith('@')) marker = fields.shift() ?? null
    if (fields.length < 3) continue
    const [hosts, keyType, keyBase64] = fields
    if (marker === '@cert-authority') continue
    if (!hostFieldMatches(hosts, lookups)) continue
    out.push({ marker, keyType, blob: Buffer.from(keyBase64, 'base64') })
  }
  return out
}

/**
 * Checks a host key against known_hosts text. `host` may be a name or an IP. A @revoked key is
 * refused wherever its line is. Once the host has any other entry, a key matching none of them is
 * a mismatch whatever its type, like OpenSSH: an impostor must not get past the check by
 * presenting another key type.
 */
export function checkKnownHosts(
  text: string,
  host: string,
  port: number,
  keyBlob: Buffer
): KnownHostStatus {
  const entries = knownHostEntries(text, host, port)
  if (entries.some((entry) => entry.marker === '@revoked' && entry.blob.equals(keyBlob))) {
    return 'revoked'
  }
  const listed = entries.filter((entry) => entry.marker !== '@revoked')
  if (listed.some((entry) => entry.blob.equals(keyBlob))) return 'match'
  return listed.length ? 'mismatch' : 'unknown'
}

/** The key types (`ssh-ed25519`, `ssh-rsa`, ...) known_hosts text lists for a host, not revoked. */
export function knownHostKeyTypes(text: string, host: string, port: number): string[] {
  const types = new Set<string>()
  for (const entry of knownHostEntries(text, host, port)) {
    if (entry.marker !== '@revoked') types.add(entry.keyType)
  }
  return [...types]
}

/** ssh2's host key algorithms, most preferred first, with the key type each one verifies. */
const HOST_KEY_ALGORITHMS: ReadonlyArray<readonly [ServerHostKeyAlgorithm, string]> = [
  ['ssh-ed25519', 'ssh-ed25519'],
  ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp256'],
  ['ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp384'],
  ['ecdsa-sha2-nistp521', 'ecdsa-sha2-nistp521'],
  ['rsa-sha2-512', 'ssh-rsa'],
  ['rsa-sha2-256', 'ssh-rsa'],
  ['ssh-rsa', 'ssh-rsa'],
  ['ssh-dss', 'ssh-dss']
]

/**
 * The host key algorithms to offer when known_hosts pins these key types, so a real server
 * negotiates a key that can be checked (an `ssh-rsa` key is verified by the rsa-sha2-* and
 * ssh-rsa signatures). Empty when none is supported: then nothing is restricted and the key the
 * server presents is refused as a mismatch.
 */
export function hostKeyAlgorithmsFor(keyTypes: readonly string[]): ServerHostKeyAlgorithm[] {
  const types = new Set(keyTypes)
  return HOST_KEY_ALGORITHMS.filter(([, type]) => types.has(type)).map(([algorithm]) => algorithm)
}

/**
 * The known_hosts line that pins `keyBlob` for `host`:`port`; null for a host name that cannot be
 * written safely (whitespace, commas, glob or marker characters would change what the line says).
 */
export function knownHostsLine(host: string, port: number, keyBlob: Buffer): string | null {
  const name = host.toLowerCase()
  const type = keyBlobType(keyBlob)
  if (!type || !/^[a-z0-9._:%-]+$/.test(name) || !/^[\w.@-]+$/.test(type)) return null
  return `${port === 22 ? name : `[${name}]:${port}`} ${type} ${keyBlob.toString('base64')}`
}

const APP_KNOWN_HOSTS_HEADER =
  '# SSH host keys trusted on first use by Hive data projects (OpenSSH known_hosts format).\n' +
  '# Delete a line to forget a host; its next connection will be trusted on first use again.\n'

/**
 * Under a test runner the developer's real trust stores are never a default: a test that forgot
 * to inject its paths fails here instead of reading ~/.ssh or pinning throwaway test keys in the
 * real app data dir (~/.hive), where they would later refuse a real server on the same port.
 */
function refuseRealPathUnderTests(path: string, what: string): string {
  if (!process.env.VITEST) return path
  const home = resolvePath(homedir())
  const full = resolvePath(path)
  const real = [join(home, '.hive'), join(home, '.ssh')]
  if (real.some((dir) => full === dir || full.startsWith(dir + sep))) {
    throw new Error(
      `Refusing to use the real ${what} (${path}) under a test runner: inject a temporary path.`
    )
  }
  return path
}

/**
 * `<data dir>/data-projects/known_hosts`: beside the app database, so a dev/E2E data dir
 * (HIVE_DESKTOP_BASE_DIR, handed to the server as HIVE_SERVER_DB_PATH) keeps its
 * own trust store. ~/.ssh/known_hosts is never written.
 */
export async function defaultAppKnownHostsPath(): Promise<string> {
  const { resolveDatabasePath } = await import('../../db/database')
  return refuseRealPathUnderTests(
    join(dirname(resolveDatabasePath()), 'data-projects', 'known_hosts'),
    'app known_hosts'
  )
}

/** A path for messages, `~/…` under the home directory. */
function displayPath(path: string): string {
  const home = homedir()
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

/** The file's text, '' when it does not exist or cannot be read. */
async function readKnownHosts(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/** Appends a trusted key to the app's known_hosts (created 0600). Returns the error, if any. */
async function saveTrustedKey(path: string, current: string, line: string): Promise<Error | null> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const prefix = !current ? APP_KNOWN_HOSTS_HEADER : current.endsWith('\n') ? '' : '\n'
    await appendFile(path, `${prefix}${line}\n`, { encoding: 'utf8', mode: 0o600 })
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Keys accepted on first use that could not be saved to the app's known_hosts, by
 * "host:port": they still pin the host for the rest of the app session.
 */
const sessionTrusted = new Map<string, Buffer>()

/**
 * First-use notices not acknowledged yet, by "<app known_hosts>|host:port", with the key they
 * are about: a later tunnel shown that same key repeats the notice (see the header).
 */
const pendingNotices = new Map<string, Buffer>()

/** Test hook: forgets the session-only acceptances and the pending first-use notices. */
export function resetSshTrustCache(): void {
  sessionTrusted.clear()
  pendingNotices.clear()
}

// Host key checks run one at a time in this process: two tunnels to a new host must not both
// trust (and save) whatever key each was shown; the second one sees the first one's entry.
let trustChain: Promise<void> = Promise.resolve()
function withTrustLock<T>(run: () => Promise<T>): Promise<T> {
  const result = trustChain.then(run)
  trustChain = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

// ---------------------------------------------------------------------------------------------
// Tunnel
// ---------------------------------------------------------------------------------------------

type Ssh2Module = typeof import('ssh2')

let ssh2Promise: Promise<Ssh2Module> | null = null
const loadSsh2 = (): Promise<Ssh2Module> => {
  ssh2Promise ??= import('ssh2').then((mod) => {
    const m = mod as Ssh2Module & { default?: Ssh2Module }
    return (m.Client ? m : m.default) as Ssh2Module
  })
  return ssh2Promise
}

const isEncryptedKeyError = (message: string): boolean =>
  /encrypted|passphrase|bad decrypt|integrity check failed/i.test(message)

export async function openSshTunnel(input: OpenSshTunnelInput): Promise<SshTunnel> {
  const { ssh, secrets, redact } = input
  const sshPort = ssh.port || 22
  const label = `${ssh.host}:${sshPort}`
  if (!ssh.host) throw connectionFailedError('SSH tunnel: the SSH host is missing.')
  if (!ssh.username) throw connectionFailedError('SSH tunnel: the SSH user name is missing.')

  const { Client, utils } = await loadSsh2()

  const config: ConnectConfig = {
    host: ssh.host,
    port: sshPort,
    username: ssh.username,
    readyTimeout: input.readyTimeoutMs ?? 15_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4
  }

  switch (ssh.authMethod) {
    case 'password':
      if (!secrets.sshPassword) {
        throw credentialsRequiredError('Enter the SSH password to connect through the tunnel.')
      }
      config.password = secrets.sshPassword
      config.tryKeyboard = true
      break
    case 'privateKey': {
      if (!ssh.privateKeyPath)
        throw connectionFailedError('SSH tunnel: no private key file is set.')
      const path = expandHomePath(ssh.privateKeyPath)
      let key: Buffer
      try {
        key = await readFile(path)
      } catch (error) {
        throw connectionFailedError(
          `SSH tunnel: cannot read the private key ${ssh.privateKeyPath}: ${errorMessage(error, redact)}`
        )
      }
      const parsed = utils.parseKey(key, secrets.sshPassphrase)
      if (parsed instanceof Error) {
        if (isEncryptedKeyError(parsed.message)) {
          throw credentialsRequiredError(
            secrets.sshPassphrase
              ? 'The SSH key passphrase is wrong. Enter it again.'
              : 'The SSH private key is encrypted. Enter its passphrase to connect.'
          )
        }
        throw connectionFailedError(
          `SSH tunnel: unsupported private key: ${redact(parsed.message)}`
        )
      }
      config.privateKey = key
      if (secrets.sshPassphrase) config.passphrase = secrets.sshPassphrase
      break
    }
    case 'agent':
    default: {
      const sock = process.env.SSH_AUTH_SOCK
      if (!sock) {
        throw connectionFailedError(
          'SSH tunnel: no SSH agent is available (SSH_AUTH_SOCK is not set). Use a private key file instead.'
        )
      }
      config.agent = sock
      break
    }
  }

  // No known_hosts file yet means no entries: every host is "first use".
  const userKnownHostsPath =
    input.knownHostsPath ??
    refuseRealPathUnderTests(join(homedir(), '.ssh', 'known_hosts'), 'user known_hosts')
  const appKnownHostsPath = input.appKnownHostsPath ?? (await defaultAppKnownHostsPath())
  const userKnownHosts = await readKnownHosts(userKnownHostsPath)
  const userLabel = displayPath(userKnownHostsPath)
  const appLabel = displayPath(appKnownHostsPath)
  const sessionKey = `${ssh.host.toLowerCase()}:${sshPort}`
  const noticeKey = `${appKnownHostsPath}|${sessionKey}`
  /** The files that list keys for this host, for messages. */
  const filesListing = (appKnownHosts: string): string[] =>
    [
      knownHostKeyTypes(userKnownHosts, ssh.host, sshPort).length ? userLabel : null,
      knownHostKeyTypes(appKnownHosts, ssh.host, sshPort).length || sessionTrusted.has(sessionKey)
        ? appLabel
        : null
    ].filter((file): file is string => file !== null)
  const changedKeyAdvice = (files: string[]): string =>
    `This can mean a man-in-the-middle attack. If the server's key really changed, remove the old entry for ${label} from ${files.join(' and ')} and connect again.`

  // Offer only the algorithms of the key types already known for this host, so a real server
  // negotiates one that can be checked and an impostor cannot sidestep the check with another
  // key type (OpenSSH prefers the known types the same way).
  const appKnownHostsAtStart = await readKnownHosts(appKnownHostsPath)
  const pinnedTypes = knownHostKeyTypes(
    `${userKnownHosts}\n${appKnownHostsAtStart}`,
    ssh.host,
    sshPort
  )
  const sessionBlob = sessionTrusted.get(sessionKey)
  const sessionType = sessionBlob ? keyBlobType(sessionBlob) : null
  if (sessionType && !pinnedTypes.includes(sessionType)) pinnedTypes.push(sessionType)
  const pinnedAlgorithms = hostKeyAlgorithmsFor(pinnedTypes)
  if (pinnedAlgorithms.length) config.algorithms = { serverHostKey: pinnedAlgorithms }

  let fingerprint = ''
  let presentedKey: Buffer | null = null
  let notice: string | null = null
  let rejection: string | null = null

  // The app's file is read again under the lock: another tunnel may have just trusted this host.
  const verifyHostKey = async (key: Buffer): Promise<boolean> => {
    const appKnownHosts = await readKnownHosts(appKnownHostsPath)
    const saved = `${userKnownHosts}\n${appKnownHosts}`
    const presented = `${keyBlobType(key) ?? 'unknown key type'} ${fingerprint}`
    const status = checkKnownHosts(saved, ssh.host, sshPort, key)
    if (status === 'match') {
      // Trusted on first use earlier in this app session, and that notice was never shown.
      if (pendingNotices.get(noticeKey)?.equals(key)) {
        notice = `SSH host key of ${label} (${fingerprint}) was accepted on first use earlier in this app session and saved to ${appLabel}. Later connections must present the same key.`
      }
      return true
    }
    if (status === 'revoked') {
      rejection = `SSH host key of ${label} (${fingerprint}) is marked @revoked in known_hosts.`
      return false
    }
    if (status === 'mismatch') {
      const known = knownHostKeyTypes(saved, ssh.host, sshPort)
      const files = filesListing(appKnownHosts)
      rejection =
        `SSH host key of ${label} does not match ${files.join(' and ')} (server presented ${presented}). ` +
        (known.includes(keyBlobType(key) ?? '')
          ? ''
          : `Only ${known.join(', ')} keys are known for this host. `) +
        changedKeyAdvice(files)
      return false
    }

    const remembered = sessionTrusted.get(sessionKey)
    if (remembered && !remembered.equals(key)) {
      rejection = `SSH host key of ${label} changed during this session (was ${sshFingerprint(remembered)}, server now presents ${presented}). This can mean a man-in-the-middle attack.`
      return false
    }
    const line = knownHostsLine(ssh.host, sshPort, key)
    const saveError = line
      ? await saveTrustedKey(appKnownHostsPath, appKnownHosts, line)
      : new Error('the host name cannot be written to known_hosts')
    if (!saveError) {
      notice = `SSH host key of ${label} (${fingerprint}) was not known; accepted on first use and saved to ${appLabel}. Later connections must present the same key.`
      pendingNotices.set(noticeKey, Buffer.from(key))
      return true
    }
    sessionTrusted.set(sessionKey, Buffer.from(key))
    notice = `SSH host key of ${label} (${fingerprint}) was not known; accepted on first use for this app session only (it could not be saved to ${appLabel}: ${errorMessage(saveError, redact)}).`
    return true
  }

  /** A failure after the host key was trusted on first use still carries that notice. */
  const withNotice = (error: Error): Error => {
    if (!notice) return error
    return Object.assign(error, { message: `${error.message} ${notice}`, sshNotice: notice })
  }

  config.hostVerifier = (key: Buffer, verify: (valid: boolean) => void): void => {
    fingerprint = sshFingerprint(key)
    presentedKey = Buffer.from(key)
    withTrustLock(() => verifyHostKey(key)).then(verify, (error: unknown) => {
      rejection = `SSH host key of ${label} could not be checked: ${errorMessage(error, redact)}`
      verify(false)
    })
  }

  const client: SshClient = new Client()
  client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
    finish(prompts.map(() => secrets.sshPassword ?? ''))
  })

  await new Promise<void>((resolve, rejectRaw) => {
    const reject = (error: Error): void => rejectRaw(withNotice(error))
    const onReady = (): void => {
      client.off('error', onError)
      resolve()
    }
    const onError = (error: Error & { level?: string }): void => {
      client.off('ready', onReady)
      if (rejection) return reject(connectionFailedError(rejection))
      const message = errorMessage(error, redact)
      if (pinnedAlgorithms.length && /no matching host key format/i.test(message)) {
        // Refused before any key was shown: the server has none of the known key types.
        return reject(
          connectionFailedError(
            `SSH host key of ${label}: the server offers none of the key types known for it (${pinnedTypes.join(', ')}). ${changedKeyAdvice(filesListing(appKnownHostsAtStart))}`
          )
        )
      }
      if (error.level === 'client-authentication') {
        if (ssh.authMethod === 'password') {
          return reject(
            credentialsRequiredError(
              `SSH authentication to ${label} failed. Check the SSH password.`
            )
          )
        }
        return reject(
          connectionFailedError(
            ssh.authMethod === 'agent'
              ? `SSH authentication to ${label} failed: the agent has no key the server accepts.`
              : `SSH authentication to ${label} failed: the server did not accept the private key.`
          )
        )
      }
      reject(connectionFailedError(`SSH connection to ${label} failed: ${message}`))
    }
    client.once('ready', onReady)
    client.once('error', onError)
    try {
      client.connect(config)
    } catch (error) {
      onError(error as Error)
    }
  })

  const sockets = new Set<net.Socket>()
  const listeners = new Set<(reason: string | null) => void>()
  let open = true
  let closeReason: string | null = null

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    if (!open) {
      socket.destroy()
      return
    }
    client.forwardOut(
      '127.0.0.1',
      socket.remotePort ?? 0,
      input.dstHost,
      input.dstPort,
      (error, channel) => {
        if (error) {
          // The DB driver sees a closed socket; its error names the tunnel.
          socket.destroy()
          return
        }
        channel.on('error', () => socket.destroy())
        socket.pipe(channel).pipe(socket)
        channel.on('close', () => socket.destroy())
      }
    )
  })

  const shutdown = (reason: string | null): void => {
    if (!open) return
    open = false
    closeReason = reason
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    server.close()
    client.end()
    for (const listener of [...listeners]) {
      try {
        listener(closeReason)
      } catch {
        // A listener's failure must not keep the others from running.
      }
    }
    listeners.clear()
  }

  client.on('error', (error) => shutdown(`SSH tunnel error: ${errorMessage(error, redact)}`))
  client.on('close', () => shutdown('SSH tunnel closed'))
  client.on('end', () => shutdown('SSH tunnel closed'))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  }).catch((error) => {
    shutdown(null)
    throw withNotice(
      connectionFailedError(`SSH tunnel: cannot open a local port: ${errorMessage(error, redact)}`)
    )
  })
  server.on('error', (error) =>
    shutdown(`SSH tunnel local port failed: ${errorMessage(error, redact)}`)
  )

  const address = server.address() as net.AddressInfo

  return {
    localHost: '127.0.0.1',
    localPort: address.port,
    hostKeyFingerprint: fingerprint,
    notice,
    acknowledgeNotice: () => {
      if (presentedKey && pendingNotices.get(noticeKey)?.equals(presentedKey))
        pendingNotices.delete(noticeKey)
    },
    isOpen: () => open,
    onClose: (listener) => {
      if (!open) {
        listener(closeReason)
        return () => {}
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: async () => {
      shutdown(null)
    }
  }
}
