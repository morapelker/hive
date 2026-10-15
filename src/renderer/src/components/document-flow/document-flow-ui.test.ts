import { describe, expect, it } from 'vitest'
import {
  USER_INTERRUPT_DETAIL,
  WAITING_FOR_WORK_PREFIX,
  WAITING_PREFIX,
  summarizeItems
} from '@shared/document-flow/planning'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  DOCUMENT_RUN_ITEM_STATUSES,
  DOCUMENT_RUN_STATUSES,
  DOCUMENT_VERIFICATION_METHODS,
  type DocumentRunMember
} from '@shared/types/document-flow'
import {
  DOCUMENT_RUN_ITEM_STATUS_DOTS,
  DOCUMENT_RUN_ITEM_STATUS_LABELS,
  DOCUMENT_RUN_ITEM_STATUS_TONES,
  DOCUMENT_RUN_STATUS_LABELS,
  DOCUMENT_RUN_STATUS_TONES,
  DOCUMENT_VERIFICATION_DESCRIPTIONS,
  DOCUMENT_VERIFICATION_LABELS,
  canEditLaunchConfig,
  canEditVerification,
  currentRootBranch,
  defaultBaseBranchLabel,
  describeBaseBranch,
  describeItemBranches,
  describeMemberBaseBranches,
  describeMemberVerifyCommands,
  describeRunDeletion,
  describeRunMembers,
  describeVerificationChip,
  describeVerificationChoice,
  documentNameFromPath,
  documentRunTicketDropRefusal,
  formatGeneration,
  formatRunProgress,
  isLaunchedRunStatus,
  isRequeueableItem,
  isResolvingRunConflicts,
  isUnlaunchedCardPhase,
  isRunDeletable,
  isRunMigrating,
  isSkippableItem,
  itemSessionTarget,
  itemStatusDisplay,
  memberBaseBranch,
  memberVerifyCommand,
  needsUser,
  needsUserMessage,
  parseDocumentPath,
  progressSegments,
  runBoardCardState,
  runCountsLabel,
  runStatusDisplay,
  toggleVerificationMethod,
  tonePillClass,
  wizardStep
} from './document-flow-ui'
import { makeDetail, makeItem, makeRun } from './test-fixtures'

const RUNNING = { status: 'running', config: DEFAULT_DOCUMENT_RUN_CONFIG } as const

const CONNECTION_MEMBERS: DocumentRunMember[] = [
  {
    project_id: 'web',
    project_name: 'Web',
    project_path: '/repo/web',
    symlink_name: 'web',
    base_branch: 'main',
    base_sha: 'aaaaaaa1111111',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-web-int',
    integration_worktree_path: '/worktrees/web--doc-checkout'
  },
  {
    project_id: 'api',
    project_name: 'API',
    project_path: '/repo/api',
    symlink_name: 'api',
    base_branch: 'master',
    base_sha: 'bbbbbbb2222222',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-api-int',
    integration_worktree_path: '/worktrees/api--doc-checkout'
  }
]

const TONES = ['neutral', 'info', 'success', 'warning', 'danger']
const DOTS = ['working', 'done', 'blocked', 'idle', 'question']

describe('status mappings', () => {
  it('gives every run status a label and a tone', () => {
    for (const status of DOCUMENT_RUN_STATUSES) {
      expect(DOCUMENT_RUN_STATUS_LABELS[status], status).toEqual(expect.any(String))
      expect(DOCUMENT_RUN_STATUS_LABELS[status].length, status).toBeGreaterThan(0)
      expect(TONES, status).toContain(DOCUMENT_RUN_STATUS_TONES[status])
      expect(tonePillClass(DOCUMENT_RUN_STATUS_TONES[status])).toContain('rounded-full')
    }
    expect(Object.keys(DOCUMENT_RUN_STATUS_LABELS).sort()).toEqual(
      [...DOCUMENT_RUN_STATUSES].sort()
    )
  })

  it('gives every item status a label, a tone and a state dot', () => {
    for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
      expect(DOCUMENT_RUN_ITEM_STATUS_LABELS[status], status).toEqual(expect.any(String))
      expect(DOCUMENT_RUN_ITEM_STATUS_LABELS[status].length, status).toBeGreaterThan(0)
      expect(TONES, status).toContain(DOCUMENT_RUN_ITEM_STATUS_TONES[status])
      expect(DOTS, status).toContain(DOCUMENT_RUN_ITEM_STATUS_DOTS[status])
      // Every status also renders as a row without falling through.
      const display = itemStatusDisplay(makeItem({ status }), [makeItem({ status })])
      expect(display.label.length, status).toBeGreaterThan(0)
    }
    expect(Object.keys(DOCUMENT_RUN_ITEM_STATUS_LABELS).sort()).toEqual(
      [...DOCUMENT_RUN_ITEM_STATUSES].sort()
    )
  })

  it('uses the wording the dashboard promises', () => {
    expect(DOCUMENT_RUN_ITEM_STATUS_LABELS).toMatchObject({
      pending: 'Queued',
      running: 'Working',
      needs_input: 'Needs you',
      checking: 'Checking result',
      ready: 'Ready to merge',
      fixing: 'Fixing checks',
      needs_attention: 'Needs attention'
    })
    expect(DOCUMENT_RUN_STATUS_LABELS.completed_with_issues).toBe('Completed with issues')
  })
})

describe('itemStatusDisplay', () => {
  it('names the dependencies a pending item is waiting for', () => {
    const items = [
      makeItem({ key: 'A1', status: 'running' }),
      makeItem({ key: 'A2', status: 'merged' }),
      makeItem({ key: 'A3', depends_on: ['A1', 'A2'] })
    ]
    expect(itemStatusDisplay(items[2], items).label).toBe('Waiting for A1')
  })

  it('reads as queued once its dependencies are merged, skipped or left out', () => {
    const items = [
      makeItem({ key: 'A1', status: 'merged' }),
      makeItem({ key: 'A2', status: 'skipped' }),
      makeItem({ key: 'A3', selected: false }),
      makeItem({ key: 'A4', depends_on: ['A1', 'A2', 'A3', 'A9'] })
    ]
    expect(itemStatusDisplay(items[3], items).label).toBe('Queued')
  })

  it('marks a deselected item as not included', () => {
    const item = makeItem({ selected: false, status: 'pending' })
    expect(itemStatusDisplay(item, [item])).toMatchObject({ label: 'Not included', dot: 'idle' })
  })

  it('reads as waiting for checks while a running item waits for its own background work', () => {
    const waiting = makeItem({
      status: 'running',
      status_detail: `${WAITING_FOR_WORK_PREFIX}the typecheck and the tests`
    })
    expect(itemStatusDisplay(waiting, [waiting])).toEqual({
      label: 'Waiting for checks',
      tone: 'info',
      dot: 'working'
    })
    expect(needsUser(waiting)).toBe(false)
  })

  it('shows a question dot when a fix session stopped to ask', () => {
    const asking = makeItem({ status: 'fixing', status_detail: `${WAITING_PREFIX}which env?` })
    const working = makeItem({ status: 'fixing', status_detail: 'Fix attempt 1 of 2' })
    expect(itemStatusDisplay(asking, [asking]).dot).toBe('question')
    expect(itemStatusDisplay(working, [working]).dot).toBe('working')
  })
})

