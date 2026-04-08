import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '../../../src/renderer/src/components/ui/dialog'
import { PRNotificationStack } from '../../../src/renderer/src/components/pr/PRNotificationStack'
import { usePRNotificationStore } from '../../../src/renderer/src/stores/usePRNotificationStore'

describe('Session 6: PR notification stack layering', () => {
  beforeEach(() => {
    act(() => {
      usePRNotificationStore.setState({ notifications: [] })
    })
  })

  afterEach(() => {
    act(() => {
      usePRNotificationStore.setState({ notifications: [] })
    })
  })

  test('renders above dialog layers when a modal is open', async () => {
    act(() => {
      usePRNotificationStore.getState().show({
        status: 'success',
        message: 'PR created',
        description: 'Ready to review',
        prUrl: 'https://github.com/org/repo/pull/1'
      })
    })

    render(
      <>
        <PRNotificationStack />
        <Dialog open={true}>
          <DialogContent>
            <DialogTitle>Ticket modal</DialogTitle>
            <DialogDescription>Ticket actions</DialogDescription>
            <div>Ticket modal</div>
          </DialogContent>
        </Dialog>
      </>
    )

    const stack = await screen.findByTestId('pr-notification-stack')
    const dialog = await screen.findByRole('dialog')

    expect(stack).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
    expect(stack).toHaveClass('z-[60]')
    expect(dialog).toHaveClass('z-50')
    expect(screen.getByText('PR created')).toBeInTheDocument()
  })
})
