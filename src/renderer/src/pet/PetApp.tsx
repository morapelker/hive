import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import type { PetPosition, PetSettings, PetState, PetStatusPayload } from '@shared/types/pet'
import { getPet } from './registry'
import { HatchCeremony } from './HatchCeremony'
import { PetSprite } from './PetSprite'
import { usePetDrag } from './usePetDrag'
import { usePetHover } from './usePetHover'
import { petApi } from '@/api/pet-api'

const DEFAULT_STATUS: PetStatusPayload = {
  state: 'idle',
  sourceWorktreeId: null,
  workingSessionCount: 0
}

export function PetApp(): React.JSX.Element {
  const [settings, setSettings] = useState<PetSettings | null>(null)
  const [position, setPosition] = useState<PetPosition | null>(null)
  const [status, setStatus] = useState<PetStatusPayload>(DEFAULT_STATUS)
  const [hatching, setHatching] = useState(false)
  const latestStatusRef = useRef(DEFAULT_STATUS)

  const pet = useMemo(() => getPet(settings?.petId ?? 'bee'), [settings?.petId])
  const { isDraggingRef, wasDraggedRef, onPointerDown } = usePetDrag(position)
  const hover = usePetHover(isDraggingRef)

  useEffect(() => {
    let cancelled = false

    async function loadInitialState(): Promise<void> {
      const [config, currentStatus] = await Promise.all([
        petApi.getConfig(),
        petApi.getCurrentStatus()
      ])
      if (cancelled) return
      setSettings(config.settings)
      setPosition(config.position)
      setStatus(currentStatus)
      latestStatusRef.current = currentStatus
      setHatching(!config.settings.hasHatched)
    }

    loadInitialState().catch(console.error)
    const cleanupStatus = petApi.onStatus((payload) => {
      latestStatusRef.current = payload
      setStatus(payload)
    })
    const cleanupSettings = petApi.onSettingsUpdated((nextSettings) => {
      setSettings(nextSettings)
    })

    return () => {
      cancelled = true
      cleanupStatus()
      cleanupSettings()
    }
  }, [])

  const handleHatchComplete = useCallback(() => {
    setHatching(false)
    setSettings((current) => (current ? { ...current, hasHatched: true } : current))
    petApi.markHatched()
  }, [])

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (wasDraggedRef.current) {
        event.preventDefault()
        event.stopPropagation()
        wasDraggedRef.current = false
        return
      }
      petApi
        .focusMain({ worktreeId: latestStatusRef.current.sourceWorktreeId })
        .catch(console.error)
    },
    [wasDraggedRef]
  )

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    petApi.hide().catch(console.error)
  }, [])

  if (!settings) return <div className="pet-root" />

  const visibleState: PetState = hatching ? 'idle' : status.state

  return (
    <div className="pet-root">
      {hatching ? (
        <HatchCeremony pet={pet} settings={settings} onComplete={handleHatchComplete} />
      ) : (
        <PetSprite
          pet={pet}
          state={visibleState}
          settings={settings}
          workingSessionCount={status.workingSessionCount}
          onPointerDown={onPointerDown}
          onMouseEnter={hover.onMouseEnter}
          onMouseLeave={hover.onMouseLeave}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        />
      )}
    </div>
  )
}
