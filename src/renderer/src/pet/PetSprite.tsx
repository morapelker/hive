import { motion } from 'motion/react'
import type * as React from 'react'
import type { LoadedPet, PetSettings, PetState } from '@shared/types/pet'
import { CanvasAtlasSprite } from './CanvasAtlasSprite'
import { DotLottieSprite } from './DotLottieSprite'
import { SpriteSheetSprite } from './SpriteSheetSprite'
import { sessionCounterSlots } from './sessionCounter'
import { workingVariantIndex } from './workingVariant'

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
  const variants = pet.resolvedWorkingLottieVariants
  const speed = workingAnimationSpeed(settings, workingSessionCount)
  const overlay = overlayForState(state)
  const variantIndex = workingVariantIndex(pet, workingSessionCount)
  const lottieSrc =
    state === 'working'
      ? (variants?.[variantIndex] ?? pet.resolvedLottieAssets?.working)
      : undefined
  const lottieScale = state === 'working' ? (pet.lottieScale?.working ?? 1) : 1
  const sheet = pet.workingSpriteSheet
  const sheetSrc =
    state === 'working' && sheet
      ? pet.resolvedWorkingSpriteSheetVariants?.[variantIndex]
      : undefined
  const count = Math.max(0, Math.floor(workingSessionCount))
  const atlas = pet.workingAtlas
  // A canvas atlas has no run for zero sessions: the idle portrait stands in, as the reference does.
  const atlasVariant =
    state === 'working' && atlas && count >= 1 ? atlas.variants[variantIndex] : undefined
  const atlasSrc = atlasVariant ? pet.resolvedWorkingAtlasVariants?.[variantIndex] : undefined
  const imageScale = pet.imageScale?.[state] ?? 1
  const activeAnimation = lottieSrc || sheetSrc || atlasSrc ? {} : animationForState(state, speed)
  const shadowless =
    (sheet && sheetSrc && sheet.shadow === false) || (atlas && atlasSrc && atlas.shadow === false)
  // The stage is as wide as the pet's widest style; the box keeps its right edge in it, so the
  // pet stays put when a style that extends left (a flame trail) comes and goes.
  const stageWidth = Math.round(size * (pet.stageWidthRatio ?? 1))

  return (
    <button
      type="button"
      className="pet-hit-target"
      style={{ width: stageWidth + 36, height: size + 36, opacity: settings.opacity }}
      onPointerDown={onPointerDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-label="Hive pet"
    >
      <span className="pet-stage" style={{ width: stageWidth, height: size }}>
        <motion.span
          className={`pet-sprite pet-sprite-${state}`}
          data-shadow={shadowless ? 'none' : undefined}
          style={
            { width: size, height: size, '--pet-image-scale': imageScale } as React.CSSProperties
          }
          {...activeAnimation}
        >
          {state === 'plan_ready' && <span className="pet-glow" />}
          {atlas && atlasVariant && atlasSrc ? (
            <CanvasAtlasSprite
              atlas={atlas}
              variant={atlasVariant}
              src={atlasSrc}
              fallbackSrc={pet.resolvedAssets[state]}
              variantIndex={variantIndex}
              count={count}
              size={size}
              speed={speed}
              state={state}
            />
          ) : sheet && sheetSrc ? (
            <SpriteSheetSprite
              sheet={sheet}
              src={sheetSrc}
              fallbackSrc={pet.resolvedAssets[state]}
              variantIndex={variantIndex}
              count={count}
              speed={speed}
              state={state}
            />
          ) : lottieSrc ? (
            <DotLottieSprite
              src={lottieSrc}
              fallbackSrc={pet.resolvedAssets[state]}
              scale={lottieScale}
              size={size}
              speed={speed}
              textSlots={sessionCounterSlots(pet.workingSessionCounter, workingSessionCount)}
              state={state}
            />
          ) : (
            <img src={pet.resolvedAssets[state]} alt="" draggable={false} />
          )}
          {overlay && <span className={overlay.className}>{overlay.symbol}</span>}
        </motion.span>
      </span>
    </button>
  )
}
