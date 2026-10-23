// SSH tunnel tests against in-process ssh2 servers (hermetic: no real SSH host; both known_hosts
// files, the user's and the app's, live in a temp dir). The live part (MySQL through the tunnel)
// is gated by TEDOOO_DP_IT.
import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Server, utils } from 'ssh2'
import { noopLogger } from '../connection-manager'
import { createDataEngineService } from '../engine-service'
import { createSafetyGate } from '../safety-gate'
import {
  checkKnownHosts,
  defaultAppKnownHostsPath,
  hostKeyAlgorithmsFor,
  keyBlobType,
  knownHostKeyTypes,
  knownHostsLine,
  openSshTunnel,
  resetSshTrustCache,
  sshFingerprint,
  type OpenSshTunnelInput,
  type SshTunnel
} from '../ssh-tunnel'
import { MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

const itLive = process.env.TEDOOO_DP_IT ? it : it.skip

const hostKey = utils.generateKeyPairSync('ed25519')
const otherKey = utils.generateKeyPairSync('ed25519')
const ecdsaKey = utils.generateKeyPairSync('ecdsa', { bits: 256 })
const blobOf = (pub: string): Buffer => {
  const parsed = utils.parseKey(pub)
  if (parsed instanceof Error) throw parsed
  return (Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH()
}
const hostBlob = blobOf(hostKey.public)
const otherBlob = blobOf(otherKey.public)
const ecdsaBlob = blobOf(ecdsaKey.public)

interface TestSshServer {
  port: number
  /** Every password a client sent (an impostor must never receive one). */
  passwords: string[]
  close(): Promise<void>
}

/** An ssh2 server with these host keys that forwards TCP for tunnel/sshpw. */
async function startSshServer(hostKeys: string[], port = 0): Promise<TestSshServer> {
  const passwords: string[] = []
  const server = new Server({ hostKeys }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') passwords.push(ctx.password)
      if (ctx.method === 'password' && ctx.username === 'tunnel' && ctx.password === 'sshpw')
        ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('tcpip', (accept, _reject, info) => {
      const channel = accept()
      const socket = net.connect(info.destPort, info.destIP)
      socket.on('error', () => channel.destroy())
      channel.pipe(socket).pipe(channel)
    })
    client.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()))
  return {
    port: (server.address() as net.AddressInfo).port,
    passwords,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}

let sshServer: TestSshServer
let sshPort = 0
let echo: net.Server
let echoPort = 0
let dir = ''
let fileSeq = 0

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tedooo-ssh-test-'))
  echo = net.createServer((s) => s.pipe(s))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
  echoPort = (echo.address() as net.AddressInfo).port
  sshServer = await startSshServer([hostKey.private])
  sshPort = sshServer.port
})

afterAll(async () => {
  await sshServer?.close()
  echo?.close()
  await rm(dir, { recursive: true, force: true })
})

const knownHosts = async (name: string, content: string): Promise<string> => {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

/** A path for a not-yet-existing app known_hosts (in a not-yet-existing directory). */
const freshAppKnownHosts = (): string => join(dir, `app-${++fileSeq}`, 'known_hosts')

/** The non-comment lines of a known_hosts file. */
const entriesOf = async (path: string): Promise<string[]> =>
  (await readFile(path, 'utf8')).split('\n').filter((line) => line && !line.startsWith('#'))

const ssh = (overrides = {}) => ({
  enabled: true,
  host: '127.0.0.1',
  port: sshPort,
  username: 'tunnel',
  authMethod: 'password' as const,
  ...overrides
})

/** openSshTunnel to the echo server; both known_hosts files must be given (never the real ones). */
const open = (
  input: Pick<OpenSshTunnelInput, 'knownHostsPath' | 'appKnownHostsPath'> &
    Partial<OpenSshTunnelInput>
): Promise<SshTunnel> =>
  openSshTunnel({
    ssh: ssh(),
    secrets: { sshPassword: 'sshpw' },
    dstHost: '127.0.0.1',
    dstPort: echoPort,
    redact: (t) => t,
    readyTimeoutMs: 5_000,
    ...input
  })

const ping = (tunnel: SshTunnel): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const socket = net.connect(tunnel.localPort, tunnel.localHost, () => socket.write('ping'))
    socket.on('data', (d) => {
      resolve(d.toString())
      socket.end()
    })
    socket.on('error', reject)
  })

