import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import { isTicketHeldByPrdFlow } from './store-coordination'
import {
  isPrdFlowHolding,
  prdFlowOfTicket,
  usePrdFlowStore,
  useTicketPrdFlow,
  type PrdFlow,
  type PrdFlowStage
} from './usePrdFlowStore'

// The flows of "New PRD → orchestrator ticket…" as the store keeps them: one per ticket,
// patched key by key (a patch that changes nothing keeps the very object every card reads),
// written to localStorage with the model chosen last and read back by the next window, the
// form itself excepted: what localStorage holds is read with suspicion, and an entry that is
// not a flow is left out without costing the others anything. And the hold the board asks
// about: a flow that is on keeps its ticket In Progress from the moment the store is read, a
// flow that needs attention holds nothing.

const STORAGE_KEY = 'hive-prd-flows'

const LAUNCH: DocumentRunLaunchConfig = {
  sdk: 'claude-code-cli',
  model: { providerID: 'anthropic', modelID: 'haiku', variant: 'low' },
  codexFastMode: false
}

const initialState = usePrdFlowStore.getState()
const store = (): ReturnType<typeof usePrdFlowStore.getState> => usePrdFlowStore.getState()
const stored = (): unknown => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')

function makeFlow(overrides: Partial<PrdFlow> = {}): PrdFlow {
  return {
    ticketId: 'ticket-1',
    projectId: 'project-1',
    name: 'code mode',
    prefix: 'CODE_MODE',
    prompt: 'i want a code mode for the composer',
    research: true,
    clarify: true,
    launch: LAUNCH,
    checkout: { kind: 'worktree', worktreeId: 'wt-main' },
    cwd: '/repo/shop',
    memberDirs: [],
    sessionId: null,
    stage: 'launching',
    status: 'running',
    attention: null,
    detail: null,
    promptedAt: 1_795_000_000_000,
    reprompts: 0,
    resumes: 0,
    waitingSince: null,
    retryAt: null,
    forcePrompt: false,
    prdPath: null,
    tasksPath: null,
    runId: null,
    createdAt: 1_795_000_000_000,
    ...overrides
  }
}

beforeEach(() => {
  usePrdFlowStore.setState(initialState, true)
  localStorage.clear()
})

