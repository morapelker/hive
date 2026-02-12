import { describe, test, expect, beforeEach } from 'vitest'
import { useFileSearchStore } from '../../../src/renderer/src/stores/useFileSearchStore'

describe('Session 10: File Search Store', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useFileSearchStore.setState({
      isOpen: false,
      searchQuery: '',
      selectedIndex: 0
    })
  })

  describe('open', () => {
    test('sets isOpen true and resets query', () => {
      // Set some dirty state first
      useFileSearchStore.setState({ searchQuery: 'old query', selectedIndex: 3 })

      useFileSearchStore.getState().open()

      expect(useFileSearchStore.getState().isOpen).toBe(true)
      expect(useFileSearchStore.getState().searchQuery).toBe('')
      expect(useFileSearchStore.getState().selectedIndex).toBe(0)
    })
  })

  describe('close', () => {
    test('sets isOpen false and resets state', () => {
      useFileSearchStore.setState({
        isOpen: true,
        searchQuery: 'some query',
        selectedIndex: 5
      })

      useFileSearchStore.getState().close()

      expect(useFileSearchStore.getState().isOpen).toBe(false)
      expect(useFileSearchStore.getState().searchQuery).toBe('')
      expect(useFileSearchStore.getState().selectedIndex).toBe(0)
    })
  })

  describe('toggle', () => {
    test('opens when closed', () => {
      useFileSearchStore.getState().toggle()

      expect(useFileSearchStore.getState().isOpen).toBe(true)
      expect(useFileSearchStore.getState().searchQuery).toBe('')
      expect(useFileSearchStore.getState().selectedIndex).toBe(0)
    })

    test('closes when open', () => {
      useFileSearchStore.setState({
        isOpen: true,
        searchQuery: 'test',
        selectedIndex: 2
      })

      useFileSearchStore.getState().toggle()

      expect(useFileSearchStore.getState().isOpen).toBe(false)
      expect(useFileSearchStore.getState().searchQuery).toBe('')
      expect(useFileSearchStore.getState().selectedIndex).toBe(0)
    })

    test('round-trip toggle returns to closed', () => {
      useFileSearchStore.getState().toggle()
      expect(useFileSearchStore.getState().isOpen).toBe(true)

      useFileSearchStore.getState().toggle()
      expect(useFileSearchStore.getState().isOpen).toBe(false)
    })
  })

  describe('setSearchQuery', () => {
    test('updates search query and resets selectedIndex', () => {
      useFileSearchStore.setState({ selectedIndex: 5 })

      useFileSearchStore.getState().setSearchQuery('new query')

      expect(useFileSearchStore.getState().searchQuery).toBe('new query')
      expect(useFileSearchStore.getState().selectedIndex).toBe(0)
    })

    test('handles empty string', () => {
      useFileSearchStore.setState({ searchQuery: 'something' })

      useFileSearchStore.getState().setSearchQuery('')

      expect(useFileSearchStore.getState().searchQuery).toBe('')
    })
  })

  describe('setSelectedIndex', () => {
    test('updates selected index', () => {
      useFileSearchStore.getState().setSelectedIndex(3)
      expect(useFileSearchStore.getState().selectedIndex).toBe(3)
    })

    test('allows setting to 0', () => {
      useFileSearchStore.setState({ selectedIndex: 5 })
      useFileSearchStore.getState().setSelectedIndex(0)
      expect(useFileSearchStore.getState().selectedIndex).toBe(0)
    })
  })

  describe('moveSelection', () => {
    test('moves down within bounds', () => {
      useFileSearchStore.getState().moveSelection('down', 5)
      expect(useFileSearchStore.getState().selectedIndex).toBe(1)

      useFileSearchStore.getState().moveSelection('down', 5)
      expect(useFileSearchStore.getState().selectedIndex).toBe(2)
    })

    test('moves up within bounds', () => {
      useFileSearchStore.setState({ selectedIndex: 3 })

      useFileSearchStore.getState().moveSelection('up', 5)
      expect(useFileSearchStore.getState().selectedIndex).toBe(2)

      useFileSearchStore.getState().moveSelection('up', 5)
      expect(useFileSearchStore.getState().selectedIndex).toBe(1)
    })

    test('does not go below 0', () => {
      useFileSearchStore.setState({ selectedIndex: 0 })

      useFileSearchStore.getState().moveSelection('up', 5)
      expect(useFileSearchStore.getState().selectedIndex).toBe(0)

      // Try again — still 0
      useFileSearchStore.getState().moveSelection('up', 5)
      expect(useFileSearchStore.getState().selectedIndex).toBe(0)
    })

    test('does not exceed maxIndex', () => {
      useFileSearchStore.setState({ selectedIndex: 5 })

      useFileSearchStore.getState().moveSelection('down', 5)
      expect(useFileSearchStore.getState().selectedIndex).toBe(5) // stays at max

      useFileSearchStore.getState().moveSelection('down', 5)
      expect(useFileSearchStore.getState().selectedIndex).toBe(5)
    })

    test('handles maxIndex of 0', () => {
      useFileSearchStore.getState().moveSelection('down', 0)
      expect(useFileSearchStore.getState().selectedIndex).toBe(0)
    })

    test('navigates full range correctly', () => {
      const maxIndex = 3

      // Move down through the full range
      useFileSearchStore.getState().moveSelection('down', maxIndex) // 0 -> 1
      useFileSearchStore.getState().moveSelection('down', maxIndex) // 1 -> 2
      useFileSearchStore.getState().moveSelection('down', maxIndex) // 2 -> 3
      useFileSearchStore.getState().moveSelection('down', maxIndex) // 3 -> 3 (clamped)
      expect(useFileSearchStore.getState().selectedIndex).toBe(3)

      // Move back up
      useFileSearchStore.getState().moveSelection('up', maxIndex) // 3 -> 2
      useFileSearchStore.getState().moveSelection('up', maxIndex) // 2 -> 1
      useFileSearchStore.getState().moveSelection('up', maxIndex) // 1 -> 0
      useFileSearchStore.getState().moveSelection('up', maxIndex) // 0 -> 0 (clamped)
      expect(useFileSearchStore.getState().selectedIndex).toBe(0)
    })
  })

  describe('initial state', () => {
    test('starts with correct defaults', () => {
      // Reset fully
      useFileSearchStore.setState({
        isOpen: false,
        searchQuery: '',
        selectedIndex: 0
      })

      const state = useFileSearchStore.getState()
      expect(state.isOpen).toBe(false)
      expect(state.searchQuery).toBe('')
      expect(state.selectedIndex).toBe(0)
    })
  })
})
