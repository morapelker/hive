import { describe, expect, it } from 'vitest'
import {
  USER_INTERRUPT_DETAIL,
  WAITING_PREFIX,
  summarizeItems
} from '@shared/document-flow/planning'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  DOCUMENT_RUN_ITEM_STATUSES,
  DOCUMENT_RUN_STATUSES
} from '@shared/types/document-flow'
import {
  DOCUMENT_RUN_ITEM_STATUS_DOTS,
  DOCUMENT_RUN_ITEM_STATUS_LABELS,
  DOCUMENT_RUN_ITEM_STATUS_TONES,
  DOCUMENT_RUN_STATUS_LABELS,
  DOCUMENT_RUN_STATUS_TONES,
  currentRootBranch,
  defaultBaseBranchLabel,
  describeBaseBranch,
  describeRunDeletion,
  documentNameFromPath,
  documentRunTicketDropRefusal,
  formatGeneration,
  formatRunProgress,
  isLaunchedRunStatus,
  isRequeueableItem,
  isRunDeletable,
  isSkippableItem,
  itemSessionTarget,
  itemStatusDisplay,
  needsUser,
  needsUserMessage,
  parseDocumentPath,
  progressSegments,
  runBoardCardState,
  runCountsLabel,
  runStatusDisplay,
  tonePillClass,
  wizardStep
} from './document-flow-ui'
import { makeDetail, makeItem, makeRun } from './test-fixtures'

const RUNNING = { status: 'running', config: DEFAULT_DOCUMENT_RUN_CONFIG } as const

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
    const run = { integration_worktree_id: 'wt-integration' }
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
    ).toEqual({ sessionId: 's-fix', worktreeId: 'wt-integration' })
    expect(
      itemSessionTarget(
        run,
        makeItem({ status: 'needs_input', session_id: 's-ticket', worktree_id: 'wt-ticket' })
      )
    ).toEqual({ sessionId: 's-ticket', worktreeId: 'wt-ticket' })
    expect(itemSessionTarget(run, makeItem({ status: 'pending' }))).toBeNull()
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
      waitingOnUser: false,
      paused: false,
      label: '2 running'
    })
    expect(state.segments.map((segment) => [segment.key, segment.count])).toEqual([
      ['merged', 1],
      ['inProgress', 4],
      ['pending', 1]
    ])
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
    expect(state.running).toBe(1)
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
    ).toMatchObject({ paused: true, running: 1, label: 'Paused · 1 running' })
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
})

describe('documentRunTicketDropRefusal', () => {
  it('never lets the ticket of a run go back to To Do', () => {
    for (const status of [...DOCUMENT_RUN_STATUSES, null]) {
      expect(documentRunTicketDropRefusal(status, 'todo'), String(status)).toBe(
        'The ticket of a document run cannot go back to To Do.'
      )
    }
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
    expect(wizardStep(false, null, undefined)).toBe('pick')
    expect(wizardStep(false, 'run-1', undefined)).toBe('loading')
    expect(wizardStep(false, 'run-1', 'extracting')).toBe('extracting')
    expect(wizardStep(false, 'run-1', 'extract_failed')).toBe('failed')
    expect(wizardStep(false, 'run-1', 'preview')).toBe('preview')
    expect(wizardStep(false, 'run-1', 'running')).toBe('launched')
    expect(wizardStep(false, 'run-1', 'completed')).toBe('launched')
  })

  it('refuses connection projects whatever the run', () => {
    expect(wizardStep(true, null, undefined)).toBe('unsupported')
    expect(wizardStep(true, 'run-1', 'preview')).toBe('unsupported')
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

describe('formatGeneration', () => {
  it('names provider and model, or says the provider default is used', () => {
    expect(formatGeneration({ provider: 'claude-code', model: 'haiku' })).toBe(
      'claude-code · haiku'
    )
    expect(formatGeneration({ provider: 'codex' })).toBe("codex · the provider's default model")
    expect(formatGeneration(null)).toMatch(/default/)
  })
})
