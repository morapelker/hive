import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UsageAccountRow } from './UsageIndicator'
import type { UsageData } from '@shared/types/usage'

afterEach(() => {
  cleanup()
})

const sampleUsage: UsageData = {
  five_hour: { utilization: 20, resets_at: '2026-05-14T12:00:00.000Z' },
  seven_day: { utilization: 10, resets_at: '2026-05-15T12:00:00.000Z' }
}

describe('UsageAccountRow', () => {
  it('hides the Switch button for the active account', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-1',
          email: 'active@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: true,
          isRefreshing: false
        }}
        onSwitch={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: /switch to/i })).toBeNull()
  })

  it('renders real seven_day usage when the idle five_hour window has a null resets_at', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-idle',
          email: 'noa@example.com',
          usage: {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 66, resets_at: '2026-07-10T01:59:59.000Z' }
          },
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
        onSwitch={vi.fn()}
      />
    )

    expect(screen.getByText('66%')).toBeTruthy()
    expect(screen.getByText('N/A')).toBeTruthy()
  })

  it('shows a Switch button for a non-active account and calls onSwitch when clicked', async () => {
    const user = userEvent.setup()
    const onSwitch = vi.fn()
    render(
      <UsageAccountRow
        row={{
          id: 'acc-2',
          email: 'other@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
        onSwitch={onSwitch}
      />
    )

    const button = screen.getByRole('button', {
      name: /switch to other@example.com/i
    }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await user.click(button)
    expect(onSwitch).toHaveBeenCalledTimes(1)
  })

  it('disables the Switch button and shows a spinner while switching', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-3',
          email: 'other@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
        isSwitching
        onSwitch={vi.fn()}
      />
    )

    const button = screen.getByRole('button', {
      name: /switch to other@example.com/i
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('shows Sign in again only when the account status is stale', () => {
    const { rerender } = render(
      <UsageAccountRow
        row={{
          id: 'acc-4',
          email: 'expired@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
        onSignInAgain={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /sign in again/i })).toBeNull()

    rerender(
      <UsageAccountRow
        row={{
          id: 'acc-4',
          email: 'expired@example.com',
          usage: sampleUsage,
          status: 'stale',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
        onSignInAgain={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /sign in again/i })).not.toBeNull()
  })

  it('disables Sign in again while a login is already active', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-5',
          email: 'expired@example.com',
          usage: sampleUsage,
          status: 'stale',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
        isLoginActive
        onSignInAgain={vi.fn()}
      />
    )

    const button = screen.getByRole('button', { name: /sign in again/i }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('renders one extra row per scoped usage entry, labeled from the API', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-6',
          email: 'scoped@example.com',
          usage: { ...sampleUsage, scoped: [{ label: 'Fable', used_percent: 55, resets_at: null }] },
          status: 'ok',
          lastError: null,
          isActive: true,
          isRefreshing: false
        }}
      />
    )

    expect(screen.getByText('Fable')).not.toBeNull()
    expect(screen.getByText('55%')).not.toBeNull()
  })

  it('does not render scoped rows when the usage payload has none', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-7',
          email: 'plain@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: true,
          isRefreshing: false
        }}
      />
    )

    expect(screen.queryByText('Fable')).toBeNull()
  })
})
