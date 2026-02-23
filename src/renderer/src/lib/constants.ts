export const PLAN_MODE_PREFIX =
  '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'

export const ASK_MODE_PREFIX =
  '[Mode: Ask] You are in question-answering mode. The user wants information only. Do NOT make any code changes, do NOT use file editing tools, do NOT modify any files. Simply answer the question directly and concisely.\n\n'

export function stripPlanModePrefix(value: string): string {
  if (value.startsWith(PLAN_MODE_PREFIX)) {
    return value.slice(PLAN_MODE_PREFIX.length)
  }
  return value
}

export function stripAskModePrefix(value: string): string {
  if (value.startsWith(ASK_MODE_PREFIX)) {
    return value.slice(ASK_MODE_PREFIX.length)
  }
  return value
}
