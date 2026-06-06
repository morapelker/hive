import { describe, expect, it } from 'vitest'
import { buildHivePromptMetadata } from './hive-enterprise-telemetry'

describe('Hive Enterprise prompt metadata', () => {
  it('captures provider, model, mode, goal, handoff, timestamp, and connection projects', () => {
    const metadata = buildHivePromptMetadata({
      prompt: '/goal Implement the ticket',
      session: {
        agent_sdk: 'codex',
        mode: 'super-plan',
        model_provider_id: 'openai',
        model_id: 'gpt-5.4-codex',
        model_variant: 'high'
      },
      requestModel: {
        providerID: 'openai',
        modelID: 'gpt-5.4-codex',
        variant: 'high'
      },
      handoffSessionId: 'parent-session',
      connectionProjects: [
        { name: 'hive-electron', path: '/workspace/hive-electron' },
        { name: 'hive-enterprise', path: '/workspace/hive-enterprise' }
      ],
      now: new Date('2026-06-06T09:34:56.789Z')
    })

    expect(metadata).toEqual({
      providerId: 'codex',
      modelProviderId: 'openai',
      modelId: 'gpt-5.4-codex',
      modelVariant: 'high',
      mode: 'super-plan',
      isGoalPrompt: true,
      handoffSessionId: 'parent-session',
      loggedAt: '2026-06-06T09:34:56.789Z',
      connectionProjects: JSON.stringify([
        { name: 'hive-electron', path: '/workspace/hive-electron' },
        { name: 'hive-enterprise', path: '/workspace/hive-enterprise' }
      ])
    })
  })
})
