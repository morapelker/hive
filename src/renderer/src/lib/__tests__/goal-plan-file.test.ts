import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import {
  GOAL_PROMPT_MAX_LENGTH,
  createPlanFile,
  exceedsGoalPromptLimit,
  planFilePrompt
} from '../goal-plan-file'

describe('exceedsGoalPromptLimit', () => {
  it('is false for null, empty, and prompts at the limit', () => {
    expect(exceedsGoalPromptLimit(null)).toBe(false)
    expect(exceedsGoalPromptLimit(undefined)).toBe(false)
    expect(exceedsGoalPromptLimit('')).toBe(false)
    expect(exceedsGoalPromptLimit('x'.repeat(GOAL_PROMPT_MAX_LENGTH))).toBe(false)
  })

  it('is true just past the limit', () => {
    expect(exceedsGoalPromptLimit('x'.repeat(GOAL_PROMPT_MAX_LENGTH + 1))).toBe(true)
  })
})

describe('planFilePrompt', () => {
  it('builds the slimmed implementation prompt', () => {
    expect(planFilePrompt('PLAN_abc.md')).toBe('Implement PLAN_abc.md')
  })
})

describe('createPlanFile', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetRendererRpcClientForTests()
    request = vi.fn(async () => null)
    setRendererRpcClient({ request, subscribe: vi.fn() })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('writes a PLAN_{uuid}.md into the root path and returns the file name', async () => {
    const fileName = await createPlanFile('/repo/feature', 'ticket body')

    expect(fileName).toMatch(/^PLAN_[0-9a-f-]{36}\.md$/)
    expect(request).toHaveBeenCalledWith('fileOps.createFile', {
      directoryPath: '/repo/feature',
      fileName,
      content: 'ticket body',
      overwrite: false
    })
  })

  it('throws when the write fails', async () => {
    request.mockRejectedValueOnce(new Error('disk full'))

    await expect(createPlanFile('/repo/feature', 'ticket body')).rejects.toThrow(
      'Failed to create plan file: disk full'
    )
  })
})
