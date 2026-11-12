import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AutoReviewPreference } from './AutoReviewPreference'
import { useSettingsStore } from '@/stores/useSettingsStore'

beforeEach(() => {
  useSettingsStore.setState({ autoReview: true, autoReviewProjects: {}, autoReviewTasks: {} })
})

describe('AutoReviewPreference', () => {
  it('changes the global default', () => {
    render(<AutoReviewPreference />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'false' } })
    expect(useSettingsStore.getState().autoReview).toBe(false)
  })

  it('sets and removes the project override', () => {
    render(<AutoReviewPreference projectId="p" />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'false' } })
    expect(useSettingsStore.getState().autoReviewProjects).toEqual({ p: false })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'inherit' } })
    expect(useSettingsStore.getState().autoReviewProjects).toEqual({})
    expect(screen.getByText('Effective: On')).toBeInTheDocument()
  })

  it('shows inherited defaults and persists explicit choices independently', () => {
    const update = vi.spyOn(useSettingsStore.getState(), 'updateSetting')
    const { rerender } = render(<AutoReviewPreference projectId="p" ticketId="t" />)
    const select = screen.getByRole('combobox')
    expect(select).toHaveValue('inherit')
    fireEvent.change(select, { target: { value: 'false' } })
    expect(update).toHaveBeenCalledWith('autoReviewTasks', { '["p","t"]': false })
    expect(select).toHaveValue('false')
    act(() => useSettingsStore.setState({ autoReview: false, autoReviewProjects: { p: true } }))
    rerender(<AutoReviewPreference projectId="p" ticketId="t" />)
    expect(select).toHaveValue('false')
    fireEvent.change(select, { target: { value: 'inherit' } })
    expect(screen.getByText('Effective: On')).toBeInTheDocument()
    update.mockRestore()
  })
})
