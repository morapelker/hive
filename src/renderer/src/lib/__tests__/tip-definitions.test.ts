import { describe, expect, it } from 'vitest'
import { TIP_DEFINITIONS } from '../tip-definitions'

describe('TIP_DEFINITIONS', () => {
  it('defines the hatch-first-pet discovery tip for the settings gear', () => {
    expect(TIP_DEFINITIONS['hatch-first-pet']).toEqual({
      id: 'hatch-first-pet',
      description:
        'Hatch your first pet — a desktop companion that reflects the worktree needing the most attention.',
      trigger: 'mount',
      priority: 0,
      side: 'bottom',
      align: 'end'
    })
  })
})