describe('runStatusDisplay', () => {
  it('reads "Waiting for you" when a running run is stuck on the user', () => {
    const items = [
      makeItem({ key: 'A1', status: 'needs_input' }),
      makeItem({ key: 'A2', depends_on: ['A1'] })
    ]
    expect(runStatusDisplay(RUNNING, items)).toEqual({
      label: 'Waiting for you',
      tone: 'warning'
    })
  })

  it('reads "Waiting for you" when every slot is held by a ticket waiting on the user', () => {
    const items = [
      makeItem({ key: 'A1', status: 'needs_input' }),
      makeItem({ key: 'A2', status: 'resolving_conflicts', status_detail: USER_INTERRUPT_DETAIL }),
      makeItem({ key: 'A3', status: 'pending' })
    ]
    const run = { status: 'running', config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, maxParallel: 2 } }
    expect(runStatusDisplay(run as typeof RUNNING, items).label).toBe('Waiting for you')
    // With a free slot, A3 launches next: the run is not stuck.
    expect(runStatusDisplay(RUNNING, items).label).toBe('Running')
  })

  it('stays "Running" while anything is still working', () => {
    const items = [
      makeItem({ key: 'A1', status: 'needs_input' }),
      makeItem({ key: 'A2', status: 'running' })
    ]
    expect(runStatusDisplay(RUNNING, items).label).toBe('Running')
  })

  it('does not second-guess a paused run', () => {
    const items = [makeItem({ status: 'needs_input' })]
    expect(runStatusDisplay({ ...RUNNING, status: 'paused' }, items).label).toBe('Paused')
  })

  it.each(['completed', 'completed_with_issues'] as const)(
    'reads "Running migrations" while a session executes those of a %s run',
    (status) => {
      const items = [makeItem({ status: 'merged' })]
      const run = { ...RUNNING, status }
      expect(runStatusDisplay({ ...run, migration_session_id: 'session-mig' }, items)).toEqual({
        label: 'Running migrations',
        tone: 'info'
      })
      // Without a session (never started, or over) the run reads as it ended.
      expect(runStatusDisplay({ ...run, migration_session_id: null }, items).label).toBe(
        DOCUMENT_RUN_STATUS_LABELS[status]
      )
      expect(runStatusDisplay(run, items).label).toBe(DOCUMENT_RUN_STATUS_LABELS[status])
    }
  )
})

describe('needs-you rules', () => {
  it('covers flagged items and fix / conflict sessions that stopped for the user', () => {
    expect(needsUser(makeItem({ status: 'needs_input' }))).toBe(true)
    expect(needsUser(makeItem({ status: 'needs_attention' }))).toBe(true)
    expect(
      needsUser(
        makeItem({ status: 'resolving_conflicts', status_detail: `${WAITING_PREFIX}a question` })
      )
    ).toBe(true)
    expect(needsUser(makeItem({ status: 'fixing', status_detail: USER_INTERRUPT_DETAIL }))).toBe(
      true
    )
    // Only the orchestrator's own markers count, not prose that happens to mention the user.
    expect(
      needsUser(makeItem({ status: 'fixing', status_detail: 'The fix needs your config file' }))
    ).toBe(false)
    expect(needsUser(makeItem({ status: 'fixing', status_detail: 'Fix attempt 1 of 2' }))).toBe(
      false
    )
    expect(needsUser(makeItem({ status: 'running', status_detail: USER_INTERRUPT_DETAIL }))).toBe(
      false
    )
    expect(needsUser(makeItem({ status: 'needs_input', selected: false }))).toBe(false)
  })

  it('offers retry and skip for a conflict session that waits, nothing for a fix session', () => {
    // The conflicting merge was aborted: the integration branch holds nothing of this ticket.
    const conflict = makeItem({
      status: 'resolving_conflicts',
      status_detail: `${WAITING_PREFIX}a permission request`
    })
    expect(isRequeueableItem(conflict)).toBe(true)
    expect(isSkippableItem(conflict)).toBe(true)
    // The merge is on the branch and the fix session lives in the integration worktree.
    const fix = makeItem({ status: 'fixing', status_detail: USER_INTERRUPT_DETAIL })
    expect(isRequeueableItem(fix)).toBe(false)
    expect(isSkippableItem(fix)).toBe(false)
  })

  it('prefers the status detail, then the verdict question, then its reason', () => {
    const verdict = {
      status: 'needs_input' as const,
      reason: 'The agent stopped to ask.',
      question: 'Which currency?',
      summary: null,
      migrations: [],
      manualSteps: [],
      confidence: 'high' as const,
      source: 'model' as const,
      classifiedAt: '2026-05-04T10:00:00.000Z'
    }
    expect(
      needsUserMessage(makeItem({ status: 'needs_input', status_detail: 'Detail', verdict }))
    ).toBe('Detail')
    expect(needsUserMessage(makeItem({ status: 'needs_input', verdict }))).toBe('Which currency?')
    expect(
      needsUserMessage(makeItem({ status: 'needs_input', verdict: { ...verdict, question: null } }))
    ).toBe('The agent stopped to ask.')
    expect(needsUserMessage(makeItem({ status: 'needs_attention' }))).toBe('Needs attention')
  })

  it('never offers to requeue or skip an item whose merge is in the integration worktree', () => {
    for (const status of ['merging', 'verifying', 'fixing'] as const) {
      const item = makeItem({ status, status_detail: `${WAITING_PREFIX}a question` })
      expect(isSkippableItem(item), status).toBe(false)
      expect(isRequeueableItem(item), status).toBe(false)
    }
    expect(isSkippableItem(makeItem({ status: 'running' }))).toBe(true)
    expect(isSkippableItem(makeItem({ status: 'merged' }))).toBe(false)
    expect(isSkippableItem(makeItem({ status: 'pending', selected: false }))).toBe(false)
    expect(isRequeueableItem(makeItem({ status: 'needs_attention' }))).toBe(true)
    expect(isRequeueableItem(makeItem({ status: 'running' }))).toBe(false)
  })

  it('opens the fix session while fixing, otherwise the ticket session', () => {
    const run = { integration_worktree_id: 'wt-integration', integration_connection_id: null }
    expect(
      itemSessionTarget(
        run,
        makeItem({
          status: 'fixing',
          session_id: 's-ticket',
          worktree_id: 'wt-ticket',
          fix_session_id: 's-fix'
        })
      )
    ).toEqual({ sessionId: 's-fix', worktreeId: 'wt-integration', connectionId: null })
    expect(
      itemSessionTarget(
        run,
        makeItem({ status: 'needs_input', session_id: 's-ticket', worktree_id: 'wt-ticket' })
      )
    ).toEqual({ sessionId: 's-ticket', worktreeId: 'wt-ticket', connectionId: null })
    expect(itemSessionTarget(run, makeItem({ status: 'pending' }))).toBeNull()
  })

  it('targets the instance of a connection run: the integration instance for a fix session', () => {
    const run = { integration_worktree_id: null, integration_connection_id: 'conn-integration' }
    expect(
      itemSessionTarget(
        run,
        makeItem({
          status: 'fixing',
          session_id: 's-ticket',
          connection_id: 'conn-ticket',
          fix_session_id: 's-fix'
        })
      )
    ).toEqual({ sessionId: 's-fix', worktreeId: null, connectionId: 'conn-integration' })
    expect(
      itemSessionTarget(
        run,
        makeItem({ status: 'running', session_id: 's-ticket', connection_id: 'conn-ticket' })
      )
    ).toEqual({ sessionId: 's-ticket', worktreeId: null, connectionId: 'conn-ticket' })
  })
})

