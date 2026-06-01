import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { PetApp } from '@/pet/PetApp'

vi.mock('motion/react', () => ({
  motion: {
    span: ({
      children,
      animate: _animate,
      transition: _transition,
      ...props
    }: React.ComponentProps<'span'> & { animate?: unknown; transition?: unknown }) => (
      <span {...props}>{children}</span>
    )
  }
}))

vi.mock('@/pet/DotLottieSprite', () => ({
  DotLottieSprite: () => <img alt="" />
}))

function pointerEvent(type: string, init: PointerEventInit): Event {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    screenX: init.screenX,
    screenY: init.screenY
  }) as PointerEvent
}

let request: ReturnType<typeof vi.fn>
let subscribe: ReturnType<typeof vi.fn>

const requestCallsFor = (method: string): unknown[][] =>
  request.mock.calls.filter(([calledMethod]) => calledMethod === method)

describe('PetApp drag and click behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    Element.prototype.setPointerCapture = vi.fn()

    request = vi.fn((method: string) => {
      if (method === 'petOps.getConfig') {
        return Promise.resolve({
          settings: { enabled: true, petId: 'bee', size: 'M', opacity: 1, hasHatched: true },
          position: { x: 10, y: 20 },
          manifest: { id: 'bee', name: 'Bee', version: '1.0.0', assets: {} }
        })
      }

      if (method === 'petOps.getCurrentStatus') {
        return Promise.resolve({ state: 'idle', sourceWorktreeId: 'worktree-1' })
      }

      return Promise.resolve(undefined)
    })
    subscribe = vi.fn().mockReturnValue(() => {})
    setRendererRpcClient({ request, subscribe })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRendererRpcClientForTests()
  })

  it('does not open the hive after a drag that moves the pet', async () => {
    render(<PetApp />)

    const pet = await screen.findByRole('button', { name: 'Hive pet' })

    fireEvent(
      pet,
      pointerEvent('pointerdown', { pointerId: 1, button: 0, screenX: 100, screenY: 100 })
    )
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, screenX: 102, screenY: 100 }))
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, screenX: 102, screenY: 100 }))
    fireEvent.click(pet)

    expect(request).toHaveBeenCalledWith('petOps.move', { x: 12, y: 20 })
    expect(request).not.toHaveBeenCalledWith('petOps.focusMain', expect.anything())
  })

  it('keeps mouse events captured until the post-drag click has been swallowed', async () => {
    render(<PetApp />)

    const pet = await screen.findByRole('button', { name: 'Hive pet' })
    vi.useFakeTimers()

    fireEvent(
      pet,
      pointerEvent('pointerdown', { pointerId: 1, button: 0, screenX: 100, screenY: 100 })
    )
    window.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, screenX: 120, screenY: 100 }))
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, screenX: 120, screenY: 100 }))

    expect(requestCallsFor('petOps.setIgnoreMouse').at(-1)).toEqual([
      'petOps.setIgnoreMouse',
      { ignore: false }
    ])

    fireEvent.click(pet)
    vi.runOnlyPendingTimers()

    expect(requestCallsFor('petOps.beginPointerInteraction')).toHaveLength(1)
    expect(requestCallsFor('petOps.endPointerInteraction')).toHaveLength(1)
    expect(request).not.toHaveBeenCalledWith('petOps.focusMain', expect.anything())
    expect(requestCallsFor('petOps.setIgnoreMouse').at(-1)).toEqual([
      'petOps.setIgnoreMouse',
      { ignore: true }
    ])
    vi.useRealTimers()
  })

  it('opens the hive on an intentional click', async () => {
    render(<PetApp />)

    const pet = await screen.findByRole('button', { name: 'Hive pet' })

    fireEvent(
      pet,
      pointerEvent('pointerdown', { pointerId: 1, button: 0, screenX: 100, screenY: 100 })
    )
    window.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, screenX: 100, screenY: 100 }))
    fireEvent.click(pet)

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('petOps.focusMain', { worktreeId: 'worktree-1' })
    )
  })
})
