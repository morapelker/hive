import { describe, expect, it } from 'vitest'
import {
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
  looksLikeCodexProposedPlan
} from '../../../src/renderer/src/lib/proposedPlan'

describe('Codex proposed plan helpers', () => {
  it('detects numbered plan output from Codex', () => {
    expect(looksLikeCodexProposedPlan('Plan\n\n1. Add the function\n2. Add tests')).toBe(true)
  })

  it('does not treat a clarifying question as a proposed plan', () => {
    expect(
      looksLikeCodexProposedPlan(
        'Where should I add it?\n\n- New module\n- Existing utils\n\nConfirm your preference.'
      )
    ).toBe(false)
  })

  it('detects actionable plan output without requiring a heading', () => {
    expect(
      looksLikeCodexProposedPlan(
        '1. Inspect the session transcript merge path\n2. Persist the pending plan state\n3. Restore the plan card on remount'
      )
    ).toBe(true)
  })

  it('builds the implementation prompt from a plan', () => {
    expect(buildPlanImplementationPrompt('Plan\n\n1. Ship it')).toBe(
      'PLEASE IMPLEMENT THIS PLAN:\nPlan\n\n1. Ship it'
    )
  })

  it('uses build-mode implementation prompt when no feedback draft is provided', () => {
    expect(
      resolvePlanFollowUpSubmission({ draftText: '', planMarkdown: 'Plan\n\n1. Ship it' })
    ).toEqual({
      text: 'PLEASE IMPLEMENT THIS PLAN:\nPlan\n\n1. Ship it',
      interactionMode: 'build'
    })
  })

  it('keeps feedback replies in plan mode', () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: 'Revise step 2',
        planMarkdown: 'Plan\n\n1. Ship it'
      })
    ).toEqual({
      text: 'Revise step 2',
      interactionMode: 'plan'
    })
  })
})