describe('the flows', () => {
  it('starts with none', () => {
    expect(store().flows).toEqual({})
    expect(prdFlowOfTicket('ticket-1')).toBeNull()
  })

  it('keeps one flow per ticket: a second one for the same ticket replaces the first', () => {
    const first = makeFlow()
    const other = makeFlow({ ticketId: 'ticket-2', name: 'checkout', prefix: 'CHECKOUT' })
    store().putFlow(first)
    store().putFlow(other)

    expect(store().flows).toEqual({ 'ticket-1': first, 'ticket-2': other })
    expect(prdFlowOfTicket('ticket-1')).toBe(first)

    const again = makeFlow({ prompt: 'a second try' })
    store().putFlow(again)

    expect(Object.keys(store().flows)).toEqual(['ticket-1', 'ticket-2'])
    expect(prdFlowOfTicket('ticket-1')).toBe(again)
    expect(prdFlowOfTicket('ticket-2')).toBe(other)
  })

  it('changes only the keys a patch names, and answers the flow as it is now', () => {
    const flow = makeFlow()
    store().putFlow(flow)

    const patched = store().patchFlow('ticket-1', {
      stage: 'prd',
      sessionId: 'session-1',
      promptedAt: 1_795_000_060_000
    })

    expect(patched).toEqual({
      ...flow,
      stage: 'prd',
      sessionId: 'session-1',
      promptedAt: 1_795_000_060_000
    })
    expect(prdFlowOfTicket('ticket-1')).toBe(patched)
    // The flow that was put is a value, not a handle: it is not written to.
    expect(flow.stage).toBe('launching')
  })

  it('sets a value back to null', () => {
    store().putFlow(
      makeFlow({
        status: 'needs_attention',
        attention: 'missing_file',
        detail: 'CODE_MODE_PRD.html was not created.',
        retryAt: 1_795_000_120_000
      })
    )

    const patched = store().patchFlow('ticket-1', {
      status: 'running',
      attention: null,
      detail: null,
      retryAt: null
    })

    expect(patched).toMatchObject({
      status: 'running',
      attention: null,
      detail: null,
      retryAt: null
    })
  })

  it('keeps the very same object, and tells no one, for a patch that changes nothing', () => {
    const flow = makeFlow({ memberDirs: ['web', 'api'] })
    store().putFlow(flow)
    const flowsBefore = store().flows
    const listener = vi.fn()
    const unsubscribe = usePrdFlowStore.subscribe(listener)

    expect(store().patchFlow('ticket-1', {})).toBe(flow)
    expect(store().patchFlow('ticket-1', { stage: 'launching', detail: null, reprompts: 0 })).toBe(
      flow
    )
    // Equal values count as no change too, also when they are other objects.
    expect(
      store().patchFlow('ticket-1', {
        launch: { ...LAUNCH, model: { providerID: 'anthropic', modelID: 'haiku', variant: 'low' } },
        checkout: { kind: 'worktree', worktreeId: 'wt-main' },
        memberDirs: ['web', 'api']
      })
    ).toBe(flow)

    expect(prdFlowOfTicket('ticket-1')).toBe(flow)
    expect(store().flows).toBe(flowsBefore)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('takes a change inside an object or a list for a change', () => {
    const flow = makeFlow({ memberDirs: ['web', 'api'] })
    store().putFlow(flow)

    const reordered = store().patchFlow('ticket-1', { memberDirs: ['api', 'web'] })
    expect(reordered).not.toBe(flow)
    expect(reordered?.memberDirs).toEqual(['api', 'web'])

    const moved = store().patchFlow('ticket-1', {
      checkout: { kind: 'connection', connectionId: 'connection-1' }
    })
    expect(moved).not.toBe(reordered)
    expect(moved?.checkout).toEqual({ kind: 'connection', connectionId: 'connection-1' })
  })

  it('leaves every other flow the object it was when one changes', () => {
    const other = makeFlow({ ticketId: 'ticket-2' })
    store().putFlow(makeFlow())
    store().putFlow(other)

    store().patchFlow('ticket-1', { detail: 'Waiting for you: a question' })

    expect(prdFlowOfTicket('ticket-2')).toBe(other)
  })

  it('answers null for a patch of a flow that is gone, and brings nothing back', () => {
    const flowsBefore = store().flows

    expect(store().patchFlow('ticket-1', { stage: 'prd' })).toBeNull()
    expect(store().flows).toBe(flowsBefore)

    store().putFlow(makeFlow())
    store().removeFlow('ticket-1')
    expect(store().patchFlow('ticket-1', { stage: 'tasks' })).toBeNull()
    expect(store().flows).toEqual({})
  })

  it('forgets a flow, and does nothing for a ticket that has none', () => {
    const other = makeFlow({ ticketId: 'ticket-2' })
    store().putFlow(makeFlow())
    store().putFlow(other)

    store().removeFlow('ticket-1')

    expect(store().flows).toEqual({ 'ticket-2': other })
    expect(prdFlowOfTicket('ticket-1')).toBeNull()

    const flowsBefore = store().flows
    const listener = vi.fn()
    const unsubscribe = usePrdFlowStore.subscribe(listener)
    store().removeFlow('ticket-1')
    store().removeFlow('never-there')

    expect(store().flows).toBe(flowsBefore)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe('the form', () => {
  it('is closed, for no project, until it is opened', () => {
    expect(store().dialog).toEqual({ open: false, projectId: null })
  })

  it('opens for a project and keeps the project while it closes', () => {
    store().openDialog('project-1')
    expect(store().dialog).toEqual({ open: true, projectId: 'project-1' })

    store().closeDialog()
    expect(store().dialog).toEqual({ open: false, projectId: 'project-1' })

    store().openDialog('project-2')
    expect(store().dialog).toEqual({ open: true, projectId: 'project-2' })
  })

  it('remembers the agent and model chosen last, and the app default as nothing chosen', () => {
    expect(store().launchPref).toBeNull()

    store().setLaunchPref(LAUNCH)
    expect(store().launchPref).toEqual(LAUNCH)

    store().setLaunchPref(null)
    expect(store().launchPref).toBeNull()
  })

  it('touches no flow when it opens, closes or remembers a model', () => {
    const flow = makeFlow()
    store().putFlow(flow)
    const flowsBefore = store().flows

    store().openDialog('project-1')
    store().setLaunchPref(LAUNCH)
    store().closeDialog()

    expect(store().flows).toBe(flowsBefore)
    expect(prdFlowOfTicket('ticket-1')).toBe(flow)
  })
})

describe('what the next window finds', () => {
  it('writes the flows and the remembered model to localStorage, and nothing of the form', () => {
    const flow = makeFlow({ stage: 'prd', sessionId: 'session-1' })
    store().putFlow(flow)
    store().setLaunchPref(LAUNCH)
    store().openDialog('project-1')

    expect(stored()).toEqual({
      state: { flows: { 'ticket-1': flow }, launchPref: LAUNCH },
      version: 1
    })

    // Every change is written as it happens: there is no later moment to rely on.
    store().patchFlow('ticket-1', { stage: 'tasks', prdPath: '/repo/shop/CODE_MODE_PRD.html' })
    expect(stored()).toMatchObject({
      state: {
        flows: { 'ticket-1': { stage: 'tasks', prdPath: '/repo/shop/CODE_MODE_PRD.html' } }
      }
    })
    store().removeFlow('ticket-1')
    expect(stored()).toMatchObject({ state: { flows: {} } })
  })

  it('reads its flows and the remembered model back, with the form closed', async () => {
    const writing = makeFlow({
      stage: 'tasks',
      sessionId: 'session-1',
      promptedAt: 1_795_000_300_000,
      prdPath: '/repo/shop/CODE_MODE_PRD.html',
      reprompts: 1
    })
    const stuck = makeFlow({
      ticketId: 'ticket-2',
      name: 'checkout',
      prefix: 'CHECKOUT',
      checkout: { kind: 'connection', connectionId: 'connection-1' },
      cwd: '/connections/shop',
      memberDirs: ['web', 'api'],
      status: 'needs_attention',
      attention: 'missing_file',
      detail: 'CHECKOUT_PRD.html was not created.'
    })
    store().putFlow(writing)
    store().putFlow(stuck)
    store().setLaunchPref(LAUNCH)
    store().openDialog('project-1')
    const written = localStorage.getItem(STORAGE_KEY) as string

    // A new window: nothing in memory, the same localStorage.
    usePrdFlowStore.setState(initialState, true)
    expect(store().flows).toEqual({})
    localStorage.setItem(STORAGE_KEY, written)
    await usePrdFlowStore.persist.rehydrate()

    expect(store().flows).toEqual({ 'ticket-1': writing, 'ticket-2': stuck })
    expect(store().launchPref).toEqual(LAUNCH)
    expect(store().dialog).toEqual({ open: false, projectId: null })
    // And it goes on from there.
    expect(store().patchFlow('ticket-1', { stage: 'creating_run' })?.stage).toBe('creating_run')
    expect(prdFlowOfTicket('ticket-2')).toEqual(stuck)
  })

  it('does not reopen a form that was open when the window went away', async () => {
    store().openDialog('project-1')
    const written = localStorage.getItem(STORAGE_KEY) as string
    expect(written).not.toContain('dialog')
    expect(written).not.toContain('project-1')

    usePrdFlowStore.setState(initialState, true)
    localStorage.setItem(STORAGE_KEY, written)
    await usePrdFlowStore.persist.rehydrate()

    expect(store().dialog).toEqual({ open: false, projectId: null })
  })

  it.each([
    ['nothing was stored', null],
    ['what was stored has no flows', { state: {}, version: 1 }],
    ['the stored flows are not a record', { state: { flows: null, launchPref: null }, version: 1 }],
    ['the stored flows are text', { state: { flows: 'none' }, version: 1 }]
  ])('starts with no flows and the app default when %s', async (_case, value) => {
    if (value === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(value))

    await usePrdFlowStore.persist.rehydrate()

    expect(store().flows).toEqual({})
    expect(store().launchPref).toBeNull()
    expect(store().dialog).toEqual({ open: false, projectId: null })
    // The store still works: a flow can be put and patched.
    store().putFlow(makeFlow())
    expect(store().patchFlow('ticket-1', { stage: 'prd' })?.stage).toBe('prd')
  })
})

describe('what the next window finds when localStorage holds something else', () => {
  /** A new window over the given stored state: nothing in memory, then the read. */
  async function reopenWith(state: unknown): Promise<void> {
    usePrdFlowStore.setState(initialState, true)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, version: 1 }))
    await usePrdFlowStore.persist.rehydrate()
  }

  let warn: MockInstance<typeof console.warn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  /** A flow as it is stored, with one key replaced or (undefined) taken out. */
  const flowWith = (key: string, value: unknown): Record<string, unknown> =>
    JSON.parse(JSON.stringify({ ...makeFlow(), [key]: value }))

  it.each<[string, unknown]>([
    ['null', null],
    ['text', 'a flow'],
    ['a number', 7],
    ['a list', [makeFlow()]],
    ['an empty object', {}],
    ['the flow of another ticket', makeFlow({ ticketId: 'ticket-9' })],
    ['a flow with no ticket id', flowWith('ticketId', undefined)],
    ['a flow with no project', flowWith('projectId', undefined)],
    ['a flow whose name is not text', flowWith('name', 7)],
    ['a flow with no prefix', flowWith('prefix', null)],
    ['a flow whose prompt is not text', flowWith('prompt', ['a prompt'])],
    ['a flow with no directory', flowWith('cwd', undefined)],
    ['a flow at a stage this build does not know', flowWith('stage', 'reviewing')],
    ['a flow with no stage', flowWith('stage', undefined)],
    ['a flow in a status this build does not know', flowWith('status', 'paused')],
    ['a flow with no agent', flowWith('launch', null)],
    ['a flow whose agent has no provider', flowWith('launch', { model: null })],
    ['a flow whose agent is text', flowWith('launch', 'claude-code-cli')],
    ['a flow with no checkout', flowWith('checkout', undefined)],
    ['a flow in a checkout of an unknown kind', flowWith('checkout', { kind: 'cloud', id: 'x' })],
    ['a flow in a worktree that is not named', flowWith('checkout', { kind: 'worktree' })],
    [
      'a flow in a connection named as a worktree',
      flowWith('checkout', { kind: 'connection', worktreeId: 'wt-main' })
    ],
    ['a flow whose member directories are not a list', flowWith('memberDirs', 'web')],
    ['a flow with a member directory that is not text', flowWith('memberDirs', ['web', 3])],
    ['a flow with no member directories', flowWith('memberDirs', undefined)]
  ])('leaves out %s, and keeps every flow beside it', async (_case, entry) => {
    const good = makeFlow({ ticketId: 'ticket-2', stage: 'tasks', sessionId: 'session-2' })

    await reopenWith({ flows: { 'ticket-1': entry, 'ticket-2': good }, launchPref: LAUNCH })

    expect(store().flows).toEqual({ 'ticket-2': good })
    expect(prdFlowOfTicket('ticket-1')).toBeNull()
    expect(store().launchPref).toEqual(LAUNCH)
    // The flow that is left goes on as it would have: it holds its ticket and takes a patch.
    expect(isTicketHeldByPrdFlow('ticket-2')).toBe(true)
    expect(isTicketHeldByPrdFlow('ticket-1')).toBe(false)
    expect(store().patchFlow('ticket-2', { stage: 'creating_run' })?.stage).toBe('creating_run')
    // And what was left out is gone from localStorage with the next write.
    expect(stored()).toMatchObject({ state: { flows: { 'ticket-2': { stage: 'creating_run' } } } })
    expect((stored() as { state: { flows: object } }).state.flows).not.toHaveProperty('ticket-1')
  })

  it.each<[string, PrdFlow]>([
    ['in a worktree', makeFlow({ checkout: { kind: 'worktree', worktreeId: 'wt-main' } })],
    [
      'in a connection, with its member directories',
      makeFlow({
        checkout: { kind: 'connection', connectionId: 'connection-1' },
        memberDirs: ['web', 'api']
      })
    ],
    [
      'that needs attention',
      makeFlow({ stage: 'creating_run', status: 'needs_attention', attention: 'run_failed' })
    ],
    [
      'on the app default model',
      makeFlow({ launch: { sdk: 'codex', model: null, codexFastMode: false } })
    ]
  ])('keeps a flow %s as it was written, and says nothing', async (_case, flow) => {
    await reopenWith({ flows: { 'ticket-1': flow }, launchPref: null })

    expect(store().flows).toEqual({ 'ticket-1': flow })
    expect(warn).not.toHaveBeenCalled()
  })

  it('says once how many entries it left out, however many there were', async () => {
    const good = makeFlow({ ticketId: 'ticket-2' })

    await reopenWith({
      flows: {
        'ticket-1': null,
        'ticket-2': good,
        'ticket-3': 'a flow',
        'ticket-4': flowWith('stage', 'reviewing')
      },
      launchPref: null
    })

    expect(store().flows).toEqual({ 'ticket-2': good })
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[prdFlow] dropped 3 stored flow(s) that could not be read'
    )
  })

  it('takes a list of flows for no flows at all: a flow is found under its ticket', async () => {
    await reopenWith({ flows: [makeFlow()], launchPref: null })

    expect(store().flows).toEqual({})
  })

  it.each<[string, unknown]>([
    ['text', 'claude-code-cli'],
    ['a number', 3],
    ['a list', [LAUNCH]],
    ['an object with no provider', { model: LAUNCH.model }],
    ['an object whose provider is not text', { sdk: 7 }]
  ])('takes a remembered model that is %s for none: the app default', async (_case, launchPref) => {
    const flow = makeFlow()

    await reopenWith({ flows: { 'ticket-1': flow }, launchPref })

    expect(store().launchPref).toBeNull()
    expect(store().flows).toEqual({ 'ticket-1': flow })
    expect(warn).not.toHaveBeenCalled()
  })

  it('takes stored state that is not an object for nothing stored', async () => {
    usePrdFlowStore.setState(initialState, true)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: 'flows', version: 1 }))

    await usePrdFlowStore.persist.rehydrate()

    expect(store().flows).toEqual({})
    expect(store().launchPref).toBeNull()
    store().putFlow(makeFlow())
    expect(prdFlowOfTicket('ticket-1')).toEqual(makeFlow())
  })
})

