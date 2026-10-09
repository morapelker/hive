// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  CODE_INPUT_SELECTORS,
  EMAIL_INPUT_SELECTORS,
  PAGE_PROBE_EXPRESSION,
  focusExpression,
  isCallbackUrl,
  isClaudeUrl,
  isWebUrl,
  locateClickableExpression,
  readValueExpression,
  type PageProbe
} from '../page-scripts'

/**
 * The probe runs inside claude.ai's page via Runtime.evaluate; here it runs
 * against jsdom fixtures of the pages observed on 2026-10-09. jsdom has no
 * layout, so the fixtures stub `getClientRects` the way the probe's visibility
 * check reads it.
 */
function renderPage(html: string, title = 'Sign in - Claude'): void {
  document.title = title
  document.body.innerHTML = html
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
    const hidden = el.hasAttribute('data-hidden')
    el.getClientRects = (() => (hidden ? [] : [{ width: 100, height: 20 }])) as never
    el.getBoundingClientRect = (() => ({
      left: 10,
      top: 20,
      width: hidden ? 0 : 100,
      height: hidden ? 0 : 20
    })) as never
    el.scrollIntoView = (() => {}) as never
  }
}

const probe = (): PageProbe => eval(PAGE_PROBE_EXPRESSION) as PageProbe

describe('PAGE_PROBE_EXPRESSION', () => {
  it('recognises the email form and whether SSO took over the primary button', () => {
    renderPage(`
      <button data-testid="login-with-google" type="button">Continue with Google</button>
      <form><input id="email" data-testid="email" type="email" />
      <button data-testid="continue" type="submit">Continue with email</button></form>`)
    expect(probe()).toMatchObject({ kind: 'email', sso: false })

    renderPage(`
      <form><input id="email" data-testid="email" type="email" />
      <button data-testid="continue" type="submit">Continue with SSO</button></form>`)
    expect(probe()).toMatchObject({ kind: 'email', sso: true })
  })

  it('recognises the email-sent screen, the code form and a code error', () => {
    renderPage(
      `<p>To continue, click the link sent to a@b.com</p><a data-testid="enter-code">Enter verification code</a>`
    )
    expect(probe().kind).toBe('email-sent')

    renderPage(`<input id="code" data-testid="code" type="text" autocomplete="one-time-code" />
      <button data-testid="continue" type="submit">Verify email address</button>`)
    expect(probe()).toMatchObject({ kind: 'code' })
    expect(probe().error).toBeUndefined()

    renderPage(`<input id="code" data-testid="code" type="text" />
      <p id="code-error">Incorrect code entered. Check that the code matches.</p>`)
    expect(probe()).toMatchObject({
      kind: 'code',
      error: expect.stringContaining('Incorrect code')
    })
  })

  it('recognises the consent page and whether Authorize is armed', () => {
    renderPage(`<h1>Claude Code would like to connect to your Claude account</h1>
      <button disabled>Authorize</button><button>Decline</button>`)
    expect(probe()).toMatchObject({ kind: 'consent', enabled: false })

    renderPage(`<button>Authorize</button><button>Decline</button>`)
    expect(probe()).toMatchObject({ kind: 'consent', enabled: true })
  })

  it('flags pages that need a human: challenge, MFA, organisation picker', () => {
    renderPage(`<p>Performing security verification</p>`, 'Just a moment...')
    expect(probe()).toMatchObject({ kind: 'challenge' })

    renderPage(`<input data-testid="mfa-code" />`)
    expect(probe()).toMatchObject({ kind: 'mfa' })

    renderPage(`<h2>Select which organization you would like to connect</h2><button>Acme</button>`)
    expect(probe()).toMatchObject({ kind: 'org-picker' })
  })

  it('ignores invisible elements and reports visible button labels for unknown pages', () => {
    renderPage(`<input data-testid="email" data-hidden /><button>Something else</button>`)
    expect(probe()).toMatchObject({ kind: 'unknown', buttons: ['Something else'] })
  })
})

describe('interaction expressions', () => {
  it('focuses, selects and locates the first visible matching input', () => {
    renderPage(`<input id="email" data-testid="email" type="email" value="old" />`)
    const point = eval(focusExpression(EMAIL_INPUT_SELECTORS)) as { x: number; y: number } | null
    expect(point).toEqual({ x: 60, y: 30 })
    expect(document.activeElement?.id).toBe('email')
    expect(eval(readValueExpression(EMAIL_INPUT_SELECTORS))).toBe('old')
    expect(eval(readValueExpression(CODE_INPUT_SELECTORS))).toBeNull()
  })

  it('locates clickable elements by selector or text but never social buttons', () => {
    renderPage(`<button type="button">Continue with Google</button>
      <button type="submit" disabled>Continue with email</button>`)
    const located = eval(
      locateClickableExpression({ selectors: ['button[type="submit"]'], textPattern: /continue/i })
    ) as { disabled: boolean } | null
    expect(located).toMatchObject({ disabled: true })

    renderPage(`<button type="button">Continue with Google</button>`)
    expect(eval(locateClickableExpression({ textPattern: /continue/i }))).toBeNull()
  })
})

describe('URL helpers', () => {
  it('matches the loopback callback on either loopback host, by port and path', () => {
    const redirectUri = 'http://localhost:54545/callback'
    expect(isCallbackUrl('http://localhost:54545/callback?code=x&state=y', redirectUri)).toBe(true)
    expect(isCallbackUrl('http://127.0.0.1:54545/callback?code=x', redirectUri)).toBe(true)
    expect(isCallbackUrl('http://localhost:54546/callback', redirectUri)).toBe(false)
    expect(isCallbackUrl('http://localhost:54545/other', redirectUri)).toBe(false)
    expect(isCallbackUrl('https://claude.ai/oauth/authorize', redirectUri)).toBe(false)
    expect(isCallbackUrl('not a url', redirectUri)).toBe(false)
  })

  it('knows which hosts are still Anthropic', () => {
    expect(isClaudeUrl('https://claude.ai/login?x=1')).toBe(true)
    expect(isClaudeUrl('https://console.anthropic.com/oauth')).toBe(true)
    expect(isClaudeUrl('https://login.okta.com/sso')).toBe(false)
  })
})

describe('isWebUrl', () => {
  it('treats only http(s) pages as navigated — about:blank is still loading', () => {
    expect(isWebUrl('https://claude.ai/login')).toBe(true)
    expect(isWebUrl('http://localhost:54545/callback')).toBe(true)
    expect(isWebUrl('about:blank')).toBe(false)
    expect(isWebUrl('chrome://new-tab-page/')).toBe(false)
    expect(isWebUrl('')).toBe(false)
  })
})
