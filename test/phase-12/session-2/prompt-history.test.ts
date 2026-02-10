import { usePromptHistoryStore } from '../../../src/renderer/src/stores/usePromptHistoryStore'

describe('Session 2: Prompt History', () => {
  beforeEach(() => {
    // Reset store state between tests
    usePromptHistoryStore.setState({ historyByWorktree: {} })
  })

  describe('usePromptHistoryStore', () => {
    test('addPrompt appends to history', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', 'hello')
      store.addPrompt('wt1', 'world')
      expect(store.getHistory('wt1')).toEqual(['hello', 'world'])
    })

    test('deduplicates same prompt', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', 'hello')
      store.addPrompt('wt1', 'world')
      store.addPrompt('wt1', 'hello')
      expect(store.getHistory('wt1')).toEqual(['world', 'hello'])
    })

    test('caps at 100 entries', () => {
      const store = usePromptHistoryStore.getState()
      for (let i = 0; i < 110; i++) {
        store.addPrompt('wt1', `msg-${i}`)
      }
      const history = store.getHistory('wt1')
      expect(history.length).toBe(100)
      expect(history[0]).toBe('msg-10') // oldest 10 evicted
      expect(history[99]).toBe('msg-109')
    })

    test('empty/whitespace prompts ignored', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', '')
      store.addPrompt('wt1', '   ')
      expect(store.getHistory('wt1')).toEqual([])
    })

    test('histories are per-worktree', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', 'branch-a')
      store.addPrompt('wt2', 'branch-b')
      expect(store.getHistory('wt1')).toEqual(['branch-a'])
      expect(store.getHistory('wt2')).toEqual(['branch-b'])
    })

    test('getHistory returns empty array for unknown worktree', () => {
      const store = usePromptHistoryStore.getState()
      expect(store.getHistory('unknown')).toEqual([])
    })

    test('trims whitespace from prompts', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', '  hello  ')
      expect(store.getHistory('wt1')).toEqual(['hello'])
    })

    test('deduplication compares trimmed values', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', 'hello')
      store.addPrompt('wt1', '  hello  ')
      // Should deduplicate since both trim to 'hello'
      expect(store.getHistory('wt1')).toEqual(['hello'])
    })

    test('addPrompt moves duplicate to end', () => {
      const store = usePromptHistoryStore.getState()
      store.addPrompt('wt1', 'first')
      store.addPrompt('wt1', 'second')
      store.addPrompt('wt1', 'third')
      store.addPrompt('wt1', 'first') // re-add first
      expect(store.getHistory('wt1')).toEqual(['second', 'third', 'first'])
    })
  })
})
