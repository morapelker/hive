import { describe, expect, it } from 'vitest'
import {
  CODEX_PLAN_MODE_PREFIX,
  PLAN_MODE_PREFIX,
  getPlanModePrefix,
  getSuperPlanModePrefix,
  stripModePrefix
} from '@/lib/constants'
import { buildSdkPlanImplementationPrompt } from '@/lib/proposedPlan'

/**
 * codex-cli asks for a plan the codex way — a `<proposed_plan>` block — rather
 * than the claude way (--permission-mode plan + an ExitPlanMode tool call).
 */
describe('codex-cli plan convention', () => {
  it('gives codex-cli the <proposed_plan> plan prefix, and claude-cli/others the claude prefix', () => {
    expect(getPlanModePrefix('codex-cli')).toBe(CODEX_PLAN_MODE_PREFIX)
    expect(CODEX_PLAN_MODE_PREFIX).toContain('<proposed_plan>')
    expect(CODEX_PLAN_MODE_PREFIX).not.toContain('ExitPlanMode')

    expect(getPlanModePrefix('claude-code-cli')).toBe(PLAN_MODE_PREFIX)
    expect(getPlanModePrefix('opencode')).toBe(PLAN_MODE_PREFIX)
    expect(getPlanModePrefix(null)).toBe(PLAN_MODE_PREFIX)
  })

  it('gives codex-cli super-plan the request_user_input interview + <proposed_plan> finalization', () => {
    const prefix = getSuperPlanModePrefix('codex-cli')
    expect(prefix).toContain('request_user_input')
    expect(prefix).toContain('<proposed_plan>')
  })

  it('leaves the SDK codex super-plan prefix byte-identical (finalization injected out-of-band there)', () => {
    const prefix = getSuperPlanModePrefix('codex')
    expect(prefix).toContain('request_user_input')
    expect(prefix).not.toContain('<proposed_plan>')
  })

  it('carries the read-only restraint in every codex-cli planning prefix (yolo has no other guard)', () => {
    // codex-cli spawns in yolo mode, so the prompt is the only thing keeping a
    // planning turn from mutating the worktree.
    expect(getPlanModePrefix('codex-cli')).toContain('Do NOT modify files')
    expect(getSuperPlanModePrefix('codex-cli')).toContain('Do NOT modify files')
    // The SDK codex enforces plan restraint out-of-band (collaboration mode), so
    // its super-plan prompt deliberately does NOT carry the text restraint.
    expect(getSuperPlanModePrefix('codex')).not.toContain('Do NOT modify files')
  })

  it('implements the codex way — a bare "Implement the plan." (no re-sent plan markdown)', () => {
    expect(buildSdkPlanImplementationPrompt('codex-cli', '# some plan\n- a\n- b')).toBe(
      'Implement the plan.'
    )
    // claude-cli still re-sends the plan text.
    expect(buildSdkPlanImplementationPrompt('claude-code-cli', '# some plan')).toContain(
      '# some plan'
    )
  })

  it('strips the codex plan prefix (so display/goal-file logic sees the raw prompt)', () => {
    expect(stripModePrefix(CODEX_PLAN_MODE_PREFIX + 'do the thing')).toBe('do the thing')
    expect(stripModePrefix(getSuperPlanModePrefix('codex-cli') + 'do the thing')).toBe('do the thing')
  })
})
