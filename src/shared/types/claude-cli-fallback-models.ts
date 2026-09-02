/**
 * Claude CLI safety / usage fallbacks land a session on an Opus 4.x snapshot
 * (e.g. Fable 5.1's dual-use guard degrades to Opus 4.8). These are real models
 * the CLI answers on, but they are NOT selectable picker options — the picker
 * only offers the current top-tier line (Opus 5, Fable 5.1, …). Collapsing them
 * to the plain `opus` alias made a degraded session read as the selectable
 * "Opus 5" on its ticket badge, so they get their own id + display name here.
 *
 * This module is the single source of truth shared by the main-process detector
 * (which stores the id on the session) and the renderer (which resolves the
 * display name and fallback tag) — neither should hard-code these strings.
 */

/** Matches an Opus 4.x model in either raw (`claude-opus-4-8`) or id (`opus-4-8`) form. */
const OPUS_4X_PATTERN = /opus-4-(\d+)/

/** A fallback model id Hive stores on the session (e.g. `opus-4-8`). */
const FALLBACK_MODEL_ID_PATTERN = /^opus-4-(\d+)$/

export interface ClaudeCliFallbackModel {
  /** Stable, non-selectable model id stored on the session (e.g. `opus-4-8`). */
  id: string
  /** Human display name for badges/selectors (e.g. `Opus 4.8`). */
  name: string
}

/**
 * Resolve a raw CLI model (from the transcript, e.g. `claude-opus-4-8`) or an
 * already-stored fallback id to its fallback descriptor, or null when it is a
 * normal selectable model.
 */
export function resolveClaudeCliFallbackModel(
  rawModel: string | null | undefined
): ClaudeCliFallbackModel | null {
  if (!rawModel) return null
  const match = OPUS_4X_PATTERN.exec(rawModel.toLowerCase())
  if (!match) return null
  const minor = match[1]
  return { id: `opus-4-${minor}`, name: `Opus 4.${minor}` }
}

/** True when a stored model id is a non-selectable safety/usage fallback. */
export function isClaudeCliFallbackModelId(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && FALLBACK_MODEL_ID_PATTERN.test(modelId)
}

/** Display name for a stored fallback model id, or null when it is not one. */
export function claudeCliFallbackModelName(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  const match = FALLBACK_MODEL_ID_PATTERN.exec(modelId)
  return match ? `Opus 4.${match[1]}` : null
}
