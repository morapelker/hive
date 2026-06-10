/**
 * Single source of truth for the agent-SDK union and the capability checks that
 * distinguish the SDKs. Previously the union was redeclared ~6 times (main DB
 * types, shared session type, both renderer stores, the main implementer
 * registry, the renderer availability helper) and the behaviors that set the
 * SDKs apart were re-encoded as raw string comparisons (`=== 'claude-code-cli'`,
 * `=== 'terminal' || === 'claude-code-cli'`, etc.) across many files.
 *
 * Centralizing both means adding a 6th SDK is a single-point change here, and
 * the intent of each comparison ("is this terminal-backed?", "does it share the
 * Claude model catalog?") is named rather than re-derived at each call site.
 *
 * The helpers accept `string | null | undefined` (not just `AgentSdk`) so they
 * drop in at the many call sites where `agent_sdk` is carried as a plain string
 * (DB rows, store records typed loosely, IPC payloads).
 */

/**
 * The canonical list of agent-SDK identifiers. The {@link AgentSdk} type is
 * derived from this, and the zod schemas that validate IPC/DB payloads build on
 * it (`z.enum(AGENT_SDK_VALUES)`) — so the type and every runtime validator stay
 * in lockstep and adding a 6th SDK is a one-line change here.
 */
export const AGENT_SDK_VALUES = [
  'opencode',
  'claude-code',
  'claude-code-cli',
  'codex',
  'terminal'
] as const

export type AgentSdk = (typeof AGENT_SDK_VALUES)[number]

/** SDKs a session can be handed off to / launched as — everything except the bare terminal. */
export type HandoffAgentSdk = Exclude<AgentSdk, 'terminal'>

type MaybeSdk = AgentSdk | string | null | undefined

/** The Claude Code CLI session type (terminal-backed Claude, distinct from the SDK-driven `claude-code`). */
export function isClaudeCli(sdk: MaybeSdk): boolean {
  return sdk === 'claude-code-cli'
}

/**
 * Sessions whose UI is a live terminal surface rather than the OpenCode-style
 * streaming view: the bare `terminal` SDK and `claude-code-cli`. These share
 * mount/teardown handling and must NOT be routed through the OpenCode IPC.
 */
export function isTerminalBacked(sdk: MaybeSdk): boolean {
  return sdk === 'terminal' || sdk === 'claude-code-cli'
}

/** Either Claude variant — the SDK-driven `claude-code` or the terminal-backed `claude-code-cli`. */
export function isClaudeFamily(sdk: MaybeSdk): boolean {
  return sdk === 'claude-code' || sdk === 'claude-code-cli'
}

/** SDKs whose CLI understands the `/goal` prompt prefix (persistent goal mode). */
export function supportsGoalMode(sdk: MaybeSdk): boolean {
  return sdk === 'codex' || sdk === 'claude-code-cli'
}

/**
 * Map an SDK to the one whose model catalog it uses. `claude-code-cli` has no
 * catalog of its own — it shares `claude-code`'s — so model-listing/selection
 * code should resolve through this rather than special-casing the CLI inline.
 * Overloaded so nullable inputs (optional IPC payload fields) pass `null` /
 * `undefined` through unchanged.
 */
export function toModelCatalogSdk(sdk: AgentSdk): AgentSdk
export function toModelCatalogSdk(sdk: AgentSdk | null | undefined): AgentSdk | null | undefined
export function toModelCatalogSdk(sdk: AgentSdk | null | undefined): AgentSdk | null | undefined {
  return sdk === 'claude-code-cli' ? 'claude-code' : sdk
}
