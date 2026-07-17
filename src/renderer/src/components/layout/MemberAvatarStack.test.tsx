import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { MemberAvatarStack, type AccountMemberInfo } from './MemberAvatarStack'

// Radix's Tooltip content renders an Arrow that measures itself via
// `useSize`, which unconditionally constructs a `ResizeObserver` — jsdom has
// none. Stub it so hovering a trigger open doesn't throw.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub

afterEach(() => {
  cleanup()
})

function renderStack(props: { members: AccountMemberInfo[] | undefined; loading: boolean }): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <MemberAvatarStack {...props} />
    </TooltipProvider>
  )
}

function makeMember(overrides: Partial<AccountMemberInfo> = {}): AccountMemberInfo {
  return {
    id: 'member-1',
    email: 'alice@example.com',
    name: 'Alice',
    picture: null,
    ...overrides
  }
}

describe('MemberAvatarStack', () => {
  it('shows a skeleton circle while loading', () => {
    renderStack({ members: undefined, loading: true })

    expect(screen.getByTestId('member-avatar-stack-loading')).toBeTruthy()
    expect(screen.queryAllByTestId('member-avatar')).toHaveLength(0)
  })

  it('renders one avatar per member when at or under the cap', () => {
    const members = [
      makeMember({ id: 'm1', name: 'Alice' }),
      makeMember({ id: 'm2', name: 'Bob' }),
      makeMember({ id: 'm3', name: 'Carol' })
    ]
    renderStack({ members, loading: false })

    expect(screen.getAllByTestId('member-avatar')).toHaveLength(3)
    expect(screen.queryByTestId('member-avatar-overflow')).toBeNull()
  })

  it('caps at 3 avatars and shows a +N overflow bubble for more than 3 members', () => {
    const members = [
      makeMember({ id: 'm1', name: 'Alice' }),
      makeMember({ id: 'm2', name: 'Bob' }),
      makeMember({ id: 'm3', name: 'Carol' }),
      makeMember({ id: 'm4', name: 'Dave' }),
      makeMember({ id: 'm5', name: 'Eve' })
    ]
    renderStack({ members, loading: false })

    expect(screen.getAllByTestId('member-avatar')).toHaveLength(3)
    const overflow = screen.getByTestId('member-avatar-overflow')
    expect(overflow.textContent).toBe('+2')
  })

  it('falls back to initials when the member has no picture', () => {
    renderStack({
      members: [makeMember({ id: 'm1', name: 'Alice', picture: null })],
      loading: false
    })

    expect(screen.getByText('A')).toBeTruthy()
  })

  it('falls back to initials from the email when name is null and there is no picture', () => {
    renderStack({
      members: [makeMember({ id: 'm1', name: null, email: 'bob@example.com', picture: null })],
      loading: false
    })

    expect(screen.getByText('b')).toBeTruthy()
  })

  it('falls back to initials when the avatar image fails to load', () => {
    renderStack({
      members: [
        makeMember({ id: 'm1', name: 'Alice', picture: 'https://example.com/alice.png' })
      ],
      loading: false
    })

    const img = screen.getByRole('img', { hidden: true }) as HTMLImageElement
    fireEvent.error(img)

    expect(screen.getByText('A')).toBeTruthy()
  })

  it('shows the member name in a tooltip on hover', async () => {
    const user = userEvent.setup()
    renderStack({
      members: [makeMember({ id: 'm1', name: 'Alice', email: 'alice@example.com' })],
      loading: false
    })

    await user.hover(screen.getByTestId('member-avatar'))

    const tooltip = await screen.findByRole('tooltip')
    expect(within(tooltip).getByText('Alice')).toBeTruthy()
  })

  it('falls back to the email in the tooltip when the member has no name', async () => {
    const user = userEvent.setup()
    renderStack({
      members: [makeMember({ id: 'm2', name: null, email: 'bob@example.com' })],
      loading: false
    })

    await user.hover(screen.getByTestId('member-avatar'))

    const tooltip = await screen.findByRole('tooltip')
    expect(within(tooltip).getByText('bob@example.com')).toBeTruthy()
  })

  it('lists the remaining member names one per line in the overflow tooltip', async () => {
    const user = userEvent.setup()
    const members = [
      makeMember({ id: 'm1', name: 'Alice' }),
      makeMember({ id: 'm2', name: 'Bob' }),
      makeMember({ id: 'm3', name: 'Carol' }),
      makeMember({ id: 'm4', name: 'Dave' }),
      makeMember({ id: 'm5', name: null, email: 'eve@example.com' })
    ]
    renderStack({ members, loading: false })

    const overflow = screen.getByTestId('member-avatar-overflow')
    await user.hover(overflow)

    const tooltip = await screen.findByRole('tooltip')
    expect(within(tooltip).getByText('Dave')).toBeTruthy()
    expect(within(tooltip).getByText('eve@example.com')).toBeTruthy()
  })

  it('renders nothing when members is undefined and not loading', () => {
    const { container } = renderStack({ members: undefined, loading: false })
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when members is an empty array and not loading', () => {
    const { container } = renderStack({ members: [], loading: false })
    expect(container.firstChild).toBeNull()
  })
})
