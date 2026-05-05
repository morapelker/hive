import { ipcMain } from 'electron'
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

export function registerPetHandlers(): void {
  ipcMain.handle('pet:show', () => {
    createPetWindow()
  })

  ipcMain.handle('pet:hide', () => {
    destroyPetWindow()
  })

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

  ipcMain.handle('pet:focus-main', (_event, payload: { worktreeId: string | null }) => {
    focusMainWindowFromPet(payload.worktreeId)
  })

  ipcMain.handle('pet:get-config', () => {
    return getPetConfig()
  })

  ipcMain.handle('pet:get-current-status', () => {
    return getCurrentPetStatus()
  })

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
