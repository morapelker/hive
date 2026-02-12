import { describe, test, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const componentPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'sessions',
  'SessionTabs.tsx'
)

describe('Session 6: Auto-Start Session on Worktree Entry', () => {
  let content: string

  beforeAll(() => {
    content = fs.readFileSync(componentPath, 'utf-8')
  })

  describe('merged load-then-autostart architecture', () => {
    test('auto-start is NOT a separate useEffect (no race conditions)', () => {
      // There should be a single effect that loads sessions AND auto-starts.
      // Count useEffects that reference both loadSessions and autoStartSession.
      const effects = extractAllEffects(content)
      const combinedEffects = effects.filter(
        (e) => e.includes('loadSessions') && e.includes('autoStartSession')
      )
      expect(combinedEffects.length).toBe(1)

      // There should be NO standalone auto-start effect
      const standaloneAutoStart = effects.filter(
        (e) => e.includes('autoStartSession') && !e.includes('loadSessions')
      )
      expect(standaloneAutoStart.length).toBe(0)
    })

    test('auto-start runs AFTER loadSessions completes (awaits it)', () => {
      const effect = extractCombinedEffect(content)
      expect(effect).toBeTruthy()

      // loadSessions should be awaited before auto-start logic runs
      expect(effect).toContain('await loadSessions(')
    })

    test('auto-start reads sessions from store AFTER load completes', () => {
      const effect = extractCombinedEffect(content)
      // After loadSessions, reads from store to check session count
      expect(effect).toContain('useSessionStore.getState()')
      expect(effect).toContain('sessions.length > 0')
    })
  })

  describe('simplified auto-start logic', () => {
    test('no project-wide session fetch (getByProject removed)', () => {
      expect(content).not.toContain('window.db.session.getByProject')
    })

    test('no project-wide active session check (hasActiveSession removed)', () => {
      expect(content).not.toContain('hasActiveSession')
    })

    test('auto-start checks sessions for the selected worktree only', () => {
      const effect = extractCombinedEffect(content)
      expect(effect).toContain('selectedWorktreeId')
      expect(effect).not.toContain('getByProject')
      expect(effect).not.toContain('projectSessions')
    })

    test('auto-start guards: no worktreeId, no project, setting disabled', () => {
      const effect = extractCombinedEffect(content)
      expect(effect).toContain('!selectedWorktreeId')
      expect(effect).toContain('!project')
      expect(effect).toContain('!autoStartSession')
    })

    test('auto-start uses autoStartedRef to prevent duplicates', () => {
      expect(content).toContain('autoStartedRef')

      const effect = extractCombinedEffect(content)
      expect(effect).toContain('autoStartedRef.current')
    })

    test('auto-start calls createSession with worktreeId and projectId', () => {
      const effect = extractCombinedEffect(content)
      expect(effect).toContain('createSession(selectedWorktreeId, project.id)')
    })
  })

  describe('cancellation on unmount/dep change', () => {
    test('effect uses cancelled flag to prevent stale creation', () => {
      const effect = extractCombinedEffect(content)
      expect(effect).toContain('cancelled')
      expect(effect).toContain('if (cancelled) return')
    })

    test('effect returns cleanup that sets cancelled = true', () => {
      const effect = extractCombinedEffect(content)
      expect(effect).toContain('cancelled = true')
    })
  })

  describe('effect dependencies', () => {
    test('effect depends on selectedWorktreeId', () => {
      const effect = extractCombinedEffect(content)
      expect(effect).toContain('selectedWorktreeId')
    })

    test('effect depends on autoStartSession setting', () => {
      const effect = extractCombinedEffect(content)
      expect(effect).toContain('autoStartSession')
    })
  })
})

/**
 * Extract ALL useEffect blocks from the component source.
 */
function extractAllEffects(source: string): string[] {
  const lines = source.split('\n')
  const effects: string[] = []

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('useEffect')) continue

    let braceCount = 0
    let started = false
    const blockLines: string[] = []

    for (let j = i; j < lines.length; j++) {
      blockLines.push(lines[j])
      for (const ch of lines[j]) {
        if (ch === '{') {
          braceCount++
          started = true
        }
        if (ch === '}') braceCount--
      }
      if (started && braceCount <= 0) {
        effects.push(blockLines.join('\n'))
        break
      }
    }
  }

  return effects
}

/**
 * Extract the combined load+autostart useEffect block.
 */
function extractCombinedEffect(source: string): string {
  const effects = extractAllEffects(source)
  return effects.find((e) => e.includes('loadSessions') && e.includes('autoStartSession')) || ''
}
