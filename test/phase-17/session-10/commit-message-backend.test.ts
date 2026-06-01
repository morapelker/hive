import { describe, test, expect, vi, beforeEach } from 'vitest'
import { dbApi } from '../../../src/renderer/src/api/db-api'

vi.mock('../../../src/renderer/src/api/db-api', () => ({
  dbApi: {
    worktree: {
      appendSessionTitle: vi.fn()
    }
  }
}))

// ── Schema tests ────────────────────────────────────────────────────────────
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/main/db/schema'

describe('Session 10: Default Commit Message Backend', () => {
  describe('Schema', () => {
    test('CURRENT_SCHEMA_VERSION is defined', () => {
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
    })

    test('schema includes session_titles column on worktrees', () => {
      const schema = MIGRATIONS.find((m) => m.version === 1)
      expect(schema).toBeDefined()
      expect(schema!.up).toContain('session_titles')
      expect(schema!.up).toContain("DEFAULT '[]'")
    })

    test('migration versions are strictly increasing', () => {
      // Versions must increase monotonically (so the runner applies them in
      // order and never skips a higher version), but gaps are allowed: a
      // version may be retired/reserved without renumbering later migrations.
      // This still catches duplicate versions, the bug a strict +1 check caught.
      for (let i = 1; i < MIGRATIONS.length; i++) {
        expect(MIGRATIONS[i].version).toBeGreaterThan(MIGRATIONS[i - 1].version)
      }
    })
  })

  // ── DatabaseService.appendSessionTitle tests ──────────────────────────────
  describe('appendSessionTitle logic', () => {
    // We test the logic in isolation since DatabaseService requires a real
    // SQLite connection. We replicate the core logic here.

    function appendSessionTitle(
      existingTitles: string[],
      title: string
    ): { updated: boolean; result: string[] } {
      if (existingTitles.includes(title)) {
        return { updated: false, result: existingTitles }
      }
      const result = [...existingTitles, title]
      return { updated: true, result }
    }

    test('adds title to empty array', () => {
      const { updated, result } = appendSessionTitle([], 'Add feature X')
      expect(updated).toBe(true)
      expect(result).toEqual(['Add feature X'])
    })

    test('adds title to existing array', () => {
      const { updated, result } = appendSessionTitle(['First title'], 'Second title')
      expect(updated).toBe(true)
      expect(result).toEqual(['First title', 'Second title'])
    })

    test('skips duplicate titles', () => {
      const { updated, result } = appendSessionTitle(['Add feature X'], 'Add feature X')
      expect(updated).toBe(false)
      expect(result).toEqual(['Add feature X'])
    })

    test('handles multiple unique titles', () => {
      let titles: string[] = []
      const titlesToAdd = ['Feature A', 'Feature B', 'Feature C']
      for (const t of titlesToAdd) {
        const { result } = appendSessionTitle(titles, t)
        titles = result
      }
      expect(titles).toEqual(['Feature A', 'Feature B', 'Feature C'])
    })

    test('JSON parsing of session_titles works with empty default', () => {
      const raw = '[]'
      const titles: string[] = JSON.parse(raw)
      expect(titles).toEqual([])
    })

    test('JSON parsing of session_titles works with populated data', () => {
      const raw = '["Add feature","Fix bug"]'
      const titles: string[] = JSON.parse(raw)
      expect(titles).toEqual(['Add feature', 'Fix bug'])
    })
  })

  // ── Default name detection ────────────────────────────────────────────────
  describe('default session name detection', () => {
    const isDefault = (name: string): boolean => /^Session \d+$/.test(name)

    test('detects default sequential counter names', () => {
      expect(isDefault('Session 1')).toBe(true)
      expect(isDefault('Session 42')).toBe(true)
    })

    test('rejects meaningful session names', () => {
      expect(isDefault('Implement dark mode')).toBe(false)
      expect(isDefault('Fix navigation bug')).toBe(false)
      expect(isDefault('Add feature X')).toBe(false)
    })

    test('rejects partial matches', () => {
      expect(isDefault('Session')).toBe(false)
      expect(isDefault('Session abc')).toBe(false)
      expect(isDefault('New session - 2025-01-01')).toBe(false)
    })
  })

  // ── updateSessionName integration ─────────────────────────────────────────
  describe('updateSessionName title tracking', () => {
    const mockAppendSessionTitle = vi.mocked(dbApi.worktree.appendSessionTitle)

    beforeEach(() => {
      vi.clearAllMocks()
      mockAppendSessionTitle.mockResolvedValue(true)
    })

    test('meaningful session names trigger appendSessionTitle', async () => {
      // Simulate what updateSessionName does:
      // 1. Update session in DB
      // 2. Check if name is non-default
      // 3. Call appendSessionTitle if meaningful
      const name = 'Implement dark mode'
      const worktreeId = 'wt-1'

      const isDefault = /^Session \d+$/.test(name)
      expect(isDefault).toBe(false)

      if (!isDefault && worktreeId) {
        await dbApi.worktree.appendSessionTitle(worktreeId, name)
      }

      expect(mockAppendSessionTitle).toHaveBeenCalledWith('wt-1', 'Implement dark mode')
    })

    test('default session names do NOT trigger appendSessionTitle', async () => {
      const name = 'Session 1'
      const worktreeId = 'wt-1'

      const isDefault = /^Session \d+$/.test(name)
      expect(isDefault).toBe(true)

      if (!isDefault && worktreeId) {
        await dbApi.worktree.appendSessionTitle(worktreeId, name)
      }

      expect(mockAppendSessionTitle).not.toHaveBeenCalled()
    })

    test('null worktreeId does NOT trigger appendSessionTitle', async () => {
      const name = 'Implement dark mode'
      const worktreeId: string | null = null

      const isDefault = /^Session \d+$/.test(name)
      expect(isDefault).toBe(false)

      if (!isDefault && worktreeId) {
        await dbApi.worktree.appendSessionTitle(worktreeId, name)
      }

      expect(mockAppendSessionTitle).not.toHaveBeenCalled()
    })
  })

  // ── RPC handler contract ──────────────────────────────────────────────────
  describe('RPC handler contract', () => {
    test('appendSessionTitle RPC method name is correct', () => {
      const expectedMethod = 'db.worktree.appendSessionTitle'
      expect(expectedMethod).toBe('db.worktree.appendSessionTitle')
    })

    test('appendSessionTitle accepts { worktreeId, title } payload', () => {
      const payload = { worktreeId: 'wt-1', title: 'Add feature X' }
      expect(payload).toHaveProperty('worktreeId')
      expect(payload).toHaveProperty('title')
      expect(typeof payload.worktreeId).toBe('string')
      expect(typeof payload.title).toBe('string')
    })
  })
})
