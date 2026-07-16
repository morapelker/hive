export function looksLikeCodexProposedPlan(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false

  const nonEmptyLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const hasSteps = /(^|\n)\s*(?:[-*]|\d+\.)\s+\S/m.test(trimmed)
  const startsWithQuestion = /^[^\n]*\?\s*(?:\n|$)/.test(trimmed)
  const hasStructuredPlanBody =
    hasSteps || (nonEmptyLines.length >= 2 && nonEmptyLines.some((line) => line.length > 24))

  return hasStructuredPlanBody && !startsWithQuestion
}

export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`
}

export function buildSdkPlanImplementationPrompt(
  agentSdk: string | null | undefined,
  planMarkdown: string
): string {
  // Both codex providers keep the just-produced <proposed_plan> in context, so
  // "Implement the plan." is enough — no need to re-send the plan markdown.
  return agentSdk === 'codex' || agentSdk === 'codex-cli'
    ? 'Implement the plan.'
    : buildPlanImplementationPrompt(planMarkdown)
}

export function resolvePlanFollowUpSubmission(input: { draftText: string; planMarkdown: string }): {
  text: string
  interactionMode: 'build' | 'plan'
} {
  const trimmedDraftText = input.draftText.trim()
  if (trimmedDraftText.length > 0) {
    return {
      text: trimmedDraftText,
      interactionMode: 'plan'
    }
  }

  return {
    text: buildPlanImplementationPrompt(input.planMarkdown),
    interactionMode: 'build'
  }
}
