import { motion } from 'motion/react'
import type * as React from 'react'
import type { LoadedPet, PetSettings, PetState } from '@shared/types/pet'
import { DotLottieSprite } from './DotLottieSprite'

const SIZE_PX: Record<PetSettings['size'], number> = {
  S: 64,
  M: 96,
  L: 128
}

function workingAnimationSpeed(settings: PetSettings, workingSessionCount: number): number {
  if (!settings.animationSpeedEnabled) return 1
  const maxSpeed = Math.min(Math.max(settings.animationSpeed, 2), 5)
  return Math.min(Math.max(workingSessionCount, 1), maxSpeed)
}

function animationForState(state: PetState, speed: number): Record<string, unknown> {
  if (state === 'working') {
    return {
      animate: { rotate: [-4, 4, -4], y: [0, -3, 0] },
      transition: { duration: 1.8 / speed, repeat: Infinity, ease: 'easeInOut' }
    }
  }
  if (state === 'question') {
    return {
      animate: { y: [0, -8, 0], rotate: [-3, 3, -3] },
      transition: { duration: 1.2, repeat: Infinity, ease: 'easeInOut' }
    }
  }
  if (state === 'permission') {
    return {
      animate: { y: [0, -10, 0], scale: [1, 1.04, 1] },
      transition: { duration: 0.8, repeat: Infinity, ease: 'easeInOut' }
    }
  }
  if (state === 'plan_ready') {
    return {
      animate: { scale: [1, 1.06, 1] },
      transition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }
    }
  }
  return {}
}

function overlayForState(state: PetState): { symbol: string; className: string } | null {
  if (state === 'question') return { symbol: '?', className: 'pet-bubble pet-bubble-question' }
  if (state === 'permission') return { symbol: '!', className: 'pet-bubble pet-bubble-permission' }
  if (state === 'plan_ready') return { symbol: '\u2713', className: 'pet-bubble pet-bubble-ready' }
  return null
}

export function PetSprite({
  pet,
  state,
  settings,
  workingSessionCount,
  onPointerDown,
  onMouseEnter,
  onMouseLeave,
  onClick,
  onContextMenu
}: {
  pet: LoadedPet
  state: PetState
  settings: PetSettings
  workingSessionCount: number
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  onClick: (event: React.MouseEvent<HTMLElement>) => void
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
}): React.JSX.Element {
  const size = SIZE_PX[settings.size]
  const speed = workingAnimationSpeed(settings, workingSessionCount)
  const overlay = overlayForState(state)
  const lottieSrc = state === 'working' ? pet.resolvedLottieAssets?.working : undefined
  const lottieScale = state === 'working' ? (pet.lottieScale?.working ?? 1) : 1
  const activeAnimation = lottieSrc ? {} : animationForState(state, speed)

  return (
    <button
      type="button"
      className="pet-hit-target"
      style={{ width: size + 36, height: size + 36, opacity: settings.opacity }}
      onPointerDown={onPointerDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-label="Hive pet"
    >
      <motion.span
        className={`pet-sprite pet-sprite-${state}`}
        style={{ width: size, height: size }}
        {...activeAnimation}
      >
        {state === 'plan_ready' && <span className="pet-glow" />}
        {lottieSrc ? (
          <DotLottieSprite
            src={lottieSrc}
            fallbackSrc={pet.resolvedAssets[state]}
            scale={lottieScale}
            size={size}
            speed={speed}
            state={state}
          />
        ) : (
          <img src={pet.resolvedAssets[state]} alt="" draggable={false} />
        )}
        {overlay && <span className={overlay.className}>{overlay.symbol}</span>}
      </motion.span>
    </button>
  )
}
