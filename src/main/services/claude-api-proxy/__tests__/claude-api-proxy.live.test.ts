// @vitest-environment node
/**
 * Live verification of the local Claude API proxy against the REAL `claude`
 * binary and the real Anthropic API.
 *
 * Opt-in: `CLAUDE_API_PROXY_LIVE=1 pnpm exec vitest run src/main/services/claude-api-proxy/__tests__/claude-api-proxy.live.test.ts`
 * Needs a logged-in claude (claude.ai subscription) and network; it runs ONE
 * tiny prompt on haiku, so it costs a few tokens of the signed-in account.
 *
 * What it proves end to end:
 *  - claude honours ANTHROPIC_BASE_URL pointed at the proxy for an OAuth
 *    session (requests arrive, are forwarded, and the turn completes);
 *  - the `/v1/messages` response carries `anthropic-ratelimit-unified-*`
 *    headers that parse into 5h/7d utilization;
 *  - the request body's `metadata.user_id` yields the account uuid, and it
 *    matches the live identity file's `oauthAccount.accountUuid`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readClaudeLiveIdentity } from '../../account-store-claude'
import { startLocalApiProxy, type LocalApiProxyExchange } from '../local-api-proxy'
import { buildUpstreamCaCertificates } from '../claude-api-proxy'
import { observationFromExchange } from '../claude-usage-live-updater'

const LIVE = process.env.CLAUDE_API_PROXY_LIVE === '1'
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude')
const MODEL = process.env.CLAUDE_API_PROXY_LIVE_MODEL ?? 'haiku'

const describeLive = LIVE && existsSync(CLAUDE_BIN) ? describe : describe.skip

describeLive('claude through the local API proxy (live)', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
  })

  it('completes an OAuth turn via the proxy and yields an attributed usage observation', async () => {
    const exchanges: LocalApiProxyExchange[] = []
    // The same trust roots production hands the tunnel (bundled + system + extras).
    const trust = buildUpstreamCaCertificates()
    console.log('[trust roots]', trust.sources)
    const proxy = await startLocalApiProxy({
      port: 0,
      resolveUpstream: () => process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com',
      onExchange: (exchange) => exchanges.push(exchange),
      upstreamTls: { ca: trust.ca },
      log: {
        debug: () => {},
        info: (message, data) => console.log(`[proxy] ${message}`, data ?? ''),
        warn: (message, data) => console.warn(`[proxy] ${message}`, data ?? '')
      }
    })
    cleanups.push(() => proxy.close())

    const cwd = mkdtempSync(join(tmpdir(), 'claude-proxy-live-'))
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: proxy.baseUrl,
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1'
    }
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
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
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

    console.log('[claude stdout]', stdout.slice(0, 2000))
    if (stderr) console.log('[claude stderr]', stderr.slice(0, 2000))
    console.log(
      '[exchanges]',
      exchanges.map((e) => `${e.method} ${e.path} -> ${e.status} (${e.latencyMs}ms)`)
    )

    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout) as { type?: string; is_error?: boolean; result?: string }
    expect(result.type).toBe('result')
    expect(result.is_error).toBeFalsy()

    const messageExchanges = exchanges.filter(
      (e) => e.path.startsWith('/v1/messages') && !e.path.includes('count_tokens')
    )
    expect(messageExchanges.length).toBeGreaterThan(0)

    const observations = messageExchanges
      .map((e) => observationFromExchange(e))
      .filter((o): o is NonNullable<typeof o> => o !== null)
    expect(observations.length).toBeGreaterThan(0)
    const observation = observations[0]
    console.log('[observation]', {
      accountUuid: observation.accountUuid,
      fiveHour: observation.snapshot.fiveHour,
      sevenDay: observation.snapshot.sevenDay,
      scoped: observation.snapshot.scoped,
      status: observation.snapshot.status,
      claim: observation.snapshot.representativeClaim
    })
    expect(observation.snapshot.fiveHour?.utilizationPercent).not.toBeNull()
    expect(observation.snapshot.sevenDay?.utilizationPercent).not.toBeNull()

    const identity = await readClaudeLiveIdentity()
    if (identity.uuid) {
      expect(observation.accountUuid).toBe(identity.uuid.toLowerCase())
    }
  }, 120_000)
})
