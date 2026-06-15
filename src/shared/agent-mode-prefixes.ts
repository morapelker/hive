export const PLAN_MODE_PREFIX =
  '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'

export const SUPER_PLAN_MODE_PREFIX =
  'Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.\n\nIf a question can be answered by exploring the codebase, explore the codebase instead.\nAll questions should be asked using the AskUserQuestion tool if possible\n\n'

export const CODEX_SUPER_PLAN_MODE_PREFIX =
  'Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.\n\nIf a question can be answered by exploring the codebase, explore the codebase instead.\nAll questions should be asked using the request_user_input tool if possible\n\n'

// Header that introduces the raw plan in a plan→implementor handoff prompt. Shared so the
// renderer (which writes it in buildHandoffPrompt) and the main process (which detects and
// strips it when externalizing oversized claude-cli goal handoffs) can't drift apart.
export const HANDOFF_PLAN_PROMPT_HEADER = 'Implement the following plan\n'

export function getSuperPlanModePrefix(agentSdk: string | null | undefined): string {
  return agentSdk === 'codex' ? CODEX_SUPER_PLAN_MODE_PREFIX : SUPER_PLAN_MODE_PREFIX
}

export function applyModePrefix(
  text: string,
  mode: 'build' | 'plan' | 'super-plan' | null | undefined
): string {
  if (mode === 'plan') return PLAN_MODE_PREFIX + text
  if (mode === 'super-plan') return SUPER_PLAN_MODE_PREFIX + text
  return text
}
