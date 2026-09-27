import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OpenAIResetControls, OpenAIResetDialog } from './OpenAIResetControls'
import { useOpenAIResetsStore } from '@/stores/useOpenAIResetsStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { usageApi } from '@/api/usage-api'
vi.mock('@/api/usage-api', () => ({
  usageApi: { listOpenaiResets: vi.fn(), consumeOpenaiReset: vi.fn() }
}))
const credit = {
  id: 'credit',
  reset_type: 'full',
  status: 'available',
  granted_at: '2026-01-01',
  expires_at: '2026-12-01T00:00:00Z',
  title: 'Full reset'
}
beforeEach(() => {
  vi.clearAllMocks()
  useOpenAIResetsStore.setState({
    accounts: {},
    selection: null,
    pending: false,
    error: null,
    message: null
  })
  vi.mocked(usageApi.listOpenaiResets).mockResolvedValue({ available_count: 3, credits: [credit] })
  useUsageStore.setState({ refreshSavedAccount: vi.fn().mockResolvedValue(undefined) })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
it('shows count and expiry, requires confirmation, and cancels without spending a reset', async () => {
  const controls = render(
    <>
      <OpenAIResetControls accountId="a" email="selected@example.com" />
      <OpenAIResetDialog />
    </>
  )
  const button = await screen.findByRole('button', {
    name: '3 usage resets available for selected@example.com'
  })
  fireEvent.click(button)
  expect(await screen.findByText(/Expires/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Use reset' }))
  expect(await screen.findByRole('dialog')).toHaveTextContent('Are you sure')
  expect(screen.getByRole('dialog')).toHaveTextContent('selected@example.com')
  expect(usageApi.consumeOpenaiReset).not.toHaveBeenCalled()
  // Closing the containing hover popover must not dismiss the modal.
  controls.rerender(<OpenAIResetDialog />)
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(usageApi.consumeOpenaiReset).not.toHaveBeenCalled()
})
it('hides accounts without available resets', async () => {
  vi.mocked(usageApi.listOpenaiResets).mockResolvedValue({ available_count: 0, credits: [] })
  render(<OpenAIResetControls accountId="empty" email="empty@example.com" />)
  await waitFor(() => expect(useOpenAIResetsStore.getState().accounts.empty?.loading).toBe(false))
  expect(screen.queryByRole('button')).toBeNull()
})
it('retries the same redemption after an uncertain result and refreshes without requiring usage to change', async () => {
  vi.useFakeTimers()
  vi.mocked(usageApi.consumeOpenaiReset)
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValueOnce({ code: 'already_redeemed', windows_reset: 2 })
  useUsageStore.setState({
    refreshSavedAccount: vi.fn().mockRejectedValue(new Error('usage delayed'))
  })
  useOpenAIResetsStore.getState().select('retry-account', 'selected@example.com', credit)
  const first = useOpenAIResetsStore.getState().selection!.requestId
  await useOpenAIResetsStore.getState().consume()
  expect(useOpenAIResetsStore.getState().error).toMatch(/Could not confirm/)
  useOpenAIResetsStore.getState().close()
  useOpenAIResetsStore.getState().select('retry-account', 'selected@example.com', credit)
  expect(useOpenAIResetsStore.getState().selection!.requestId).toBe(first)
  await useOpenAIResetsStore.getState().consume()
  expect(useOpenAIResetsStore.getState().message).toMatch(/successfully/)
  expect(useOpenAIResetsStore.getState().error).toBeNull()
  expect(usageApi.consumeOpenaiReset).toHaveBeenNthCalledWith(2, 'retry-account', first, 'credit')
  expect(useUsageStore.getState().refreshSavedAccount).toHaveBeenCalledWith('retry-account', {
    userInitiated: true
  })
  await act(async () => {
    await vi.runAllTimersAsync()
  })
})
it('prevents duplicate submissions while the reset is pending', async () => {
  let resolve!: (result: { code: 'nothing_to_reset'; windows_reset: number }) => void
  vi.mocked(usageApi.consumeOpenaiReset).mockReturnValue(
    new Promise((r) => {
      resolve = r
    })
  )
  useOpenAIResetsStore.getState().select('double-account', 'selected@example.com', credit)
  const pending = useOpenAIResetsStore.getState().consume()
  await useOpenAIResetsStore.getState().consume()
  useOpenAIResetsStore.getState().close()
  expect(useOpenAIResetsStore.getState().selection).not.toBeNull()
  expect(usageApi.consumeOpenaiReset).toHaveBeenCalledTimes(1)
  resolve({ code: 'nothing_to_reset', windows_reset: 0 })
  await pending
  expect(useOpenAIResetsStore.getState().message).toMatch(/does not need/)
})

it('submits only after confirmation and updates an exhausted credit list', async () => {
  vi.mocked(usageApi.consumeOpenaiReset).mockResolvedValue({ code: 'no_credit', windows_reset: 0 })
  vi.mocked(usageApi.listOpenaiResets).mockResolvedValue({ available_count: 0, credits: [] })
  useOpenAIResetsStore.getState().select('exhausted', 'selected@example.com', credit)
  render(<OpenAIResetDialog />)
  expect(usageApi.consumeOpenaiReset).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use one reset' }))
  expect(await screen.findByText(/That reset is no longer available/)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled())
  expect(screen.getByText('0 resets remaining.')).toBeInTheDocument()
  expect(usageApi.consumeOpenaiReset).toHaveBeenCalledWith(
    'exhausted',
    expect.any(String),
    'credit'
  )
})

it('waits for an older list request before refreshing credits after redemption', async () => {
  let finishOldList!: (data: { available_count: number; credits: (typeof credit)[] }) => void
  vi.mocked(usageApi.listOpenaiResets)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishOldList = resolve
      })
    )
    .mockResolvedValueOnce({ available_count: 0, credits: [] })
  vi.mocked(usageApi.consumeOpenaiReset).mockResolvedValue({ code: 'no_credit', windows_reset: 0 })
  const oldRequest = useOpenAIResetsStore.getState().load('race')
  useOpenAIResetsStore.getState().select('race', 'selected@example.com', credit)
  const redemption = useOpenAIResetsStore.getState().consume()
  await Promise.resolve()
  finishOldList({ available_count: 1, credits: [credit] })
  await Promise.all([oldRequest, redemption])
  expect(usageApi.listOpenaiResets).toHaveBeenCalledTimes(2)
  expect(useOpenAIResetsStore.getState().accounts.race.data?.available_count).toBe(0)
})
