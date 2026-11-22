import { prdFlowPrefix } from '@shared/document-flow/prd-flow'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import { toast } from '@/lib/toast'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePrdFlowStore, type PrdFlowDraft } from '@/stores/usePrdFlowStore'
import type { KanbanTicket } from '../../../../main/db/types'
import { findPrdFlowTicket } from './board'
import { startPrdFlow } from './start'

// A PRD flow saved for later ("Save for later" in the form of "New PRD → orchestrator
// ticket…"): the form's answers become a ticket in To Do and a draft in the store, and nothing
// is started. The person opens the draft again from its card, edits it, and launches it, from
// the form or straight from the card; the launch (./start) turns the draft's ticket into the
// ticket of a flow. A draft is dropped the moment its ticket stops being a draft's ticket: it
// was launched as an ordinary ticket, moved on, archived or deleted. And it follows its ticket:
// one that is renamed on the board renames the draft.

export interface SavePrdFlowDraftInput {
  projectId: string
  name: string
  prompt: string
  research: boolean
  clarify: boolean
  /** The agent and model chosen in the form; null = the app's default launch. */
  launch: DocumentRunLaunchConfig | null
  /** The ticket of the draft that is saved again; absent for a new draft. */
  ticketId?: string
}

export type SavePrdFlowDraftResult = { ok: true; ticketId: string } | { ok: false; error: string }

/**
 * A draft's ticket waits in To Do with no session: a ticket that was started, moved on or
 * archived is an ordinary ticket, whatever was once saved for it.
 */
export function isPrdFlowDraftTicket(
  ticket: Pick<KanbanTicket, 'column' | 'current_session_id' | 'archived_at'>
): boolean {
  return ticket.column === 'todo' && !ticket.current_session_id && !ticket.archived_at
}

/**
 * The saved draft of the ticket, while the ticket is still a draft's (see
 * isPrdFlowDraftTicket) and has no flow; null otherwise. A hook: the card draws from it.
 */
export function useLivePrdFlowDraft(ticket: KanbanTicket): PrdFlowDraft | null {
  const draft = usePrdFlowStore((state) =>
    state.flows[ticket.id] ? null : (state.drafts[ticket.id] ?? null)
  )
  return draft && isPrdFlowDraftTicket(ticket) ? draft : null
}

/**
 * Saves the form's answers for later: a new draft gets a ticket in To Do, a draft that is saved
 * again has its ticket renamed to match. Only the name is needed; the prompt can wait until the
 * launch. Never rejects: whatever stops the save comes back as `ok: false` with the sentence the
 * form shows.
 */
export async function savePrdFlowDraft(
  input: SavePrdFlowDraftInput
): Promise<SavePrdFlowDraftResult> {
  const name = input.name.trim()
  const prompt = input.prompt.trim()
  if (!name) return { ok: false, error: 'Give the ticket a name.' }
  if (!prdFlowPrefix(name)) {
    return { ok: false, error: 'The name needs at least one letter or digit.' }
  }

  const kanban = useKanbanStore.getState()
  const now = Date.now()
  let ticketId: string
  let createdAt = now
  if (input.ticketId) {
    const saved = usePrdFlowStore.getState().drafts[input.ticketId]
    const ticket = findPrdFlowTicket(input.projectId, input.ticketId)
    if (!saved || !ticket || !isPrdFlowDraftTicket(ticket)) {
      return { ok: false, error: 'This draft is no longer waiting in To Do.' }
    }
    if (ticket.title !== name || (ticket.description ?? '') !== prompt) {
      try {
        await kanban.updateTicket(input.ticketId, input.projectId, {
          title: name,
          description: prompt || null
        })
      } catch (error) {
        console.warn('[prdFlow] could not update the ticket of a draft', error)
        return { ok: false, error: 'The ticket could not be updated.' }
      }
    }
    ticketId = input.ticketId
    createdAt = saved.createdAt
  } else {
    try {
      const ticket = await kanban.createTicket(input.projectId, {
        project_id: input.projectId,
        title: name,
        description: prompt || null,
        column: 'todo'
      })
      ticketId = ticket.id
    } catch (error) {
      console.warn('[prdFlow] could not create the ticket of a draft', error)
      return { ok: false, error: 'The ticket could not be created.' }
    }
  }

  const store = usePrdFlowStore.getState()
  store.putDraft({
    ticketId,
    projectId: input.projectId,
    name,
    prompt,
    research: input.research,
    clarify: input.clarify,
    launch: input.launch,
    createdAt,
    updatedAt: now
  })
  // The next form opens on the same agent and model (null: the app's default).
  store.setLaunchPref(input.launch)
  return { ok: true, ticketId }
}

