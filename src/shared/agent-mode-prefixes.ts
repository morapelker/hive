export const PLAN_MODE_PREFIX =
  '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'

/**
 * Codex's plan convention (shared by the `codex` app-server SDK and the
 * `codex-cli` terminal provider): codex has no ExitPlanMode tool — the model
 * signals "plan is ready" by emitting a `<proposed_plan>…</proposed_plan>`
 * block. The SDK injects this as `collaborationMode` developer_instructions;
 * codex-cli, having no developer-instruction channel, injects it as a prompt
 * prefix instead. Detection extracts the block (extractProposedPlanText in
 * codex-cli-hooks.ts / extractProposedPlanMarkdown in codex-implementer.ts).
 */
export const CODEX_PROPOSED_PLAN_FINALIZATION =
  'When your plan is complete, output it wrapped in `<proposed_plan>` and `</proposed_plan>` tags, with the implementation steps as markdown inside the block. Producing that block IS the signal that you are done — do NOT ask "should I proceed?" and do NOT implement anything after it.\n\n'

/**
 * The read-only restraint every codex-cli planning prefix must carry. codex-cli
 * always spawns in yolo mode (`--dangerously-bypass-approvals-and-sandbox`, no
 * sandbox), so — unlike the `codex` app-server SDK, which enforces plan
 * restraint out-of-band via its collaboration mode — the prompt text is the
 * ONLY thing stopping the agent from mutating the worktree while the UI still
 * treats the turn as planning. Shared by the plain plan and super-plan prefixes
 * so they can't drift.
 */
export const CODEX_READ_ONLY_RESTRAINT =
  'Do NOT modify files or run mutating commands — only read, explore, search, and reason about the codebase. '

/**
 * Plan-mode prompt prefix for the codex-cli terminal provider. Mirrors the
 * restraint + finalization rules of the SDK's plan collaboration instructions,
 * so codex-cli asks for a plan the codex way (a `<proposed_plan>` block) rather
 * than the claude way (`--permission-mode plan` + an ExitPlanMode tool call).
 */
export const CODEX_PLAN_MODE_PREFIX =
  '[Mode: Plan] Investigate and design an approach. ' +
  CODEX_READ_ONLY_RESTRAINT +
  CODEX_PROPOSED_PLAN_FINALIZATION

export const SUPER_PLAN_MODE_PREFIX =
  'Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.\n\nIf a question can be answered by exploring the codebase, explore the codebase instead.\nAll questions should be asked using the AskUserQuestion tool if possible\n\n'

// Unchanged from before the codex-cli work — used by the `codex` app-server
// SDK, which supplies the `<proposed_plan>` finalization out-of-band via
// developer_instructions. Kept byte-identical so stripping of already-persisted
// codex super-plan messages still matches (the constant doubles as the strip
// key — see stripSuperPlanModePrefix).
export const CODEX_SUPER_PLAN_MODE_PREFIX =
  'Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.\n\nIf a question can be answered by exploring the codebase, explore the codebase instead.\nAll questions should be asked using the request_user_input tool if possible\n\n'

/**
 * codex-cli's super-plan prefix: the interview instruction, the same read-only
 * restraint the plain codex-cli plan prefix carries, plus the `<proposed_plan>`
 * finalization (codex-cli has no developer-instruction channel, so both ride
 * the prompt). The restraint is essential here because codex-cli super-plan
 * launches still spawn in yolo mode — without it the interview could mutate the
 * worktree while the ticket is treated as planning. This is a NEW constant, so
 * there are no pre-existing persisted messages to break; the strip list picks
 * it up alongside the plain codex prefix (it still starts with
 * CODEX_SUPER_PLAN_MODE_PREFIX, so longest-first stripping is unaffected).
 */
export const CODEX_CLI_SUPER_PLAN_MODE_PREFIX =
  CODEX_SUPER_PLAN_MODE_PREFIX + CODEX_READ_ONLY_RESTRAINT + CODEX_PROPOSED_PLAN_FINALIZATION

// Header that introduces the raw plan in a plan→implementor handoff prompt. Shared so the
// renderer (which writes it in buildHandoffPrompt) and the main process (which detects and
// strips it when externalizing oversized claude-cli goal handoffs) can't drift apart.
export const HANDOFF_PLAN_PROMPT_HEADER = 'Implement the following plan\n'

export function getSuperPlanModePrefix(agentSdk: string | null | undefined): string {
  // Both codex providers interview via request_user_input; only codex-cli also
  // needs the `<proposed_plan>` finalization inline (the SDK injects it
  // out-of-band).
  if (agentSdk === 'codex-cli') return CODEX_CLI_SUPER_PLAN_MODE_PREFIX
  if (agentSdk === 'codex') return CODEX_SUPER_PLAN_MODE_PREFIX
  return SUPER_PLAN_MODE_PREFIX
}

/**
 * The plain plan-mode prompt prefix for an SDK. Only the codex-cli terminal
 * provider uses a codex-style (`<proposed_plan>`) prefix here — the `codex`
 * SDK injects its plan instructions out-of-band (developer_instructions) and
 * so is not covered by this prompt-prefix helper.
 */
export function getPlanModePrefix(agentSdk: string | null | undefined): string {
  if (agentSdk === 'codex-cli') return CODEX_PLAN_MODE_PREFIX
  return PLAN_MODE_PREFIX
}

export function applyModePrefix(
  text: string,
  mode: 'build' | 'plan' | 'super-plan' | null | undefined
): string {
  if (mode === 'plan') return PLAN_MODE_PREFIX + text
  if (mode === 'super-plan') return SUPER_PLAN_MODE_PREFIX + text
  return text
}
