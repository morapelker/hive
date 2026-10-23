// The confirmation flow end to end: runWithConfirmation re-calls with the token after Run,
// returns 'declined' on Cancel, shows the blocked dialog for 'blocked', re-asks after an expired
// token, declines when no host is mounted; the dialog orders dangerous statements first, shows the
// environment strip and class badges, gates Run behind the typed confirmation and runs on Cmd+Enter.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DataExecutionPlan } from '@shared/data-projects/types'

vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const { DataConfirmHost } = await import('./DataConfirmHost')
const { orderPlanStatements, runWithConfirmation, useDataConfirmStore } = await import('./confirm')

const plan = (overrides: Partial<DataExecutionPlan> = {}): DataExecutionPlan => ({
  dataProjectId: 'dp-1',
  projectName: 'orders-db',
  engine: 'postgres',
  environment: 'production',
  safeMode: 'half-safe',
  database: 'shop',
  statements: [
    {
      index: 0,
      text: 'SELECT 1',
      start: 0,
      end: 8,
      classification: 'read',
      dangerous: [],
      reasons: [],
      needsConfirmation: false
    },
    {
      index: 1,
      text: 'DELETE FROM orders',
      start: 10,
      end: 28,
      classification: 'write',
      dangerous: ['DELETE without WHERE removes every row of orders'],
      reasons: ['write'],
      needsConfirmation: true
    }
  ],
  ...overrides
})

afterEach(() => {
  useDataConfirmStore.getState().cancelAll()
  cleanup()
})

describe('runWithConfirmation', () => {
  it('re-calls with the token after Run', async () => {
    render(<DataConfirmHost />)
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'confirmation_required',
        plan: plan({ typedConfirmation: undefined }),
        confirmToken: 'tok-1'
      })
      .mockResolvedValueOnce({ status: 'ok', statements: [], durationMs: 3 })
    let result: unknown
    const done = runWithConfirmation(call).then((r) => (result = r))
    const dialog = await screen.findByTestId('data-project-confirm-dialog')
    expect(screen.getByTestId('data-project-confirm-env')).toHaveTextContent(
      'PRODUCTION · orders-db · shop'
    )
    // dangerous statement first, badges shown
    const items = screen.getByTestId('data-project-confirm-statements').querySelectorAll('li')
    expect(items[0]).toHaveTextContent('DELETE FROM orders')
    expect(items[0]).toHaveTextContent('DELETE without WHERE removes every row of orders')
    expect(screen.getByTestId('data-project-statement-badge-write')).toBeInTheDocument()
    expect(screen.getByTestId('data-project-statement-badge-read')).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-confirm-run'))
    })
    await done
    expect(call).toHaveBeenNthCalledWith(1)
    expect(call).toHaveBeenNthCalledWith(2, 'tok-1')
    expect(result).toEqual({ status: 'ok', statements: [], durationMs: 3 })
    expect(screen.queryByTestId('data-project-confirm-dialog')).toBeNull()
  })

  it('returns declined on Cancel without calling again', async () => {
    render(<DataConfirmHost />)
    const call = vi
      .fn()
      .mockResolvedValue({ status: 'confirmation_required', plan: plan(), confirmToken: 't' })
    const done = runWithConfirmation(call)
    await screen.findByTestId('data-project-confirm-dialog')
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-confirm-cancel'))
    })
    await expect(done).resolves.toEqual({ status: 'declined' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('puts focus back where the run started once the dialog closes', async () => {
    render(
      <>
        <textarea data-testid="editor" />
        <DataConfirmHost />
      </>
    )
    const editor = screen.getByTestId('editor')
    editor.focus()
    const call = vi
      .fn()
      .mockResolvedValue({ status: 'confirmation_required', plan: plan(), confirmToken: 't' })
    const done = runWithConfirmation(call)
    await screen.findByTestId('data-project-confirm-dialog')
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-confirm-cancel'))
    })
    await done
    await waitFor(() => expect(document.activeElement).toBe(editor))
  })

  it('gates Run behind the typed confirmation and runs on Cmd+Enter once typed', async () => {
    render(<DataConfirmHost />)
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'confirmation_required',
        plan: plan({ typedConfirmation: 'orders' }),
        confirmToken: 'tok'
      })
      .mockResolvedValueOnce({ status: 'ok', statements: [], durationMs: 1 })
    const done = runWithConfirmation(call)
    const run = await screen.findByTestId('data-project-confirm-run')
    expect(run).toBeDisabled()
    const input = screen.getByTestId('data-project-confirm-typed')
    fireEvent.change(input, { target: { value: 'order' } })
    expect(run).toBeDisabled()
    fireEvent.keyDown(screen.getByTestId('data-project-confirm-dialog'), {
      key: 'Enter',
      metaKey: true
    })
    expect(call).toHaveBeenCalledTimes(1)
    fireEvent.change(input, { target: { value: 'orders' } })
    expect(run).toBeEnabled()
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('data-project-confirm-dialog'), {
        key: 'Enter',
        metaKey: true
      })
    })
    await expect(done).resolves.toMatchObject({ status: 'ok' })
    expect(call).toHaveBeenLastCalledWith('tok')
  })

  it('shows the blocked dialog and returns the blocked response', async () => {
    render(<DataConfirmHost />)
    const blocked = {
      status: 'blocked',
      plan: plan({ safeMode: 'read-only' }),
      reason: 'Read-only mode refuses writes.'
    }
    const done = runWithConfirmation(vi.fn().mockResolvedValue(blocked))
    await screen.findByTestId('data-project-blocked-dialog')
    expect(screen.getByText('Blocked by read-only mode')).toBeInTheDocument()
    expect(screen.getByTestId('data-project-blocked-reason')).toHaveTextContent(
      'Read-only mode refuses writes.'
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-blocked-close'))
    })
    await expect(done).resolves.toBe(blocked)
  })

  it('asks again when the token expired while the dialog was open', async () => {
    render(<DataConfirmHost />)
    const expired = Object.assign(new Error('expired'), { name: 'DATA_CONFIRMATION_INVALID' })
    const call = vi
      .fn()
      .mockResolvedValueOnce({ status: 'confirmation_required', plan: plan(), confirmToken: 'old' })
      .mockRejectedValueOnce(expired)
      .mockResolvedValueOnce({ status: 'confirmation_required', plan: plan(), confirmToken: 'new' })
      .mockResolvedValueOnce({ status: 'ok', statements: [], durationMs: 1 })
    const done = runWithConfirmation(call)
    await act(async () => {
      fireEvent.click(await screen.findByTestId('data-project-confirm-run'))
    })
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3))
    await act(async () => {
      fireEvent.click(await screen.findByTestId('data-project-confirm-run'))
    })
    await expect(done).resolves.toMatchObject({ status: 'ok' })
    expect(call.mock.calls.map((c) => c[0])).toEqual([undefined, 'old', undefined, 'new'])
  })

  it('declines immediately when no host is mounted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const call = vi
      .fn()
      .mockResolvedValue({ status: 'confirmation_required', plan: plan(), confirmToken: 't' })
    await expect(runWithConfirmation(call)).resolves.toEqual({ status: 'declined' })
    warn.mockRestore()
  })

  it('passes non-confirmation responses straight through', async () => {
    const ok = { status: 'ok', statements: [], durationMs: 0 }
    await expect(runWithConfirmation(async () => ok)).resolves.toBe(ok)
  })
})

describe('orderPlanStatements', () => {
  it('puts dangerous statements first, then those needing confirmation', () => {
    const ordered = orderPlanStatements(plan().statements)
    expect(ordered.map((s) => s.index)).toEqual([1, 0])
  })
})
