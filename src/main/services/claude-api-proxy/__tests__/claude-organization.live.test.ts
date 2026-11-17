// @vitest-environment node
/**
 * Live check that the organization learned for the signed-in account is the
 * one a real model response for that account is billed to.
 *
 * Opt-in: `CLAUDE_ORGANIZATION_LIVE=1 pnpm exec vitest run --project main src/main/services/claude-api-proxy/__tests__/claude-organization.live.test.ts`
 * Needs a logged-in claude (claude.ai subscription) and network. It runs ONE
 * tiny prompt on haiku through a local proxy to see a real `/v1/messages`
 * response, then makes the two requests the app learns from, once each, with
 * the same account's access token: the usage poll and the profile request.
 *
 * It never refreshes a token (the poll is handed the access token alone), and
 * writes nothing: no database, no account store, no identity file. Only the
 * first 8 characters of an organization id are printed.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeOrganizationLearner } from '../../claude-organization-learner'
import {
  fetchClaudeProfileOrganization,
  fetchClaudeUsage,
  readClaudeCredentialsBlob
} from '../../usage-service'
import { buildUpstreamCaCertificates } from '../claude-api-proxy'
import { organizationFromResponseHeaders } from '../claude-usage-live-updater'
import { startLocalApiProxy, type LocalApiProxyExchange } from '../local-api-proxy'

const LIVE = process.env.CLAUDE_ORGANIZATION_LIVE === '1'
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude')
const MODEL = process.env.CLAUDE_ORGANIZATION_LIVE_MODEL ?? 'haiku'

const describeLive = LIVE && existsSync(CLAUDE_BIN) ? describe : describe.skip

const short = (organization: string | null | undefined): string =>
  organization ? `${organization.slice(0, 8)}…` : String(organization)

/** The environment for the nested CLI: this session's own Claude Code variables kept out. */
function nestedClaudeEnv(baseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_')) continue
    if (name === 'ANTHROPIC_LOG') continue
    env[name] = value
  }
  env.ANTHROPIC_BASE_URL = baseUrl
  env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
  return env
}

describeLive('the organization learned for the signed-in account (live)', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
  })

  it('equals the organization on a real model response for that account', async () => {
    // 1. A real model response for the signed-in account.
    const exchanges: LocalApiProxyExchange[] = []
    const trust = buildUpstreamCaCertificates()
    const proxy = await startLocalApiProxy({
      port: 0,
      resolveUpstream: () => 'https://api.anthropic.com',
      onExchange: (exchange) => exchanges.push(exchange),
      upstreamTls: { ca: trust.ca },
      log: { debug: () => {}, info: () => {}, warn: () => {} }
    })
    cleanups.push(() => proxy.close())

    const cwd = mkdtempSync(join(tmpdir(), 'claude-organization-live-'))
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))

    const child = spawn(
      CLAUDE_BIN,
      [
        '-p',
        'Reply with exactly the word OK and nothing else.',
        '--model',
        MODEL,
        '--max-turns',
        '1',
        '--output-format',
        'json'
      ],
      { cwd, env: nestedClaudeEnv(proxy.baseUrl), stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.resume()
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(null)
      }, 110_000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    expect(exitCode).toBe(0)
    const turn = JSON.parse(stdout) as { type?: string; is_error?: boolean }
    expect(turn.type).toBe('result')
    expect(turn.is_error).toBeFalsy()

    const modelResponses = exchanges.filter(
      (exchange) =>
        exchange.path.startsWith('/v1/messages') &&
        !exchange.path.includes('count_tokens') &&
        exchange.status === 200
    )
    expect(modelResponses.length).toBeGreaterThan(0)
    const billed = new Set(
      modelResponses.map((exchange) => organizationFromResponseHeaders(exchange.responseHeaders))
    )
    console.log('[model responses]', {
      count: modelResponses.length,
      organizations: [...billed].map(short)
    })
    expect(billed.size).toBe(1)
    const modelOrganization = [...billed][0]
    expect(modelOrganization).not.toBeNull()

    // 2. The same account's own credential, after the turn (the CLI may have refreshed it).
    const credential = await readClaudeCredentialsBlob()
    expect(credential?.accessToken).toBeTruthy()
    const accessToken = credential!.accessToken

    // 3. The usage poll: the organization rides on the response header. Handed the access
    //    token alone, so nothing can be refreshed or rotated by this check.
    const poll = await fetchClaudeUsage({ accessToken }, { caller: 'usage:fetchForAccount' })
    console.log('[usage poll]', {
      success: poll.success,
      error: poll.error,
      organization: short(poll.organizationUuid)
    })
    expect(poll.success).toBe(true)
    expect(poll.organizationUuid).toBe(modelOrganization)

    // 4. The profile request the learner makes for an account the poll did not teach.
    const profile = await fetchClaudeProfileOrganization(accessToken)
    console.log(
      '[profile]',
      profile.ok
        ? { ok: true, organization: short(profile.organizationUuid) }
        : { ok: false, reason: profile.reason, status: profile.status }
    )
    expect(profile).toEqual({ ok: true, organizationUuid: modelOrganization })

    // 5. The learner itself, for an account with no organization: what it stores.
    let stored: string | null = null
    const learner = new ClaudeOrganizationLearner({
      listAccountsWithoutOrganization: () =>
        stored === null ? [{ id: 'signed-in', email: 'signed-in' }] : [],
      readCredential: async () => ({ accessToken, expiresAt: credential!.expiresAt }),
      fetchOrganization: fetchClaudeProfileOrganization,
      storeOrganization: (_account, organizationUuid) => {
        stored = organizationUuid
        return true
      },
      log: { info: () => {}, warn: () => {} }
    })
    await learner.sweep()
    console.log('[learner]', { stored: short(stored) })
    expect(stored).toBe(modelOrganization)
  }, 150_000)
})
