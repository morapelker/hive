import { describe, expect, it, vi } from 'vitest'

import { DatabaseService } from '../../db/database'

describe('DatabaseService session activities', () => {
  it('deleteSessionActivities deletes rows by target session id and returns changed count', () => {
    const run = vi.fn().mockReturnValue({ changes: 2 })
    const prepare = vi.fn().mockReturnValue({ run })
    const service = Object.create(DatabaseService.prototype) as unknown as {
      deleteSessionActivities: (sessionId: string) => number
      db: { prepare: typeof prepare }
    }
    service.db = { prepare }

    const deleted = service.deleteSessionActivities('session-target')

    expect(prepare).toHaveBeenCalledWith('DELETE FROM session_activities WHERE session_id = ?')
    expect(run).toHaveBeenCalledWith('session-target')
    expect(deleted).toBe(2)
  })
})
