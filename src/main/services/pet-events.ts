import {
  PET_JUMP_TO_WORKTREE_CHANNEL,
  PET_SETTINGS_UPDATED_CHANNEL,
  PET_STATUS_CHANNEL
} from '../../shared/pet-events'
import type { PetSettings, PetStatusPayload } from '../../shared/types/pet'
import { publishDesktopBackendEvent } from '../desktop/backend-manager'

export const emitPetStatus = (payload: PetStatusPayload): void => {
  void publishDesktopBackendEvent(PET_STATUS_CHANNEL, payload)
}

export const emitPetSettingsUpdated = (settings: PetSettings): void => {
  void publishDesktopBackendEvent(PET_SETTINGS_UPDATED_CHANNEL, settings)
}

export const emitPetJumpToWorktree = (worktreeId: string): void => {
  void publishDesktopBackendEvent(PET_JUMP_TO_WORKTREE_CHANNEL, { worktreeId })
}
