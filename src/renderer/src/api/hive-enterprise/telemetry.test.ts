import { describe, expect, it } from 'vitest'
import { isHiveTelemetryEnabled } from './client'
import { resolveHiveTelemetryWorktreeId } from '@/lib/hive-enterprise-telemetry'
import { useSessionStore } from '@/stores/useSessionStore'

describe('Hive Enterprise telemetry gate', () => {
  it('requires both an auth token and organization id', () => {
    expect(isHiveTelemetryEnabled({ hiveAuthToken: 'jwt', hiveOrganizationId: 'org_1' })).toBe(true)
    expect(isHiveTelemetryEnabled({ hiveAuthToken: 'jwt', hiveOrganizationId: null })).toBe(false)
    expect(isHiveTelemetryEnabled({ hiveAuthToken: '', hiveOrganizationId: 'org_1' })).toBe(false)
  })

  it('falls back to the session worktree when queued follow-up dispatch has no prop worktree id', () => {
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        [
          'wt_1',
          [
            {
              id: 'session_1',
              worktree_id: 'wt_1',
              project_id: 'project_1',
              connection_id: null,
              name: 'Session 1',
              status: 'active',
              opencode_session_id: 'opencode_1',
              claude_session_id: null,
              agent_sdk: 'opencode',
              mode: 'build',
              session_type: 'default',
              model_provider_id: null,
              model_id: null,
              model_variant: null,
              created_at: '2026-06-06T00:00:00.000Z',
              updated_at: '2026-06-06T00:00:00.000Z',
              completed_at: null
            }
          ]
        ]
      ]),
      sessionsByConnection: new Map()
    })

    expect(resolveHiveTelemetryWorktreeId('session_1', null)).toBe('wt_1')
    expect(resolveHiveTelemetryWorktreeId('session_1', 'explicit_wt')).toBe('explicit_wt')
  })
})