describe('the hold on the ticket', () => {
  it.each<PrdFlowStage>(['launching', 'prd', 'tasks', 'creating_run'])(
    'keeps the ticket of a flow that is on In Progress while it is %s',
    (stage) => {
      store().putFlow(makeFlow({ stage }))

      expect(isTicketHeldByPrdFlow('ticket-1')).toBe(true)
      expect(isPrdFlowHolding(prdFlowOfTicket('ticket-1'))).toBe(true)
    }
  )

  it.each<PrdFlowStage>(['launching', 'prd', 'tasks', 'creating_run'])(
    'holds nothing for a flow that needs attention while it is %s',
    (stage) => {
      store().putFlow(
        makeFlow({
          stage,
          status: 'needs_attention',
          attention: 'user_stopped',
          detail: 'Stopped.'
        })
      )

      expect(isTicketHeldByPrdFlow('ticket-1')).toBe(false)
      expect(isPrdFlowHolding(prdFlowOfTicket('ticket-1'))).toBe(false)
    }
  )

  it('lets go when the flow stops for the person, and holds again once it is retried', () => {
    store().putFlow(makeFlow({ stage: 'prd', sessionId: 'session-1' }))
    expect(isTicketHeldByPrdFlow('ticket-1')).toBe(true)

    store().patchFlow('ticket-1', {
      status: 'needs_attention',
      attention: 'missing_file',
      detail: 'CODE_MODE_PRD.html was not created.'
    })
    expect(isTicketHeldByPrdFlow('ticket-1')).toBe(false)

    store().patchFlow('ticket-1', { status: 'running', attention: null, detail: null })
    expect(isTicketHeldByPrdFlow('ticket-1')).toBe(true)
  })

  it('holds no ticket that has no flow, and lets go when the flow is over', () => {
    expect(isTicketHeldByPrdFlow('ticket-1')).toBe(false)

    store().putFlow(makeFlow())
    expect(isTicketHeldByPrdFlow('ticket-1')).toBe(true)
    expect(isTicketHeldByPrdFlow('ticket-2')).toBe(false)

    store().removeFlow('ticket-1')
    expect(isTicketHeldByPrdFlow('ticket-1')).toBe(false)
  })

  it('holds from the moment the flows are read back, before any session reports a status', async () => {
    store().putFlow(makeFlow({ stage: 'tasks', sessionId: 'session-1' }))
    store().putFlow(
      makeFlow({ ticketId: 'ticket-2', status: 'needs_attention', attention: 'session_closed' })
    )
    const written = localStorage.getItem(STORAGE_KEY) as string
    usePrdFlowStore.setState(initialState, true)
    expect(isTicketHeldByPrdFlow('ticket-1')).toBe(false)

    localStorage.setItem(STORAGE_KEY, written)
    await usePrdFlowStore.persist.rehydrate()

    expect(isTicketHeldByPrdFlow('ticket-1')).toBe(true)
    expect(isTicketHeldByPrdFlow('ticket-2')).toBe(false)
  })

  it('takes no flow at all for nothing held', () => {
    expect(isPrdFlowHolding(null)).toBe(false)
    expect(isPrdFlowHolding(undefined)).toBe(false)
  })
})

