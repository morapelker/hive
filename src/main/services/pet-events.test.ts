import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PET_JUMP_TO_WORKTREE_CHANNEL,
  PET_SETTINGS_UPDATED_CHANNEL,
  PET_STATUS_CHANNEL
} from '../../shared/pet-events'
import type { PetSettings, PetStatusPayload } from '../../shared/types/pet'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-manager', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { emitPetJumpToWorktree, emitPetSettingsUpdated, emitPetStatus } from './pet-events'

describe('pet events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
  })

  it('publishes pet status through the backend event stream', () => {
    const payload: PetStatusPayload = {
      state: 'working',
      sourceWorktreeId: 'worktree-1'
    }

    emitPetStatus(payload)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(PET_STATUS_CHANNEL, payload)
  })

  it('publishes pet settings updates through the backend event stream', () => {
    const settings: PetSettings = {
      enabled: true,
      petId: 'bee',
      size: 'M',
      opacity: 0.9,
      hasHatched: true
    }

    emitPetSettingsUpdated(settings)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      PET_SETTINGS_UPDATED_CHANNEL,
      settings
    )
  })

  it('publishes pet worktree jumps through the backend event stream', () => {
    emitPetJumpToWorktree('worktree-1')

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      PET_JUMP_TO_WORKTREE_CHANNEL,
      { worktreeId: 'worktree-1' }
    )
  })
})
