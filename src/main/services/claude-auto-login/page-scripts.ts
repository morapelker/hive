/**
 * What the driver knows about claude.ai's sign-in pages, kept in one place
 * because it is the part that drifts: selectors, button texts and the page
 * probe that classifies what is currently on screen.
 *
 * Observed on 2026-10-09 (claude.ai login bundle build 1791508235):
 *   - email form:  input#email[data-testid=email], button[data-testid=continue]
 *                  "Continue with email" (always enabled), social buttons
 *                  data-testid login-with-google / login-with-apple (never clicked)
 *   - after submit: an "email sent" screen with a[data-testid=enter-code]
 *                  "Enter verification code" that auto-advances after 5 s
 *   - code form:   a single input#code[data-testid=code][autocomplete=one-time-code],
 *                  button[data-testid=continue] "Verify email address"; errors in #code-error
 *   - MFA:         input[data-testid=mfa-code] (SMS second factor — not automatable)
 *   - consent:     /oauth/authorize with buttons "Authorize" (no testid, armed ~700 ms
 *                  after load, disabled in a small window) and "Decline"
 *   - challenges:  Cloudflare interstitial ("Just a moment…") or a visible hCaptcha
 * Fallback selectors from the previous (ccswitch) sidecar are kept behind the
 * testids so a renamed attribute degrades gracefully.
 */

export const EMAIL_INPUT_SELECTORS = [
  '[data-testid="email"]',
  'input#email',
  'input[type="email"]',
  'input[autocomplete="email"]',
  'input[name="email"]'
]

export const CODE_INPUT_SELECTORS = [
  '[data-testid="code"]',
  'input#code',
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]:not([maxlength="1"])',
  'input[name*="code" i]',
  'input[name*="otp" i]'
]

export const SUBMIT_BUTTON_SELECTORS = ['[data-testid="continue"]', 'button[type="submit"]']
export const ENTER_CODE_LINK_SELECTORS = ['[data-testid="enter-code"]']
export const MFA_INPUT_SELECTORS = ['[data-testid="mfa-code"]']

/** Social/SSO buttons sit next to the email form — never click those. */
export const SOCIAL_BUTTON_PATTERN = /google|apple|microsoft|sso|saml|okta|passkey|phone/i

/** The kinds of page the probe can report. */
export type PageKind =
  | 'email'
  | 'email-sent'
  | 'code'
  | 'mfa'
  | 'consent'
  | 'org-picker'
  | 'challenge'
  | 'blocked'
  | 'unknown'

export interface PageProbe {
  kind: PageKind
  url: string
  title: string
  /** Visible error text next to the active form, if any. */
  error?: string
  /** A longer explanation for `challenge` / `blocked` / `unknown`. */
  detail?: string
  /** `email`: the primary submit became "Continue with SSO" (SSO-enforced domain). */
  sso?: boolean
  /** `consent`: whether the Authorize button is currently clickable. */
  enabled?: boolean
  /** `unknown`: visible button labels, for diagnostics. */
  buttons?: string[]
}

const asJsArray = (selectors: string[]): string => JSON.stringify(selectors)

/**
 * JS expression evaluated in the page (`Runtime.evaluate`, returnByValue). It
 * must be self-contained and never throw — a thrown probe would look like a
 * dead page to the driver.
 */
export const PAGE_PROBE_EXPRESSION = `(() => {
  try {
    const visible = (el) => {
      if (!el) return false
      const rects = el.getClientRects()
      if (!rects.length) return false
      const style = getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
    }
    const first = (selectors) => {
      for (const selector of selectors) {
        const el = Array.from(document.querySelectorAll(selector)).find(visible)
        if (el) return el
      }
      return null
    }
    const text = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim()
    const url = location.href
    const title = document.title || ''
    const body = text(document.body)

    if (/just a moment|attention required|performing security verification/i.test(title + ' ' + body.slice(0, 400)) ||
        Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]')).some(visible)) {
      return { kind: 'challenge', url, title, detail: 'Cloudflare verification' }
    }
    const hcaptcha = Array.from(document.querySelectorAll('iframe[src*="hcaptcha.com"]')).find((frame) => {
      const rect = frame.getBoundingClientRect()
      return rect.width > 60 && rect.height > 60 && visible(frame)
    })
    if (hcaptcha) return { kind: 'challenge', url, title, detail: 'hCaptcha verification' }

    if (first(${asJsArray(MFA_INPUT_SELECTORS)})) {
      return { kind: 'mfa', url, title, detail: 'SMS verification code required' }
    }
    const codeInput = first(${asJsArray(CODE_INPUT_SELECTORS)})
    if (codeInput) {
      const error = text(first(['#code-error', '[id$="-error"]', '[role="alert"]']))
      return error ? { kind: 'code', url, title, error } : { kind: 'code', url, title }
    }
    if (first(${asJsArray(ENTER_CODE_LINK_SELECTORS)})) return { kind: 'email-sent', url, title }

    const emailInput = first(${asJsArray(EMAIL_INPUT_SELECTORS)})
    if (emailInput) {
      const submit = first(${asJsArray(SUBMIT_BUTTON_SELECTORS)})
      const sso = !!submit && /sso/i.test(text(submit))
      const error = text(first(['#email-error', '[id$="-error"]', '[role="alert"]']))
      const result = { kind: 'email', url, title, sso }
      if (error) result.error = error
      return result
    }

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible)
    const authorize = buttons.find((b) => /^authorize$/i.test(text(b)))
    if (authorize) {
      return { kind: 'consent', url, title, enabled: !authorize.disabled && authorize.getAttribute('aria-disabled') !== 'true' }
    }
    if (/isn't available in a window this small|make the window larger/i.test(body)) {
      return { kind: 'consent', url, title, enabled: false, detail: 'window too small' }
    }
    if (/select (an |which )?organi[sz]ation|choose a workspace|select workspace|switch organi[sz]ation/i.test(body)) {
      return { kind: 'org-picker', url, title, detail: 'Choose the organisation to connect' }
    }
    if (/max or pro is required|unable to access claude code|account.*on hold/i.test(body)) {
      return { kind: 'blocked', url, title, detail: body.slice(0, 200) }
    }
    return { kind: 'unknown', url, title, buttons: buttons.map(text).filter(Boolean).slice(0, 12) }
  } catch (error) {
    return { kind: 'unknown', url: location.href, title: document.title || '', detail: String(error) }
  }
})()`

