import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { ProviderUsageBlock, UsageAccountRow } from './UsageIndicator'
import { useAccountStore, useUsageStore } from '@/stores'
import type { AccountMemberInfo } from './MemberAvatarStack'
import type { OpenAIUsageData, UsageData } from '@shared/types/usage'

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

  it('draws a bold purple border on the active account when highlightActive is set', () => {
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
    expect(rowEl.className).toContain('border-purple-500')
    expect(rowEl.className).toContain('border-2')
  })

  it('does not draw the purple border on non-active accounts even when highlightActive is set', () => {
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

    expect((container.firstChild as HTMLElement).className).not.toContain('border-purple-500')
  })

  it('does not draw the purple border on the active account without highlightActive', () => {
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

    expect((container.firstChild as HTMLElement).className).not.toContain('border-purple-500')
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

  it('does not scroll back to the bottom when accounts load after the user scrolls up', async () => {
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

    const popover = screen.getByText('OpenAI API Usage').closest(
      '[data-slot="hover-card-content"]'
    ) as HTMLDivElement
    Object.defineProperties(popover, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 }
    })

    popover.scrollTop = 100
    fireEvent.scroll(popover)

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

    expect(popover.scrollTop).toBe(100)
  })
})