describe('isResolvingRunConflicts', () => {
  const runs = {
    'run-1': makeDetail({ id: 'run-1' }, [
      { key: 'A1', status: 'resolving_conflicts', ticket_id: 'ticket-a1', session_id: 's-a1' },
      { key: 'A2', status: 'running', ticket_id: 'ticket-a2', session_id: 's-a2' }
    ]),
    'run-2': makeDetail({ id: 'run-2' }, [
      { key: 'B1', status: 'resolving_conflicts', ticket_id: 'ticket-b1', session_id: 's-b1' }
    ])
  }

  it('finds the item resolving conflicts by its ticket or its session, in any run', () => {
    expect(isResolvingRunConflicts(runs, { ticketId: 'ticket-a1' })).toBe(true)
    expect(isResolvingRunConflicts(runs, { sessionId: 's-a1' })).toBe(true)
    expect(isResolvingRunConflicts(runs, { ticketId: 'ticket-b1', sessionId: null })).toBe(true)
    expect(isResolvingRunConflicts(runs, { ticketId: 'ticket-x', sessionId: 's-b1' })).toBe(true)
  })

  it('is false for an item at work on its task, an unknown ticket, or no reference', () => {
    expect(isResolvingRunConflicts(runs, { ticketId: 'ticket-a2', sessionId: 's-a2' })).toBe(false)
    expect(isResolvingRunConflicts(runs, { ticketId: 'ticket-x' })).toBe(false)
    expect(isResolvingRunConflicts(runs, { ticketId: null, sessionId: null })).toBe(false)
    expect(isResolvingRunConflicts({}, { ticketId: 'ticket-a1' })).toBe(false)
  })
})

describe('progress', () => {
  const items = [
    makeItem({ key: 'A1', status: 'merged' }),
    makeItem({ key: 'A2', status: 'running' }),
    makeItem({ key: 'A3', status: 'verifying' }),
    makeItem({ key: 'A4', status: 'needs_input' }),
    makeItem({ key: 'A5', status: 'pending' }),
    makeItem({ key: 'A6', status: 'pending', selected: false })
  ]

  it('formats the one-line state of a run', () => {
    expect(formatRunProgress(summarizeItems(items))).toBe('1/5 merged · 2 working')
  })

  it('leaves empty groups out of the progress bar', () => {
    const segments = progressSegments(summarizeItems(items))
    expect(segments.map((segment) => [segment.key, segment.count])).toEqual([
      ['merged', 1],
      ['inProgress', 2],
      ['attention', 1],
      ['pending', 1]
    ])
  })

  it('describes a run in the previous-runs list by where it is', () => {
    expect(runCountsLabel(makeDetail({ status: 'extracting' }, []))).toBe('Extracting tickets…')
    expect(
      runCountsLabel(
        makeDetail({ status: 'preview' }, [{ key: 'A1' }, { key: 'A2', selected: false }])
      )
    ).toBe('2 tickets · 1 selected')
    expect(runCountsLabel({ run: makeRun({ status: 'running' }), items })).toBe(
      '1/5 merged · 1 need you'
    )
  })
})