describe('known_hosts', () => {
  const b64 = hostBlob.toString('base64')
  it('matches plain, [host]:port, hashed and wildcard entries', () => {
    expect(checkKnownHosts(`example.com ssh-ed25519 ${b64}`, 'example.com', 22, hostBlob)).toBe(
      'match'
    )
    expect(checkKnownHosts(`[db.local]:2222 ssh-ed25519 ${b64}`, 'db.local', 2222, hostBlob)).toBe(
      'match'
    )
    expect(checkKnownHosts(`db.local ssh-ed25519 ${b64}`, 'db.local', 2222, hostBlob)).toBe(
      'unknown'
    )
    const salt = Buffer.from('0123456789abcdef0123')
    const hash = createHmac('sha1', salt).update('secret.host').digest('base64')
    expect(
      checkKnownHosts(
        `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${b64}`,
        'secret.host',
        22,
        hostBlob
      )
    ).toBe('match')
    // OpenSSH looks host names up in lower case (hashed entries included).
    expect(
      checkKnownHosts(
        `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${b64}`,
        'Secret.HOST',
        22,
        hostBlob
      )
    ).toBe('match')
    expect(checkKnownHosts(`*.corp,!evil.corp ssh-ed25519 ${b64}`, 'db.corp', 22, hostBlob)).toBe(
      'match'
    )
    expect(checkKnownHosts(`*.corp,!evil.corp ssh-ed25519 ${b64}`, 'evil.corp', 22, hostBlob)).toBe(
      'unknown'
    )
  })

  it('reports any other key as a mismatch once the host is listed, whatever its type, and @revoked', () => {
    const other = otherBlob.toString('base64')
    expect(checkKnownHosts(`h ssh-ed25519 ${other}`, 'h', 22, hostBlob)).toBe('mismatch')
    // An impostor presenting another key type must not fall through to "unknown".
    expect(checkKnownHosts(`h ssh-rsa AAAAB3NzaC1yc2E=`, 'h', 22, hostBlob)).toBe('mismatch')
    expect(
      checkKnownHosts(`h ecdsa-sha2-nistp256 ${ecdsaBlob.toString('base64')}`, 'h', 22, hostBlob)
    ).toBe('mismatch')
    expect(
      checkKnownHosts(`@revoked h ssh-ed25519 ${b64}\nh ssh-ed25519 ${b64}`, 'h', 22, hostBlob)
    ).toBe('revoked')
    // Wherever the @revoked line is.
    expect(
      checkKnownHosts(`h ssh-ed25519 ${b64}\n@revoked h ssh-ed25519 ${b64}`, 'h', 22, hostBlob)
    ).toBe('revoked')
    // A revoked other key or a @cert-authority line alone does not pin the host.
    expect(checkKnownHosts(`@revoked h ssh-ed25519 ${other}`, 'h', 22, hostBlob)).toBe('unknown')
    expect(checkKnownHosts(`@cert-authority h ssh-ed25519 ${other}`, 'h', 22, hostBlob)).toBe(
      'unknown'
    )
  })

  it('lists the pinned key types and maps them to the host key algorithms to offer', () => {
    const text = [
      `h ssh-ed25519 ${hostBlob.toString('base64')}`,
      `h,other ssh-rsa AAAAB3NzaC1yc2E=`,
      `@revoked h ecdsa-sha2-nistp256 ${ecdsaBlob.toString('base64')}`,
      `@cert-authority h ssh-dss AAAA`,
      `[h]:2222 ecdsa-sha2-nistp384 AAAA`
    ].join('\n')
    expect(knownHostKeyTypes(text, 'H', 22)).toEqual(['ssh-ed25519', 'ssh-rsa'])
    expect(knownHostKeyTypes(text, 'h', 2222)).toEqual(['ecdsa-sha2-nistp384'])
    expect(knownHostKeyTypes(text, 'nope', 22)).toEqual([])
    expect(hostKeyAlgorithmsFor(['ssh-rsa'])).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'])
    expect(hostKeyAlgorithmsFor(['ecdsa-sha2-nistp256', 'ssh-ed25519'])).toEqual([
      'ssh-ed25519',
      'ecdsa-sha2-nistp256'
    ])
    expect(hostKeyAlgorithmsFor(['ssh-xmss@openssh.com'])).toEqual([])
  })

  it('writes OpenSSH lines only for host names that cannot change what the line says', () => {
    const b64 = hostBlob.toString('base64')
    expect(knownHostsLine('DB.example.com', 22, hostBlob)).toBe(`db.example.com ssh-ed25519 ${b64}`)
    expect(knownHostsLine('10.0.0.5', 2222, hostBlob)).toBe(`[10.0.0.5]:2222 ssh-ed25519 ${b64}`)
    expect(knownHostsLine('fe80::1%en0', 22, hostBlob)).toBe(`fe80::1%en0 ssh-ed25519 ${b64}`)
    for (const host of ['evil\n* ssh-ed25519 AAAA', 'a,b', '*', 'h ost', '!x', '@revoked', ''])
      expect(knownHostsLine(host, 22, hostBlob), JSON.stringify(host)).toBeNull()
    const line = knownHostsLine('db.local', 2200, hostBlob)!
    expect(checkKnownHosts(line, 'db.local', 2200, hostBlob)).toBe('match')
  })

  it("keeps the app's trust store beside the app database (HIVE_SERVER_DB_PATH)", async () => {
    const before = process.env.HIVE_SERVER_DB_PATH
    process.env.HIVE_SERVER_DB_PATH = join(dir, 'base', 'hive.db')
    try {
      expect(await defaultAppKnownHostsPath()).toBe(
        join(dir, 'base', 'data-projects', 'known_hosts')
      )
    } finally {
      if (before === undefined) delete process.env.HIVE_SERVER_DB_PATH
      else process.env.HIVE_SERVER_DB_PATH = before
    }
  })

  it('fingerprints like OpenSSH', () => {
    expect(sshFingerprint(hostBlob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(keyBlobType(hostBlob)).toBe('ssh-ed25519')
    expect(keyBlobType(ecdsaBlob)).toBe('ecdsa-sha2-nistp256')
  })
})

describe('openSshTunnel (in-process SSH server)', () => {
  it('forwards TCP, warns on first use and saves the key to the app known_hosts', async () => {
    resetSshTrustCache()
    const appPath = freshAppKnownHosts()
    const tunnel = await open({
      knownHostsPath: await knownHosts('empty', ''),
      appKnownHostsPath: appPath
    })
    try {
      expect(tunnel.notice).toContain(sshFingerprint(hostBlob))
      expect(tunnel.notice).toMatch(/accepted on first use and saved to/)
      expect(tunnel.hostKeyFingerprint).toBe(sshFingerprint(hostBlob))
      expect(await ping(tunnel)).toBe('ping')
    } finally {
      await tunnel.close()
    }
    expect(tunnel.isOpen()).toBe(false)
    expect(await entriesOf(appPath)).toEqual([knownHostsLine('127.0.0.1', sshPort, hostBlob)])
    expect(await readFile(appPath, 'utf8')).toMatch(/^# SSH host keys trusted on first use/)
    expect((await stat(appPath)).mode & 0o777).toBe(0o600)
  })

  it('accepts the saved key silently after a restart and refuses a changed one', async () => {
    resetSshTrustCache()
    const userPath = await knownHosts('empty-restart', '')
    const appPath = freshAppKnownHosts()
    const first = await startSshServer([hostKey.private])
    try {
      const tofu = await open({
        ssh: ssh({ port: first.port }),
        knownHostsPath: userPath,
        appKnownHostsPath: appPath
      })
      expect(tofu.notice).toMatch(/accepted on first use/)
      await tofu.close()

      resetSshTrustCache() // an app restart: only the file remembers the host
      const again = await open({
        ssh: ssh({ port: first.port }),
        knownHostsPath: userPath,
        appKnownHostsPath: appPath
      })
      expect(again.notice).toBeNull()
      await again.close()
    } finally {
      await first.close()
    }

    // Another server (another key) on the same address: refused before any password is sent.
    resetSshTrustCache()
    const impostor = await startSshServer([otherKey.private], first.port)
    try {
      const error = await open({
        ssh: ssh({ port: impostor.port }),
        knownHostsPath: userPath,
        appKnownHostsPath: appPath
      }).then(
        () => null,
        (e: Error) => e
      )
      expect(error).toMatchObject({ code: 'DATA_CONNECTION_FAILED' })
      expect(error?.message).toContain('does not match')
      expect(error?.message).toContain(appPath.split('/').slice(-2).join('/'))
      expect(error?.message).toContain(sshFingerprint(otherBlob))
      expect(error?.message).toMatch(/man-in-the-middle/)
      expect(impostor.passwords).toEqual([])
    } finally {
      await impostor.close()
    }
    expect(await entriesOf(appPath)).toHaveLength(1)
  })

  it('accepts a key in ~/.ssh/known_hosts silently and refuses a changed one', async () => {
    resetSshTrustCache()
    const appPath = freshAppKnownHosts()
    const good = await open({
      knownHostsPath: await knownHosts(
        'good',
        `[127.0.0.1]:${sshPort} ssh-ed25519 ${hostBlob.toString('base64')}\n`
      ),
      appKnownHostsPath: appPath
    })
    expect(good.notice).toBeNull()
    await good.close()
    const before = sshServer.passwords.length
    await expect(
      open({
        knownHostsPath: await knownHosts(
          'bad',
          `[127.0.0.1]:${sshPort} ssh-ed25519 ${otherBlob.toString('base64')}\n`
        ),
        appKnownHostsPath: appPath
      })
    ).rejects.toThrow(/man-in-the-middle/)
    expect(sshServer.passwords.length).toBe(before)
    // Nothing is trusted on first use for a host the user's known_hosts already lists.
    await expect(readFile(appPath, 'utf8')).rejects.toThrow()
  })

  it('refuses an impostor with another key type before the password is sent', async () => {
    // known_hosts pins ed25519; the impostor only has an ECDSA key. The handshake offers only
    // ed25519, so it fails before the server sees any credential.
    resetSshTrustCache()
    const impostor = await startSshServer([ecdsaKey.private])
    try {
      for (const pinIn of ['user', 'app'] as const) {
        const line = `[127.0.0.1]:${impostor.port} ssh-ed25519 ${hostBlob.toString('base64')}\n`
        const userPath = await knownHosts(`pin-${pinIn}-user`, pinIn === 'user' ? line : '')
        const appPath = await knownHosts(`pin-${pinIn}-app`, pinIn === 'app' ? line : '')
        const error = await open({
          ssh: ssh({ port: impostor.port }),
          knownHostsPath: userPath,
          appKnownHostsPath: appPath
        }).then(
          () => null,
          (e: Error) => e
        )
        expect(error, pinIn).toMatchObject({ code: 'DATA_CONNECTION_FAILED' })
        expect(error?.message).toMatch(/offers none of the key types known for it \(ssh-ed25519\)/)
        expect(error?.message).toContain(pinIn === 'user' ? 'pin-user-user' : 'pin-app-app')
        expect(error?.message).toMatch(/man-in-the-middle/)
        expect(await entriesOf(appPath)).toEqual(pinIn === 'app' ? [line.trim()] : [])
      }
      expect(impostor.passwords).toEqual([])
    } finally {
      await impostor.close()
    }
  })

  it('negotiates the pinned key type when the server has several host keys', async () => {
    // ssh2 prefers ed25519; with only the ECDSA key known, the client must ask for ECDSA.
    resetSshTrustCache()
    const server = await startSshServer([hostKey.private, ecdsaKey.private])
    try {
      const tunnel = await open({
        ssh: ssh({ port: server.port }),
        knownHostsPath: await knownHosts(
          'ecdsa-pin',
          `[127.0.0.1]:${server.port} ecdsa-sha2-nistp256 ${ecdsaBlob.toString('base64')}\n`
        ),
        appKnownHostsPath: freshAppKnownHosts()
      })
      expect(tunnel.notice).toBeNull()
      expect(tunnel.hostKeyFingerprint).toBe(sshFingerprint(ecdsaBlob))
      expect(await ping(tunnel)).toBe('ping')
      await tunnel.close()
    } finally {
      await server.close()
    }
  })

  it('refuses a key of another type when the known types cannot be negotiated', async () => {
    resetSshTrustCache()
    const before = sshServer.passwords.length
    const error = await open({
      knownHostsPath: await knownHosts(
        'xmss',
        `[127.0.0.1]:${sshPort} ssh-xmss@openssh.com AAAAFHNzaC14bXNzQG9wZW5zc2guY29t\n`
      ),
      appKnownHostsPath: freshAppKnownHosts()
    }).then(
      () => null,
      (e: Error) => e
    )
    expect(error?.message).toContain('does not match')
    expect(error?.message).toContain('Only ssh-xmss@openssh.com keys are known for this host')
    expect(error?.message).toContain(`ssh-ed25519 ${sshFingerprint(hostBlob)}`)
    expect(sshServer.passwords.length).toBe(before)
  })

  it('two first connections at once trust and save the key once', async () => {
    resetSshTrustCache()
    const appPath = freshAppKnownHosts()
    const userPath = await knownHosts('empty-race', '')
    const tunnels = await Promise.all([
      open({ knownHostsPath: userPath, appKnownHostsPath: appPath }),
      open({ knownHostsPath: userPath, appKnownHostsPath: appPath })
    ])
    try {
      const notices = tunnels.map((t) => t.notice ?? '')
      // One saved the key; the other found it saved and repeats the not yet shown notice.
      expect(
        notices.filter((n) => /was not known; accepted on first use and saved/.test(n))
      ).toHaveLength(1)
      expect(notices.filter((n) => /earlier in this app session/.test(n))).toHaveLength(1)
      for (const notice of notices) expect(notice).toContain(sshFingerprint(hostBlob))
      expect(await entriesOf(appPath)).toHaveLength(1)
    } finally {
      await Promise.all(tunnels.map((t) => t.close()))
    }
  })

  it('a first attempt that fails after the key was saved still reports its fingerprint', async () => {
    // Wrong SSH password on the very first connection: the key is pinned before authentication,
    // so the notice must come with the error and with every later tunnel until it is shown.
    resetSshTrustCache()
    const appPath = freshAppKnownHosts()
    const userPath = await knownHosts('empty-first-fail', '')
    const error = await open({
      secrets: { sshPassword: 'nope' },
      knownHostsPath: userPath,
      appKnownHostsPath: appPath
    }).then(
      () => null,
      (e: Error & { sshNotice?: string }) => e
    )
    expect(error).toMatchObject({ code: 'DATA_CREDENTIALS_REQUIRED' })
    expect(error?.message).toMatch(
      /Check the SSH password\. SSH host key of .* accepted on first use/
    )
    expect(error?.message).toContain(sshFingerprint(hostBlob))
    expect(error?.sshNotice).toMatch(/accepted on first use and saved to/)
    expect(await entriesOf(appPath)).toEqual([knownHostsLine('127.0.0.1', sshPort, hostBlob)])

    // The right password: the key is known now, but its notice was never shown.
    const second = await open({ knownHostsPath: userPath, appKnownHostsPath: appPath })
    expect(second.notice).toContain(sshFingerprint(hostBlob))
    expect(second.notice).toMatch(/accepted on first use earlier in this app session and saved to/)
    await second.close()
    // A caller that dropped it (the database login behind the tunnel failed) gets it again…
    const third = await open({ knownHostsPath: userPath, appKnownHostsPath: appPath })
    expect(third.notice).toContain(sshFingerprint(hostBlob))
    // …until one acknowledges that the user saw it.
    third.acknowledgeNotice?.()
    await third.close()
    const fourth = await open({ knownHostsPath: userPath, appKnownHostsPath: appPath })
    expect(fourth.notice).toBeNull()
    await fourth.close()
    expect(await entriesOf(appPath)).toHaveLength(1)
  })

  it('never falls back to the real ~/.ssh or ~/.hive known_hosts under the test runner', async () => {
    const saved = {
      db: process.env.HIVE_SERVER_DB_PATH,
      base: process.env.HIVE_SERVER_BASE_DIR,
      desktop: process.env.HIVE_DESKTOP_BASE_DIR
    }
    delete process.env.HIVE_SERVER_DB_PATH
    delete process.env.HIVE_SERVER_BASE_DIR
    delete process.env.HIVE_DESKTOP_BASE_DIR
    const before = sshServer.passwords.length
    try {
      await expect(defaultAppKnownHostsPath()).rejects.toThrow(
        /Refusing to use the real app known_hosts .*\.hive/
      )
      await expect(
        openSshTunnel({
          ssh: ssh(),
          secrets: { sshPassword: 'sshpw' },
          dstHost: '127.0.0.1',
          dstPort: echoPort,
          redact: (t) => t,
          appKnownHostsPath: freshAppKnownHosts()
        })
      ).rejects.toThrow(/Refusing to use the real user known_hosts .*\.ssh/)
      await expect(
        openSshTunnel({
          ssh: ssh(),
          secrets: { sshPassword: 'sshpw' },
          dstHost: '127.0.0.1',
          dstPort: echoPort,
          redact: (t) => t,
          knownHostsPath: await knownHosts('empty-default-app', '')
        })
      ).rejects.toThrow(/Refusing to use the real app known_hosts/)
      // Refused before connecting: nothing was sent to the server.
      expect(sshServer.passwords.length).toBe(before)
    } finally {
      for (const [key, value] of [
        ['HIVE_SERVER_DB_PATH', saved.db],
        ['HIVE_SERVER_BASE_DIR', saved.base],
        ['HIVE_DESKTOP_BASE_DIR', saved.desktop]
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('trusts for the session only when the app known_hosts cannot be written', async () => {
    resetSshTrustCache()
    const notADir = await knownHosts('not-a-dir', 'x')
    const appPath = join(notADir, 'known_hosts')
    const userPath = await knownHosts('empty-session', '')
    const first = await startSshServer([hostKey.private])
    const port = first.port
    try {
      const tunnel = await open({
        ssh: ssh({ port }),
        knownHostsPath: userPath,
        appKnownHostsPath: appPath
      })
      expect(tunnel.notice).toMatch(/for this app session only/)
      await tunnel.close()
    } finally {
      await first.close()
    }
    const impostor = await startSshServer([otherKey.private], port)
    try {
      await expect(
        open({ ssh: ssh({ port }), knownHostsPath: userPath, appKnownHostsPath: appPath })
      ).rejects.toThrow(/changed during this session/)
      expect(impostor.passwords).toEqual([])
    } finally {
      await impostor.close()
      resetSshTrustCache()
    }
  })

  it('a wrong or missing SSH password asks for credentials', async () => {
    const path = await knownHosts('empty2', '')
    const appKnownHostsPath = freshAppKnownHosts()
    await expect(
      open({ secrets: { sshPassword: 'nope' }, knownHostsPath: path, appKnownHostsPath })
    ).rejects.toMatchObject({ code: 'DATA_CREDENTIALS_REQUIRED' })
    await expect(
      open({ secrets: {}, knownHostsPath: path, appKnownHostsPath })
    ).rejects.toMatchObject({ code: 'DATA_CREDENTIALS_REQUIRED' })
  })

  it('notifies onClose listeners when closed', async () => {
    const tunnel = await open({
      knownHostsPath: await knownHosts('empty3', ''),
      appKnownHostsPath: freshAppKnownHosts()
    })
    const reasons: Array<string | null> = []
    tunnel.onClose((r) => reasons.push(r))
    await tunnel.close()
    expect(reasons).toEqual([null])
  })

  itLive('connects MySQL through the tunnel via the engine and shows the TOFU notice', async () => {
    resetSshTrustCache()
    const path = await knownHosts('engine', '')
    const appKnownHostsPath = freshAppKnownHosts()
    const opened: SshTunnel[] = []
    const engine = createDataEngineService({
      repository: new MemoryRepository([
        makeRecord({
          id: 'ssh-mysql',
          engine: 'mysql',
          config: { host: '127.0.0.1', port: 13306, user: 'root', database: 'shop', ssh: ssh() }
        })
      ]),
      secrets: new MemorySecrets({ 'ssh-mysql': { password: 'rootpw', sshPassword: 'sshpw' } }),
      openTunnel: async (input) => {
        const tunnel = await openSshTunnel({ ...input, knownHostsPath: path, appKnownHostsPath })
        opened.push(tunnel)
        return tunnel
      },
      gate: createSafetyGate(),
      logger: noopLogger
    })
    try {
      const status = await engine.connect('ssh-mysql')
      expect(status.state).toBe('connected')
      expect(status.notice).toMatch(/accepted on first use/)
      // The status showed it: once acknowledged, later tunnels to the host stop repeating it.
      opened[0].acknowledgeNotice?.()
      const res = await engine.execute(
        {
          dataProjectId: 'ssh-mysql',
          queryId: 'ssh-q',
          text: 'SELECT COUNT(*) AS n FROM users',
          limit: 10,
          source: 'editor'
        },
        { clientId: null }
      )
      expect(res.status === 'ok' && res.statements[0].output?.kind).toBe('rows')
      // The key was saved by the first connection: the test connection finds it known.
      const test = await engine.testConnection({
        engine: 'mysql',
        config: { host: '127.0.0.1', port: 13306, user: 'root', ssh: ssh() },
        secrets: { password: 'rootpw', sshPassword: 'sshpw' }
      })
      expect(test).toMatchObject({ ok: true })
      expect(test.notice).toBeUndefined()
      expect(test.databases).toContain('shop')
    } finally {
      await engine.shutdown()
    }
  })

  itLive('the connection test reports the first-use fingerprint notice', async () => {
    resetSshTrustCache()
    const path = await knownHosts('engine-test', '')
    const appKnownHostsPath = freshAppKnownHosts()
    const engine = createDataEngineService({
      repository: new MemoryRepository([]),
      secrets: new MemorySecrets({}),
      openTunnel: (input) => openSshTunnel({ ...input, knownHostsPath: path, appKnownHostsPath }),
      gate: createSafetyGate(),
      logger: noopLogger
    })
    try {
      const test = await engine.testConnection({
        engine: 'mysql',
        config: { host: '127.0.0.1', port: 13306, user: 'root', ssh: ssh() },
        secrets: { password: 'rootpw', sshPassword: 'sshpw' }
      })
      expect(test).toMatchObject({ ok: true })
      expect(test.notice).toContain(sshFingerprint(hostBlob))
      expect(await entriesOf(appKnownHostsPath)).toHaveLength(1)
    } finally {
      await engine.shutdown()
    }
  })
})
