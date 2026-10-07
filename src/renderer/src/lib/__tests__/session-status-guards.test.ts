import { describe, expect, it } from 'vitest'

import {
  isCliQuestionResolutionEntry,
  shouldPreserveBlockingSessionStatus
} from '../session-status-guards'

describe('shouldPreserveBlockingSessionStatus', () => {
  it('preserves command_approval and permission unconditionally, matching the existing guards', () => {
    expect(shouldPreserveBlockingSessionStatus('command_approval', false)).toBe(true)
    expect(shouldPreserveBlockingSessionStatus('permission', false)).toBe(true)
  })

  it('preserves answering while a question is still pending', () => {
    expect(shouldPreserveBlockingSessionStatus('answering', true)).toBe(true)
  })

  it('does not preserve a stale answering status with no pending question', () => {
    expect(shouldPreserveBlockingSessionStatus('answering', false)).toBe(false)
  })

  it('does not preserve non-blocking statuses', () => {
    expect(shouldPreserveBlockingSessionStatus('working', true)).toBe(false)
    expect(shouldPreserveBlockingSessionStatus('planning', false)).toBe(false)
    expect(shouldPreserveBlockingSessionStatus('completed', false)).toBe(false)
    expect(shouldPreserveBlockingSessionStatus(null, true)).toBe(false)
    expect(shouldPreserveBlockingSessionStatus(undefined, true)).toBe(false)
  })
})

describe('isCliQuestionResolutionEntry', () => {
  it('accepts the AskUserQuestion PostToolUse / PostToolUseFailure resuming work', () => {
    expect(
      isCliQuestionResolutionEntry({
        status: 'working',
        hookEventName: 'PostToolUse',
        toolName: 'AskUserQuestion'
      })
    ).toBe(true)
    expect(
      isCliQuestionResolutionEntry({
        status: 'planning',
        hookEventName: 'PostToolUseFailure',
        toolName: 'AskUserQuestion'
      })
    ).toBe(true)
  })

  it("accepts codex's title-derived question resolution", () => {
    expect(
      isCliQuestionResolutionEntry({ status: 'working', reason: 'codex_title_action_resolved' })
    ).toBe(true)
  })

  it('rejects every other working flip: other tools, bare writes, prompts, resurfaced questions', () => {
    expect(
      isCliQuestionResolutionEntry({
        status: 'working',
        hookEventName: 'PostToolUse',
        toolName: 'Read'
      })
    ).toBe(false)
    expect(isCliQuestionResolutionEntry({ status: 'working' })).toBe(false)
    expect(
      isCliQuestionResolutionEntry({ status: 'working', hookEventName: 'UserPromptSubmit' })
    ).toBe(false)
    expect(
      isCliQuestionResolutionEntry({
        status: 'answering',
        hookEventName: 'PreToolUse',
        toolName: 'AskUserQuestion',
        reason: 'interaction_resurfaced'
      })
    ).toBe(false)
    expect(
      isCliQuestionResolutionEntry({
        status: 'completed',
        hookEventName: 'PostToolUse',
        toolName: 'AskUserQuestion'
      })
    ).toBe(false)
    expect(isCliQuestionResolutionEntry(null)).toBe(false)
    expect(isCliQuestionResolutionEntry(undefined)).toBe(false)
  })
})
