import {
  CODEX_SUPER_PLAN_MODE_PREFIX,
  PLAN_MODE_PREFIX,
  SUPER_PLAN_MODE_PREFIX
} from '@shared/agent-mode-prefixes'

export {
  CODEX_SUPER_PLAN_MODE_PREFIX,
  PLAN_MODE_PREFIX,
  SUPER_PLAN_MODE_PREFIX,
  getSuperPlanModePrefix
} from '@shared/agent-mode-prefixes'

export const ASK_MODE_PREFIX =
  '[Mode: Ask] You are in question-answering mode. The user wants information only. Do NOT make any code changes, do NOT use file editing tools, do NOT modify any files. Simply answer the question directly and concisely.\n\n'

const SUPER_PLAN_MODE_PREFIXES = [CODEX_SUPER_PLAN_MODE_PREFIX, SUPER_PLAN_MODE_PREFIX]

export function stripSuperPlanModePrefix(value: string): string | null {
  for (const prefix of SUPER_PLAN_MODE_PREFIXES) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length)
    }
  }

  return null
}

export function stripModePrefix(value: string): string {
  const superPlanStripped = stripSuperPlanModePrefix(value)
  if (superPlanStripped !== null) {
    return superPlanStripped
  }
  if (value.startsWith(PLAN_MODE_PREFIX)) {
    return value.slice(PLAN_MODE_PREFIX.length)
  }
  return value
}

/** @deprecated Use stripModePrefix instead */
export const stripPlanModePrefix = stripModePrefix

export function isPlanLike(mode: string | null | undefined): boolean {
  return mode === 'plan' || mode === 'super-plan'
}