describe('runBoardCardState', () => {
  it('summarizes a running run: progress, merged of total and the sessions at work', () => {
    const state = runBoardCardState(
      makeDetail({ status: 'running', title: 'Checkout redesign' }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'running' },
        { key: 'A3', status: 'launching' },
        { key: 'A4', status: 'verifying' },
        { key: 'A5', status: 'checking' },
        { key: 'A6', status: 'pending' },
        { key: 'A7', status: 'running', selected: false }
      ])
    )

    expect(state).toMatchObject({
      title: 'Checkout redesign',
      merged: 1,
      total: 6,
      running: 2,
      phase: 'running',
      waiting: 0,
      waitingOnUser: false,
      paused: false,
      label: '2 working'
    })
  })

  it('falls back to the file name of an untitled run', () => {
    expect(
      runBoardCardState(makeDetail({ title: '', source_path: '/docs/brand-os-bugs (2).html' }))
        .title
    ).toBe('brand-os-bugs (2).html')
  })

  it.each([
    ['a question', { status: 'needs_input' }],
    ['a flagged ticket', { status: 'needs_attention' }],
    [
      'a conflict session that stopped to ask',
      { status: 'resolving_conflicts', status_detail: `${WAITING_PREFIX}which one wins?` }
    ],
    ['an interrupted fix session', { status: 'fixing', status_detail: USER_INTERRUPT_DETAIL }]
  ] as const)('waits on the user for %s, which is not a running session', (_name, waiting) => {
    const state = runBoardCardState(
      makeDetail({ status: 'running' }, [
        { key: 'A1', status: 'running' },
        { key: 'A2', ...waiting }
      ])
    )

    expect(state.waitingOnUser).toBe(true)
    expect(state.waiting).toBe(1)
    expect(state.running).toBe(1)
    expect(state.label).toBe('1 waiting for answer')
  })

  it('does not wait on the user for a ticket left out of the run', () => {
    const state = runBoardCardState(
      makeDetail({ status: 'running' }, [
        { key: 'A1', status: 'running' },
        { key: 'A2', status: 'needs_input', selected: false }
      ])
    )

    expect(state.waitingOnUser).toBe(false)
  })

  it('says a paused run is paused, and how many sessions are still finishing', () => {
    expect(
      runBoardCardState(makeDetail({ status: 'paused' }, [{ key: 'A1', status: 'pending' }]))
    ).toMatchObject({ paused: true, running: 0, label: 'Paused' })
    expect(
      runBoardCardState(
        makeDetail({ status: 'paused' }, [
          { key: 'A1', status: 'running' },
          { key: 'A2', status: 'pending' }
        ])
      )
    ).toMatchObject({ paused: true, running: 1, label: 'Paused · 1 working' })
  })

  it('says a completed run is ready to merge into its base branch, until its ticket moved on', () => {
    const detail = makeDetail({ status: 'completed', base_branch: 'main' }, [
      { key: 'A1', status: 'merged' },
      { key: 'A2', status: 'merged' }
    ])

    expect(runBoardCardState(detail, 'review')).toMatchObject({
      phase: 'completed',
      merged: 2,
      total: 2,
      paused: false,
      waitingOnUser: false,
      label: 'Ready to merge into main'
    })
    expect(runBoardCardState(detail).label).toBe('Ready to merge into main')
    expect(runBoardCardState(detail, 'merged').label).toBe('Finished')
    expect(runBoardCardState(detail, 'done').label).toBe('Finished')
    expect(
      runBoardCardState(makeDetail({ status: 'completed', base_branch: null }), 'review').label
    ).toBe('Ready to merge into the base branch')
  })

  it('treats a completed run with skipped tickets as completed, not as one with issues', () => {
    const state = runBoardCardState(
      makeDetail({ status: 'completed', base_branch: 'main' }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'skipped' }
      ]),
      'review'
    )

    expect(state).toMatchObject({
      phase: 'completed',
      merged: 1,
      total: 2,
      waitingOnUser: false,
      label: 'Ready to merge into main'
    })
  })

  it('counts what a run with issues left unmerged, without asking for the user', () => {
    const state = runBoardCardState(
      makeDetail({ status: 'completed_with_issues' }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'needs_attention' },
        { key: 'A3', status: 'skipped' },
        { key: 'A4', status: 'merged', selected: false }
      ]),
      'review'
    )

    expect(state).toMatchObject({
      phase: 'issues',
      merged: 1,
      total: 3,
      // The flagged ticket is part of the result now, not a question to answer.
      waitingOnUser: false,
      label: 'Finished · 2 not merged'
    })
  })

  it('says a cancelled run was cancelled', () => {
    expect(
      runBoardCardState(
        makeDetail({ status: 'cancelled' }, [
          { key: 'A1', status: 'merged' },
          { key: 'A2', status: 'cancelled' },
          { key: 'A3', status: 'needs_input' }
        ]),
        'review'
      )
    ).toMatchObject({
      phase: 'cancelled',
      merged: 1,
      total: 3,
      running: 0,
      waitingOnUser: false,
      label: 'Cancelled'
    })
  })

  it('says the tickets of a run are being extracted, before any exist', () => {
    expect(runBoardCardState(makeDetail({ status: 'extracting' }, []), 'todo')).toMatchObject({
      phase: 'extracting',
      merged: 0,
      total: 0,
      running: 0,
      waitingOnUser: false,
      paused: false,
      label: 'Extracting tickets…'
    })
  })

  it('says a previewed run is ready to launch, counting the tickets that are in', () => {
    expect(
      runBoardCardState(
        makeDetail({ status: 'preview' }, [
          { key: 'A1' },
          { key: 'A2' },
          { key: 'A3', selected: false }
        ]),
        'todo'
      )
    ).toMatchObject({
      phase: 'ready',
      merged: 0,
      total: 2,
      running: 0,
      waitingOnUser: false,
      label: 'Ready to launch'
    })
  })

  it('says the extraction of a run failed', () => {
    expect(
      runBoardCardState(makeDetail({ status: 'extract_failed', error: 'no json' }, []), 'todo')
    ).toMatchObject({ phase: 'extract_failed', total: 0, label: 'Extraction failed' })
  })

  it('tells the phases of a run that is not launched apart from the rest', () => {
    for (const phase of ['extracting', 'ready', 'extract_failed'] as const) {
      expect(isUnlaunchedCardPhase(phase), phase).toBe(true)
    }
    for (const phase of [
      'running',
      'paused',
      'completed',
      'issues',
      'cancelled',
      'migrating',
      null,
      undefined
    ] as const) {
      expect(isUnlaunchedCardPhase(phase), String(phase)).toBe(false)
    }
  })

  it.each(['completed', 'completed_with_issues'] as const)(
    'says the migrations of a %s run are running, wherever its ticket sits',
    (status) => {
      const detail = makeDetail(
        { status, base_branch: 'main', migration_session_id: 'session-mig' },
        [
          { key: 'A1', status: 'merged' },
          { key: 'A2', status: 'needs_attention' }
        ]
      )

      for (const column of [undefined, 'in_progress', 'review', 'merged', 'done']) {
        expect(runBoardCardState(detail, column), String(column)).toMatchObject({
          phase: 'migrating',
          label: 'Running migrations',
          merged: 1,
          total: 2,
          paused: false,
          // What the run left flagged is still not a question to answer.
          waitingOnUser: false
        })
      }
      // The session over, the card says how the run ended again.
      const settled = { ...detail, run: { ...detail.run, migration_session_id: null } }
      expect(runBoardCardState(settled, 'review').phase).toBe(
        status === 'completed' ? 'completed' : 'issues'
      )
    }
  )

  it.each(['running', 'paused'] as const)(
    'keeps a %s run in its own phase whatever migration session it carries',
    (status) => {
      const state = runBoardCardState(
        makeDetail({ status, migration_session_id: 'session-mig' }, [
          { key: 'A1', status: 'running' }
        ]),
        'in_progress'
      )

      expect(state.phase).toBe(status)
      expect(state.label).toBe(status === 'running' ? '1 working' : 'Paused · 1 working')
    }
  )

  it.each(['completed', 'completed_with_issues'] as const)(
    'says the migrations of a %s run wait for the user once their session does',
    (status) => {
      const detail = makeDetail(
        { status, base_branch: 'main', migration_session_id: 'session-mig' },
        [
          { key: 'A1', status: 'merged' },
          { key: 'A2', status: 'needs_attention' }
        ]
      )

      for (const column of [undefined, 'in_progress', 'review', 'merged', 'done']) {
        expect(runBoardCardState(detail, column, true), String(column)).toMatchObject({
          phase: 'migrating',
          label: 'Migrations waiting for you',
          // The session, not the ticket the run left flagged.
          waiting: 1,
          waitingOnUser: true,
          merged: 1,
          total: 2,
          paused: false
        })
      }
      // A session at work, said or left unsaid, leaves the card as it was.
      const working = { phase: 'migrating', label: 'Running migrations', waiting: 0 }
      expect(runBoardCardState(detail, 'in_progress', false)).toMatchObject({
        ...working,
        waitingOnUser: false
      })
      expect(runBoardCardState(detail, 'in_progress')).toEqual(
        runBoardCardState(detail, 'in_progress', false)
      )
    }
  )

  it.each(['running', 'paused'] as const)(
    'counts only its own tickets for a %s run, whatever its migration session waits for',
    (status) => {
      const quiet = makeDetail({ status, migration_session_id: 'session-mig' }, [
        { key: 'A1', status: 'running' }
      ])
      const asking = makeDetail({ status, migration_session_id: 'session-mig' }, [
        { key: 'A1', status: 'running' },
        { key: 'A2', status: 'needs_input' }
      ])

      expect(runBoardCardState(quiet, 'in_progress', true)).toMatchObject({
        phase: status,
        waiting: 0,
        waitingOnUser: false,
        label: status === 'running' ? '1 working' : 'Paused · 1 working'
      })
      // The ticket that asks is counted once, the session not at all.
      expect(runBoardCardState(asking, 'in_progress', true).waiting).toBe(1)
      for (const detail of [quiet, asking]) {
        expect(runBoardCardState(detail, 'in_progress', true)).toEqual(
          runBoardCardState(detail, 'in_progress')
        )
      }
    }
  )

  it.each(['completed', 'completed_with_issues', 'cancelled'] as const)(
    'waits on nobody for a %s run that has no migration session',
    (status) => {
      const detail = makeDetail({ status, base_branch: 'main' }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'needs_attention' }
      ])

      const state = runBoardCardState(detail, 'review', true)
      expect(state).toMatchObject({ waiting: 0, waitingOnUser: false })
      expect(state.phase).not.toBe('migrating')
      expect(state.label).not.toBe('Migrations waiting for you')
      expect(state).toEqual(runBoardCardState(detail, 'review'))
    }
  )
})

