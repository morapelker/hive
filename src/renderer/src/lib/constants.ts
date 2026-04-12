export const PLAN_MODE_PREFIX =
  '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'

export const SUPER_PLAN_MODE_PREFIX =
  'Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.\n\nIf a question can be answered by exploring the codebase, explore the codebase instead.\nAll questions should be asked using the AskUserQuestion tool if possible\n\n'

export const CODEX_SUPER_PLAN_MODE_PREFIX =
  'Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.\n\nIf a question can be answered by exploring the codebase, explore the codebase instead.\nAll questions should be asked using the request_user_input tool if possible\n\n'

export const ASK_MODE_PREFIX =
  '[Mode: Ask] You are in question-answering mode. The user wants information only. Do NOT make any code changes, do NOT use file editing tools, do NOT modify any files. Simply answer the question directly and concisely.\n\n'

const SUPER_PLAN_MODE_PREFIXES = [CODEX_SUPER_PLAN_MODE_PREFIX, SUPER_PLAN_MODE_PREFIX]

export function getSuperPlanModePrefix(agentSdk: string | null | undefined): string {
  return agentSdk === 'codex' ? CODEX_SUPER_PLAN_MODE_PREFIX : SUPER_PLAN_MODE_PREFIX
}

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
