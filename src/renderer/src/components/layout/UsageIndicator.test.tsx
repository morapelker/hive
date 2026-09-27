import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { ProviderUsageBlock, UsageAccountRow } from './UsageIndicator'
import { autoSwitchIneligibilityReason } from '@/lib/auto-switch-score'
import { useAccountStore, useUsageStore } from '@/stores'
import { useAccountScheduleStore } from '@/stores/useAccountScheduleStore'
import type { AccountMemberInfo } from './MemberAvatarStack'
import type { OpenAIUsageData, SavedAccountDTO, UsageData } from '@shared/types/usage'
import { nextUsageRefreshAt } from '@/hooks/useAccountScheduleRunner'

// Default to "nothing scheduled" so the countdown stays hidden in the
// unrelated tests, matching the real function's behavior when no session
// is running.
vi.mock('@/hooks/useAccountScheduleRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAccountScheduleRunner')>()
  return { ...actual, nextUsageRefreshAt: vi.fn(() => null) }
})

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

  it('includes the date in the five_hour reset time when it is more than 24h away', () => {
    const farReset = new Date(Date.now() + 30 * 60 * 60 * 1000)
    farReset.setMinutes(0, 0, 0)
    render(
      <UsageAccountRow
        row={{
          id: 'acc-far-window',
          email: 'far@example.com',
          usage: {
            five_hour: { utilization: 20, resets_at: farReset.toISOString() },
            seven_day: { utilization: 10, resets_at: null }
          },
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
      />
    )

    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec'
    ]
    const hour12 = farReset.getHours() % 12 || 12
    const ampm = farReset.getHours() >= 12 ? 'pm' : 'am'
    const expected = `${months[farReset.getMonth()]} ${farReset.getDate()}, ${hour12}${ampm}`
    expect(screen.getByText(expected)).toBeTruthy()
  })

  it('shows only the time for a five_hour reset within 24h', () => {
    const nearReset = new Date(Date.now() + 60 * 60 * 1000)
    nearReset.setMinutes(0, 0, 0)
    render(
      <UsageAccountRow
        row={{
          id: 'acc-near-window',
          email: 'near@example.com',
          usage: {
            five_hour: { utilization: 20, resets_at: nearReset.toISOString() },
            seven_day: { utilization: 10, resets_at: null }
          },
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
      />
    )

    const hour12 = nearReset.getHours() % 12 || 12
    const ampm = nearReset.getHours() >= 12 ? 'pm' : 'am'
    expect(screen.getByText(`${hour12}${ampm}`)).toBeTruthy()
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

  it('draws a neutral ring on the active account when highlightActive is set', () => {
    const { container } = render(
      <UsageAccountRow
        row={{
          id: 'acc-hl-1',
          email: 'active@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: true,
          isRefreshing: false
        }}
        highlightActive
      />
    )

    const rowEl = container.firstChild as HTMLElement
    expect(rowEl.className).toContain('ring-1')
    expect(rowEl.className).toContain('ring-ring/50')
  })

  it('does not draw the active ring on non-active accounts even when highlightActive is set', () => {
    const { container } = render(
      <UsageAccountRow
        row={{
          id: 'acc-hl-2',
          email: 'other@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: false,
          isRefreshing: false
        }}
        highlightActive
      />
    )

    expect((container.firstChild as HTMLElement).className).not.toContain('ring-ring/50')
  })

  it('does not draw the active ring on the active account without highlightActive', () => {
    const { container } = render(
      <UsageAccountRow
        row={{
          id: 'acc-hl-3',
          email: 'active@example.com',
          usage: sampleUsage,
          status: 'ok',
          lastError: null,
          isActive: true,
          isRefreshing: false
        }}
      />
    )

    expect((container.firstChild as HTMLElement).className).not.toContain('ring-ring/50')
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

  it('renders a non-blocking opacity overlay when given an auto-switch ineligibility reason', async () => {
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
        autoSwitchIneligibleReason="At 85% — auto-switch only targets accounts below 80%"
      />
    )

    const overlay = screen.getByTestId('auto-switch-ineligible-overlay')
    expect(overlay.getAttribute('title')).toBe(
      'At 85% — auto-switch only targets accounts below 80%'
    )
    expect(overlay.className).toContain('pointer-events-none')
    // The overlay dims but doesn't block: manual switching still works.
    await user.click(screen.getByRole('button', { name: /switch to other@example.com/i }))
    expect(onSwitch).toHaveBeenCalledTimes(1)
  })

  it('renders no overlay without an ineligibility reason', () => {
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
      />
    )
    expect(screen.queryByTestId('auto-switch-ineligible-overlay')).toBeNull()
  })
})

describe('autoSwitchIneligibilityReason', () => {
  const now = Date.now()
  const base = { status: 'ok' as const, isActive: false }

  it('is null when auto-switch is not armed', () => {
    const usage: UsageData = {
      five_hour: { utilization: 95, resets_at: inOneHour() },
      seven_day: { utilization: 10, resets_at: inOneDay() }
    }
    expect(autoSwitchIneligibilityReason({ ...base, usage }, undefined, now)).toBeNull()
  })

  it('flags an account whose max window is at or over the threshold', () => {
    const usage: UsageData = {
      five_hour: { utilization: 20, resets_at: inOneHour() },
      seven_day: { utilization: 80, resets_at: inOneDay() }
    }
    expect(autoSwitchIneligibilityReason({ ...base, usage }, 80, now)).toMatch(/At 80%/)
    expect(autoSwitchIneligibilityReason({ ...base, usage }, 81, now)).toBeNull()
  })

  it('ignores windows whose reset time has already passed', () => {
    const usage: UsageData = {
      five_hour: { utilization: 99, resets_at: oneHourAgo() },
      seven_day: { utilization: 10, resets_at: inOneDay() }
    }
    expect(autoSwitchIneligibilityReason({ ...base, usage }, 80, now)).toBeNull()
  })

  it('never flags the active account, and does not flag unknown usage', () => {
    const usage: UsageData = {
      five_hour: { utilization: 99, resets_at: inOneHour() },
      seven_day: { utilization: 10, resets_at: inOneDay() }
    }
    expect(
      autoSwitchIneligibilityReason({ ...base, usage, isActive: true }, 80, now)
    ).toBeNull()
    expect(autoSwitchIneligibilityReason({ ...base, usage: null }, 80, now)).toBeNull()
  })

  it('flags stale and errored accounts', () => {
    expect(
      autoSwitchIneligibilityReason({ ...base, usage: null, status: 'stale' }, 80, now)
    ).toMatch(/expired/i)
    expect(
      autoSwitchIneligibilityReason({ ...base, usage: null, status: 'error' }, 80, now)
    ).toMatch(/refresh failed/i)
  })
})

describe('UsageAccountRow refresh countdown', () => {
  const initialLastFetchedAt = useUsageStore.getState().anthropicLastFetchedAt

  beforeEach(() => {
    vi.mocked(nextUsageRefreshAt).mockReturnValue(null)
    useUsageStore.setState({ anthropicLastFetchedAt: null })
  })

  afterEach(() => {
    useUsageStore.setState({ anthropicLastFetchedAt: initialLastFetchedAt })
  })

  const activeRow = {
    id: 'acc-1',
    email: 'active@example.com',
    usage: sampleUsage,
    status: 'ok' as const,
    lastError: null,
    isActive: true,
    isRefreshing: false
  }

  it('shows a seconds countdown on the active row when a refresh is scheduled', () => {
    vi.mocked(nextUsageRefreshAt).mockImplementation(() => Date.now() + 45_000)

    render(<UsageAccountRow row={activeRow} provider="anthropic" onRefresh={vi.fn()} />)

    expect(screen.getByTestId('usage-refresh-countdown').textContent).toMatch(
      /^Refreshing in \d+ sec$/
    )
  })

  it('shows minutes once the next refresh is over a minute away', () => {
    vi.mocked(nextUsageRefreshAt).mockImplementation(() => Date.now() + 150_000)

    render(<UsageAccountRow row={activeRow} provider="anthropic" onRefresh={vi.fn()} />)

    expect(screen.getByTestId('usage-refresh-countdown').textContent).toMatch(
      /^Refreshing in \d+ min$/
    )
  })

  it('shows "Refreshing soon" when the scheduled time has already passed', () => {
    vi.mocked(nextUsageRefreshAt).mockImplementation(() => Date.now() - 5_000)

    render(<UsageAccountRow row={activeRow} provider="anthropic" onRefresh={vi.fn()} />)

    expect(screen.getByTestId('usage-refresh-countdown').textContent).toBe('Refreshing soon')
  })

  it('shows how long ago usage was refreshed when nothing is scheduled', () => {
    useUsageStore.setState({ anthropicLastFetchedAt: Date.now() - 5 * 60_000 })

    render(<UsageAccountRow row={activeRow} provider="anthropic" onRefresh={vi.fn()} />)

    expect(screen.getByTestId('usage-refresh-countdown').textContent).toMatch(
      /^Refreshed \d+ min ago$/
    )
  })

  it('shows "Refreshed just now" right after an idle refresh', () => {
    useUsageStore.setState({ anthropicLastFetchedAt: Date.now() })

    render(<UsageAccountRow row={activeRow} provider="anthropic" onRefresh={vi.fn()} />)

    expect(screen.getByTestId('usage-refresh-countdown').textContent).toBe('Refreshed just now')
  })

  it('is hidden when nothing is scheduled and usage was never fetched', () => {
    render(<UsageAccountRow row={activeRow} provider="anthropic" onRefresh={vi.fn()} />)

    expect(screen.queryByTestId('usage-refresh-countdown')).toBeNull()
  })

  it('is hidden on inactive account rows', () => {
    vi.mocked(nextUsageRefreshAt).mockImplementation(() => Date.now() + 45_000)

    render(
      <UsageAccountRow
        row={{ ...activeRow, isActive: false }}
        provider="anthropic"
        onRefresh={vi.fn()}
        onSwitch={vi.fn()}
      />
    )

    expect(screen.queryByTestId('usage-refresh-countdown')).toBeNull()
  })
})

describe('ProviderUsageBlock provider toggle', () => {
  const initialUsageState = useUsageStore.getState()
  const initialAccountState = useAccountStore.getState()

  const epochIn = (seconds: number): number => Math.floor(Date.now() / 1000) + seconds

  const sampleOpenAIUsage: OpenAIUsageData = {
    plan_type: 'plus',
    rate_limit: {
      primary_window: {
        used_percent: 30,
        limit_window_seconds: 18000,
        reset_after_seconds: 3600,
        reset_at: epochIn(3600)
      },
      secondary_window: {
        used_percent: 12,
        limit_window_seconds: 604800,
        reset_after_seconds: 86400,
        reset_at: epochIn(86400)
      }
    }
  }

  beforeEach(() => {
    useUsageStore.setState({
      anthropicUsage: sampleUsage,
      openaiUsage: sampleOpenAIUsage,
      savedAccounts: { anthropic: [], openai: [] },
      loadSavedAccounts: async () => {}
    })
    useAccountStore.setState({
      anthropicEmail: 'claude@example.com',
      openaiEmail: 'openai@example.com'
    })
  })

  afterEach(() => {
    // Unmount before restoring: swapping the stubbed loadSavedAccounts back to
    // the real action while components are mounted re-fires their effects
    // against the mocked RPC, corrupting savedAccounts for the next test.
    cleanup()
    useUsageStore.setState(initialUsageState, true)
    useAccountStore.setState(initialAccountState, true)
  })

  it('shows a toggle defaulting to the hovered provider and swaps content on click', async () => {
    const user = userEvent.setup()
    render(
      <ProviderUsageBlock
        provider="openai"
        isExplicitlySelected
        toggleProviders={['anthropic', 'openai']}
      />
    )

    await user.hover(screen.getByTestId('usage-trigger-openai'))
    await screen.findByText('OpenAI API Usage')

    const claudeButton = screen.getByRole('button', { name: 'Show Claude usage' })
    const openaiButton = screen.getByRole('button', { name: 'Show OpenAI usage' })
    expect(openaiButton.getAttribute('aria-pressed')).toBe('true')
    expect(claudeButton.getAttribute('aria-pressed')).toBe('false')

    await user.click(claudeButton)
    await screen.findByText('Claude API Usage')
    expect(screen.queryByText('OpenAI API Usage')).toBeNull()
    expect(screen.getByText('claude@example.com')).toBeTruthy()
    expect(claudeButton.getAttribute('aria-pressed')).toBe('true')
  })

  it('resets to the hovered provider when the popover reopens', async () => {
    const user = userEvent.setup()
    render(
      <ProviderUsageBlock
        provider="openai"
        isExplicitlySelected
        toggleProviders={['anthropic', 'openai']}
      />
    )

    const trigger = screen.getByTestId('usage-trigger-openai')
    await user.hover(trigger)
    await screen.findByText('OpenAI API Usage')
    await user.click(screen.getByRole('button', { name: 'Show Claude usage' }))
    await screen.findByText('Claude API Usage')

    await user.unhover(screen.getByText('Claude API Usage'))
    await waitFor(() => expect(screen.queryByText('Claude API Usage')).toBeNull(), {
      timeout: 3000
    })

    await user.hover(trigger)
    await screen.findByText('OpenAI API Usage')
    expect(screen.queryByText('Claude API Usage')).toBeNull()
  })

  it('hides the toggle when only one provider is visible', async () => {
    const user = userEvent.setup()
    render(
      <ProviderUsageBlock
        provider="anthropic"
        isExplicitlySelected
        toggleProviders={['anthropic']}
      />
    )

    await user.hover(screen.getByTestId('usage-trigger-anthropic'))
    await screen.findByText('Claude API Usage')
    expect(screen.queryByTestId('usage-provider-toggle')).toBeNull()
    expect(screen.queryByRole('button', { name: /show .* usage/i })).toBeNull()
  })

  it('does not move the scroll position when accounts load after opening', async () => {
    const user = userEvent.setup()
    render(
      <ProviderUsageBlock
        provider="openai"
        isExplicitlySelected
        toggleProviders={['openai']}
      />
    )

    await user.hover(screen.getByTestId('usage-trigger-openai'))
    await screen.findByText('OpenAI API Usage')

    const scroller = screen.getByTestId('usage-popover-scroll') as HTMLDivElement
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 }
    })

    expect(scroller.scrollTop).toBe(0)

    act(() => {
      useUsageStore.setState((state) => ({
        savedAccounts: {
          ...state.savedAccounts,
          openai: [
            {
              id: 'openai-loaded-account',
              provider: 'openai',
              email: 'loaded@example.com',
              last_usage: sampleOpenAIUsage,
              last_fetched_at: null,
              status: 'ok',
              last_error: null,
              created_at: new Date().toISOString(),
              plan: 'plus'
            }
          ]
        }
      }))
    })

    expect(scroller.scrollTop).toBe(0)
  })

  it('preserves a user scroll position when accounts load', async () => {
    const user = userEvent.setup()
    render(
      <ProviderUsageBlock
        provider="openai"
        isExplicitlySelected
        toggleProviders={['openai']}
      />
    )

    await user.hover(screen.getByTestId('usage-trigger-openai'))
    await screen.findByText('OpenAI API Usage')

    const scroller = screen.getByTestId('usage-popover-scroll') as HTMLDivElement
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 }
    })

    scroller.scrollTop = 100
    fireEvent.scroll(scroller)

    act(() => {
      useUsageStore.setState((state) => ({
        savedAccounts: {
          ...state.savedAccounts,
          openai: [
            {
              id: 'openai-loaded-account',
              provider: 'openai',
              email: 'loaded@example.com',
              last_usage: sampleOpenAIUsage,
              last_fetched_at: null,
              status: 'ok',
              last_error: null,
              created_at: new Date().toISOString(),
              plan: 'plus'
            }
          ]
        }
      }))
    })

    expect(scroller.scrollTop).toBe(100)
  })

  it('renders the active account first among multiple accounts', async () => {
    const user = userEvent.setup()
    useUsageStore.setState((state) => ({
      savedAccounts: {
        ...state.savedAccounts,
        openai: [
          {
            id: 'openai-inactive',
            provider: 'openai',
            email: 'inactive@example.com',
            last_usage: sampleOpenAIUsage,
            last_fetched_at: null,
            status: 'ok',
            last_error: null,
            created_at: new Date().toISOString(),
            plan: 'plus'
          },
          {
            id: 'openai-active',
            provider: 'openai',
            email: 'openai@example.com',
            last_usage: sampleOpenAIUsage,
            last_fetched_at: null,
            status: 'ok',
            last_error: null,
            created_at: new Date().toISOString(),
            plan: 'plus'
          }
        ]
      }
    }))

    render(
      <ProviderUsageBlock
        provider="openai"
        isExplicitlySelected
        toggleProviders={['openai']}
      />
    )

    await user.hover(screen.getByTestId('usage-trigger-openai'))
    await screen.findByText('OpenAI API Usage')

    const active = screen.getByText('openai@example.com')
    const inactive = screen.getByText('inactive@example.com')
    expect(
      active.compareDocumentPosition(inactive) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('orders inactive accounts by soonest 7d reset, then Fable, then 5h', async () => {
    const user = userEvent.setup()
    const account = (id: string, email: string, last_usage: UsageData): SavedAccountDTO => ({
      id,
      provider: 'anthropic',
      email,
      last_usage,
      last_fetched_at: null,
      status: 'ok',
      last_error: null,
      created_at: new Date().toISOString(),
      plan: null
    })
    const at = (hours: number): string =>
      new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()

    useUsageStore.setState((state) => ({
      savedAccounts: {
        ...state.savedAccounts,
        anthropic: [
          account('late-7d', 'late-7d@example.com', {
            five_hour: { utilization: 5, resets_at: at(1) },
            seven_day: { utilization: 5, resets_at: at(120) }
          }),
          account('tie-late-fable', 'tie-late-fable@example.com', {
            five_hour: { utilization: 5, resets_at: at(1) },
            seven_day: { utilization: 5, resets_at: at(48) },
            scoped: [{ label: 'Fable', used_percent: 5, resets_at: at(40) }]
          }),
          account('tie-soon-fable', 'tie-soon-fable@example.com', {
            five_hour: { utilization: 5, resets_at: at(4) },
            seven_day: { utilization: 5, resets_at: at(48) },
            scoped: [{ label: 'Fable', used_percent: 5, resets_at: at(10) }]
          }),
          account('active', 'claude@example.com', {
            five_hour: { utilization: 5, resets_at: at(4) },
            seven_day: { utilization: 5, resets_at: at(160) }
          }),
          account('soon-7d', 'soon-7d@example.com', {
            five_hour: { utilization: 5, resets_at: at(4) },
            seven_day: { utilization: 5, resets_at: at(24) }
          })
        ]
      }
    }))

    render(
      <ProviderUsageBlock
        provider="anthropic"
        isExplicitlySelected
        toggleProviders={['anthropic']}
      />
    )

    await user.hover(screen.getByTestId('usage-trigger-anthropic'))
    await screen.findByText('soon-7d@example.com')

    const emails = screen
      .getAllByText(/@example\.com$/)
      .map((el) => el.textContent)
      .filter((text) => text !== null && text.endsWith('@example.com'))
    expect(emails).toEqual([
      'claude@example.com',
      'soon-7d@example.com',
      'tie-soon-fable@example.com',
      'tie-late-fable@example.com',
      'late-7d@example.com'
    ])
  })

  it('puts potential auto-switch targets above ineligible accounts, each by 7d reset', async () => {
    const user = userEvent.setup()
    const account = (
      id: string,
      email: string,
      last_usage: UsageData,
      status: SavedAccountDTO['status'] = 'ok'
    ): SavedAccountDTO => ({
      id,
      provider: 'anthropic',
      email,
      last_usage,
      last_fetched_at: null,
      status,
      last_error: null,
      created_at: new Date().toISOString(),
      plan: null
    })
    const at = (hours: number): string =>
      new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
    const usageAt = (utilization: number, sevenDayHours: number): UsageData => ({
      five_hour: { utilization, resets_at: at(1) },
      seven_day: { utilization, resets_at: at(sevenDayHours) }
    })

    useAccountScheduleStore.setState({
      schedules: {},
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 80, createdAt: Date.now() }
      }
    })
    useUsageStore.setState((state) => ({
      savedAccounts: {
        ...state.savedAccounts,
        anthropic: [
          // Over threshold but frees up soonest: must still sit below every target.
          account('over-soon', 'over-soon@example.com', usageAt(90, 12)),
          account('target-late', 'target-late@example.com', usageAt(10, 96)),
          account('expired', 'expired@example.com', usageAt(10, 6), 'stale'),
          account('active', 'claude@example.com', usageAt(95, 160)),
          account('target-soon', 'target-soon@example.com', usageAt(10, 48)),
          account('over-late', 'over-late@example.com', usageAt(85, 120))
        ]
      }
    }))

    try {
      render(
        <ProviderUsageBlock
          provider="anthropic"
          isExplicitlySelected
          toggleProviders={['anthropic']}
        />
      )

      await user.hover(screen.getByTestId('usage-trigger-anthropic'))
      await screen.findByText('target-soon@example.com')

      const emails = screen
        .getAllByText(/@example\.com$/)
        .map((el) => el.textContent)
        .filter((text) => text !== null && text.endsWith('@example.com'))
      expect(emails).toEqual([
        'claude@example.com',
        'target-soon@example.com',
        'target-late@example.com',
        'expired@example.com',
        'over-soon@example.com',
        'over-late@example.com'
      ])
    } finally {
      useAccountScheduleStore.setState({ schedules: {}, autoSwitch: {} })
    }
  })

  it('shows the auto-switch shuffle icon in the bar when armed, instead of the timer', () => {
    useAccountScheduleStore.setState({
      schedules: {},
      autoSwitch: {
        anthropic: { provider: 'anthropic', thresholdPercent: 90, createdAt: Date.now() }
      }
    })
    render(
      <ProviderUsageBlock
        provider="anthropic"
        isExplicitlySelected
        toggleProviders={['anthropic']}
      />
    )

    expect(screen.getByLabelText(/auto-switch armed/i)).toBeTruthy()
    expect(screen.queryByLabelText(/account switch scheduled/i)).toBeNull()
    useAccountScheduleStore.setState({ schedules: {}, autoSwitch: {} })
  })

  it('shows the auto-switch controls in the popover only with multiple saved accounts', async () => {
    const user = userEvent.setup()
    useAccountScheduleStore.setState({ schedules: {}, autoSwitch: {} })
    useUsageStore.setState((state) => ({
      savedAccounts: {
        ...state.savedAccounts,
        openai: [
          {
            id: 'openai-1',
            provider: 'openai',
            email: 'one@example.com',
            last_usage: sampleOpenAIUsage,
            last_fetched_at: null,
            status: 'ok',
            last_error: null,
            created_at: new Date().toISOString(),
            plan: 'plus'
          },
          {
            id: 'openai-2',
            provider: 'openai',
            email: 'openai@example.com',
            last_usage: sampleOpenAIUsage,
            last_fetched_at: null,
            status: 'ok',
            last_error: null,
            created_at: new Date().toISOString(),
            plan: 'plus'
          }
        ]
      }
    }))

    render(
      <ProviderUsageBlock provider="openai" isExplicitlySelected toggleProviders={['openai']} />
    )

    await user.hover(screen.getByTestId('usage-trigger-openai'))
    await screen.findByText('OpenAI API Usage')
    expect(screen.getByTestId('auto-switch-controls')).toBeTruthy()
  })

  it('keeps the auto-switch controls visible while armed even with fewer than two accounts', async () => {
    // Armed, then the alternate account disappears (removed or load failure):
    // the only control that can disarm must not vanish with it.
    const user = userEvent.setup()
    useAccountScheduleStore.setState({
      schedules: {},
      autoSwitch: {
        openai: { provider: 'openai', thresholdPercent: 90, createdAt: Date.now() }
      }
    })

    render(
      <ProviderUsageBlock provider="openai" isExplicitlySelected toggleProviders={['openai']} />
    )

    await user.hover(screen.getByTestId('usage-trigger-openai'))
    await screen.findByText('OpenAI API Usage')
    expect(screen.getByTestId('auto-switch-controls')).toBeTruthy()
    useAccountScheduleStore.setState({ schedules: {}, autoSwitch: {} })
  })

  it('hides the auto-switch controls when only one account is saved', async () => {
    const user = userEvent.setup()
    useAccountScheduleStore.setState({ schedules: {}, autoSwitch: {} })
    render(
      <ProviderUsageBlock provider="openai" isExplicitlySelected toggleProviders={['openai']} />
    )

    await user.hover(screen.getByTestId('usage-trigger-openai'))
    await screen.findByText('OpenAI API Usage')
    expect(screen.queryByTestId('auto-switch-controls')).toBeNull()
  })

  it('dims saved accounts over the armed auto-switch threshold, but not the active or viable ones', async () => {
    const user = userEvent.setup()
    useAccountScheduleStore.setState({
      schedules: {},
      autoSwitch: { openai: { provider: 'openai', thresholdPercent: 80, createdAt: Date.now() } }
    })
    const usageAt = (percent: number): OpenAIUsageData => ({
      ...sampleOpenAIUsage,
      rate_limit: {
        ...sampleOpenAIUsage.rate_limit,
        primary_window: { ...sampleOpenAIUsage.rate_limit.primary_window!, used_percent: percent }
      }
    })
    const account = (id: string, email: string, percent: number) => ({
      id,
      provider: 'openai' as const,
      email,
      last_usage: usageAt(percent),
      last_fetched_at: null,
      status: 'ok' as const,
      last_error: null,
      created_at: new Date().toISOString(),
      plan: 'plus'
    })
    useUsageStore.setState((state) => ({
      savedAccounts: {
        ...state.savedAccounts,
        openai: [
          account('openai-active', 'openai@example.com', 95),
          account('openai-over', 'over@example.com', 90),
          account('openai-under', 'under@example.com', 30)
        ]
      }
    }))

    render(
      <ProviderUsageBlock provider="openai" isExplicitlySelected toggleProviders={['openai']} />
    )
    await user.hover(screen.getByTestId('usage-trigger-openai'))
    await screen.findByText('OpenAI API Usage')

    const overlays = screen.getAllByTestId('auto-switch-ineligible-overlay')
    expect(overlays).toHaveLength(1)
    expect(overlays[0].getAttribute('title')).toMatch(/At 90%.*below 80%/)
    const dimmedRow = overlays[0].parentElement!
    expect(dimmedRow.textContent).toContain('over@example.com')

    // Disarming removes the layer.
    act(() => useAccountScheduleStore.setState({ schedules: {}, autoSwitch: {} }))
    await waitFor(() =>
      expect(screen.queryByTestId('auto-switch-ineligible-overlay')).toBeNull()
    )
  })

  it('keeps the provider toggle outside the scroll container', async () => {
    const user = userEvent.setup()
    render(
      <ProviderUsageBlock
        provider="openai"
        isExplicitlySelected
        toggleProviders={['anthropic', 'openai']}
      />
    )

    await user.hover(screen.getByTestId('usage-trigger-openai'))
    await screen.findByText('OpenAI API Usage')

    const scroller = screen.getByTestId('usage-popover-scroll')
    const toggle = screen.getByTestId('usage-provider-toggle')
    expect(scroller.contains(toggle)).toBe(false)
  })
})
