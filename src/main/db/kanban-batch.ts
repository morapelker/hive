import type { KanbanTicketBatchCreateItem } from './types'

export type NormalizedKanbanBatchDraft = KanbanTicketBatchCreateItem & {
  draft_key: string
  title: string
  project_id: string
  depends_on: string[]
}

export function normalizeKanbanBatchDrafts(
  drafts: KanbanTicketBatchCreateItem[]
): NormalizedKanbanBatchDraft[] {
  if (drafts.length === 0) {
    throw new Error('Batch ticket creation requires at least one draft')
  }

  const normalized: NormalizedKanbanBatchDraft[] = []
  const draftKeys = new Set<string>()
  let projectId: string | null = null

  for (const draft of drafts) {
    const draftKey = draft.draft_key.trim()
    const title = draft.title.trim()
    const nextProjectId = draft.project_id.trim()

    if (!draftKey) {
      throw new Error('Each batch draft must include a draft_key')
    }
    if (!title) {
      throw new Error(`Draft "${draftKey}" must include a title`)
    }
    if (!nextProjectId) {
      throw new Error(`Draft "${draftKey}" must include a project_id`)
    }
    if (draftKeys.has(draftKey)) {
      throw new Error(`Duplicate draft_key "${draftKey}" in batch`)
    }

    if (projectId === null) {
      projectId = nextProjectId
    } else if (projectId !== nextProjectId) {
      throw new Error('All drafts in a batch must belong to the same project')
    }

    const dependsOn = Array.from(
      new Set(
        (draft.depends_on ?? [])
          .filter((dependency): dependency is string => typeof dependency === 'string')
          .map((dependency) => dependency.trim())
          .filter(Boolean)
      )
    )

    if (dependsOn.includes(draftKey)) {
      throw new Error(`Draft "${draftKey}" cannot depend on itself`)
    }

    draftKeys.add(draftKey)
    normalized.push({
      ...draft,
      draft_key: draftKey,
      title,
      project_id: nextProjectId,
      depends_on: dependsOn
    })
  }

  const normalizedKeySet = new Set(normalized.map((draft) => draft.draft_key))
  for (const draft of normalized) {
    for (const dependency of draft.depends_on) {
      if (!normalizedKeySet.has(dependency)) {
        throw new Error(`Draft "${draft.draft_key}" depends on unknown draft "${dependency}"`)
      }
    }
  }

  const visitState = new Map<string, 'visiting' | 'done'>()
  const visit = (draftKey: string): void => {
    const state = visitState.get(draftKey)
    if (state === 'visiting') {
      throw new Error(`Draft dependencies contain a cycle involving "${draftKey}"`)
    }
    if (state === 'done') return

    visitState.set(draftKey, 'visiting')
    const draft = normalized.find((item) => item.draft_key === draftKey)
    if (!draft) return

    for (const dependency of draft.depends_on) {
      visit(dependency)
    }

    visitState.set(draftKey, 'done')
  }

  for (const draft of normalized) {
    visit(draft.draft_key)
  }

  return normalized
}
