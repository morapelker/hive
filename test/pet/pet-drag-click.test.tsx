import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

function petOps(): typeof window.petOps {
  return window.petOps
}

function pointerEvent(type: string, init: PointerEventInit): Event {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    screenX: init.screenX,
    screenY: init.screenY
  }) as PointerEvent
}

describe('PetApp drag and click behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.setPointerCapture = vi.fn()

    petOps().getConfig.mockResolvedValue({
      settings: { enabled: true, petId: 'bee', size: 'M', opacity: 1, hasHatched: true },
      position: { x: 10, y: 20 },
      manifest: { id: 'bee', name: 'Bee', version: '1.0.0', assets: {} }
    })
    petOps().getCurrentStatus.mockResolvedValue({ state: 'idle', sourceWorktreeId: 'worktree-1' })
    petOps().onStatus.mockReturnValue(() => {})
    petOps().onSettingsUpdated.mockReturnValue(() => {})
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

    expect(petOps().move).toHaveBeenCalledWith({ x: 12, y: 20 })
    expect(petOps().focusMain).not.toHaveBeenCalled()
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
      expect(petOps().focusMain).toHaveBeenCalledWith({ worktreeId: 'worktree-1' })
    )
  })
})