describe('documentRunTicketDropRefusal', () => {
  it('never lets the ticket of a run go back to To Do', () => {
    for (const status of [...DOCUMENT_RUN_STATUSES, null]) {
      expect(documentRunTicketDropRefusal(status, 'todo'), String(status)).toBe(
        'The ticket of a document run cannot go back to To Do.'
      )
    }
  })

  it('holds the ticket of a run in To Do while its tickets are being extracted', () => {
    for (const column of ['in_progress', 'review', 'merged', 'done']) {
      expect(documentRunTicketDropRefusal('extracting', column), column).toBe(
        'The tickets of this document run are still being extracted. Wait for them before moving it.'
      )
    }
  })

  it('holds the ticket of a run whose extraction failed, pointing at the retry', () => {
    for (const column of ['in_progress', 'review', 'merged', 'done']) {
      expect(documentRunTicketDropRefusal('extract_failed', column), column).toBe(
        'The tickets of this document run could not be extracted. Open its ticket to try again.'
      )
    }
  })

  it('lets the ticket of a previewed run go to In Progress only: that is how it is launched', () => {
    expect(documentRunTicketDropRefusal('preview', 'in_progress')).toBeNull()
    for (const column of ['review', 'merged', 'done']) {
      expect(documentRunTicketDropRefusal('preview', column), column).toBe(
        'This document run has not been launched yet. Drop its ticket on In Progress, or open it, to launch it.'
      )
    }
    // Migrations belong to a launched run; they change nothing here.
    expect(documentRunTicketDropRefusal('preview', 'review', true)).toBe(
      documentRunTicketDropRefusal('preview', 'review')
    )
  })

  it.each(['running', 'paused'] as const)('keeps the ticket of a %s run In Progress', (status) => {
    expect(documentRunTicketDropRefusal(status, 'in_progress')).toBeNull()
    expect(documentRunTicketDropRefusal(status, 'review')).toBe(
      'The document run is still going; its ticket moves to Review when the run ends.'
    )
    for (const column of ['merged', 'done']) {
      expect(documentRunTicketDropRefusal(status, column)).toBe(
        'The document run is still going. Wait for it to end, or cancel it, before merging it.'
      )
    }
  })

  it.each(['completed', 'completed_with_issues', 'cancelled', null] as const)(
    'lets the ticket of a %s run move forward, but not back to In Progress',
    (status) => {
      for (const column of ['review', 'merged', 'done']) {
        expect(documentRunTicketDropRefusal(status, column)).toBeNull()
      }
      expect(documentRunTicketDropRefusal(status, 'in_progress')).toBe(
        'This document run is over; its ticket cannot go back to In Progress.'
      )
    }
  )

  it.each(['completed', 'completed_with_issues', 'cancelled'] as const)(
    'holds the ticket of a %s run In Progress while its migrations are executed',
    (status) => {
      expect(documentRunTicketDropRefusal(status, 'in_progress', true)).toBeNull()
      for (const column of ['review', 'merged', 'done']) {
        expect(documentRunTicketDropRefusal(status, column, true), column).toBe(
          'The migrations of this document run are being executed. Wait for them to finish, or stop them, before moving its ticket.'
        )
      }
      // To Do keeps its own answer.
      expect(documentRunTicketDropRefusal(status, 'todo', true)).toBe(
        'The ticket of a document run cannot go back to To Do.'
      )
    }
  )

  it.each(['running', 'paused'] as const)(
    'answers for a %s run as if no migrations were being executed',
    (status) => {
      for (const column of ['todo', 'in_progress', 'review', 'merged', 'done']) {
        expect(documentRunTicketDropRefusal(status, column, true), column).toBe(
          documentRunTicketDropRefusal(status, column)
        )
      }
      expect(documentRunTicketDropRefusal(status, 'review', true)).toBe(
        'The document run is still going; its ticket moves to Review when the run ends.'
      )
    }
  )
})

