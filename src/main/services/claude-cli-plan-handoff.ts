import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HANDOFF_PLAN_PROMPT_HEADER } from '@shared/agent-mode-prefixes'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeCliPlanHandoff' })

const GOAL_PREFIX = '/goal '
// '/goal Implement the following plan\n' — uniquely identifies a claude-cli goal-mode
// handoff (the `/goal ` prefix == goal mode; the header == plan→implementor handoff).
const HANDOFF_MARKER = GOAL_PREFIX + HANDOFF_PLAN_PROMPT_HEADER

export interface ExternalizeGoalHandoffPlanOptions {
  /** Override the generated UUID (tests). */
  uuid?: string
  /** Override the file writer (tests). */
  writeFile?: (filePath: string, content: string) => void
}

/**
 * claude-cli rejects `/goal` statements longer than ~4k characters. When a plan is handed
 * off to a claude-cli implementor in goal mode, the whole plan rides inline on the prompt
 * and large plans fail to start. This writes the raw plan to `PLAN_{uuid}.md` in the
 * implementor's worktree and replaces the inline plan with a short reference.
 *
 * Returns the (possibly rewritten) prompt. Prompts that are not goal-mode handoffs — and any
 * prompt where the file write fails — pass through unchanged so the session still starts.
 */
export function externalizeGoalHandoffPlan(
  prompt: string,
  worktreePath: string,
  opts?: ExternalizeGoalHandoffPlanOptions
): string {
  const idx = prompt.indexOf(HANDOFF_MARKER)
  if (idx === -1) return prompt

  const leadingPrefix = prompt.slice(0, idx) // preserves any leading super-plan prefix
  const planBody = prompt.slice(idx + HANDOFF_MARKER.length) // the raw plan content
  const uuid = opts?.uuid ?? randomUUID()
  const fileName = `PLAN_${uuid}.md`

  try {
    ;(opts?.writeFile ?? writeFileSync)(join(worktreePath, fileName), planBody)
  } catch (error) {
    log.warn('Failed to write handoff plan file; falling back to inline prompt', {
      worktreePath,
      fileName,
      error: error instanceof Error ? error.message : String(error)
    })
    return prompt
  }

  log.info('Externalized goal handoff plan', { worktreePath, fileName })
  return `${leadingPrefix}${GOAL_PREFIX}implement ${fileName}. the goal's success criteria is written there`
}
