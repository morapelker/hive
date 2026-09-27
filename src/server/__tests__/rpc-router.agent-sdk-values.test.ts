import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { AGENT_SDK_VALUES } from '@shared/types/agent-sdk'
import { makeEventBus } from '../events/event-bus'
import { makeRpcRouter } from '../rpc/router'

/**
 * The db / opencode RPC validators used to spell out the agent-SDK list by
 * hand, so a new SDK (codex-cli) was accepted by the renderer and the DB but
 * rejected at the RPC boundary with VALIDATION_FAILED — the session never got
 * created. Both schemas now derive from AGENT_SDK_VALUES; this pins that every
 * SDK in the shared list round-trips through `db.session.create`.
 */
describe('RPC agent_sdk validation follows AGENT_SDK_VALUES', () => {
  it('accepts every shared SDK id on db.session.create', async () => {
    const created: string[] = []
    const dbStub = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'createSession') {
            return (data: { agent_sdk?: string }) => {
              created.push(data.agent_sdk ?? 'missing')
              return Effect.succeed({ id: `s-${data.agent_sdk}`, ...data })
            }
          }
          return () => Effect.succeed(null)
        }
      }
    )
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      db: dbStub as unknown as Parameters<typeof makeRpcRouter>[0]['db']
    })

    for (const sdk of AGENT_SDK_VALUES) {
      const response = await Effect.runPromise(
        router.handle({
          id: `create-${sdk}`,
          method: 'db.session.create',
          params: { worktree_id: 'wt-1', project_id: 'p-1', agent_sdk: sdk }
        })
      )
      expect(response, sdk).toMatchObject({ id: `create-${sdk}`, ok: true })
    }
    expect(created).toEqual([...AGENT_SDK_VALUES])

    const rejected = await Effect.runPromise(
      router.handle({
        id: 'create-bogus',
        method: 'db.session.create',
        params: { worktree_id: 'wt-1', project_id: 'p-1', agent_sdk: 'not-an-sdk' }
      })
    )
    expect(rejected).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })
})