describe('run status groups', () => {
  it('sends launched runs to the dashboard and the rest to the wizard', () => {
    const launched = DOCUMENT_RUN_STATUSES.filter(isLaunchedRunStatus)
    expect(launched).toEqual([
      'running',
      'paused',
      'completed',
      'completed_with_issues',
      'cancelled'
    ])
  })

  it('allows deleting every run the orchestrator is not driving', () => {
    expect(DOCUMENT_RUN_STATUSES.filter((status) => !isRunDeletable(status))).toEqual([
      'running',
      'paused'
    ])
  })

  it('tells a run whose migrations are being executed by the session it records', () => {
    expect(isRunMigrating(makeRun({ migration_session_id: 'session-mig' }))).toBe(true)
    expect(isRunMigrating(makeRun())).toBe(false)
    expect(isRunMigrating({ migration_session_id: '' })).toBe(false)
  })

  it('allows deleting no run while its migrations are being executed', () => {
    const migrating = makeRun({ migration_session_id: 'session-mig' })
    expect(DOCUMENT_RUN_STATUSES.filter((status) => isRunDeletable(status, migrating))).toEqual([])
    // A run that carries no session is deletable as its status says.
    expect(DOCUMENT_RUN_STATUSES.filter((status) => !isRunDeletable(status, makeRun()))).toEqual([
      'running',
      'paused'
    ])
  })
})

describe('describeRunDeletion', () => {
  it('keeps the spec text and figures on disk as soon as any item has a ticket', () => {
    // Mirrors the server: the run directory stays with the board tickets that attach it.
    expect(
      describeRunDeletion([
        makeItem({ key: 'A1' }),
        makeItem({ key: 'A2', ticket_id: 'ticket-A2' })
      ])
    ).toBe(
      "The run's own ticket is removed from the board. Branches, worktrees and the tickets of its tasks are not touched, and the spec text and figures those tickets attach stay on disk."
    )
  })

  it('removes the files of a run that has no tickets', () => {
    expect(describeRunDeletion([makeItem({ key: 'A1' })])).toBe(
      'Its spec text and figures are removed from disk as well.'
    )
    expect(describeRunDeletion([])).toBe('Its spec text and figures are removed from disk as well.')
  })
})

describe('wizardStep', () => {
  it('derives the step from the run the wizard points at', () => {
    expect(wizardStep(null, undefined)).toBe('pick')
    expect(wizardStep('run-1', undefined)).toBe('loading')
    expect(wizardStep('run-1', 'extracting')).toBe('extracting')
    expect(wizardStep('run-1', 'extract_failed')).toBe('failed')
    expect(wizardStep('run-1', 'preview')).toBe('preview')
    expect(wizardStep('run-1', 'running')).toBe('launched')
    expect(wizardStep('run-1', 'completed')).toBe('launched')
  })
})

describe('parseDocumentPath', () => {
  it('accepts absolute paths, trimming whitespace and quotes', () => {
    expect(parseDocumentPath('  /docs/spec.html ')).toEqual({
      path: '/docs/spec.html',
      error: null
    })
    expect(parseDocumentPath('"/docs/my spec.md"')).toEqual({
      path: '/docs/my spec.md',
      error: null
    })
    expect(parseDocumentPath('C:\\docs\\spec.TXT').path).toBe('C:\\docs\\spec.TXT')
  })

  it('passes home-relative paths through for the server to expand', () => {
    expect(parseDocumentPath('~/Documents/spec.md')).toEqual({
      path: '~/Documents/spec.md',
      error: null
    })
    expect(parseDocumentPath('~\\docs\\spec.md').path).toBe('~\\docs\\spec.md')
    // Only a bare tilde is the home directory; "~user" and "~spec.md" are relative names.
    expect(parseDocumentPath('~spec.md').error).toMatch(/absolute path/)
    expect(parseDocumentPath('~me/spec.md').error).toMatch(/absolute path/)
  })

  it('decodes file:// URLs', () => {
    expect(parseDocumentPath('file:///Users/me/My%20Spec.html').path).toBe('/Users/me/My Spec.html')
    expect(parseDocumentPath('file:///C:/docs/spec.md').path).toBe('C:/docs/spec.md')
  })

  it('passes http(s) links through for the server to download', () => {
    expect(parseDocumentPath(' https://specs.example.com/round-2 ')).toEqual({
      path: 'https://specs.example.com/round-2',
      error: null
    })
    expect(parseDocumentPath('http://localhost:8080/spec.html?v=2').path).toBe(
      'http://localhost:8080/spec.html?v=2'
    )
    expect(parseDocumentPath('https://').error).toMatch(/not a valid http\(s\) URL/)
    expect(parseDocumentPath('ftp://specs.example.com/spec.html').error).toMatch(/absolute path/)
  })

  it('rejects empty, relative and unsupported inputs with a reason', () => {
    expect(parseDocumentPath('   ')).toEqual({ path: null, error: 'Choose a document first.' })
    expect(parseDocumentPath('docs/spec.html').error).toMatch(/absolute path/)
    expect(parseDocumentPath('/docs/spec.pdf').error).toMatch(/HTML, Markdown or text/)
    expect(parseDocumentPath('~/spec.pdf').error).toMatch(/HTML, Markdown or text/)
    expect(parseDocumentPath('file://%zz').error).toMatch(/file:\/\/ URL/)
  })

  it('takes the file name off either kind of path', () => {
    expect(documentNameFromPath('/docs/checkout/spec.html')).toBe('spec.html')
    expect(documentNameFromPath('C:\\docs\\spec.md')).toBe('spec.md')
  })
})