/**
 * JS expression: focus the first visible element matching one of `selectors`,
 * select its current contents (so a trusted `Input.insertText` replaces them)
 * and return its viewport centre, or null.
 */
export function focusExpression(selectors: string[]): string {
  return `(() => {
    const visible = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    for (const selector of ${asJsArray(selectors)}) {
      const el = Array.from(document.querySelectorAll(selector)).find(visible)
      if (!el) continue
      el.scrollIntoView({ block: 'center', inline: 'center' })
      el.focus()
      if (typeof el.select === 'function') el.select()
      const rect = el.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    return null
  })()`
}

/**
 * JS expression: locate a clickable element — by selector list, or by visible
 * text pattern (source of a RegExp) excluding social/SSO buttons — scroll it
 * into view and return its viewport centre plus whether it is enabled.
 */
export function locateClickableExpression(options: {
  selectors?: string[]
  textPattern?: RegExp
}): string {
  const selectors = asJsArray(options.selectors ?? [])
  const pattern = options.textPattern ? options.textPattern.source : null
  const flags = options.textPattern ? options.textPattern.flags : ''
  return `(() => {
    const visible = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    const text = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim()
    const exclude = ${SOCIAL_BUTTON_PATTERN.toString()}
    let el = null
    for (const selector of ${selectors}) {
      el = Array.from(document.querySelectorAll(selector)).find((candidate) => visible(candidate) && !exclude.test(text(candidate)))
      if (el) break
    }
    if (!el && ${pattern ? 'true' : 'false'}) {
      const re = new RegExp(${JSON.stringify(pattern ?? '')}, ${JSON.stringify(flags)})
      el = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"]'))
        .find((candidate) => visible(candidate) && re.test(text(candidate)) && !exclude.test(text(candidate)))
    }
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = el.getBoundingClientRect()
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true'
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, disabled }
  })()`
}

/** JS expression: the current value of the first visible input matching `selectors`. */
export function readValueExpression(selectors: string[]): string {
  return `(() => {
    const visible = (el) => el && el.getClientRects().length > 0
    for (const selector of ${asJsArray(selectors)}) {
      const el = Array.from(document.querySelectorAll(selector)).find(visible)
      if (el) return el.value
    }
    return null
  })()`
}

/**
 * Whether a navigation target is our loopback callback. Chrome may report
 * `localhost` or `127.0.0.1`; the port and path are what identify it.
 */
export function isCallbackUrl(candidate: string, redirectUri: string): boolean {
  try {
    const target = new URL(candidate)
    const expected = new URL(redirectUri)
    const loopback = (host: string): boolean =>
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
    return (
      loopback(target.hostname) &&
      loopback(expected.hostname) &&
      target.port === expected.port &&
      target.pathname === expected.pathname
    )
  } catch {
    return false
  }
}

/** Whether a URL still belongs to claude.ai (leaving it mid-login means an SSO/IdP hop). */
export function isClaudeUrl(candidate: string): boolean {
  try {
    const host = new URL(candidate).hostname
    return host === 'claude.ai' || host.endsWith('.claude.ai') || host.endsWith('.anthropic.com')
  } catch {
    return false
  }
}

/** A navigable http(s) page — as opposed to `about:blank` or a chrome:// page while loading. */
export function isWebUrl(candidate: string): boolean {
  try {
    const protocol = new URL(candidate).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