/** Drafts this page is launching at this moment: one launch per draft. */
const launchingDrafts = new Set<string>()

/**
 * Launches a saved draft as it stands, from its card: its ticket becomes the ticket of a PRD
 * flow. A draft that cannot be launched yet (no prompt, a name whose files exist, an agent
 * that is not installed) opens in the form instead, with the reason said. Does nothing for a
 * ticket with no draft, or while a launch of the same draft is under way. Never rejects.
 */
export async function launchSavedPrdFlowDraft(ticketId: string): Promise<void> {
  const draft = usePrdFlowStore.getState().drafts[ticketId]
  if (!draft || launchingDrafts.has(ticketId)) return
  launchingDrafts.add(ticketId)
  try {
    const result = await startPrdFlow({
      projectId: draft.projectId,
      name: draft.name,
      prompt: draft.prompt,
      research: draft.research,
      clarify: draft.clarify,
      launch: draft.launch,
      ticketId
    })
    if (result.ok) {
      toast.success(`PRD flow started: “${draft.name}”`)
      return
    }
    toast.error(`PRD draft “${draft.name}” was not launched: ${result.error}`)
    // Still a draft: the form is where it is put right.
    if (usePrdFlowStore.getState().drafts[ticketId]) {
      usePrdFlowStore.getState().openDialog(draft.projectId, ticketId)
    }
  } finally {
    launchingDrafts.delete(ticketId)
  }
}

/**
 * "Convert to ordinary ticket": the app forgets the draft and nothing else. Its ticket stays in
 * To Do, with the name as its title and the prompt as its description.
 */
export function discardPrdFlowDraft(ticketId: string): void {
  const store = usePrdFlowStore.getState()
  const draft = store.drafts[ticketId]
  if (!draft) return
  store.removeDraft(ticketId)
  toast.info(`“${draft.name}” is an ordinary ticket now.`)
}

/**
 * Brings the drafts in step with what this page's board shows of their tickets. A draft whose
 * ticket is no draft's ticket any more (it was started as an ordinary ticket, moved out of To
 * Do or archived) is forgotten. A draft whose ticket was renamed or rewritten on the board
 * ("Rename" in the card's menu, the board assistant) takes the ticket's title as its name and
 * the description as its prompt: the ticket is what the person sees, and the launch must not
 * put the older words back. A ticket the board does not show says nothing (its board may not
 * be loaded, or the list may be an older one): the draft of a deleted ticket is forgotten by
 * whoever deletes it.
 */
export function reconcilePrdFlowDrafts(): void {
  const store = usePrdFlowStore.getState()
  for (const draft of Object.values(store.drafts)) {
    const ticket = findPrdFlowTicket(draft.projectId, draft.ticketId)
    if (!ticket) continue
    if (!isPrdFlowDraftTicket(ticket)) {
      store.removeDraft(draft.ticketId)
      continue
    }
    const name = ticket.title.trim()
    const prompt = (ticket.description ?? '').trim()
    if (name && (name !== draft.name || prompt !== draft.prompt)) {
      store.putDraft({ ...draft, name, prompt, updatedAt: Date.now() })
    }
  }
}

/**
 * Keeps the drafts in step with the board for as long as the returned stop is not called:
 * reconcilePrdFlowDrafts now, and again whenever the board's tickets change.
 */
export function watchPrdFlowDrafts(): () => void {
  reconcilePrdFlowDrafts()
  return useKanbanStore.subscribe((state, previous) => {
    if (state.tickets !== previous.tickets) reconcilePrdFlowDrafts()
  })
}

export function resetPrdFlowDraftLaunchesForTests(): void {
  launchingDrafts.clear()
}
