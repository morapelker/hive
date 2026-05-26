import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import type { PetPosition, PetSettings, PetState, PetStatusPayload } from '@shared/types/pet'
import { getPet } from './registry'
import { HatchCeremony } from './HatchCeremony'
import { PetSprite } from './PetSprite'
import { usePetDrag } from './usePetDrag'
import { usePetHover } from './usePetHover'
import { unwrapEnvelope } from '@/lib/ipc-envelope'

const DEFAULT_STATUS: PetStatusPayload = { state: 'idle', sourceWorktreeId: null }

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
        window.petOps.getConfig().then(unwrapEnvelope),
        window.petOps.getCurrentStatus().then(unwrapEnvelope)
      ])
      if (cancelled) return
      setSettings(config.settings)
      setPosition(config.position)
      setStatus(currentStatus)
      latestStatusRef.current = currentStatus
      setHatching(!config.settings.hasHatched)
    }

    loadInitialState().catch(console.error)
    const cleanupStatus = window.petOps.onStatus((payload) => {
      latestStatusRef.current = payload
      setStatus(payload)
    })
    const cleanupSettings = window.petOps.onSettingsUpdated((nextSettings) => {
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
    window.petOps.markHatched()
  }, [])

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (wasDraggedRef.current) {
        event.preventDefault()
        event.stopPropagation()
        wasDraggedRef.current = false
        return
      }
      window.petOps
        .focusMain({ worktreeId: latestStatusRef.current.sourceWorktreeId })
        .then(unwrapEnvelope)
        .catch(console.error)
    },
    [wasDraggedRef]
  )

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    window.petOps.hide().then(unwrapEnvelope).catch(console.error)
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
