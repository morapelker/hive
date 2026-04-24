export interface CodexModelInfo {
  id: string
  name: string
  limit: { context: number; output: number }
  variants: Record<string, Record<string, never>>
  defaultVariant: string
}

export const CODEX_REASONING_EFFORTS = ['xhigh', 'high', 'medium', 'low'] as const
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number]

const CODEX_EFFORT_VARIANTS: Record<string, Record<string, never>> = {
  xhigh: {},
  high: {},
  medium: {},
  low: {}
}

export const CODEX_MODELS: CodexModelInfo[] = [
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    limit: { context: 400000, output: 32000 },
    variants: CODEX_EFFORT_VARIANTS,
    defaultVariant: 'high'
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    limit: { context: 258400, output: 32000 },
    variants: CODEX_EFFORT_VARIANTS,
    defaultVariant: 'high'
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    limit: { context: 258400, output: 32000 },
    variants: CODEX_EFFORT_VARIANTS,
    defaultVariant: 'high'
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    limit: { context: 258400, output: 16000 },
    variants: CODEX_EFFORT_VARIANTS,
    defaultVariant: 'high'
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    limit: { context: 258400, output: 16000 },
    variants: CODEX_EFFORT_VARIANTS,
    defaultVariant: 'high'
  }
]

export const CODEX_DEFAULT_MODEL = 'gpt-5.5'

/**
 * Returns all available Codex models in the format expected by the renderer.
 * Shape matches ClaudeCodeImplementer.getAvailableModels().
 */
export function getAvailableCodexModels(): Array<{
  id: string
  name: string
  models: Record<
    string,
    {
      id: string
      name: string
      limit: { context: number; output: number }
      variants: Record<string, Record<string, never>>
    }
  >
}> {
  return [
    {
      id: 'codex',
      name: 'Codex',
      models: Object.fromEntries(
        CODEX_MODELS.map((m) => [
          m.id,
          { id: m.id, name: m.name, limit: m.limit, variants: m.variants }
        ])
      )
    }
  ]
}

/**
 * Look up a specific model by its ID.
 * Returns model metadata or null if the model is not found.
 */
export function getCodexModelInfo(
  modelId: string
): { id: string; name: string; limit: { context: number; output: number } } | null {
  const normalized = normalizeCodexModelSlug(modelId) ?? modelId
  const model = CODEX_MODELS.find((m) => m.id === normalized)
  if (!model) return null
  return { id: model.id, name: model.name, limit: model.limit }
}

// ── Model slug normalization ──────────────────────────────────────

export const CODEX_MODEL_ALIASES: Record<string, string> = {
  '5.5': 'gpt-5.5',
  '5.4': 'gpt-5.4',
  '5.3': 'gpt-5.3-codex',
  'gpt-5.3': 'gpt-5.3-codex',
  '5.3-spark': 'gpt-5.3-codex-spark',
  'gpt-5.3-spark': 'gpt-5.3-codex-spark',
  '5.2': 'gpt-5.2-codex',
  'gpt-5.2': 'gpt-5.2-codex'
}

export function normalizeCodexModelSlug(model: string | null | undefined): string | null {
  if (typeof model !== 'string') return null
  const trimmed = model.trim()
  if (!trimmed) return null
  return CODEX_MODEL_ALIASES[trimmed] ?? trimmed
}

export function resolveCodexModelSlug(model: string | null | undefined): string {
  const normalized = normalizeCodexModelSlug(model)
  if (!normalized) return CODEX_DEFAULT_MODEL
  const valid = CODEX_MODELS.find((m) => m.id === normalized)
  return valid ? normalized : CODEX_DEFAULT_MODEL
}
