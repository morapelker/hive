import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { UsageAccountRow } from './UsageIndicator'
import type { AccountMemberInfo } from './MemberAvatarStack'
import type { UsageData } from '@shared/types/usage'

afterEach(() => {
  cleanup()
})

const inOneHour = (): string => new Date(Date.now() + 60 * 60 * 1000).toISOString()
const inOneDay = (): string => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
const oneHourAgo = (): string => new Date(Date.now() - 60 * 60 * 1000).toISOString()

const sampleUsage: UsageData = {
  five_hour: { utilization: 20, resets_at: inOneHour() },
  seven_day: { utilization: 10, resets_at: inOneDay() }
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
            seven_day: { utilization: 66, resets_at: inOneDay() }
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

  it('shows N/A and an empty bar for a window whose reset time is in the past', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-stale-window',
          email: 'stale@example.com',
          usage: {
            five_hour: { utilization: 42, resets_at: oneHourAgo() },
            seven_day: { utilization: 66, resets_at: inOneDay() }
          },
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
      />
    )

    // Stale five_hour window: percent and reset time are both replaced
    expect(screen.queryByText('42%')).toBeNull()
    expect(screen.getByText('0%')).toBeTruthy()
    expect(screen.getByText('N/A')).toBeTruthy()
    // Fresh seven_day window still renders normally
    expect(screen.getByText('66%')).toBeTruthy()
  })

  it('shows N/A and an empty bar for a scoped entry whose reset time is in the past', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-stale-scoped',
          email: 'stale-scoped@example.com',
          usage: {
            ...sampleUsage,
            scoped: [{ label: 'Fable', used_percent: 55, resets_at: oneHourAgo() }]
          },
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
      />
    )

    expect(screen.getByText('Fable')).toBeTruthy()
    expect(screen.queryByText('55%')).toBeNull()
    expect(screen.getByText('0%')).toBeTruthy()
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

  it('shows a Refresh button and calls onRefresh when clicked', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    render(
      <UsageAccountRow
        row={{
          id: 'acc-r1',
          email: 'other@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
        onSwitch={vi.fn()}
        onRefresh={onRefresh}
      />
    )

    const button = screen.getByRole('button', {
      name: /refresh usage for other@example.com/i
    }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await user.click(button)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('shows the Refresh button for the active account too', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-r2',
          email: 'active@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: true,
          isRefreshing: false
        }}
        onSwitch={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: /switch to/i })).toBeNull()
    expect(
      screen.getByRole('button', { name: /refresh usage for active@example.com/i })
    ).toBeTruthy()
  })

  it('disables the Refresh button while the account is refreshing', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-r3',
          email: 'other@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: true
        }}
        onSwitch={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    const button = screen.getByRole('button', {
      name: /refresh usage for other@example.com/i
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('does not render a Refresh button when onRefresh is not provided', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'anthropic-active',
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

    expect(screen.queryByRole('button', { name: /refresh usage/i })).toBeNull()
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

  it('renders the member avatar stack when members is given', () => {
    const members: AccountMemberInfo[] = [
      { id: 'member-1', email: 'alice@example.com', name: 'Alice', picture: null }
    ]
    render(
      <TooltipProvider>
        <UsageAccountRow
          row={{
            id: 'acc-8',
            email: 'shared@example.com',
            usage: sampleUsage,
            status: 'ok',
            lastError: null,
            isActive: true,
            isRefreshing: false
          }}
          members={members}
          membersLoading={false}
        />
      </TooltipProvider>
    )

    expect(screen.getByTestId('member-avatar')).toBeTruthy()
  })

  it('renders nothing from the avatar stack when members is undefined', () => {
    render(
      <UsageAccountRow
        row={{
          id: 'acc-9',
          email: 'shared@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: true,
          isRefreshing: false
        }}
      />
    )

    expect(screen.queryByTestId('member-avatar')).toBeNull()
    expect(screen.queryByTestId('member-avatar-stack-loading')).toBeNull()
  })
})
