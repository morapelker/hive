import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePrdFlowStore, type PrdFlow, type PrdFlowDraft } from '@/stores/usePrdFlowStore'
import type { KanbanTicket, KanbanTicketCreate, KanbanTicketUpdate } from '../../../../main/db/types'
import {
  discardPrdFlowDraft,
  isPrdFlowDraftTicket,
  launchSavedPrdFlowDraft,
  reconcilePrdFlowDrafts,
  resetPrdFlowDraftLaunchesForTests,
  savePrdFlowDraft,
  watchPrdFlowDrafts,
  type SavePrdFlowDraftInput
} from './draft'

// A PRD flow saved for later, against the real flow and board stores: the ticket and the draft
// a save leaves behind (and what a save is refused for), a draft saved again, the launch of a
// draft from its card (the start itself is ./start's, and is faked here), a draft made an
// ordinary ticket, the drafts that are forgotten when their ticket stops being a draft's, and
// the draft that follows a ticket renamed on the board.

const mocks = vi.hoisted(() => ({
  startPrdFlow: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock('./start', () => ({ startPrdFlow: mocks.startPrdFlow }))
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }))

const PROJECT = 'project-shop'
const TICKET = 'ticket-draft'
const NOW = Date.parse('2026-11-22T09:00:00.000Z')

const LAUNCH: DocumentRunLaunchConfig = {
  sdk: 'codex',
  model: { providerID: 'codex', modelID: 'gpt-5.5', variant: 'high' },
  codexFastMode: true,
  customProviderId: null
}

const initialFlowState = usePrdFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: TICKET,
    project_id: PROJECT,
    title: 'Code mode',
    description: 'Build a code mode.',
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    archived_at: null,
    ...overrides
  } as KanbanTicket
}

function makeDraft(overrides: Partial<PrdFlowDraft> = {}): PrdFlowDraft {
  return {
    ticketId: TICKET,
    projectId: PROJECT,
    name: 'Code mode',
    prompt: 'Build a code mode.',
    research: true,
    clarify: true,
    launch: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...overrides
  }
}

const formInput = (overrides: Partial<SavePrdFlowDraftInput> = {}): SavePrdFlowDraftInput => ({
  projectId: PROJECT,
  name: 'Code mode',
  prompt: 'Build a code mode.',
  research: true,
  clarify: true,
  launch: null,
  ...overrides
})

const drafts = (): Record<string, PrdFlowDraft> => usePrdFlowStore.getState().drafts

function seedTickets(tickets: KanbanTicket[]): void {
  useKanbanStore.setState((state) => ({ tickets: new Map(state.tickets).set(PROJECT, tickets) }))
}

/** A draft in the store with its ticket on the board. */
function seedDraft(draft: PrdFlowDraft = makeDraft(), ticket: Partial<KanbanTicket> = {}): void {
  usePrdFlowStore.getState().putDraft(draft)
  seedTickets([makeTicket(ticket)])
}

let createTicket: ReturnType<typeof vi.fn>
let updateTicket: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  resetPrdFlowDraftLaunchesForTests()
  usePrdFlowStore.setState(initialFlowState, true)

  createTicket = vi.fn(async (projectId: string, data: KanbanTicketCreate) => {
    const ticket = makeTicket({
      project_id: projectId,
      title: data.title,
      description: data.description ?? null,
      column: data.column ?? 'todo'
    })
    seedTickets([...(useKanbanStore.getState().tickets.get(projectId) ?? []), ticket])
    return ticket
  })
  updateTicket = vi.fn(async (ticketId: string, _projectId: string, data: KanbanTicketUpdate) => {
    seedTickets(
      (useKanbanStore.getState().tickets.get(PROJECT) ?? []).map((ticket) =>
        ticket.id === ticketId ? ({ ...ticket, ...data } as KanbanTicket) : ticket
      )
    )
  })
  useKanbanStore.setState(
    { ...initialKanbanState, tickets: new Map(), createTicket, updateTicket } as never,
    true
  )
  mocks.startPrdFlow.mockResolvedValue({ ok: true, ticketId: TICKET })
})

