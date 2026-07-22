import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AutoSwitchControls, ScheduleSwitchForm } from './ScheduleSwitchControls'
import { useAccountScheduleStore } from '@/stores/useAccountScheduleStore'
import { useUsageStore } from '@/stores/useUsageStore'
import type { UsageData } from '@shared/types/usage'

function makeUsage(fiveHour: number, sevenDay: number): UsageData {
  const futureReset = new Date(Date.now() + 3_600_000).toISOString()
  return {
    five_hour: { utilization: fiveHour, resets_at: futureReset },
    seven_day: { utilization: sevenDay, resets_at: futureReset }
  }
}

describe('AutoSwitchControls', () => {
  beforeEach(() => {
    useAccountScheduleStore.setState({ schedules: {}, autoSwitch: {} })
    useUsageStore.setState({ anthropicUsage: makeUsage(73, 10), openaiUsage: null })
  })

  afterEach(() => {
    cleanup()
  })

  it('arms auto-switch at the default 90% threshold when toggled on', async () => {
    const user = userEvent.setup()
    render(<AutoSwitchControls provider="anthropic" />)

    await user.click(screen.getByRole('switch'))

    const auto = useAccountScheduleStore.getState().autoSwitch.anthropic
    expect(auto).toBeDefined()
    expect(auto?.thresholdPercent).toBe(90)
  })

  it('disarms when toggled off', async () => {
    const user = userEvent.setup()
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)
    render(<AutoSwitchControls provider="anthropic" />)

    await user.click(screen.getByRole('switch'))

    expect(useAccountScheduleStore.getState().autoSwitch.anthropic).toBeUndefined()
  })

  it('warns that arming replaces a pending schedule, and does replace it', async () => {
    const user = userEvent.setup()
    useAccountScheduleStore.getState().scheduleByUsage('anthropic', 'acc-2', 'x@y.com', 95)
    render(<AutoSwitchControls provider="anthropic" />)

    expect(screen.getByText(/replaces the pending/i)).toBeTruthy()

    await user.click(screen.getByRole('switch'))

    const state = useAccountScheduleStore.getState()
    expect(state.schedules.anthropic).toBeUndefined()
    expect(state.autoSwitch.anthropic).toBeDefined()
  })

  it('updates the threshold via presets and marks the active one', async () => {
    const user = userEvent.setup()
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)
    render(<AutoSwitchControls provider="anthropic" />)

    await user.click(screen.getByRole('button', { name: /auto-switch at 95% usage/i }))

    expect(useAccountScheduleStore.getState().autoSwitch.anthropic?.thresholdPercent).toBe(95)
    expect(
      screen.getByRole('button', { name: /auto-switch at 95% usage/i }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: /auto-switch at 90% usage/i }).getAttribute('aria-pressed')
    ).toBe('false')
  })

  it('sets a custom threshold', async () => {
    const user = userEvent.setup()
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)
    render(<AutoSwitchControls provider="anthropic" />)

    await user.type(screen.getByLabelText(/custom auto-switch percent/i), '85')
    await user.click(screen.getByRole('button', { name: 'Set' }))

    expect(useAccountScheduleStore.getState().autoSwitch.anthropic?.thresholdPercent).toBe(85)
  })

  it('shows the live threshold and current usage while armed', () => {
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)
    render(<AutoSwitchControls provider="anthropic" />)

    expect(screen.getByText(/at 90% usage/i)).toBeTruthy()
    expect(screen.getByText(/now 73%/i)).toBeTruthy()
  })
})

describe('ScheduleSwitchForm with auto-switch armed', () => {
  beforeEach(() => {
    useAccountScheduleStore.setState({ schedules: {}, autoSwitch: {} })
  })

  afterEach(() => {
    cleanup()
  })

  it('warns that scheduling replaces auto-switch', () => {
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)
    render(<ScheduleSwitchForm provider="anthropic" accountId="acc-2" email="x@y.com" />)

    expect(screen.getByText(/replaces .*auto-switch/i)).toBeTruthy()
  })

  it('scheduling by usage disarms auto-switch', async () => {
    const user = userEvent.setup()
    useAccountScheduleStore.getState().setAutoSwitch('anthropic', 90)
    render(<ScheduleSwitchForm provider="anthropic" accountId="acc-2" email="x@y.com" />)

    await user.click(screen.getByRole('button', { name: /by usage/i }))
    await user.click(screen.getByRole('button', { name: /switch at 90% usage/i }))

    const state = useAccountScheduleStore.getState()
    expect(state.autoSwitch.anthropic).toBeUndefined()
    expect(state.schedules.anthropic?.accountId).toBe('acc-2')
  })
})