describe('base branch', () => {
  const branches = [
    { name: 'develop', isRemote: false, isCheckedOut: true, worktreePath: '/repo/shop' },
    { name: 'a1-task', isRemote: false, isCheckedOut: true, worktreePath: '/worktrees/a1' },
    { name: 'main', isRemote: false, isCheckedOut: false },
    { name: 'origin/main', isRemote: true, isCheckedOut: false }
  ]

  it('names the branch of the root checkout, not one checked out in another worktree', () => {
    expect(currentRootBranch(branches, '/repo/shop')).toBe('develop')
    expect(currentRootBranch(branches, '/repo/other')).toBeNull()
    expect(currentRootBranch([], '/repo/shop')).toBeNull()
  })

  it('labels the default option with the branch it resolves to', () => {
    expect(defaultBaseBranchLabel('develop')).toBe('Current branch (develop)')
    expect(defaultBaseBranchLabel(null)).toBe('Current branch')
  })

  it('describes where a run is cut from: its own base branch, else the current one', () => {
    expect(describeBaseBranch({ baseBranch: 'release' }, 'develop')).toBe('release')
    expect(describeBaseBranch({ baseBranch: null }, 'develop')).toBe('develop')
    expect(describeBaseBranch({ baseBranch: null }, null)).toBe('the current branch')
  })
})

describe('connection project members', () => {
  const members = [
    { id: 'web', name: 'Web' },
    { id: 'api', name: 'API' }
  ]

  it('reads a member base branch, null when none is chosen', () => {
    const config = { memberBaseBranches: { web: 'release', api: null } }
    expect(memberBaseBranch(config, 'web')).toBe('release')
    expect(memberBaseBranch(config, 'api')).toBeNull()
    expect(memberBaseBranch(config, 'unknown')).toBeNull()
  })

  it('names every member base branch, the current one standing in for an unchosen member', () => {
    expect(
      describeMemberBaseBranches(
        members,
        { memberBaseBranches: { web: 'release' } },
        { web: 'main', api: 'master' }
      )
    ).toBe('release (Web) · master (API)')
    expect(describeMemberBaseBranches(members, { memberBaseBranches: {} }, {})).toBe(
      'the current branch (Web) · the current branch (API)'
    )
  })

  it('summarises the member verify commands, or says there is none', () => {
    expect(
      describeMemberVerifyCommands(members, {
        memberVerifyCommands: { web: ' pnpm check ', api: '' }
      })
    ).toBe('Web: pnpm check · API: none')
    expect(describeMemberVerifyCommands(members, { memberVerifyCommands: {} })).toBe(
      'no verify command'
    )
    expect(memberVerifyCommand({ memberVerifyCommands: { web: ' pnpm check ' } }, 'web')).toBe(
      'pnpm check'
    )
    expect(memberVerifyCommand({ memberVerifyCommands: {} }, 'api')).toBe('')
  })

  it('lists the members of a launched connection run with their branches', () => {
    expect(describeRunMembers(makeRun({ members: null }))).toEqual([])
    expect(describeRunMembers(makeRun({ members: CONNECTION_MEMBERS }))).toEqual([
      { projectId: 'web', label: 'Web · doc-checkout (from main)' },
      { projectId: 'api', label: 'API · doc-checkout (from master)' }
    ])
  })

  it('names the branch of an item in every member, by member project name', () => {
    const run = makeRun({ members: CONNECTION_MEMBERS })
    expect(describeItemBranches(run, makeItem({ members: null }))).toBeNull()
    expect(describeItemBranches(run, makeItem({ members: [] }))).toBeNull()
    expect(
      describeItemBranches(
        run,
        makeItem({
          members: [
            {
              project_id: 'web',
              worktree_id: 'wt-w',
              branch_name: 'a1-web',
              pre_merge_sha: null,
              merge_sha: null
            },
            {
              project_id: 'other',
              worktree_id: 'wt-o',
              branch_name: 'a1-other',
              pre_merge_sha: null,
              merge_sha: null
            }
          ]
        })
      )
    ).toBe('Web: a1-web\nother: a1-other')
  })
})

describe('formatGeneration', () => {
  it('names provider and model, or says the provider default is used', () => {
    expect(formatGeneration({ provider: 'claude-code', model: 'haiku' })).toBe(
      'claude-code · haiku'
    )
    expect(formatGeneration({ provider: 'codex' })).toBe("codex · the provider's default model")
    expect(formatGeneration(null)).toMatch(/default/)
  })
})

describe('verification labels', () => {
  it('gives every verification method a label and a description', () => {
    for (const method of DOCUMENT_VERIFICATION_METHODS) {
      expect(DOCUMENT_VERIFICATION_LABELS[method], method).toEqual(expect.any(String))
      expect(DOCUMENT_VERIFICATION_LABELS[method].length, method).toBeGreaterThan(0)
      expect(DOCUMENT_VERIFICATION_DESCRIPTIONS[method], method).toEqual(expect.any(String))
      expect(DOCUMENT_VERIFICATION_DESCRIPTIONS[method].length, method).toBeGreaterThan(0)
    }
    expect(Object.keys(DOCUMENT_VERIFICATION_LABELS).sort()).toEqual(
      [...DOCUMENT_VERIFICATION_METHODS].sort()
    )
    expect(Object.keys(DOCUMENT_VERIFICATION_DESCRIPTIONS).sort()).toEqual(
      [...DOCUMENT_VERIFICATION_METHODS].sort()
    )
  })

  it('uses the words the chips show', () => {
    expect(DOCUMENT_VERIFICATION_LABELS).toEqual({
      tcu: 'tcu',
      playwright: 'playwright',
      tests: 'tests'
    })
  })
})

describe('toggleVerificationMethod', () => {
  it('adds a method in canonical order, wherever it would land', () => {
    expect(toggleVerificationMethod([], 'tests')).toEqual(['tests'])
    expect(toggleVerificationMethod(['tests'], 'playwright')).toEqual(['playwright', 'tests'])
    expect(toggleVerificationMethod(['playwright', 'tests'], 'tcu')).toEqual([
      'tcu',
      'playwright',
      'tests'
    ])
    expect(toggleVerificationMethod(['tcu', 'tests'], 'playwright')).toEqual([
      'tcu',
      'playwright',
      'tests'
    ])
  })

  it('removes a method that is on, leaving the rest in canonical order', () => {
    expect(toggleVerificationMethod(['tcu', 'playwright', 'tests'], 'playwright')).toEqual([
      'tcu',
      'tests'
    ])
    expect(toggleVerificationMethod(['tests'], 'tests')).toEqual([])
  })

  it('treats a duplicated method as on once, and does not keep the duplicate', () => {
    expect(toggleVerificationMethod(['tests', 'tests'], 'tests')).toEqual([])
    expect(toggleVerificationMethod(['tests', 'tests'], 'tcu')).toEqual(['tcu', 'tests'])
  })

  it('does not change the array it was given', () => {
    const current = ['tests'] as const
    toggleVerificationMethod(current, 'tcu')
    expect(current).toEqual(['tests'])
  })
})

