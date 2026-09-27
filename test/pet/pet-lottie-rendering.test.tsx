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
      setSpeed: vi.fn()
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
    expect(pet.lottieScale?.working).toBe(1.3)
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

  it('caps the working Lottie speed at the configured animation speed', async () => {
    const pet = getPet('corgi')

    render(
      <PetSprite
        pet={pet}
        state="working"
        settings={
          {
            ...settings,
            petId: 'corgi',
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
    expect(vi.mocked(DotLottie).mock.results[0]?.value.setSpeed).toHaveBeenCalledWith(2)
  })

  it('keeps the working Lottie at 1x when animation speed scaling is disabled', async () => {
    const pet = getPet('corgi')

    render(
      <PetSprite
        pet={pet}
        state="working"
        settings={
          {
            ...settings,
            petId: 'corgi',
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
    expect(vi.mocked(DotLottie).mock.results[0]?.value.setSpeed).toHaveBeenCalledWith(1)
  })

  it('caps enabled working Lottie speed at 5x', async () => {
    const pet = getPet('corgi')

    render(
      <PetSprite
        pet={pet}
        state="working"
        settings={
          {
            ...settings,
            petId: 'corgi',
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
    expect(vi.mocked(DotLottie).mock.results[0]?.value.setSpeed).toHaveBeenCalledWith(5)
  })
})
