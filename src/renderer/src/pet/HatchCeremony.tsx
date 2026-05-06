import { motion } from 'motion/react'
import type { LoadedPet, PetSettings } from '@shared/types/pet'

const SIZE_PX: Record<PetSettings['size'], number> = {
  S: 64,
  M: 96,
  L: 128
}

export function HatchCeremony({
  pet,
  settings,
  onComplete
}: {
  pet: LoadedPet
  settings: PetSettings
  onComplete: () => void
}): React.JSX.Element {
  const size = SIZE_PX[settings.size]

  return (
    <div className="hatch-root" style={{ width: size + 36, height: size + 36 }}>
      <motion.div
        className="hatch-egg"
        style={{ width: size * 0.72, height: size * 0.88 }}
        animate={{
          rotate: [0, -8, 8, -8, 8, 0],
          scale: [1, 1, 1, 1.05, 0.96, 0]
        }}
        transition={{ duration: 1.9, times: [0, 0.28, 0.42, 0.56, 0.72, 1] }}
      >
        <span className="hatch-crack" />
      </motion.div>
      <motion.img
        className="hatch-bee"
        src={pet.resolvedAssets.idle}
        alt=""
        draggable={false}
        style={{ width: size, height: size }}
        initial={{ opacity: 0, y: 10, scale: 0.55 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: 1.35, duration: 0.45, ease: 'easeOut' }}
        onAnimationComplete={onComplete}
      />
    </div>
  )
}
