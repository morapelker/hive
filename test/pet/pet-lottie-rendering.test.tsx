import { render, screen, waitFor } from '@testing-library/react'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DotLottie } from '@lottiefiles/dotlottie-web'
import type { LoadedPet, PetSettings } from '@shared/types/pet'
import { getPet, listPets } from '@/pet/registry'
import { PetSprite } from '@/pet/PetSprite'

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

vi.mock('@lottiefiles/dotlottie-web', () => ({
  DotLottie: Object.assign(
    vi.fn().mockImplementation(() => ({
      addEventListener: vi.fn(),
      destroy: vi.fn(),
      resize: vi.fn(),
      setSpeed: vi.fn(),
      setTextSlot: vi.fn(),
      resetSlot: vi.fn(),
      isLoaded: true
    })),
    { setWasmUrl: vi.fn() }
  )
}))

vi.mock('@lottiefiles/dotlottie-web/dotlottie-player.wasm?url', () => ({
  default: '/assets/dotlottie-player.wasm'
}))

const settings: PetSettings = {
  enabled: true,
  petId: 'bee',
  size: 'M',
  opacity: 1,
  animationSpeedEnabled: false,
  animationSpeed: 5,
  hasHatched: true
}

describe('pet Lottie rendering', () => {
  beforeEach(() => {
    vi.mocked(DotLottie).mockClear()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8))
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves a working-state Lottie asset for the bee pet', () => {
    const pet = getPet('bee')

    expect(pet.resolvedLottieAssets?.working).toContain('honey-bee')
    expect(pet.lottieScale?.working).toBe(2.15)
  })

  it('resolves static and working-state Lottie assets for the corgi pet', () => {
    const pet = getPet('corgi')

    expect(pet.name).toBe('Corgi')
    expect(pet.resolvedAssets.idle).toContain('corgi-static')
    expect(pet.resolvedAssets.question).toContain('corgi-static')
    expect(pet.resolvedLottieAssets?.working).toContain('corgi-anim')
    expect(pet.lottieScale?.working).toBe(1.55)
  })

  it('resolves static and working-state Lottie assets for the French bulldog pet', () => {
    const pet = getPet('french-bulldog')

    expect(pet.name).toBe('French Bulldog')
    expect(pet.resolvedAssets.idle).toContain('french-bulldog')
    expect(pet.resolvedAssets.permission).toContain('french-bulldog')
    expect(pet.resolvedLottieAssets?.working).toContain('french-bulldog-run')
    expect(pet.lottieScale?.working).toBe(1.45)
  })

  it('resolves static and working-state Lottie assets for the dachshund pet', () => {
    const pet = getPet('dachshund')

    expect(pet.name).toBe('Dachshund')
    expect(pet.resolvedAssets.idle).toContain('dachshund')
    expect(pet.resolvedAssets.question).toContain('dachshund')
    expect(pet.resolvedLottieAssets?.working).toContain('dachshund-run')
    expect(pet.lottieScale?.working).toBe(1.4)
    // The standing dachshund is a wide landscape image, so it is scaled up to
    // match the running animation inside the square sprite box.
    expect(pet.imageScale?.idle).toBe(1.4)
  })

  it('lists all four pets in the registry', () => {
    expect(
      listPets()
        .map((pet) => pet.id)
        .sort()
    ).toEqual(['bee', 'corgi', 'dachshund', 'french-bulldog'].sort())
  })

  it('applies the manifest image scale to static states and falls back to 1', () => {
    const { container, rerender } = render(
      <PetSprite
        pet={getPet('dachshund')}
        state="idle"
        settings={{ ...settings, petId: 'dachshund' }}
        workingSessionCount={0}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    expect(container.querySelector('.pet-sprite')).toHaveStyle({ '--pet-image-scale': '1.4' })
    expect(container.querySelector('img')?.getAttribute('src')).toContain('dachshund')

    rerender(
      <PetSprite
        pet={getPet('french-bulldog')}
        state="idle"
        settings={{ ...settings, petId: 'french-bulldog' }}
        workingSessionCount={0}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    expect(container.querySelector('.pet-sprite')).toHaveStyle({ '--pet-image-scale': '1' })
  })

  it('renders Lottie only for working and keeps other states on the PNG sprite', async () => {
    const pet = {
      id: 'bee',
      name: 'Bee',
      version: '1.0.0',
      assets: {
        idle: '/bee.png',
        working: '/bee.png',
        question: '/bee.png',
        permission: '/bee.png',
        plan_ready: '/bee.png'
      },
      resolvedAssets: {
        idle: '/bee.png',
        working: '/bee.png',
        question: '/bee.png',
        permission: '/bee.png',
        plan_ready: '/bee.png'
      },
      resolvedLottieAssets: {
        working: '/honey-bee.lottie'
      },
      lottieScale: {
        working: 2.15
      }
    } satisfies LoadedPet

    const { container, rerender } = render(
      <PetSprite
        pet={pet}
        state="working"
        settings={settings}
        workingSessionCount={1}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    expect(screen.getByTestId('pet-lottie-working')).toBeInTheDocument()
    expect(screen.getByTestId('pet-lottie-working')).toHaveStyle({
      '--pet-lottie-scale': '2.15'
    })
    expect(container.querySelector('img.pet-lottie-fallback')).toBeInTheDocument()
    await waitFor(() => expect(DotLottie).toHaveBeenCalledTimes(1))

    expect(DotLottie).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.any(ArrayBuffer),
        autoplay: true,
        loop: true,
        renderConfig: expect.objectContaining({
          autoResize: true,
          freezeOnOffscreen: false
        })
      })
    )
    expect(vi.mocked(DotLottie).mock.calls[0]?.[0]).not.toHaveProperty('src')
    expect(DotLottie.setWasmUrl).toHaveBeenCalledWith('/assets/dotlottie-player.wasm')

    rerender(
      <PetSprite
        pet={pet}
        state="question"
        settings={settings}
        workingSessionCount={1}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    expect(screen.queryByTestId('pet-lottie-working')).not.toBeInTheDocument()
    expect(container.querySelector('img')).toBeInTheDocument()
  })

  it('uses the corgi Lottie for working and the static corgi for other states', async () => {
    const pet = getPet('corgi')

    const { container, rerender } = render(
      <PetSprite
        pet={pet}
        state="working"
        settings={{ ...settings, petId: 'corgi' }}
        workingSessionCount={1}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    expect(screen.getByTestId('pet-lottie-working')).toBeInTheDocument()
    expect(screen.getByTestId('pet-lottie-working')).toHaveStyle({
      '--pet-lottie-scale': '1.55'
    })
    expect(container.querySelector('img.pet-lottie-fallback')?.getAttribute('src')).toContain(
      'corgi-static'
    )
    await waitFor(() => expect(DotLottie).toHaveBeenCalledTimes(1))

    rerender(
      <PetSprite
        pet={pet}
        state="permission"
        settings={{ ...settings, petId: 'corgi' }}
        workingSessionCount={1}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    expect(screen.queryByTestId('pet-lottie-working')).not.toBeInTheDocument()
    expect(container.querySelector('img')?.getAttribute('src')).toContain('corgi-static')
  })

  it('resolves all five corgi styles in session-count order', () => {
    const pet = getPet('corgi')
    expect(pet.resolvedWorkingLottieVariants).toHaveLength(5)
    expect(pet.resolvedWorkingLottieVariants?.[0]).toBe(pet.resolvedLottieAssets?.working)
    for (let level = 2; level <= 5; level++) {
      expect(pet.resolvedWorkingLottieVariants?.[level - 1]).toContain(`corgi-level-${level}`)
    }
    expect(getPet('bee').resolvedWorkingLottieVariants).toBeUndefined()
  })

  it.each([false, true])(
    'changes corgi styles independently of speed scaling (%s)',
    async (scaling) => {
      const pet = getPet('corgi')
      const sprite = (
        count: number,
        speedEnabled = scaling,
        state: 'working' | 'idle' = 'working'
      ) => (
        <PetSprite
          pet={pet}
          state={state}
          settings={{
            ...settings,
            petId: 'corgi',
            animationSpeedEnabled: speedEnabled,
            animationSpeed: 2
          }}
          workingSessionCount={count}
          onPointerDown={vi.fn()}
          onMouseEnter={vi.fn()}
          onMouseLeave={vi.fn()}
          onClick={vi.fn()}
          onContextMenu={vi.fn()}
        />
      )
      const { rerender, container } = render(sprite(1))
      await waitFor(() => expect(DotLottie).toHaveBeenCalledTimes(1))

      let loads = 1
      for (const count of [2, 3, 4, 5, 8, 2, 0]) {
        const previousPlayer = vi.mocked(DotLottie).mock.results.at(-1)?.value
        rerender(sprite(count))
        if (count !== 8) loads++ // Five and eight share a style; keep that player alive.
        await waitFor(() => expect(DotLottie).toHaveBeenCalledTimes(loads))
        expect(fetch).toHaveBeenLastCalledWith(
          pet.resolvedWorkingLottieVariants?.[Math.max(1, Math.min(count, 5)) - 1]
        )
        expect(vi.mocked(DotLottie).mock.calls.at(-1)?.[0]).toMatchObject({
          speed: scaling ? Math.max(1, Math.min(count, 2)) : 1
        })
        expect(previousPlayer.destroy).toHaveBeenCalledTimes(count === 8 ? 0 : 1)
      }

      rerender(sprite(5, false))
      loads++
      await waitFor(() => expect(DotLottie).toHaveBeenCalledTimes(loads))
      expect(fetch).toHaveBeenLastCalledWith(pet.resolvedWorkingLottieVariants?.[4])
      expect(vi.mocked(DotLottie).mock.calls.at(-1)?.[0]).toMatchObject({ speed: 1 })

      rerender(sprite(0, false, 'idle'))
      expect(screen.queryByTestId('pet-lottie-working')).not.toBeInTheDocument()
      expect(container.querySelector('img')?.src).toContain('corgi-static')
    }
  )

  it.each([false, true])(
    'updates the cape count without restarting with speed scaling %s',
    async (scaling) => {
      const listeners = new Map<string, () => void>()
      const player = {
        isLoaded: false,
        addEventListener: vi.fn((event: string, listener: () => void) =>
          listeners.set(event, listener)
        ),
        destroy: vi.fn(),
        resize: vi.fn(),
        setSpeed: vi.fn(),
        setFrame: vi.fn(),
        setTextSlot: vi.fn(),
        resetSlot: vi.fn()
      }
      vi.mocked(DotLottie).mockImplementationOnce(() => player as unknown as DotLottie)
      const sprite = (count: number, speedEnabled = scaling, maxSpeed = 2) => (
        <PetSprite
          pet={getPet('corgi')}
          state="working"
          settings={{
            ...settings,
            petId: 'corgi',
            animationSpeedEnabled: speedEnabled,
            animationSpeed: maxSpeed
          }}
          workingSessionCount={count}
          onPointerDown={vi.fn()}
          onMouseEnter={vi.fn()}
          onMouseLeave={vi.fn()}
          onClick={vi.fn()}
          onContextMenu={vi.fn()}
        />
      )
      const { rerender } = render(sprite(5))
      await waitFor(() => expect(DotLottie).toHaveBeenCalledTimes(1))
      rerender(sprite(7))
      expect(vi.mocked(DotLottie).mock.calls[0]?.[0]).toMatchObject({ speed: scaling ? 2 : 1 })
      expect(player.setTextSlot).not.toHaveBeenCalled()
      player.isLoaded = true
      listeners.get('load')?.()
      expect(player.setTextSlot).toHaveBeenLastCalledWith('session-count', { t: '7', s: 90 })

      for (const count of [8, 9, 10, 20, 123, 12345, 6]) {
        rerender(sprite(count))
        expect(player.setTextSlot).toHaveBeenLastCalledWith('session-count', {
          t: String(count),
          s: 90 * Math.min(1, 2 / String(count).length)
        })
      }
      expect(player.setSpeed).toHaveBeenLastCalledWith(scaling ? 2 : 1)
      // Changing playback settings must preserve the full count and the running player.
      for (const [enabled, limit, expectedSpeed] of [
        [true, 2, 2],
        [true, 5, 5],
        [false, 5, 1]
      ] as const) {
        rerender(sprite(20, enabled, limit))
        expect(player.setSpeed).toHaveBeenLastCalledWith(expectedSpeed)
        expect(player.setTextSlot).toHaveBeenLastCalledWith('session-count', { t: '20', s: 90 })
      }
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(DotLottie).toHaveBeenCalledTimes(1)
      expect(player.destroy).not.toHaveBeenCalled()
      // Seven on load, seven count changes, then twenty once. Speed-only
      // updates must not reapply identical slots (the WASM core resets glyphs).
      expect(player.setTextSlot).toHaveBeenCalledTimes(9)
      expect(player.setFrame).not.toHaveBeenCalled()
      expect(player.setSpeed).toHaveBeenLastCalledWith(1)
    }
  )

  it('passes the working speed to the player constructor and re-applies it on load', async () => {
    // `DotLottie#setSpeed` is a no-op until the WASM core has booted, so a
    // speed that is only applied via setSpeed right after construction is
    // silently dropped and the pet runs at 1x. The speed must be part of the
    // constructor config and re-applied once the animation has loaded.
    const listeners = new Map<string, () => void>()
    vi.mocked(DotLottie).mockImplementationOnce(
      () =>
        ({
          addEventListener: vi.fn((event: string, listener: () => void) => {
            listeners.set(event, listener)
          }),
          destroy: vi.fn(),
          resize: vi.fn(),
          setSpeed: vi.fn()
        }) as unknown as DotLottie
    )
    const pet = getPet('bee')

    const { rerender } = render(
      <PetSprite
        pet={pet}
        state="working"
        settings={
          {
            ...settings,
            petId: 'bee',
            animationSpeed: 5,
            animationSpeedEnabled: true
          } as PetSettings
        }
        workingSessionCount={4}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    await waitFor(() => expect(DotLottie).toHaveBeenCalledTimes(1))
    expect(vi.mocked(DotLottie).mock.calls[0]?.[0]).toMatchObject({ speed: 4 })
    const player = vi.mocked(DotLottie).mock.results[0]?.value as {
      setSpeed: ReturnType<typeof vi.fn>
    }

    // The session count changes while the core is still booting: the
    // constructor speed is stale, so `load` must re-apply the latest one.
    rerender(
      <PetSprite
        pet={pet}
        state="working"
        settings={
          {
            ...settings,
            petId: 'bee',
            animationSpeed: 5,
            animationSpeedEnabled: true
          } as PetSettings
        }
        workingSessionCount={5}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )
    player.setSpeed.mockClear()
    listeners.get('load')?.()
    expect(player.setSpeed).toHaveBeenLastCalledWith(5)
  })

  it('caps the working Lottie speed at the configured animation speed', async () => {
    const pet = getPet('bee')

    render(
      <PetSprite
        pet={pet}
        state="working"
        settings={
          {
            ...settings,
            petId: 'bee',
            animationSpeed: 2,
            animationSpeedEnabled: true
          } as PetSettings
        }
        workingSessionCount={5}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    await waitFor(() => expect(DotLottie).toHaveBeenCalledTimes(1))
    expect(vi.mocked(DotLottie).mock.calls[0]?.[0]).toMatchObject({ speed: 2 })
  })

  it('keeps the working Lottie at 1x when animation speed scaling is disabled', async () => {
    const pet = getPet('bee')

    render(
      <PetSprite
        pet={pet}
        state="working"
        settings={
          {
            ...settings,
            petId: 'bee',
            animationSpeed: 5,
            animationSpeedEnabled: false
          } as PetSettings
        }
        workingSessionCount={5}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    await waitFor(() => expect(DotLottie).toHaveBeenCalledTimes(1))
    expect(vi.mocked(DotLottie).mock.calls[0]?.[0]).toMatchObject({ speed: 1 })
  })

  it('caps enabled working Lottie speed at 5x', async () => {
    const pet = getPet('bee')

    render(
      <PetSprite
        pet={pet}
        state="working"
        settings={
          {
            ...settings,
            petId: 'bee',
            animationSpeed: 10,
            animationSpeedEnabled: true
          } as PetSettings
        }
        workingSessionCount={10}
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        onClick={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    await waitFor(() => expect(DotLottie).toHaveBeenCalledTimes(1))
    expect(vi.mocked(DotLottie).mock.calls[0]?.[0]).toMatchObject({ speed: 5 })
  })
})
