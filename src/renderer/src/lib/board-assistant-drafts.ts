import type { BoardAssistantDraft } from '../../../main/db/types'

export const BOARD_DRAFT_BLOCK_CAPTURE_RE = /```board-ticket-drafts\s*([\s\S]*?)```/i

export interface ParsedBoardAssistantDraft extends BoardAssistantDraft {
  validationIssues: string[]
}

export interface ParsedBoardAssistantDraftSet {
  drafts: ParsedBoardAssistantDraft[]
  dependencyCount: number
  hasValidationErrors: boolean
  usesDependencySchema: boolean
}

interface ParseBoardAssistantDraftSetOptions {
  fallbackProjectId?: string | null
  strictProjectId?: string | null
  requireExplicitDraftKeys?: boolean
}

function makeFallbackDraftKey(index: number): string {
  return `draft-${index + 1}`
}

export function parseBoardAssistantDraftSet(
  content: string,
  options: ParseBoardAssistantDraftSetOptions = {}
): ParsedBoardAssistantDraftSet | null {
  const match = content.match(BOARD_DRAFT_BLOCK_CAPTURE_RE)
  if (!match?.[1]) return null

  try {
    const parsed = JSON.parse(match[1]) as { drafts?: unknown[] }
    if (!Array.isArray(parsed.drafts)) return null

    const drafts = parsed.drafts
      .map((draft, index): ParsedBoardAssistantDraft | null => {
        if (!draft || typeof draft !== 'object') return null

        const record = draft as Record<string, unknown>
        const rawTitle = typeof record.title === 'string' ? record.title.trim() : ''
        const rawDraftKey = typeof record.draftKey === 'string' ? record.draftKey.trim() : ''
        const projectId =
          typeof record.projectId === 'string' && record.projectId.trim()
            ? record.projectId.trim()
            : options.fallbackProjectId?.trim() ?? ''
        const dependsOn = Array.isArray(record.dependsOn)
          ? Array.from(
              new Set(
                record.dependsOn
                  .filter((dependency): dependency is string => typeof dependency === 'string')
                  .map((dependency) => dependency.trim())
                  .filter(Boolean)
              )
            )
          : []
        const warnings = Array.isArray(record.warnings)
          ? record.warnings.filter((warning): warning is string => typeof warning === 'string')
          : []
        const validationIssues: string[] = []

        if (!rawTitle) {
          validationIssues.push('Draft is missing a title.')
        }
        if (!projectId) {
          validationIssues.push('Draft is missing a projectId.')
        }
        if (options.strictProjectId && projectId && projectId !== options.strictProjectId) {
          validationIssues.push(`Draft projectId must be ${options.strictProjectId}.`)
        }
        if (options.requireExplicitDraftKeys && !rawDraftKey) {
          validationIssues.push('Draft is missing a draftKey.')
        }

        const draftKey = rawDraftKey || makeFallbackDraftKey(index)

        return {
          draftKey,
          title: rawTitle || `Untitled draft ${index + 1}`,
          description:
            typeof record.description === 'string' && record.description.trim()
              ? record.description.trim()
              : null,
          projectId,
          dependsOn,
          warnings,
          validationIssues
        }
      })
      .filter((draft): draft is ParsedBoardAssistantDraft => draft !== null)

    const draftKeyCounts = new Map<string, number>()
    for (const draft of drafts) {
      draftKeyCounts.set(draft.draftKey, (draftKeyCounts.get(draft.draftKey) ?? 0) + 1)
    }

    const draftMap = new Map(drafts.map((draft) => [draft.draftKey, draft]))
    for (const draft of drafts) {
      if ((draftKeyCounts.get(draft.draftKey) ?? 0) > 1) {
        draft.validationIssues.push(`Duplicate draftKey "${draft.draftKey}".`)
      }

      for (const dependency of draft.dependsOn) {
        if (dependency === draft.draftKey) {
          draft.validationIssues.push('Draft cannot depend on itself.')
          continue
        }
        if (!draftMap.has(dependency)) {
          draft.validationIssues.push(`Depends on unknown draftKey "${dependency}".`)
        }
      }
    }

    const visitState = new Map<string, 'visiting' | 'done'>()
    const cycleKeys = new Set<string>()
    const visit = (draftKey: string, trail: string[]): void => {
      const state = visitState.get(draftKey)
      if (state === 'visiting') {
        const cycleStart = trail.indexOf(draftKey)
        const cycleTrail = cycleStart >= 0 ? trail.slice(cycleStart) : [draftKey]
        for (const key of cycleTrail) {
          cycleKeys.add(key)
        }
        return
      }
      if (state === 'done') return

      visitState.set(draftKey, 'visiting')
      const draft = draftMap.get(draftKey)
      if (draft) {
        for (const dependency of draft.dependsOn) {
          if (!draftMap.has(dependency)) continue
          visit(dependency, [...trail, draftKey])
        }
      }
      visitState.set(draftKey, 'done')
    }

    for (const draft of drafts) {
      visit(draft.draftKey, [])
    }

    for (const cycleKey of cycleKeys) {
      draftMap.get(cycleKey)?.validationIssues.push('Draft is part of a dependency cycle.')
    }

    return {
      drafts,
      dependencyCount: drafts.reduce((count, draft) => count + draft.dependsOn.length, 0),
      hasValidationErrors: drafts.some((draft) => draft.validationIssues.length > 0),
      usesDependencySchema: drafts.some((draft) => draft.dependsOn.length > 0 || !draft.draftKey.startsWith('draft-'))
    }
  } catch {
    return null
  }
}
