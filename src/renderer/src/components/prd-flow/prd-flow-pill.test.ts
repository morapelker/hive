import { describe, expect, it } from 'vitest'
import type { PrdFlow, PrdFlowAttention, PrdFlowStage } from '@/stores/usePrdFlowStore'
import { prdFlowPill } from './prd-flow-pill'

// The pill the board card wears for a ticket's PRD flow ("New PRD → orchestrator ticket…"): its
// label and colour for every step of a flow that is on, for a session that waits for the
// person, and for a flow that stopped; and its hover text, which is the flow's own words when
// it has any.

function makeFlow(overrides: Partial<PrdFlow> = {}): PrdFlow {
  return {
    ticketId: 'ticket-1',
    projectId: 'project-1',
    name: 'code mode',
    prefix: 'CODE_MODE',
    prompt: 'A mode for writing code.',
    research: true,
    clarify: true,
    launch: { sdk: 'claude-code', model: null, codexFastMode: false },
    checkout: { kind: 'worktree', worktreeId: 'wt-main' },
    cwd: '/code/shop',
    memberDirs: [],
    sessionId: 'session-1',
    stage: 'prd',
    status: 'running',
    attention: null,
    detail: null,
    promptedAt: 1_000,
    reprompts: 0,
    resumes: 0,
    waitingSince: null,
    retryAt: null,
    forcePrompt: false,
    prdPath: null,
    tasksPath: null,
    runId: null,
    createdAt: 1_000,
    ...overrides
  }
}

const STAGES: PrdFlowStage[] = ['launching', 'prd', 'tasks', 'creating_run']

describe('prdFlowPill', () => {
  it('is nothing for a ticket with no flow', () => {
    expect(prdFlowPill(null)).toBeNull()
  })

  it.each<[PrdFlowStage, string]>([
    ['launching', 'PRD flow · starting'],
    ['prd', 'PRD flow · writing the PRD'],
    ['tasks', 'PRD flow · writing the tasks'],
    ['creating_run', 'PRD flow · creating the orchestrator']
  ])(
    'names the step of a flow that is on at %s, in blue, with nothing to retry',
    (stage, label) => {
      const pill = prdFlowPill(makeFlow({ stage }))

      expect(pill).toMatchObject({ label, tone: 'info', canRetry: false })
    }
  )

  it('says in its hover text what the step does and what comes next', () => {
    const hint = (stage: PrdFlowStage): string => prdFlowPill(makeFlow({ stage }))!.hint

    expect(hint('launching')).toBe(
      'The session that writes CODE_MODE_PRD.html is being started. It is asked for CODE_MODE_TASKS.html next.'
    )
    expect(hint('prd')).toBe(
      'The session is writing CODE_MODE_PRD.html. It is asked for CODE_MODE_TASKS.html once the PRD exists.'
    )
    expect(hint('tasks')).toBe(
      'The session is writing CODE_MODE_TASKS.html, which becomes an orchestrator ticket.'
    )
    expect(hint('creating_run')).toBe(
      'CODE_MODE_TASKS.html is being made into an orchestrator ticket, which waits in To Do to be launched.'
    )
  })

  it("says the flow's own words instead, once it has any", () => {
    const detail = 'Waiting for work the session left running.'

    for (const stage of STAGES) {
      expect(prdFlowPill(makeFlow({ stage, detail })), stage).toMatchObject({
        tone: 'info',
        hint: detail,
        canRetry: false
      })
    }
    // Work the session left running is not the person's to answer: the step keeps its name.
    expect(prdFlowPill(makeFlow({ stage: 'tasks', detail }))!.label).toBe(
      'PRD flow · writing the tasks'
    )
  })

  it.each<[PrdFlowStage]>([['prd'], ['tasks']])(
    'says "waiting for you", in amber, while the session of the %s step asks the person something',
    (stage) => {
      const detail = 'Waiting for you: a question'

      expect(prdFlowPill(makeFlow({ stage, detail }))).toEqual({
        label: 'PRD flow · waiting for you',
        tone: 'warning',
        hint: detail,
        canRetry: false
      })
    }
  )

  it.each<[PrdFlowStage, PrdFlowAttention, string]>([
    ['launching', 'launch_failed', 'The session could not be started: no model.'],
    ['prd', 'missing_file', 'CODE_MODE_PRD.html was not created.'],
    ['tasks', 'user_stopped', 'You stopped the session. Retry continues the flow.'],
    ['creating_run', 'run_failed', 'The orchestrator ticket could not be created: offline']
  ])(
    'says "needs attention", in red, for a flow that stopped at %s (%s), and can be retried',
    (stage, attention, detail) => {
      const pill = prdFlowPill(makeFlow({ stage, status: 'needs_attention', attention, detail }))

      expect(pill).toEqual({
        label: 'PRD flow · needs attention',
        tone: 'danger',
        hint: detail,
        canRetry: true
      })
    }
  )

  it('needs attention whatever a stopped flow last waited for', () => {
    const pill = prdFlowPill(
      makeFlow({
        status: 'needs_attention',
        attention: 'session_closed',
        detail: 'Waiting for you: a question'
      })
    )

    expect(pill).toMatchObject({ label: 'PRD flow · needs attention', tone: 'danger' })
  })

  it('still has a hover text for a stopped flow that says nothing', () => {
    const pill = prdFlowPill(makeFlow({ status: 'needs_attention', attention: 'missing_file' }))

    expect(pill!.hint).toBe('The PRD flow stopped. Retry continues it.')
  })
})
