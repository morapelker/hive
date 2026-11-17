/**
 * Which sessions have a `bash.run` command running in this process (`runningBashSessionIds`),
 * asked the way the server's router starts and stops such a command: through the handlers,
 * with the event bus of the router. The commands are real ones.
 */
import { tmpdir } from 'node:os'

import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import type { BashStreamEvent } from '../../../../main/effect/bash/types'
import { BASH_STREAM_CHANNEL } from '../../../../shared/bash-events'
import { makeEventBus, type EventBus } from '../../../events/event-bus'
import { makeBashRpcHandlers, runningBashSessionIds } from '../bash'

describe.skipIf(process.platform === 'win32')('runningBashSessionIds', () => {
  const started: { readonly eventBus: EventBus; readonly sessionId: string }[] = []

  const call = (eventBus: EventBus, method: string, params: unknown): Promise<unknown> => {
    const handler = makeBashRpcHandlers(undefined, eventBus).get(method)
    if (handler === undefined) throw new Error(`no handler for ${method}`)
    return Effect.runPromise(handler(params, { eventBus }))
  }

  /** Start a command as `!command` in a session does; resolves once it is running. */
  const run = async (
    eventBus: EventBus,
    sessionId: string,
    command: string
  ): Promise<{ readonly ended: Promise<void> }> => {
    // Listening before the command starts: a short one is over before `bash.run` answers.
    const ended = new Promise<void>((resolve) => {
      Effect.runSync(
        eventBus.subscribe(BASH_STREAM_CHANNEL, (event) => {
          const payload = event.payload as BashStreamEvent
          if (payload.type === 'end' && payload.sessionId === sessionId) resolve()
        })
      )
    })
    started.push({ eventBus, sessionId })
    await call(eventBus, 'bash.run', { sessionId, command, cwd: tmpdir() })
    return { ended }
  }

  const stop = (eventBus: EventBus, sessionId: string): Promise<unknown> =>
    call(eventBus, 'bash.abort', { sessionId })

  afterEach(async () => {
    // Nothing is left running when an expectation fails half way.
    for (const { eventBus, sessionId } of started.splice(0)) {
      await stop(eventBus, sessionId).catch(() => undefined)
    }
  })

  it('lists nothing while no command was started', async () => {
    expect(await runningBashSessionIds()).toEqual([])
  })

  it('lists the session of a running command, on whichever event bus it was started, until it is stopped', async () => {
    const first = makeEventBus()
    const second = makeEventBus()
    const one = await run(first, 'bash-test-one', 'sleep 30')
    const two = await run(second, 'bash-test-two', 'sleep 30')

    expect((await runningBashSessionIds()).sort()).toEqual(['bash-test-one', 'bash-test-two'])

    expect(await stop(first, 'bash-test-one')).toBe(true)
    await one.ended
    expect(await runningBashSessionIds()).toEqual(['bash-test-two'])

    expect(await stop(second, 'bash-test-two')).toBe(true)
    await two.ended
    expect(await runningBashSessionIds()).toEqual([])
  }, 20_000)

  it('no longer lists a command that has ended by itself', async () => {
    const eventBus = makeEventBus()
    const { ended } = await run(eventBus, 'bash-test-short', 'exit 0')

    await ended
    expect(await runningBashSessionIds()).toEqual([])
    expect(await call(eventBus, 'bash.getRun', { sessionId: 'bash-test-short' })).toMatchObject({
      status: 'exited'
    })
  }, 20_000)
})