describe('useTicketPrdFlow', () => {
  it('is null for a ticket without a flow, and the flow once it has one', () => {
    const { result } = renderHook(() => useTicketPrdFlow('ticket-1'))
    expect(result.current).toBeNull()

    const flow = makeFlow()
    act(() => store().putFlow(flow))
    expect(result.current).toBe(flow)

    act(() => store().removeFlow('ticket-1'))
    expect(result.current).toBeNull()
  })

  it("hands a card the same object, with no new render, until the ticket's own flow changes", () => {
    const flow = makeFlow()
    store().putFlow(flow)
    store().putFlow(makeFlow({ ticketId: 'ticket-2' }))
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useTicketPrdFlow('ticket-1')
    })
    expect(result.current).toBe(flow)
    const rendersBefore = renders

    act(() => {
      // Another ticket's flow, a patch that changes nothing, and the form.
      store().patchFlow('ticket-2', { detail: 'Waiting for you: a question' })
      store().patchFlow('ticket-1', { stage: 'launching', status: 'running' })
      store().setLaunchPref(LAUNCH)
      store().openDialog('project-1')
    })
    expect(result.current).toBe(flow)
    expect(renders).toBe(rendersBefore)

    act(() => {
      store().patchFlow('ticket-1', { stage: 'prd', sessionId: 'session-1' })
    })
    expect(result.current).not.toBe(flow)
    expect(result.current).toMatchObject({ stage: 'prd', sessionId: 'session-1' })
    expect(renders).toBe(rendersBefore + 1)
  })
})
