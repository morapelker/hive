// @vitest-environment node
import { PassThrough } from 'stream'
import { describe, expect, it, vi } from 'vitest'
import { CdpPipeClient } from '../cdp-pipe-client'

/** Two pipes standing in for Chrome's fd 3 (we write) and fd 4 (Chrome writes). */
function harness(): {
  client: CdpPipeClient
  sent: () => Array<Record<string, unknown>>
  reply: (message: Record<string, unknown>) => void
  fromChrome: PassThrough
} {
  const toChrome = new PassThrough()
  const fromChrome = new PassThrough()
  let raw = ''
  toChrome.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8')
  })
  const client = new CdpPipeClient(toChrome, fromChrome)
  return {
    client,
    fromChrome,
    sent: () =>
      raw
        .split('\0')
        .filter(Boolean)
        .map((frame) => JSON.parse(frame) as Record<string, unknown>),
    reply: (message) => {
      fromChrome.write(JSON.stringify(message) + '\0')
    }
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('CdpPipeClient', () => {
  it('frames requests with NUL and correlates replies by id, routing sessionId through', async () => {
    const h = harness()
    const browserCall = h.client.send('Target.getTargets')
    const pageCall = h.client.send('Runtime.evaluate', { expression: '1+1' }, 'session-1')
    await tick()

    expect(h.sent()).toEqual([
      { id: 1, method: 'Target.getTargets', params: {} },
      { id: 2, method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: 'session-1' }
    ])

    h.reply({ id: 2, sessionId: 'session-1', result: { result: { value: 2 } } })
    h.reply({ id: 1, result: { targetInfos: [] } })

    expect(await pageCall).toEqual({ result: { value: 2 } })
    expect(await browserCall).toEqual({ targetInfos: [] })
  })

  it('reassembles frames split across chunks and ignores torn JSON', async () => {
    const h = harness()
    const call = h.client.send('Page.enable')
    await tick()

    const frame = JSON.stringify({ id: 1, result: { ok: true } }) + '\0'
    h.fromChrome.write('garbage\0')
    h.fromChrome.write(frame.slice(0, 7))
    h.fromChrome.write(frame.slice(7))

    expect(await call).toEqual({ ok: true })
  })

  it('rejects a call Chrome answers with an error and delivers events to listeners', async () => {
    const h = harness()
    const events = vi.fn()
    h.client.onEvent(events)
    const call = h.client.send('Input.insertText', { text: 'x' }, 's')
    await tick()

    h.reply({
      method: 'Page.frameNavigated',
      params: { frame: { url: 'https://claude.ai/' } },
      sessionId: 's'
    })
    h.reply({ id: 1, error: { code: -32000, message: 'Not attached' } })

    await expect(call).rejects.toThrow('Input.insertText: Not attached')
    expect(events).toHaveBeenCalledWith({
      method: 'Page.frameNavigated',
      params: { frame: { url: 'https://claude.ai/' } },
      sessionId: 's'
    })
  })

  it('fails pending calls and reports once when the pipe closes', async () => {
    const h = harness()
    const onClose = vi.fn()
    h.client.onClose(onClose)
    const call = h.client.send('Browser.getVersion')
    // Attach the expectation before the close lands, or the rejection is briefly unhandled.
    const rejected = expect(call).rejects.toThrow('CDP pipe closed')
    await tick()

    h.fromChrome.end()
    await tick()

    await rejected
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(h.client.isClosed).toBe(true)
    await expect(h.client.send('Browser.getVersion')).rejects.toThrow('CDP pipe closed')
  })
})