describe('describeVerificationChoice', () => {
  it('says verification is skipped for every ticket when the run disables it', () => {
    const items = [makeItem({ key: 'A1', verification: ['tests'] })]
    expect(describeVerificationChoice(items, true)).toBe('skipped for every ticket')
    expect(describeVerificationChoice([], true)).toBe('skipped for every ticket')
  })

  it('says none when no selected ticket verifies', () => {
    expect(describeVerificationChoice([], false)).toBe('none')
    expect(describeVerificationChoice([makeItem({ key: 'A1' })], false)).toBe('none')
  })

  it('counts each method over the selected tickets only, in canonical order', () => {
    const items = [
      makeItem({ key: 'A1', verification: ['tests'] }),
      makeItem({ key: 'A2', verification: ['playwright', 'tests'] }),
      makeItem({ key: 'A3', verification: ['tcu', 'tests'], selected: false })
    ]
    expect(describeVerificationChoice(items, false)).toBe('playwright ×1 · tests ×2')
  })

  it('lists tcu before playwright before tests, whatever the tickets say', () => {
    const items = [
      makeItem({ key: 'A1', verification: ['tests', 'tcu'] }),
      makeItem({ key: 'A2', verification: ['playwright'] })
    ]
    expect(describeVerificationChoice(items, false)).toBe('tcu ×1 · playwright ×1 · tests ×1')
  })
})

describe('canEditVerification', () => {
  it('lets every ticket be changed while the run is in preview', () => {
    for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
      expect(canEditVerification({ status: 'preview' }, { status }), status).toBe(true)
    }
  })

  it('lets only a pending ticket be changed while the run is running or paused', () => {
    for (const runStatus of ['running', 'paused'] as const) {
      for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
        expect(
          canEditVerification({ status: runStatus }, { status }),
          `${runStatus}/${status}`
        ).toBe(status === 'pending')
      }
    }
  })

  it('lets nothing be changed once the run is over or before it was extracted', () => {
    for (const runStatus of [
      'completed',
      'completed_with_issues',
      'cancelled',
      'extracting',
      'extract_failed'
    ] as const) {
      for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
        expect(
          canEditVerification({ status: runStatus }, { status }),
          `${runStatus}/${status}`
        ).toBe(false)
      }
    }
  })
})

describe('canEditLaunchConfig', () => {
  it('lets every ticket be changed while the run is in preview', () => {
    for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
      expect(canEditLaunchConfig({ status: 'preview' }, { status, session_id: null }), status).toBe(
        true
      )
    }
  })

  it('lets a ticket that has not launched be changed while the run is running or paused', () => {
    for (const runStatus of ['running', 'paused'] as const) {
      for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
        expect(
          canEditLaunchConfig({ status: runStatus }, { status, session_id: 'session-1' }),
          `${runStatus}/${status}`
        ).toBe(status === 'pending')
      }
      // Flagged after a failed launch, with no session: Retry launches it afresh.
      expect(
        canEditLaunchConfig({ status: runStatus }, { status: 'needs_attention', session_id: null })
      ).toBe(true)
    }
  })

  it('lets nothing be changed once the run is over or before it was extracted', () => {
    for (const runStatus of [
      'completed',
      'completed_with_issues',
      'cancelled',
      'extracting',
      'extract_failed'
    ] as const) {
      for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
        expect(
          canEditLaunchConfig({ status: runStatus }, { status, session_id: null }),
          `${runStatus}/${status}`
        ).toBe(false)
      }
    }
  })
})

describe('describeVerificationChip', () => {
  const editable = { disabled: false, readOnly: false }

  it('starts with what the method is', () => {
    for (const method of DOCUMENT_VERIFICATION_METHODS) {
      expect(
        describeVerificationChip(method, makeItem(), editable).startsWith(
          DOCUMENT_VERIFICATION_DESCRIPTIONS[method]
        ),
        method
      ).toBe(true)
    }
  })

  it('says whether the method is on and what a click does', () => {
    const on = makeItem({ verification: ['tests'] })
    expect(describeVerificationChip('tests', on, editable)).toBe(
      `${DOCUMENT_VERIFICATION_DESCRIPTIONS.tests} · on (click to turn off)`
    )
    expect(describeVerificationChip('tcu', on, editable)).toBe(
      `${DOCUMENT_VERIFICATION_DESCRIPTIONS.tcu} · off (click to turn on)`
    )
  })

  it('names the suggestion and its reason', () => {
    const item = makeItem({
      verification_suggested: ['tests'],
      verification: [],
      verification_reason: 'pure parsing logic'
    })
    expect(describeVerificationChip('tests', item, editable)).toBe(
      `${DOCUMENT_VERIFICATION_DESCRIPTIONS.tests} · off (click to turn on) · suggested by the extraction: pure parsing logic`
    )
    // A method the extraction did not suggest says nothing about it.
    expect(describeVerificationChip('tcu', item, editable)).not.toContain('suggested')
  })

  it('names a suggestion without a reason too', () => {
    const item = makeItem({ verification_suggested: ['playwright'], verification: ['playwright'] })
    expect(describeVerificationChip('playwright', item, editable)).toBe(
      `${DOCUMENT_VERIFICATION_DESCRIPTIONS.playwright} · on (click to turn off) · suggested by the extraction`
    )
  })

  it('says the run skips verification instead of inviting a click', () => {
    const item = makeItem({ verification: ['tests'] })
    const text = describeVerificationChip('tests', item, { disabled: true, readOnly: false })
    expect(text).toBe(
      `${DOCUMENT_VERIFICATION_DESCRIPTIONS.tests} · verification is skipped for this run`
    )
    expect(text).not.toContain('click to turn')
  })

  it('states on or off without a click once the ticket is read-only', () => {
    const item = makeItem({ verification: ['tests'] })
    expect(describeVerificationChip('tests', item, { disabled: false, readOnly: true })).toBe(
      `${DOCUMENT_VERIFICATION_DESCRIPTIONS.tests} · on`
    )
    expect(describeVerificationChip('tcu', item, { disabled: false, readOnly: true })).toBe(
      `${DOCUMENT_VERIFICATION_DESCRIPTIONS.tcu} · off`
    )
  })

  it('lets the run-wide skip win over read-only', () => {
    const item = makeItem({ verification: ['tests'] })
    expect(describeVerificationChip('tests', item, { disabled: true, readOnly: true })).toBe(
      `${DOCUMENT_VERIFICATION_DESCRIPTIONS.tests} · verification is skipped for this run`
    )
  })
})
