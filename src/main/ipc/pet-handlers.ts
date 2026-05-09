import { ipcMain } from 'electron'
import { Data, Effect } from 'effect'
import { z } from 'zod'

import type { PetPosition, PetSettings, PetStatusPayload } from '../../shared/types/pet'
import {
  beginPetPointerInteraction,
  createPetWindow,
  destroyPetWindow,
  endPetPointerInteraction,
  focusMainWindowFromPet,
  forwardStatusToPet,
  getCurrentPetStatus,
  getPetConfig,
  movePetWindow,
  persistPetSettings,
  setPetIgnoreMouseEvents,
  updatePetSettings
} from '../services/pet-window'
import { defineHandler } from './_shared/define-handler'

class PetHandlerFailed extends Data.TaggedError('PetHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const petFailed = (operation: string, cause: unknown): PetHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new PetHandlerFailed({ operation, reason, message: reason })
}

export function registerPetHandlers(): void {
  defineHandler('pet:show', z.tuple([]), () =>
    Effect.try({
      try: () => {
        createPetWindow()
      },
      catch: (cause) => petFailed('pet:show', cause)
    })
  )

  defineHandler('pet:hide', z.tuple([]), () =>
    Effect.try({
      try: () => destroyPetWindow(),
      catch: (cause) => petFailed('pet:hide', cause)
    })
  )

  ipcMain.on('pet:publish-status', (_event, payload: PetStatusPayload) => {
    forwardStatusToPet(payload)
  })

  ipcMain.on('pet:set-ignore-mouse', (_event, payload: { ignore: boolean }) => {
    setPetIgnoreMouseEvents(Boolean(payload.ignore))
  })

  ipcMain.on('pet:begin-pointer-interaction', () => {
    beginPetPointerInteraction()
  })

  ipcMain.on('pet:end-pointer-interaction', () => {
    endPetPointerInteraction()
  })

  ipcMain.on('pet:move', (_event, payload: PetPosition) => {
    movePetWindow(payload)
  })

  defineHandler('pet:focus-main', z.object({ worktreeId: z.string().nullable() }), (payload) =>
    Effect.try({
      try: () => focusMainWindowFromPet(payload.worktreeId),
      catch: (cause) => petFailed('pet:focus-main', cause)
    })
  )

  defineHandler('pet:get-config', z.tuple([]), () =>
    Effect.try({
      try: () => getPetConfig(),
      catch: (cause) => petFailed('pet:get-config', cause)
    })
  )

  defineHandler('pet:get-current-status', z.tuple([]), () =>
    Effect.try({
      try: () => getCurrentPetStatus(),
      catch: (cause) => petFailed('pet:get-current-status', cause)
    })
  )

  ipcMain.on('pet:update-settings', (_event, partial: Partial<PetSettings>) => {
    updatePetSettings(partial)
    if (partial.enabled === true) {
      createPetWindow()
    } else if (partial.enabled === false) {
      destroyPetWindow()
    }
  })

  ipcMain.on('pet:mark-hatched', () => {
    persistPetSettings({ hasHatched: true })
  })
}
