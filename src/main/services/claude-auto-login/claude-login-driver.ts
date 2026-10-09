/**
 * Drives claude.ai's sign-in in a throwaway Chrome, from the OAuth authorize
 * URL to the redirect back to the app's loopback callback:
 *
 *   open Chrome → type the email, submit → ask the code server for the code
 *   that email triggers → type it, submit → click "Authorize" → redirect
 *
 * The loopback server in login-service.ts stays the single source of truth for
 * success: this driver never touches the OAuth code. It only moves the page
 * along and reports which stage it is at.
 *
 * Policy for anything it cannot drive (a Cloudflare/hCaptcha challenge, SMS
 * 2FA, an organisation picker, an SSO-enforced domain, an unrecognised page):
 * report `needs-human` with a reason and leave the window open — but keep
 * watching. If the user clears the obstacle (ticks the challenge, picks the
 * organisation), the automation picks up again from the page it then sees.
 * The window is closed by login-service once the login reaches a terminal
 * state; the user closing it cancels the login (as with the old driven flow).
 *
 * Hands-off implementation notes: no `Runtime.enable` (an automation tell),
 * trusted input via `Input.insertText` / `Input.dispatchMouseEvent` so React's
 * controlled inputs and the invisible hCaptcha see real events, and a page
 * probe that never throws (a throwing probe looks like a dead page).
 */
import type { AutoSignInSettings } from '@shared/types/settings'
import type { LoginStage } from '@shared/types/usage'
import { createLogger } from '../logger'
import { CdpPipeClient } from './cdp-pipe-client'
import { launchChrome, type LaunchedChrome } from './chrome-launcher'
import { waitForSignInCode, type CodeWaitResult } from './code-server-client'
import {
  CODE_INPUT_SELECTORS,
  EMAIL_INPUT_SELECTORS,
  ENTER_CODE_LINK_SELECTORS,
  PAGE_PROBE_EXPRESSION,
  SUBMIT_BUTTON_SELECTORS,
  focusExpression,
  isCallbackUrl,
  isClaudeUrl,
  isWebUrl,
  locateClickableExpression,
  readValueExpression,
  type PageProbe
} from './page-scripts'

const log = createLogger({ component: 'ClaudeAutoLogin' })

/** How often the page is re-probed. */
const PROBE_INTERVAL_MS = 400
/** One `Runtime.evaluate` can hang across a navigation; never wait longer than this for it. */
const EVALUATE_TIMEOUT_MS = 2_500
/** Waiting for the email form (page load, possible challenge solved by the user). */
const EMAIL_FORM_TIMEOUT_MS = 30_000
/** After submitting the email: the "email sent" / code screen should follow quickly. */
const EMAIL_SUBMIT_TIMEOUT_MS = 20_000
/** After submitting the code: the consent page (or an error) should follow quickly. */
const CODE_SUBMIT_TIMEOUT_MS = 20_000
/** The Authorize button arms ~700 ms after load; allow for slow data loading. */
const CONSENT_TIMEOUT_MS = 30_000
/** After clicking Authorize: the redirect to the loopback callback. */
const REDIRECT_TIMEOUT_MS = 20_000
/** Give the probe (login_methods) time to flip the primary button to SSO before we submit. */
const SSO_PROBE_SETTLE_MS = 700
/** Clock-skew margin when telling the code server which codes are "new". */
const SINCE_SKEW_MS = 5_000
/** How long to keep watching the page in `needs-human` for the user to clear the obstacle. */
const NEEDS_HUMAN_WATCH_MS = 10 * 60_000
/** A rejected code is retried once with a fresh wait (a newer code may have landed). */
const MAX_CODE_ATTEMPTS = 2

export interface ClaudeAutoLoginInput {
  loginId: string
  authorizeUrl: string
  /** The loopback redirect URI the authorize URL was built with. */
  redirectUri: string
  email: string
  settings: AutoSignInSettings
  /** Stage transitions, for the renderer's banner. */
  onStage: (stage: LoginStage, detail?: string | null) => void
  /** The user closed the browser before the redirect: the login should be cancelled. */
  onBrowserClosed: () => void
  /** True once login-service has captured the callback — stop driving. */
  isResolved: () => boolean
}

