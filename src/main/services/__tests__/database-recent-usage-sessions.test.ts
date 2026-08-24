import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { DatabaseService } from '../../db/database'

describe('listRecentUsageSessionIds', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const createService = (): DatabaseService => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-recent-usage-sessions-'))
    tempDirs.push(dir)
    const service = new DatabaseService(join(dir, 'hive.db'))
    service.init()
    return service
  }

  function insertSession(
    service: DatabaseService,
    overrides: { status: string; agentSdk: string; updatedAt: string }
  ): string {
    const db = service.getRawDb()
    const id = randomUUID()
    const created = '2026-08-01T00:00:00.000Z'
    db.prepare(
      `INSERT INTO sessions (
         id, worktree_id, project_id, connection_id, name, status,
         opencode_session_id, claude_session_id, agent_sdk, custom_provider_id,
         mode, session_type, model_provider_id, model_id, model_variant,
         remote_launch, created_at, updated_at, completed_at, pinned_to_board
       ) VALUES (?, NULL, ?, NULL, 'test', ?, NULL, NULL, ?, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, 0)`
    ).run(id, randomUUID(), overrides.status, overrides.agentSdk, created, overrides.updatedAt)
    return id
  }

  it('keeps active sessions eligible even when their row has not been touched recently', () => {
    const service = createService()
    const staleIso = '2026-08-20T00:00:00.000Z'
    const freshIso = new Date().toISOString()
    const since = new Date(Date.now() - 6 * 3_600_000).toISOString()

    // A long-running CLI session can burn for hours with no DB mutation —
    // active status must keep it in the tally regardless of updated_at.
    const activeStale = insertSession(service, {
      status: 'active',
      agentSdk: 'claude-code-cli',
      updatedAt: staleIso
    })
    const recentDone = insertSession(service, {
      status: 'done',
      agentSdk: 'claude-code',
      updatedAt: freshIso
    })
    const staleDone = insertSession(service, {
      status: 'done',
      agentSdk: 'claude-code-cli',
      updatedAt: staleIso
    })
    const activeWrongSdk = insertSession(service, {
      status: 'active',
      agentSdk: 'opencode',
      updatedAt: freshIso
    })

    const ids = service.listRecentUsageSessionIds(since)
    expect(ids).toContain(activeStale)
    expect(ids).toContain(recentDone)
    expect(ids).not.toContain(staleDone)
    expect(ids).not.toContain(activeWrongSdk)
    // Active sessions sort first so a downstream cap (the burn-rate tally
    // keeps at most 40) can never evict a still-burning session in favor of
    // more recently touched finished ones.
    expect(ids.indexOf(activeStale)).toBeLessThan(ids.indexOf(recentDone))
  })
})
