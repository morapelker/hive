/**
 * Client for the code server's long-poll endpoint
 * (claude-code-extractor: `GET /api/codes/wait?email=&since=&timeout=`).
 *
 * The server holds each request open for up to `timeout` seconds (it caps at
 * 120) and answers 204 when nothing arrived; this client keeps asking until its
 * own budget is spent, so the budget in settings can exceed one server
 * request. Network blips are retried with the same `since` — the record is kept
 * server-side, so a retry can never miss a code that arrived in between.
 */
import { normalizeAutoSignInUrl } from '@shared/types/settings'

export const CODE_WAIT_PATH = '/api/codes/wait'
/** The server's cap on one request. */
const SERVER_MAX_TIMEOUT_SECONDS = 120
/** Extra time for the response to travel after the server's own deadline. */
const RESPONSE_GRACE_MS = 10_000
const RETRY_DELAY_MS = 2_000
/** A probe address that never gets mail — the server validates the shape only. */
const PROBE_EMAIL = 'probe@example.com'

export type CodeWaitResult =
  | { kind: 'code'; code: string; receivedAt: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'timeout' }

export interface CodeServerOptions {
  baseUrl: string
  apiToken?: string
  fetchImpl?: typeof fetch
}

export interface WaitForCodeOptions extends CodeServerOptions {
  email: string
  /** Codes from emails received before this (epoch ms) belong to a previous attempt. */
  sinceMs: number
  budgetMs: number
  signal?: AbortSignal
  /** Test seams. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

function buildUrl(baseUrl: string, params: Record<string, string>): string {
  const url = new URL(`${normalizeAutoSignInUrl(baseUrl)}${CODE_WAIT_PATH}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

function headersFor(apiToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`
  return headers
}

function combineSignals(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()
  const onAbort = (): void => {
    clearTimeout(timer)
    controller.abort(outer?.reason)
  }
  if (outer?.aborted) onAbort()
  else outer?.addEventListener('abort', onAbort, { once: true })
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Errors that mean "stop asking" rather than "ask again". */
export class CodeServerError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'CodeServerError'
  }
}

/**
 * Long-poll for the sign-in code of `email`. Resolves with the code, with the
 * server's failure record (the mail arrived but no code could be produced),
 * or with `timeout` once the budget is spent. Rejects only on a definitive
 * server rejection (bad token, bad request) or when `signal` aborts.
 */
export async function waitForSignInCode(options: WaitForCodeOptions): Promise<CodeWaitResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const deadline = now() + options.budgetMs

  for (;;) {
    if (options.signal?.aborted) throw new Error('cancelled')
    const remainingMs = deadline - now()
    if (remainingMs <= 0) return { kind: 'timeout' }

    const timeoutSeconds = Math.min(SERVER_MAX_TIMEOUT_SECONDS, Math.ceil(remainingMs / 1000))
    const url = buildUrl(options.baseUrl, {
      email: options.email,
      since: String(Math.floor(options.sinceMs)),
      timeout: String(timeoutSeconds)
    })

    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: headersFor(options.apiToken),
        signal: combineSignals(timeoutSeconds * 1000 + RESPONSE_GRACE_MS, options.signal)
      })
    } catch (error) {
      if (options.signal?.aborted) throw new Error('cancelled')
      // Unreachable server, DNS failure (telepresence down), request timed out:
      // retry while the budget lasts; the final answer is then `timeout`.
      if (deadline - now() <= RETRY_DELAY_MS) {
        throw new CodeServerError(
          `Code server unreachable: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      await sleep(RETRY_DELAY_MS)
      continue
    }

    if (response.status === 204) continue
    if (response.status === 401)
      throw new CodeServerError('Code server rejected the API token', 401)
    if (response.status === 400) {
      throw new CodeServerError(
        `Code server rejected the request: ${await safeText(response)}`,
        400
      )
    }
    if (!response.ok) {
      // 5xx or a proxy in the way — transient; retry.
      await sleep(RETRY_DELAY_MS)
      continue
    }

    const body = (await response.json().catch(() => null)) as {
      status?: string
      code?: string
      receivedAt?: string
      reason?: string
    } | null
    if (body?.status === 'code' && typeof body.code === 'string') {
      return { kind: 'code', code: body.code.trim(), receivedAt: body.receivedAt ?? '' }
    }
    if (body?.status === 'failed') {
      return { kind: 'failed', reason: body.reason ?? 'the code server could not resolve a code' }
    }
    throw new CodeServerError('Code server returned an unexpected response')
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200)
  } catch {
    return ''
  }
}

export interface CodeServerTestResult {
  ok: boolean
  message: string
}

/**
 * One cheap request (`timeout=0`, probe address) to confirm the URL points at a
 * code server and the token (if any) is accepted.
 */
export async function testCodeServer(options: CodeServerOptions): Promise<CodeServerTestResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = buildUrl(options.baseUrl, { email: PROBE_EMAIL, timeout: '0' })
  try {
    const response = await fetchImpl(url, {
      headers: headersFor(options.apiToken),
      signal: combineSignals(10_000)
    })
    if (response.status === 204 || response.status === 200) {
      return { ok: true, message: 'Code server reachable' }
    }
    if (response.status === 401)
      return { ok: false, message: 'The code server rejected the API token' }
    return { ok: false, message: `Code server answered HTTP ${response.status}` }
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the code server: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
