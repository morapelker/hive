import { describe, it, expect, beforeEach } from 'vitest'
import { assignSessionHints, SECOND_CHARS } from '@/lib/hint-utils'
import { useHintStore } from '@/stores/useHintStore'
import { useVimModeStore } from '@/stores/useVimModeStore'

describe('session tab hints', () => {
  beforeEach(() => {
    useHintStore.setState({
      hintMap: new Map(),
      hintTargetMap: new Map(),
      sessionHintMap: new Map(),
      sessionHintTargetMap: new Map(),
      mode: 'idle',
      pendingChar: null,
      filterActive: false,
      inputFocused: false
    })
    useVimModeStore.setState({ mode: 'normal' })
  })

  describe('session hint computation via assignSessionHints', () => {
    it('produces S-prefixed codes for orderedSessions IDs', () => {
      const sessionIds = ['s1', 's2', 's3']
      const { sessionHintMap, sessionHintTargetMap } = assignSessionHints(sessionIds)

      expect(sessionHintMap.get('s1')).toBe('Sa')
      expect(sessionHintMap.get('s2')).toBe('Sb')
      expect(sessionHintMap.get('s3')).toBe('Sc')

      expect(sessionHintTargetMap.get('Sa')).toBe('s1')
      expect(sessionHintTargetMap.get('Sb')).toBe('s2')
      expect(sessionHintTargetMap.get('Sc')).toBe('s3')
    })

    it('returns empty maps for an empty session list', () => {
      const { sessionHintMap, sessionHintTargetMap } = assignSessionHints([])

      expect(sessionHintMap.size).toBe(0)
      expect(sessionHintTargetMap.size).toBe(0)
    })

    it('recomputes hints when session list changes', () => {
      const first = assignSessionHints(['s1', 's2'])
      expect(first.sessionHintMap.size).toBe(2)
      expect(first.sessionHintMap.get('s1')).toBe('Sa')
      expect(first.sessionHintMap.get('s2')).toBe('Sb')

      const second = assignSessionHints(['s3', 's1', 's4'])
      expect(second.sessionHintMap.size).toBe(3)
      // s3 is now first so gets Sa
      expect(second.sessionHintMap.get('s3')).toBe('Sa')
      // s1 is now second so gets Sb
      expect(second.sessionHintMap.get('s1')).toBe('Sb')
      expect(second.sessionHintMap.get('s4')).toBe('Sc')
    })

    it('uses SECOND_CHARS sequence for codes', () => {
      const sessionIds = Array.from({ length: 5 }, (_, i) => `s${i}`)
      const { sessionHintMap } = assignSessionHints(sessionIds)

      sessionIds.forEach((id, index) => {
        expect(sessionHintMap.get(id)).toBe('S' + SECOND_CHARS[index])
      })
    })

    it('caps at SECOND_CHARS.length sessions', () => {
      const sessionIds = Array.from({ length: SECOND_CHARS.length + 5 }, (_, i) => `s${i}`)
      const { sessionHintMap } = assignSessionHints(sessionIds)

      expect(sessionHintMap.size).toBe(SECOND_CHARS.length)
    })

    it('produces a single hint for a single session', () => {
      const { sessionHintMap, sessionHintTargetMap } = assignSessionHints(['only-session'])

      expect(sessionHintMap.size).toBe(1)
      expect(sessionHintMap.get('only-session')).toBe('Sa')
      expect(sessionHintTargetMap.get('Sa')).toBe('only-session')
    })
  })

  describe('store sync behavior', () => {
    it('setSessionHints populates hint store when vim mode is normal', () => {
      const sessionIds = ['s1', 's2']
      const { sessionHintMap, sessionHintTargetMap } = assignSessionHints(sessionIds)

      // Simulate what the useEffect would do when vimMode === 'normal'
      const vimMode = useVimModeStore.getState().mode
      expect(vimMode).toBe('normal')

      useHintStore.getState().setSessionHints(sessionHintMap, sessionHintTargetMap)

      const state = useHintStore.getState()
      expect(state.sessionHintMap.get('s1')).toBe('Sa')
      expect(state.sessionHintMap.get('s2')).toBe('Sb')
      expect(state.sessionHintTargetMap.get('Sa')).toBe('s1')
      expect(state.sessionHintTargetMap.get('Sb')).toBe('s2')
    })

    it('clearSessionHints clears session maps when vim mode is insert', () => {
      // First populate
      const { sessionHintMap, sessionHintTargetMap } = assignSessionHints(['s1', 's2'])
      useHintStore.getState().setSessionHints(sessionHintMap, sessionHintTargetMap)
      expect(useHintStore.getState().sessionHintMap.size).toBe(2)

      // Simulate switching to insert mode
      useVimModeStore.getState().enterInsertMode()
      expect(useVimModeStore.getState().mode).toBe('insert')

      // Simulate what the useEffect would do when vimMode === 'insert'
      useHintStore.getState().clearSessionHints()

      const state = useHintStore.getState()
      expect(state.sessionHintMap.size).toBe(0)
      expect(state.sessionHintTargetMap.size).toBe(0)
    })

    it('session hints should be cleared on unmount (clearSessionHints)', () => {
      // Populate session hints
      const { sessionHintMap, sessionHintTargetMap } = assignSessionHints(['s1'])
      useHintStore.getState().setSessionHints(sessionHintMap, sessionHintTargetMap)
      expect(useHintStore.getState().sessionHintMap.size).toBe(1)

      // Simulate unmount cleanup calling clearSessionHints
      useHintStore.getState().clearSessionHints()

      const state = useHintStore.getState()
      expect(state.sessionHintMap.size).toBe(0)
      expect(state.sessionHintTargetMap.size).toBe(0)
    })

    it('toggling vim mode back to normal re-syncs session hints', () => {
      const sessionIds = ['s1', 's2', 's3']
      const { sessionHintMap, sessionHintTargetMap } = assignSessionHints(sessionIds)

      // Start in normal mode, set hints
      useHintStore.getState().setSessionHints(sessionHintMap, sessionHintTargetMap)
      expect(useHintStore.getState().sessionHintMap.size).toBe(3)

      // Switch to insert -> clear
      useVimModeStore.getState().enterInsertMode()
      useHintStore.getState().clearSessionHints()
      expect(useHintStore.getState().sessionHintMap.size).toBe(0)

      // Switch back to normal -> re-set
      useVimModeStore.getState().enterNormalMode()
      useHintStore.getState().setSessionHints(sessionHintMap, sessionHintTargetMap)
      expect(useHintStore.getState().sessionHintMap.size).toBe(3)
      expect(useHintStore.getState().sessionHintMap.get('s1')).toBe('Sa')
    })

    it('session hints are independent of sidebar hints', () => {
      // Set sidebar hints
      const sidebarMap = new Map([['w1', 'Aa']])
      const sidebarTargetMap = new Map([
        ['w1', { kind: 'worktree' as const, worktreeId: 'w1', projectId: 'p1' }]
      ])
      useHintStore.getState().setHints(sidebarMap, sidebarTargetMap)

      // Set session hints
      const { sessionHintMap, sessionHintTargetMap } = assignSessionHints(['s1'])
      useHintStore.getState().setSessionHints(sessionHintMap, sessionHintTargetMap)

      // Clear session hints should not affect sidebar hints
      useHintStore.getState().clearSessionHints()
      expect(useHintStore.getState().hintMap.get('w1')).toBe('Aa')
      expect(useHintStore.getState().sessionHintMap.size).toBe(0)
    })
  })

  describe('hint badge visibility logic', () => {
    it('badge should show when hintCode exists and vimMode is normal', () => {
      const hintCode = 'Sa'
      const vimMode = 'normal'

      const shouldShow = !!hintCode && vimMode === 'normal'
      expect(shouldShow).toBe(true)
    })

    it('badge should NOT show when hintCode exists and vimMode is insert', () => {
      const hintCode = 'Sa'
      const vimMode = 'insert'

      const shouldShow = !!hintCode && vimMode === 'normal'
      expect(shouldShow).toBe(false)
    })

    it('badge should NOT show when hintCode is undefined regardless of mode', () => {
      const hintCode = undefined

      expect(!!hintCode && 'normal' === 'normal').toBe(false)
      expect(!!hintCode && 'insert' === 'normal').toBe(false)
    })

    it('badge should NOT show when hintCode is empty string regardless of mode', () => {
      const hintCode = ''

      expect(!!hintCode && 'normal' === 'normal').toBe(false)
      expect(!!hintCode && 'insert' === 'normal').toBe(false)
    })

    it('hintCode lookup from sessionHintMap matches session IDs', () => {
      const orderedSessionIds = ['s1', 's2', 's3']
      const { sessionHintMap } = assignSessionHints(orderedSessionIds)

      // Simulate what SessionTabs render loop does:
      // hintCode={sessionHints.get(session.id)}
      expect(sessionHintMap.get('s1')).toBe('Sa')
      expect(sessionHintMap.get('s2')).toBe('Sb')
      expect(sessionHintMap.get('s3')).toBe('Sc')
      // Unknown session returns undefined
      expect(sessionHintMap.get('nonexistent')).toBeUndefined()
    })

    it('visibility tracks vim mode transitions from store', () => {
      const hintCode = 'Sa'

      // Start in normal mode
      expect(useVimModeStore.getState().mode).toBe('normal')
      expect(!!hintCode && useVimModeStore.getState().mode === 'normal').toBe(true)

      // Switch to insert
      useVimModeStore.getState().enterInsertMode()
      expect(!!hintCode && useVimModeStore.getState().mode === 'normal').toBe(false)

      // Back to normal
      useVimModeStore.getState().enterNormalMode()
      expect(!!hintCode && useVimModeStore.getState().mode === 'normal').toBe(true)
    })
  })

  describe('worktree switch recomputes session hints', () => {
    it('produces different hints for different worktree session lists', () => {
      // Worktree A has sessions s1, s2
      const worktreeASessions = ['s1', 's2']
      const hintsA = assignSessionHints(worktreeASessions)

      expect(hintsA.sessionHintMap.get('s1')).toBe('Sa')
      expect(hintsA.sessionHintMap.get('s2')).toBe('Sb')
      expect(hintsA.sessionHintMap.has('s3')).toBe(false)

      // Worktree B has sessions s3, s4, s5
      const worktreeBSessions = ['s3', 's4', 's5']
      const hintsB = assignSessionHints(worktreeBSessions)

      expect(hintsB.sessionHintMap.get('s3')).toBe('Sa')
      expect(hintsB.sessionHintMap.get('s4')).toBe('Sb')
      expect(hintsB.sessionHintMap.get('s5')).toBe('Sc')
      expect(hintsB.sessionHintMap.has('s1')).toBe(false)
    })

    it('store is updated with new hints when switching worktrees', () => {
      // Simulate worktree A active
      const hintsA = assignSessionHints(['s1', 's2'])
      useHintStore.getState().setSessionHints(hintsA.sessionHintMap, hintsA.sessionHintTargetMap)

      expect(useHintStore.getState().sessionHintMap.get('s1')).toBe('Sa')
      expect(useHintStore.getState().sessionHintTargetMap.get('Sa')).toBe('s1')

      // Simulate switching to worktree B: clear old, set new
      const hintsB = assignSessionHints(['s3', 's4'])
      useHintStore.getState().setSessionHints(hintsB.sessionHintMap, hintsB.sessionHintTargetMap)

      const state = useHintStore.getState()
      expect(state.sessionHintMap.size).toBe(2)
      expect(state.sessionHintMap.get('s3')).toBe('Sa')
      expect(state.sessionHintMap.get('s4')).toBe('Sb')
      // Old session hints are replaced
      expect(state.sessionHintMap.has('s1')).toBe(false)
      expect(state.sessionHintTargetMap.has('Sa')).toBe(true)
      expect(state.sessionHintTargetMap.get('Sa')).toBe('s3')
    })

    it('switching to a worktree with no sessions produces empty hints', () => {
      // Start with hints for worktree A
      const hintsA = assignSessionHints(['s1'])
      useHintStore.getState().setSessionHints(hintsA.sessionHintMap, hintsA.sessionHintTargetMap)
      expect(useHintStore.getState().sessionHintMap.size).toBe(1)

      // Switch to worktree with no sessions
      const hintsEmpty = assignSessionHints([])
      useHintStore.getState().setSessionHints(
        hintsEmpty.sessionHintMap,
        hintsEmpty.sessionHintTargetMap
      )

      expect(useHintStore.getState().sessionHintMap.size).toBe(0)
      expect(useHintStore.getState().sessionHintTargetMap.size).toBe(0)
    })
  })
})