export interface ClaudeAutoLoginHandle {
  /** Resolves when the driver stops driving (redirect seen, gave up, or cancelled). Never rejects. */
  finished: Promise<void>
  /** Closes Chrome (and the throwaway profile). Idempotent. */
  close: () => Promise<void>
}

export type ClaudeAutoLoginRunner = (input: ClaudeAutoLoginInput) => Promise<ClaudeAutoLoginHandle>

interface Point {
  x: number
  y: number
}

/** Thrown internally to unwind the flow when the login was cancelled/resolved. */
class StopDriving extends Error {
  constructor(readonly reason: 'cancelled' | 'resolved' | 'browser-closed') {
    super(reason)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Launch Chrome on the authorize URL and start driving. Rejects only when the
 * browser cannot be launched or attached to; everything after that is reported
 * through `onStage` and resolves `finished`.
 */
export const runClaudeAutoLogin: ClaudeAutoLoginRunner = async (input) => {
  input.onStage('opening-browser')
  const chrome = await launchChrome(input.authorizeUrl)
  const session = new DriverSession(input, chrome)
  try {
    await session.attach()
  } catch (error) {
    await chrome.kill().catch(() => {})
    throw error
  }
  const finished = session.run()
  return { finished, close: () => session.close() }
}

class DriverSession {
  private readonly cdp: CdpPipeClient
  private sessionId: string | null = null
  private targetId: string | null = null
  private closed = false
  private sawCallback = false
  private readonly abort = new AbortController()

  constructor(
    private readonly input: ClaudeAutoLoginInput,
    private readonly chrome: LaunchedChrome
  ) {
    this.cdp = new CdpPipeClient(chrome.cdpWrite, chrome.cdpRead)
    this.cdp.onClose(() => this.handleBrowserGone())
    void chrome.exited.then(() => this.handleBrowserGone())
  }

  /** Find the tab Chrome opened on the authorize URL and attach to it. */
  async attach(): Promise<void> {
    await this.cdp.send('Target.setDiscoverTargets', { discover: true })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const { targetInfos } = await this.cdp.send<{
        targetInfos: Array<{ targetId: string; type: string; url: string }>
      }>('Target.getTargets')
      const page = targetInfos.find((t) => t.type === 'page')
      if (page) {
        this.targetId = page.targetId
        const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
          targetId: page.targetId,
          flatten: true
        })
        this.sessionId = sessionId
        await this.cdp.send('Page.enable', {}, sessionId)
        this.cdp.onEvent((event) => this.onCdpEvent(event))
        return
      }
      await sleep(200)
    }
    throw new Error('Chrome opened but no page appeared')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    try {
      if (!this.cdp.isClosed) await Promise.race([this.cdp.send('Browser.close'), sleep(1500)])
    } catch {
      // Chrome may already be gone
    }
    this.cdp.close()
    await this.chrome.kill().catch(() => {})
  }

  /** The whole flow; never rejects. */
  async run(): Promise<void> {
    try {
      await this.drive()
    } catch (error) {
      if (error instanceof StopDriving) {
        log.info('Auto sign-in stopped driving', {
          loginId: this.input.loginId,
          reason: error.reason
        })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Auto sign-in gave up — leaving the window to the user', {
        loginId: this.input.loginId,
        error: message
      })
      this.stage('needs-human', message)
    }
  }

  // ─── Flow ─────────────────────────────────────────────────────────────

  private async drive(): Promise<void> {
    // 1. Email
    const emailProbe = await this.waitForKind(
      ['email', 'code', 'email-sent', 'consent'],
      EMAIL_FORM_TIMEOUT_MS,
      {
        stage: 'entering-email'
      }
    )
    let sinceMs = Date.now() - SINCE_SKEW_MS
    if (emailProbe.kind === 'email') {
      sinceMs = await this.submitEmail()
    }

    // 2. Code (unless the account was somehow already past it)
    if (emailProbe.kind !== 'consent') {
      await this.handleCodeStep(sinceMs)
    }

    // 3. Consent
    await this.handleConsent()

    // 4. Redirect
    this.stage('redirecting')
    await this.waitForRedirect()
  }

  private async submitEmail(): Promise<number> {
    this.stage('entering-email')
    await this.typeInto(EMAIL_INPUT_SELECTORS, this.input.email)
    // claude.ai probes the address (login_methods) as you type; for an
    // SSO-enforced domain the primary button turns into "Continue with SSO".
    await sleep(SSO_PROBE_SETTLE_MS)
    const check = await this.probe()
    if (check?.kind === 'email' && check.sso) {
      throw new Error('This account signs in with SSO — complete the sign-in in the Chrome window')
    }
    const typed = await this.evaluate<string | null>(readValueExpression(EMAIL_INPUT_SELECTORS))
    if ((typed ?? '').trim().toLowerCase() !== this.input.email.trim().toLowerCase()) {
      // Typing did not take (focus stolen?) — one more try before giving up.
      await this.typeInto(EMAIL_INPUT_SELECTORS, this.input.email)
    }
    const sinceMs = Date.now() - SINCE_SKEW_MS
    await this.clickSubmit(/continue with email|^continue$/i)

    const after = await this.waitForKind(
      ['email-sent', 'code', 'consent', 'mfa'],
      EMAIL_SUBMIT_TIMEOUT_MS,
      {
        onStuck: (probe) => {
          if (probe.kind === 'email' && probe.error)
            return `claude.ai rejected the email: ${probe.error}`
          return null
        }
      }
    )
    if (after.kind === 'email-sent') {
      // The screen auto-advances to the code field after 5 s; the link skips the wait.
      await this.click({
        selectors: ENTER_CODE_LINK_SELECTORS,
        textPattern: /enter verification code/i
      })
    }
    return sinceMs
  }

  private async handleCodeStep(initialSinceMs: number): Promise<void> {
    let sinceMs = initialSinceMs
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
      // Ask the code server as soon as the email is out: the code may land
      // before the code field is even on screen, and that is fine — it is held.
      this.stage('waiting-for-code')
      const codePromise = waitForSignInCode({
        baseUrl: this.input.settings.codeServerUrl,
        apiToken: this.input.settings.apiToken || undefined,
        email: this.input.email,
        sinceMs,
        budgetMs: this.input.settings.codeTimeoutSeconds * 1000,
        signal: this.abort.signal
      })
      // Don't let an early code-server rejection surface as an unhandled rejection
      // while we are still waiting for the code field.
      codePromise.catch(() => {})

      const field = await this.waitForKind(['code', 'consent', 'mfa'], CODE_SUBMIT_TIMEOUT_MS)
      if (field.kind !== 'code') return // already past it
      this.stage('waiting-for-code')

      const result: CodeWaitResult = await codePromise
      if (result.kind === 'timeout') {
        throw new Error(
          `No sign-in code arrived within ${this.input.settings.codeTimeoutSeconds}s — enter it in the Chrome window`
        )
      }
      if (result.kind === 'failed') {
        throw new Error(`The code server could not resolve the code: ${result.reason}`)
      }

      this.stage('entering-code')
      await this.typeInto(CODE_INPUT_SELECTORS, result.code)
      await this.clickSubmit(/verify|^continue$|^submit$/i)

      const outcome = await this.waitForKind(
        ['consent', 'org-picker', 'mfa'],
        CODE_SUBMIT_TIMEOUT_MS,
        {
          onStuck: (probe) => (probe.kind === 'code' && probe.error ? probe.error : null),
          // A rejected code shows an error on the same page: surface it as a value, not a throw.
          rejectOnError: false
        }
      )
      if (outcome.kind !== 'code') return

      const error = outcome.error ?? ''
      const retryable = /incorrect code|already used|expired/i.test(error)
      if (!retryable || attempt === MAX_CODE_ATTEMPTS) {
        throw new Error(
          error ? `claude.ai rejected the code: ${error}` : 'The code was not accepted'
        )
      }
      log.info('Code rejected — waiting for a newer one', { loginId: this.input.loginId, error })
      // Only a code from a *later* email can be different.
      sinceMs = Math.max(sinceMs, Date.parse(result.receivedAt) + 1 || sinceMs)
    }
  }

  private async handleConsent(): Promise<void> {
    this.stage('authorizing')
    const deadline = Date.now() + CONSENT_TIMEOUT_MS
    for (;;) {
      const probe = await this.waitForKind(['consent'], Math.max(1_000, deadline - Date.now()))
      if (probe.kind === 'consent' && probe.enabled) break
      if (probe.detail === 'window too small') {
        throw new Error(
          'claude.ai needs a larger window to show Authorize — resize the Chrome window'
        )
      }
      if (Date.now() >= deadline) throw new Error('The Authorize button never became available')
      await sleep(PROBE_INTERVAL_MS)
    }
    await this.click({ textPattern: /^authorize$/i })
  }

  private async waitForRedirect(): Promise<void> {
    const deadline = Date.now() + REDIRECT_TIMEOUT_MS
    while (Date.now() < deadline) {
      this.throwIfStopped()
      if (this.sawCallback || this.input.isResolved()) return
      await sleep(PROBE_INTERVAL_MS)
    }
    // Authorize was clicked but nothing came back: maybe an org picker appeared,
    // maybe the click did not register. Report and leave it to the user.
    const probe = await this.probe()
    throw new Error(
      probe?.kind === 'org-picker'
        ? 'Choose the organisation to connect in the Chrome window'
        : 'claude.ai did not redirect back after Authorize — finish in the Chrome window'
    )
  }

  // ─── Waiting on the page ──────────────────────────────────────────────

  /**
   * Probe until the page is one of `kinds`. Pages that need a human
   * (challenge, MFA, org picker, SSO hop, blocked, unknown for too long) switch
   * the stage to `needs-human` but keep watching for a long time — the user may
   * clear the obstacle — and `onStuck` lets a step turn a same-kind probe with
   * an error into a failure message.
   */
  private async waitForKind(
    kinds: PageProbe['kind'][],
    timeoutMs: number,
    options: {
      stage?: LoginStage
      onStuck?: (probe: PageProbe) => string | null
      rejectOnError?: boolean
    } = {}
  ): Promise<PageProbe> {
    const start = Date.now()
    let deadline = start + timeoutMs
    let needsHuman = false
    let lastProbe: PageProbe | null = null
    let unknownSince: number | null = null

    for (;;) {
      this.throwIfStopped()
      const probe = await this.probe()
      if (probe) {
        lastProbe = probe
        if (kinds.includes(probe.kind)) {
          if (needsHuman && options.stage) this.stage(options.stage)
          return probe
        }
        // Rejected code / email errors come back on the same page kind.
        if (probe.error && options.onStuck) {
          const message = options.onStuck(probe)
          if (message) {
            if (options.rejectOnError === false) return probe
            throw new Error(message)
          }
        }
        const humanReason = this.humanReasonFor(probe, start, unknownSince)
        if (probe.kind === 'unknown') unknownSince ??= Date.now()
        else unknownSince = null
        if (humanReason && !needsHuman) {
          needsHuman = true
          this.stage('needs-human', humanReason)
          // Watch patiently: the user may be solving it right now.
          deadline = Date.now() + NEEDS_HUMAN_WATCH_MS
        }
      }
      if (Date.now() >= deadline) {
        if (needsHuman) throw new StopDriving('cancelled')
        const where = lastProbe ? `${lastProbe.kind} page` : 'no page'
        throw new Error(`Timed out waiting for ${kinds.join('/')} (saw ${where})`)
      }
      await sleep(PROBE_INTERVAL_MS)
    }
  }

  private humanReasonFor(
    probe: PageProbe,
    start: number,
    unknownSince: number | null
  ): string | null {
    switch (probe.kind) {
      case 'challenge':
        return `${probe.detail ?? 'A verification'} is required — complete it in the Chrome window`
      case 'mfa':
        return 'SMS verification code required — enter it in the Chrome window'
      case 'org-picker':
        return 'Choose the organisation to connect in the Chrome window'
      case 'blocked':
        return probe.detail ?? 'claude.ai blocked the sign-in'
      case 'unknown': {
        // A real http(s) page that is neither Anthropic nor our callback is an
        // SSO/IdP hop; `about:blank` before the first navigation is just loading.
        if (
          isWebUrl(probe.url) &&
          !isClaudeUrl(probe.url) &&
          !isCallbackUrl(probe.url, this.input.redirectUri)
        ) {
          return 'The sign-in left claude.ai (SSO?) — complete it in the Chrome window'
        }
        // Blank/loading pages are "unknown" too; only call it after a while.
        const unknownFor = Date.now() - (unknownSince ?? Date.now())
        return unknownFor > 15_000 && Date.now() - start > 15_000
          ? 'Could not recognise the page — complete the sign-in in the Chrome window'
          : null
      }
      default:
        return null
    }
  }

  // ─── Page interaction ─────────────────────────────────────────────────

  private async probe(): Promise<PageProbe | null> {
    const result = await this.evaluate<PageProbe | null>(PAGE_PROBE_EXPRESSION)
    return result && typeof result === 'object' && 'kind' in result ? result : null
  }

  private async typeInto(selectors: string[], text: string): Promise<void> {
    const point = await this.evaluate<Point | null>(focusExpression(selectors))
    if (!point) throw new Error('The input field disappeared before it could be filled')
    // A trusted click first: focus() alone sometimes leaves React's field inactive.
    await this.clickAt(point)
    await this.evaluate(focusExpression(selectors))
    await this.sendSession('Input.insertText', { text })
  }

  private async clickSubmit(textPattern: RegExp): Promise<void> {
    const located = await this.evaluate<(Point & { disabled: boolean }) | null>(
      locateClickableExpression({ selectors: SUBMIT_BUTTON_SELECTORS, textPattern })
    )
    if (located && !located.disabled) {
      await this.clickAt(located)
      return
    }
    // No button we trust — Enter submits the form just as well.
    await this.pressEnter()
  }

  private async click(options: { selectors?: string[]; textPattern?: RegExp }): Promise<void> {
    const located = await this.evaluate<(Point & { disabled: boolean }) | null>(
      locateClickableExpression(options)
    )
    if (!located) throw new Error('The expected button is not on the page')
    if (located.disabled) throw new Error('The expected button is disabled')
    await this.clickAt(located)
  }

  private async clickAt(point: Point): Promise<void> {
    const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
    await this.sendSession('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y
    })
    await this.sendSession('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
    await this.sendSession('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
  }

  private async pressEnter(): Promise<void> {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await this.sendSession('Input.dispatchKeyEvent', { ...key, type: 'keyDown', text: '\r' })
    await this.sendSession('Input.dispatchKeyEvent', { ...key, type: 'keyUp' })
  }

  /** `Runtime.evaluate` bounded in time; null when the page is mid-navigation or the call failed. */
  private async evaluate<T>(expression: string): Promise<T | null> {
    this.throwIfStopped()
    try {
      const result = await Promise.race([
        this.sendSession<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true }
        ),
        sleep(EVALUATE_TIMEOUT_MS).then(() => null)
      ])
      if (!result || result.exceptionDetails) return null
      return (result.result?.value as T | undefined) ?? null
    } catch (error) {
      if (error instanceof StopDriving) throw error
      return null
    }
  }

  private sendSession<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    if (!this.sessionId) return Promise.reject(new Error('not attached'))
    return this.cdp.send<T>(method, params, this.sessionId)
  }

  // ─── Events ───────────────────────────────────────────────────────────

  private onCdpEvent(event: {
    method: string
    params: Record<string, unknown>
    sessionId?: string
  }): void {
    if (event.method === 'Page.frameNavigated' && event.sessionId === this.sessionId) {
      const frame = event.params.frame as { url?: string; parentId?: string } | undefined
      if (
        frame &&
        !frame.parentId &&
        frame.url &&
        isCallbackUrl(frame.url, this.input.redirectUri)
      ) {
        this.sawCallback = true
      }
      return
    }
    if (event.method === 'Target.targetDestroyed') {
      if ((event.params.targetId as string | undefined) === this.targetId) this.handleBrowserGone()
    }
  }

  private handleBrowserGone(): void {
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    this.cdp.close()
    if (!this.sawCallback && !this.input.isResolved()) {
      log.info('Sign-in browser closed before the redirect — cancelling', {
        loginId: this.input.loginId
      })
      this.input.onBrowserClosed()
    }
  }

  private stage(stage: LoginStage, detail?: string | null): void {
    log.info('Auto sign-in stage', {
      loginId: this.input.loginId,
      stage,
      detail: detail ?? undefined
    })
    this.input.onStage(stage, detail ?? null)
  }

  private throwIfStopped(): void {
    if (this.closed)
      throw new StopDriving(this.abort.signal.aborted ? 'cancelled' : 'browser-closed')
    if (this.sawCallback || this.input.isResolved()) throw new StopDriving('resolved')
  }
}
