import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useFilterStore, FILTER_DEBOUNCE_MS } from '../useFilterStore'

describe('useFilterStore filter query debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useFilterStore.getState().clearAll()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('updates filterQuery immediately but debouncedFilterQuery after the delay', () => {
    useFilterStore.getState().setFilterQuery('he')

    expect(useFilterStore.getState().filterQuery).toBe('he')
    expect(useFilterStore.getState().debouncedFilterQuery).toBe('')

    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS)

    expect(useFilterStore.getState().debouncedFilterQuery).toBe('he')
  })

  it('only applies the last value when typing rapidly', () => {
    useFilterStore.getState().setFilterQuery('h')
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS - 1)
    useFilterStore.getState().setFilterQuery('hi')
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS - 1)

    expect(useFilterStore.getState().debouncedFilterQuery).toBe('')

    vi.advanceTimersByTime(1)

    expect(useFilterStore.getState().debouncedFilterQuery).toBe('hi')
  })

  it('clears both values immediately when the query is emptied', () => {
    useFilterStore.getState().setFilterQuery('hive')
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS)
    useFilterStore.getState().setFilterQuery('')

    expect(useFilterStore.getState().filterQuery).toBe('')
    expect(useFilterStore.getState().debouncedFilterQuery).toBe('')
  })

  it('cancels a pending debounce when cleared', () => {
    useFilterStore.getState().setFilterQuery('hive')
    useFilterStore.getState().setFilterQuery('')
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS)

    expect(useFilterStore.getState().debouncedFilterQuery).toBe('')
  })

  it('clearAll cancels a pending debounce and resets both values', () => {
    useFilterStore.getState().setFilterQuery('hive')
    useFilterStore.getState().clearAll()
    vi.advanceTimersByTime(FILTER_DEBOUNCE_MS)

    expect(useFilterStore.getState().filterQuery).toBe('')
    expect(useFilterStore.getState().debouncedFilterQuery).toBe('')
  })
})
