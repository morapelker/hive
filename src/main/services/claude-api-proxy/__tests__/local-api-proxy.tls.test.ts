// @vitest-environment node
/**
 * The upstream TLS leg must trust whatever roots the caller hands in — that is
 * how a corporate TLS-inspection root (installed in the OS store, or named by
 * NODE_EXTRA_CA_CERTS) keeps working once the CLI stops terminating TLS itself.
 * Certificates are minted with the system `openssl`; skipped where absent.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import http from 'http'
import https from 'https'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startLocalApiProxy, type LocalApiProxy } from '../local-api-proxy'

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const describeTls = hasOpenssl() ? describe : describe.skip

interface TestPki {
  caPem: string
  certPem: string
  keyPem: string
}

/** A throwaway CA plus a leaf for 127.0.0.1 (SAN included, as modern TLS requires). */
function mintPki(dir: string): TestPki {
  const run = (args: string[], input?: string): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: ['pipe', 'ignore', 'ignore'], input })
  }
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Tedooo Test CA',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem'
  ])
  run([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=127.0.0.1',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr'
  ])
  run(
    [
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-days',
      '2',
      '-out',
      'leaf.pem',
      '-extfile',
      '/dev/stdin'
    ],
    'subjectAltName=IP:127.0.0.1\n'
  )
  return {
    caPem: readFileSync(join(dir, 'ca.pem'), 'utf8'),
    certPem: readFileSync(join(dir, 'leaf.pem'), 'utf8'),
    keyPem: readFileSync(join(dir, 'leaf.key'), 'utf8')
  }
}

describeTls('upstream TLS trust', () => {
  let dir: string
  let pki: TestPki
  let upstream: https.Server
  let origin: string
  const proxies: LocalApiProxy[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-proxy-tls-'))
    pki = mintPki(dir)
    upstream = https.createServer({ cert: pki.certPem, key: pki.keyPem }, (_req, res) => {
      res.writeHead(200, { 'anthropic-ratelimit-unified-5h-utilization': '0.5' })
      res.end('secure')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    origin = `https://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    for (const proxy of proxies) await proxy.close()
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections()
      upstream.close(() => resolve())
    })
    rmSync(dir, { recursive: true, force: true })
  })

  function request(port: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'GET', path: '/v1/models' },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => (body += chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        }
      )
      req.on('error', reject)
      req.end()
    })
  }

  it('passes through when the private root is among the configured trust roots', async () => {
    const proxy = await startLocalApiProxy({
      port: 0,
      resolveUpstream: () => origin,
      upstreamTls: { ca: [pki.caPem] }
    })
    proxies.push(proxy)
    const response = await request(proxy.port)
    expect(response.status).toBe(200)
    expect(response.body).toBe('secure')
  })

  it('answers a diagnosable 502 when the root is not trusted', async () => {
    const proxy = await startLocalApiProxy({ port: 0, resolveUpstream: () => origin })
    proxies.push(proxy)
    const response = await request(proxy.port)
    expect(response.status).toBe(502)
    expect(response.body).toContain('TLS verification')
    expect(response.body).toMatch(
      /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT/
    )
  })
})