afterEach(() => {
  vi.useRealTimers()
  useKanbanStore.setState(initialKanbanState, true)
})

describe('isPrdFlowDraftTicket', () => {
  it('is a ticket that waits in To Do with no session', () => {
    expect(isPrdFlowDraftTicket(makeTicket())).toBe(true)
  })

  it.each<[string, Partial<KanbanTicket>]>([
    ['was moved to In Progress', { column: 'in_progress' }],
    ['was moved to Review', { column: 'review' }],
    ['was given a session', { current_session_id: 's-1' }],
    ['was archived', { archived_at: '2026-11-22T09:00:00.000Z' }]
  ])('is not a ticket that %s', (_what, overrides) => {
    expect(isPrdFlowDraftTicket(makeTicket(overrides))).toBe(false)
  })
})

describe('savePrdFlowDraft', () => {
  it('puts a ticket in To Do and keeps the answers by its id, starting nothing', async () => {
    await expect(
      savePrdFlowDraft(formInput({ name: '  Code mode ', research: false, launch: LAUNCH }))
    ).resolves.toEqual({ ok: true, ticketId: TICKET })

    expect(createTicket).toHaveBeenCalledExactlyOnceWith(PROJECT, {
      project_id: PROJECT,
      title: 'Code mode',
      description: 'Build a code mode.',
      column: 'todo'
    })
    expect(drafts()).toEqual({
      [TICKET]: {
        ticketId: TICKET,
        projectId: PROJECT,
        name: 'Code mode',
        prompt: 'Build a code mode.',
        research: false,
        clarify: true,
        launch: LAUNCH,
        createdAt: NOW,
        updatedAt: NOW
      }
    })
    expect(usePrdFlowStore.getState().flows).toEqual({})
    expect(mocks.startPrdFlow).not.toHaveBeenCalled()
    // The next form opens on the agent and model chosen here
    expect(usePrdFlowStore.getState().launchPref).toEqual(LAUNCH)
  })

  it('saves a draft whose prompt is not written yet', async () => {
    await expect(savePrdFlowDraft(formInput({ prompt: '  ' }))).resolves.toEqual({
      ok: true,
      ticketId: TICKET
    })

    expect(createTicket.mock.calls[0][1]).toMatchObject({ title: 'Code mode', description: null })
    expect(drafts()[TICKET]).toMatchObject({ prompt: '' })
  })

  it.each([
    ['an empty name', { name: '   ' }, 'Give the ticket a name.'],
    [
      'a name without a letter or a digit',
      { name: ' -> ?! ' },
      'The name needs at least one letter or digit.'
    ]
  ])('refuses %s, and makes no ticket', async (_what, overrides, error) => {
    await expect(savePrdFlowDraft(formInput(overrides))).resolves.toEqual({ ok: false, error })

    expect(createTicket).not.toHaveBeenCalled()
    expect(drafts()).toEqual({})
  })

  it('says so when the ticket could not be created, and keeps no draft', async () => {
    createTicket.mockRejectedValueOnce(new Error('offline'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(savePrdFlowDraft(formInput())).resolves.toEqual({
      ok: false,
      error: 'The ticket could not be created.'
    })

    expect(drafts()).toEqual({})
    warn.mockRestore()
  })

  describe('a draft that is saved again', () => {
    it('renames its ticket and keeps the day it was first saved', async () => {
      seedDraft()

      await expect(
        savePrdFlowDraft(
          formInput({
            ticketId: TICKET,
            name: 'Code mode v2',
            prompt: 'Build it properly.',
            clarify: false
          })
        )
      ).resolves.toEqual({ ok: true, ticketId: TICKET })

      expect(createTicket).not.toHaveBeenCalled()
      expect(updateTicket).toHaveBeenCalledExactlyOnceWith(TICKET, PROJECT, {
        title: 'Code mode v2',
        description: 'Build it properly.'
      })
      expect(drafts()[TICKET]).toEqual(
        makeDraft({
          name: 'Code mode v2',
          prompt: 'Build it properly.',
          clarify: false,
          createdAt: NOW - 60_000,
          updatedAt: NOW
        })
      )
    })

    it('leaves the ticket alone when only a checkmark or the model changed', async () => {
      seedDraft()

      await savePrdFlowDraft(formInput({ ticketId: TICKET, research: false, launch: LAUNCH }))

      expect(updateTicket).not.toHaveBeenCalled()
      expect(drafts()[TICKET]).toMatchObject({ research: false, launch: LAUNCH })
    })

    it.each<[string, () => void]>([
      ['its ticket is gone', () => seedTickets([])],
      ['its ticket was started', () => seedTickets([makeTicket({ current_session_id: 's-1' })])],
      ['its ticket left To Do', () => seedTickets([makeTicket({ column: 'review' })])],
      ['the draft was forgotten', () => usePrdFlowStore.getState().removeDraft(TICKET)]
    ])('is refused when %s', async (_what, change) => {
      seedDraft()
      change()
      const before = drafts()

      await expect(savePrdFlowDraft(formInput({ ticketId: TICKET, name: 'New' }))).resolves.toEqual(
        { ok: false, error: 'This draft is no longer waiting in To Do.' }
      )

      expect(updateTicket).not.toHaveBeenCalled()
      expect(createTicket).not.toHaveBeenCalled()
      expect(drafts()).toBe(before)
    })
  })
})

describe('launchSavedPrdFlowDraft', () => {
  it('starts the flow of the draft on its own ticket, as it was saved', async () => {
    seedDraft(makeDraft({ research: false, launch: LAUNCH }))

    await launchSavedPrdFlowDraft(TICKET)

    expect(mocks.startPrdFlow).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT,
      name: 'Code mode',
      prompt: 'Build a code mode.',
      research: false,
      clarify: true,
      launch: LAUNCH,
      ticketId: TICKET
    })
    expect(mocks.toast.success).toHaveBeenCalledExactlyOnceWith('PRD flow started: “Code mode”')
    expect(usePrdFlowStore.getState().dialog.open).toBe(false)
  })

  it('opens the draft in the form, with the reason, when it cannot be launched yet', async () => {
    seedDraft(makeDraft({ prompt: '' }))
    mocks.startPrdFlow.mockResolvedValueOnce({ ok: false, error: 'Say what you want to create.' })

    await launchSavedPrdFlowDraft(TICKET)

    expect(mocks.toast.error).toHaveBeenCalledExactlyOnceWith(
      'PRD draft “Code mode” was not launched: Say what you want to create.'
    )
    expect(usePrdFlowStore.getState().dialog).toEqual({
      open: true,
      projectId: PROJECT,
      draftTicketId: TICKET
    })
    expect(drafts()[TICKET]).toBeDefined()
  })

  it('does nothing for a ticket that has no draft', async () => {
    await launchSavedPrdFlowDraft(TICKET)

    expect(mocks.startPrdFlow).not.toHaveBeenCalled()
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  it('starts one flow for two launches of the same draft in a row', async () => {
    seedDraft()
    let finish!: (value: { ok: true; ticketId: string }) => void
    mocks.startPrdFlow.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )

    const first = launchSavedPrdFlowDraft(TICKET)
    const second = launchSavedPrdFlowDraft(TICKET)
    finish({ ok: true, ticketId: TICKET })
    await Promise.all([first, second])

    expect(mocks.startPrdFlow).toHaveBeenCalledTimes(1)
  })
})

describe('discardPrdFlowDraft', () => {
  it('forgets the draft and leaves its ticket as it is', () => {
    seedDraft()

    discardPrdFlowDraft(TICKET)

    expect(drafts()).toEqual({})
    expect(useKanbanStore.getState().tickets.get(PROJECT)).toEqual([makeTicket()])
    expect(updateTicket).not.toHaveBeenCalled()
    expect(mocks.toast.info).toHaveBeenCalledExactlyOnceWith('“Code mode” is an ordinary ticket now.')
  })

  it('says nothing of a ticket that has no draft', () => {
    discardPrdFlowDraft(TICKET)

    expect(mocks.toast.info).not.toHaveBeenCalled()
  })
})

describe('the drafts that are forgotten', () => {
  it.each<[string, Partial<KanbanTicket>]>([
    ['was started as an ordinary ticket', { current_session_id: 's-1', column: 'in_progress' }],
    ['was moved out of To Do', { column: 'done' }],
    ['was archived', { archived_at: '2026-11-22T09:00:00.000Z' }]
  ])('forgets the draft of a ticket that %s', (_what, overrides) => {
    seedDraft(makeDraft(), overrides)

    reconcilePrdFlowDrafts()

    expect(drafts()).toEqual({})
  })

  it('keeps the draft of a ticket that still waits in To Do', () => {
    seedDraft()
    const before = drafts()

    reconcilePrdFlowDrafts()

    expect(drafts()).toBe(before)
  })

  it('keeps the draft of a ticket this page does not show: its board may not be loaded', () => {
    usePrdFlowStore.getState().putDraft(makeDraft())
    const before = drafts()

    reconcilePrdFlowDrafts()
    seedTickets([])
    reconcilePrdFlowDrafts()

    expect(drafts()).toBe(before)
  })

  it('follows the board for as long as it is watched', () => {
    seedDraft()
    const stop = watchPrdFlowDrafts()
    expect(drafts()[TICKET]).toBeDefined()

    seedTickets([makeTicket({ column: 'in_progress', current_session_id: 's-1' })])
    expect(drafts()).toEqual({})

    stop()
    usePrdFlowStore.getState().putDraft(makeDraft())
    seedTickets([makeTicket({ column: 'review' })])
    expect(drafts()[TICKET]).toBeDefined()
  })

  it('forgets what was saved for a ticket once a watch begins', () => {
    seedDraft(makeDraft(), { column: 'review' })

    const stop = watchPrdFlowDrafts()

    expect(drafts()).toEqual({})
    stop()
  })

  it('leaves a flow alone: only drafts are forgotten', () => {
    seedDraft(makeDraft(), { column: 'in_progress', current_session_id: 's-1' })
    const flow = { ticketId: TICKET, projectId: PROJECT, name: 'Code mode' } as PrdFlow
    usePrdFlowStore.getState().putFlow(flow)

    reconcilePrdFlowDrafts()

    expect(usePrdFlowStore.getState().flows[TICKET]).toBe(flow)
  })
})

describe('a draft whose ticket was changed on the board', () => {
  it('takes the new title as its name, so that a launch does not put the old one back', () => {
    seedDraft()
    const stop = watchPrdFlowDrafts()

    seedTickets([makeTicket({ title: '  Code mode, renamed ' })])

    expect(drafts()[TICKET]).toEqual(makeDraft({ name: 'Code mode, renamed', updatedAt: NOW }))
    stop()
  })

  it('takes the new description as its prompt, an emptied one included', () => {
    seedDraft()

    seedTickets([makeTicket({ description: 'Build it another way.' })])
    reconcilePrdFlowDrafts()
    expect(drafts()[TICKET]).toMatchObject({ name: 'Code mode', prompt: 'Build it another way.' })

    seedTickets([makeTicket({ description: null })])
    reconcilePrdFlowDrafts()
    expect(drafts()[TICKET]).toMatchObject({ name: 'Code mode', prompt: '' })
  })

  it('keeps its checkmarks, its model and the day it was first saved', () => {
    seedDraft(makeDraft({ research: false, launch: LAUNCH }))

    seedTickets([makeTicket({ title: 'Renamed' })])
    reconcilePrdFlowDrafts()

    expect(drafts()[TICKET]).toEqual(
      makeDraft({ name: 'Renamed', research: false, launch: LAUNCH, updatedAt: NOW })
    )
  })

  it('keeps the very same draft while its ticket says what it says', () => {
    seedDraft()
    const before = drafts()

    seedTickets([makeTicket({ sort_order: 7 })])
    reconcilePrdFlowDrafts()

    expect(drafts()).toBe(before)
  })

  it('keeps its name when the ticket was left with no title', () => {
    seedDraft()
    const before = drafts()

    seedTickets([makeTicket({ title: '   ' })])
    reconcilePrdFlowDrafts()

    expect(drafts()).toBe(before)
  })
})
