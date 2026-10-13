import { describe, expect, it } from 'vitest'

import {
  DOCUMENT_RUN_ITEM_STATUSES,
  type DocumentRunItem,
  type DocumentRunItemStatus
} from '../types/document-flow'
import {
  USER_INTERRUPT_DETAIL,
  WAITING_PREFIX,
  awaitsLaunch,
  countOccupiedSlots,
  countRunningAgents,
  integrationBranchHint,
  isDependencySatisfied,
  isMergeInFlight,
  isRunSettled,
  isRunWaitingOnUser,
  isTerminalItemStatus,
  launchableItems,
  mergeCandidates,
  mergeLaneOwner,
  sanitizeDependencies,
  summarizeItems,
  ticketBranchHint,
  unmetDependencies
} from './planning'

let nextPosition = 0

function item(
  key: string,
  status: DocumentRunItemStatus = 'pending',
  overrides: Partial<DocumentRunItem> = {}
): DocumentRunItem {
  return {
    id: `item-${key}`,
    run_id: 'run-1',
    key,
    position: nextPosition++,
    title: `Task ${key}`,
    summary: '',
    description: '',
    kind: 'change',
    depends_on: [],
    has_migration: false,
    size: null,
    conflict_risk: null,
    doc_status: 'open',
    selected: true,
    figures: [],
    open_questions: [],
    verification_suggested: [],
    verification: [],
    verification_reason: '',
    launch_config: null,
    status,
    status_detail: null,
    ticket_id: null,
    worktree_id: null,
    connection_id: null,
    members: null,
    session_id: null,
    fix_ticket_id: null,
    fix_session_id: null,
    branch_name: null,
    verdict: null,
    nudge_count: 0,
    conflict_attempts: 0,
    conflict_head: null,
    fix_attempts: 0,
    continue_attempts: 0,
    pre_merge_sha: null,
    merge_sha: null,
    last_prompt_at: null,
    last_checked_at: null,
    retry_at: null,
    created_at: '2026-10-05T10:00:00.000Z',
    updated_at: '2026-10-05T10:00:00.000Z',
    started_at: null,
    finished_at: null,
    ...overrides
  }
}

const keys = (items: readonly DocumentRunItem[]): string[] => items.map((entry) => entry.key)

describe('dependencies', () => {
  it('treats merged, skipped, deselected and absent dependencies as satisfied', () => {
    expect(isDependencySatisfied(undefined)).toBe(true)
    expect(isDependencySatisfied(item('A', 'merged'))).toBe(true)
    expect(isDependencySatisfied(item('A', 'skipped'))).toBe(true)
    expect(isDependencySatisfied(item('A', 'running', { selected: false }))).toBe(true)
    for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
      if (status === 'merged' || status === 'skipped') continue
      expect(isDependencySatisfied(item('A', status))).toBe(false)
    }
  })

  it('lists the dependencies still holding an item back', () => {
    const items = [
      item('A', 'merged'),
      item('B', 'running'),
      item('C', 'needs_attention'),
      item('D', 'pending', { depends_on: ['A', 'B', 'C', 'GONE'] })
    ]
    expect(unmetDependencies(items[3], items)).toEqual(['B', 'C'])
    expect(unmetDependencies(items[0], items)).toEqual([])
  })

  it('knows the terminal statuses', () => {
    expect(DOCUMENT_RUN_ITEM_STATUSES.filter(isTerminalItemStatus)).toEqual([
      'merged',
      'skipped',
      'cancelled'
    ])
  })
})

describe('launchableItems', () => {
  it('launches in dependency waves', () => {
    const a = item('A')
    const b = item('B', 'pending', { depends_on: ['A'] })
    const c = item('C', 'pending', { depends_on: ['A', 'B'] })
    const d = item('D')
    expect(keys(launchableItems([a, b, c, d], 8))).toEqual(['A', 'D'])

    a.status = 'running'
    d.status = 'ready'
    expect(keys(launchableItems([a, b, c, d], 8))).toEqual([])

    a.status = 'merged'
    expect(keys(launchableItems([a, b, c, d], 8))).toEqual(['B'])

    b.status = 'merged'
    expect(keys(launchableItems([a, b, c, d], 8))).toEqual(['C'])
  })

  it('fills only the free slots, in document order whatever the array order', () => {
    const items = [item('A'), item('B'), item('C'), item('D'), item('E')]
    const shuffled = [items[3], items[0], items[4], items[2], items[1]]
    expect(keys(launchableItems(shuffled, 2))).toEqual(['A', 'B'])

    items[0].status = 'running'
    expect(keys(launchableItems(shuffled, 2))).toEqual(['B'])
    expect(keys(launchableItems(shuffled, 3))).toEqual(['B', 'C'])

    items[1].status = 'needs_input'
    expect(keys(launchableItems(shuffled, 2))).toEqual([])
  })

  it.each(['launching', 'running', 'needs_input', 'checking', 'resolving_conflicts'] as const)(
    'counts %s against the parallel limit',
    (status) => {
      expect(launchableItems([item('A', status), item('B')], 1)).toEqual([])
    }
  )

  it.each([
    'ready',
    'merging',
    'verifying',
    'fixing',
    'merged',
    'needs_attention',
    'skipped',
    'cancelled'
  ] as const)('does not count %s against the parallel limit', (status) => {
    expect(keys(launchableItems([item('A', status), item('B')], 1))).toEqual(['B'])
  })

  it('treats deselected and skipped dependencies as satisfied', () => {
    const items = [
      item('A', 'pending', { selected: false }),
      item('B', 'skipped'),
      item('C', 'pending', { depends_on: ['A', 'B', 'UNKNOWN'] }),
      item('D', 'pending', { depends_on: ['E'] }),
      item('E', 'needs_attention')
    ]
    // A is deselected: never launched itself, and never in the way.
    expect(keys(launchableItems(items, 8))).toEqual(['C'])
  })

  it('ignores a deselected item that is somehow active', () => {
    const items = [item('A', 'running', { selected: false }), item('B')]
    expect(keys(launchableItems(items, 1))).toEqual(['B'])
  })

  it('always allows one slot, and whole slots only', () => {
    const items = [item('A'), item('B'), item('C')]
    expect(keys(launchableItems(items, 0))).toEqual(['A'])
    expect(keys(launchableItems(items, -3))).toEqual(['A'])
    expect(keys(launchableItems(items, 2.9))).toEqual(['A', 'B'])
    expect(launchableItems([], 4)).toEqual([])
  })

  it('launches nothing while more slots are held than the limit allows', () => {
    // The limit was lowered under what is running: no launch until the count is below it.
    const items = [item('A', 'running'), item('B', 'running'), item('C', 'running'), item('D')]
    expect(launchableItems(items, 1)).toEqual([])
    expect(launchableItems(items, 3)).toEqual([])
    expect(keys(launchableItems(items, 4))).toEqual(['D'])
  })
})

describe('awaitsLaunch', () => {
  it('is true for a pending ticket, and for one flagged after a failed launch', () => {
    // With a session, only a pending ticket has not launched: a flagged one has an agent whose
    // work has to be looked at.
    for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
      expect(awaitsLaunch(item('A', status, { session_id: 'session-1' })), status).toBe(
        status === 'pending'
      )
    }
    // Without one, a flagged ticket is one whose launch failed: Retry launches it afresh.
    for (const status of DOCUMENT_RUN_ITEM_STATUSES) {
      expect(awaitsLaunch(item('A', status, { session_id: null })), status).toBe(
        status === 'pending' || status === 'needs_attention'
      )
    }
  })
})

describe('countOccupiedSlots', () => {
  it('counts what maxParallel limits: every item with a session that is, or may be, working', () => {
    const items = [
      item('A', 'launching'),
      item('B', 'running'),
      item('C', 'needs_input'),
      item('D', 'checking'),
      item('E', 'resolving_conflicts'),
      item('F', 'pending'),
      item('G', 'ready'),
      item('H', 'merging'),
      item('I', 'verifying'),
      item('J', 'fixing'),
      item('K', 'needs_attention'),
      item('L', 'merged'),
      item('M', 'skipped'),
      item('N', 'cancelled')
    ]
    expect(countOccupiedSlots(items)).toBe(5)
  })

  it('ignores items that are not part of the run', () => {
    expect(countOccupiedSlots([item('A', 'running', { selected: false })])).toBe(0)
    expect(countOccupiedSlots([])).toBe(0)
  })

  it('is the count launchableItems fills up to', () => {
    const items = [item('A', 'running'), item('B', 'needs_input'), item('C'), item('D'), item('E')]
    const limit = 4
    expect(launchableItems(items, limit)).toHaveLength(limit - countOccupiedSlots(items))
  })
})

describe('mergeCandidates', () => {
  it('lists ready items in document order', () => {
    const items = [item('A', 'running'), item('B', 'ready'), item('C', 'ready')]
    expect(mergeCandidates([items[2], items[1], items[0]]).map((it) => it.key)).toEqual(['B', 'C'])
  })

  it('puts tickets with migrations after those without', () => {
    const items = [
      item('A', 'ready', { has_migration: true }),
      item('B', 'ready', { has_migration: true }),
      item('C', 'ready'),
      item('D', 'ready')
    ]
    expect(mergeCandidates(items).map((it) => it.key)).toEqual(['C', 'D', 'A', 'B'])
  })

  it.each(['merging', 'verifying', 'fixing'] as const)(
    'offers nothing while another item is %s',
    (status) => {
      const items = [item('A', status), item('B', 'ready')]
      expect(isMergeInFlight(items)).toBe(true)
      expect(mergeCandidates(items)).toEqual([])
    }
  )

  it('offers nothing while a ticket resolves its conflicts', () => {
    const items = [
      item('A', 'resolving_conflicts', { conflict_attempts: 1 }),
      item('B', 'ready'),
      item('C', 'ready')
    ]
    expect(isMergeInFlight(items)).toBe(false)
    expect(mergeLaneOwner(items)?.key).toBe('A')
    expect(mergeCandidates(items)).toEqual([])
  })

  it.each(['checking', 'running', 'needs_input'] as const)(
    'keeps the lane for a resolving ticket that is %s',
    (status) => {
      // After its resolution turn the ticket is judged, nudged, or stops for the user; a merge
      // landing meanwhile would make it conflict again.
      const items = [item('A', status, { conflict_attempts: 1 }), item('B', 'ready')]
      expect(mergeLaneOwner(items)?.key).toBe('A')
      expect(mergeCandidates(items)).toEqual([])
    }
  )

  it('offers only the ticket that resolved its conflicts once it is ready again', () => {
    const items = [
      item('A', 'ready'),
      item('B', 'ready', { has_migration: true, conflict_attempts: 1 }),
      item('C', 'ready')
    ]
    expect(mergeCandidates(items).map((it) => it.key)).toEqual(['B'])
  })

  it.each(['needs_attention', 'merged', 'skipped', 'cancelled'] as const)(
    'releases the lane when the resolving ticket is %s',
    (status) => {
      const items = [item('A', status, { conflict_attempts: 2 }), item('B', 'ready')]
      expect(mergeLaneOwner(items)).toBeNull()
      expect(mergeCandidates(items).map((it) => it.key)).toEqual(['B'])
    }
  )

  it('ignores deselected items', () => {
    expect(mergeCandidates([item('A', 'ready', { selected: false })])).toEqual([])
    const items = [
      item('A', 'merging', { selected: false }),
      item('B', 'resolving_conflicts', { selected: false, conflict_attempts: 1 }),
      item('C', 'ready')
    ]
    expect(mergeLaneOwner(items)).toBeNull()
    expect(mergeCandidates(items).map((it) => it.key)).toEqual(['C'])
  })

  it('offers nothing when nothing is ready', () => {
    expect(mergeCandidates([])).toEqual([])
    expect(mergeCandidates([item('A', 'running'), item('B', 'merged')])).toEqual([])
  })
})

describe('isRunSettled', () => {
  it('is settled once every selected item is merged, skipped or cancelled', () => {
    expect(isRunSettled([item('A', 'merged'), item('B', 'skipped'), item('C', 'cancelled')])).toBe(
      true
    )
    expect(isRunSettled([item('A', 'merged'), item('B', 'running', { selected: false })])).toBe(
      true
    )
  })

  it.each(
    DOCUMENT_RUN_ITEM_STATUSES.filter(
      (status) => !['merged', 'skipped', 'cancelled'].includes(status)
    )
  )('is not settled while an item is %s', (status) => {
    expect(isRunSettled([item('A', 'merged'), item('B', status)])).toBe(false)
  })

  it('is not settled with nothing selected', () => {
    expect(isRunSettled([])).toBe(false)
    expect(isRunSettled([item('A', 'merged', { selected: false })])).toBe(false)
  })
})

describe('isRunWaitingOnUser', () => {
  it('waits when every open item needs the user', () => {
    expect(isRunWaitingOnUser([item('A', 'needs_input'), item('B', 'merged')])).toBe(true)
    expect(isRunWaitingOnUser([item('A', 'needs_attention'), item('B', 'needs_input')])).toBe(true)
  })

  it('waits when the rest is stuck behind a flagged item', () => {
    const items = [
      item('A', 'merged'),
      item('B', 'needs_attention'),
      item('C', 'pending', { depends_on: ['B'] }),
      item('D', 'pending', { depends_on: ['C'] })
    ]
    expect(isRunWaitingOnUser(items)).toBe(true)
  })

  it('does not wait while something can still move', () => {
    const flagged = item('A', 'needs_attention')
    expect(isRunWaitingOnUser([flagged, item('B', 'running')])).toBe(false)
    expect(isRunWaitingOnUser([flagged, item('B', 'ready')])).toBe(false)
    expect(isRunWaitingOnUser([flagged, item('B', 'merging')])).toBe(false)
    expect(isRunWaitingOnUser([flagged, item('B', 'checking')])).toBe(false)
    // A pending item with nothing in its way launches on the next tick.
    expect(isRunWaitingOnUser([flagged, item('B', 'pending')])).toBe(false)
    expect(
      isRunWaitingOnUser([
        flagged,
        item('B', 'pending', { depends_on: ['C'] }),
        item('C', 'merged')
      ])
    ).toBe(false)
  })

  it('does not wait while a pending item is behind a working one', () => {
    const items = [item('A', 'running'), item('B', 'pending', { depends_on: ['A'] })]
    expect(isRunWaitingOnUser(items)).toBe(false)
  })

  it('waits when the ready items are behind a conflict resolution that stopped for the user', () => {
    const stopped = item('A', 'resolving_conflicts', {
      conflict_attempts: 1,
      status_detail: `${WAITING_PREFIX}Keep both prices?`
    })
    expect(isRunWaitingOnUser([stopped, item('B', 'ready')])).toBe(true)
    expect(isRunWaitingOnUser([stopped, item('B', 'ready'), item('C', 'running')])).toBe(false)
    // Nothing merges behind a resolution that is still at work either, but that is not on the user.
    const working = item('A', 'resolving_conflicts', { conflict_attempts: 1 })
    expect(isRunWaitingOnUser([working, item('B', 'ready')])).toBe(false)
    const judged = item('A', 'needs_input', { conflict_attempts: 1 })
    expect(isRunWaitingOnUser([judged, item('B', 'ready')])).toBe(true)
  })

  it('does not wait when nothing is open', () => {
    expect(isRunWaitingOnUser([])).toBe(false)
    expect(isRunWaitingOnUser([item('A', 'merged'), item('B', 'skipped')])).toBe(false)
    expect(isRunWaitingOnUser([item('A', 'needs_input', { selected: false })])).toBe(false)
  })
})

describe('countRunningAgents', () => {
  it('counts the sessions at work, not the steps the orchestrator runs itself', () => {
    const items = [
      item('A', 'launching'),
      item('B', 'running'),
      item('C', 'resolving_conflicts'),
      item('D', 'fixing', { status_detail: 'Fixing the failed checks.' }),
      item('E', 'checking'),
      item('F', 'ready'),
      item('G', 'merging'),
      item('H', 'verifying'),
      item('I', 'pending'),
      item('J', 'needs_input'),
      item('K', 'needs_attention'),
      item('L', 'merged'),
      item('M', 'skipped'),
      item('N', 'cancelled')
    ]
    expect(countRunningAgents(items)).toBe(4)
  })

  it('leaves out a conflict or fix session that stopped for the user', () => {
    expect(
      countRunningAgents([
        item('A', 'resolving_conflicts', { status_detail: `${WAITING_PREFIX}which one wins?` }),
        item('B', 'fixing', { status_detail: USER_INTERRUPT_DETAIL }),
        item('C', 'fixing')
      ])
    ).toBe(1)
  })

  it('ignores items that are not part of the run', () => {
    expect(countRunningAgents([item('A', 'running', { selected: false })])).toBe(0)
    expect(countRunningAgents([])).toBe(0)
  })
})

describe('sanitizeDependencies', () => {
  const graph = (edges: Record<string, string[]>) =>
    Object.entries(edges).map(([key, depends_on]) => ({ key, depends_on }))

  /** Kahn's algorithm: true when every node can be ordered after its dependencies. */
  const isAcyclic = (dependsOn: Record<string, string[]>): boolean => {
    const remaining = new Map(Object.entries(dependsOn).map(([key, deps]) => [key, new Set(deps)]))
    for (let progressed = true; progressed && remaining.size > 0;) {
      progressed = false
      for (const [key, deps] of remaining) {
        if (deps.size > 0) continue
        remaining.delete(key)
        for (const others of remaining.values()) others.delete(key)
        progressed = true
      }
    }
    return remaining.size === 0
  }

  it('leaves a clean graph alone, order included', () => {
    const result = sanitizeDependencies(
      graph({ A: [], B: ['A'], C: ['B', 'A'], D: ['C', 'A', 'B'] })
    )
    expect(result).toEqual({
      dependsOn: { A: [], B: ['A'], C: ['B', 'A'], D: ['C', 'A', 'B'] },
      warnings: []
    })
  })

  it('drops self-references', () => {
    expect(sanitizeDependencies(graph({ A: ['A'], B: ['A', 'B'] }))).toEqual({
      dependsOn: { A: [], B: ['A'] },
      warnings: [
        'A listed itself as a dependency; ignored.',
        'B listed itself as a dependency; ignored.'
      ]
    })
  })

  it('drops unknown keys', () => {
    expect(sanitizeDependencies(graph({ A: ['Z9', 'B'], B: [] }))).toEqual({
      dependsOn: { A: ['B'], B: [] },
      warnings: ['A depends on unknown task "Z9"; ignored.']
    })
  })

  it('drops duplicates silently, keeping the first position', () => {
    expect(sanitizeDependencies(graph({ A: [], B: [], C: ['B', 'A', 'B', 'A'] }))).toEqual({
      dependsOn: { A: [], B: [], C: ['B', 'A'] },
      warnings: []
    })
  })

  it('breaks a two-task cycle so the earlier task stays first', () => {
    expect(sanitizeDependencies(graph({ A: ['B'], B: ['A'] }))).toEqual({
      dependsOn: { A: [], B: ['A'] },
      warnings: ['Circular dependency A → B → A; dropped "A depends on B".']
    })
  })

  it('breaks a three-task cycle at the edge that points forward in the document', () => {
    // C → A and B → A keep document order; only "A depends on B" points at a later task.
    expect(sanitizeDependencies(graph({ A: ['B'], B: ['C'], C: ['A'] }))).toEqual({
      dependsOn: { A: [], B: ['C'], C: ['A'] },
      warnings: ['Circular dependency A → B → C → A; dropped "A depends on B".']
    })
    expect(sanitizeDependencies(graph({ A: ['C'], B: ['A'], C: ['B'] }))).toEqual({
      dependsOn: { A: [], B: ['A'], C: ['B'] },
      warnings: ['Circular dependency A → C → B → A; dropped "A depends on C".']
    })
  })

  it('never makes an earlier task wait for a later one to break a cycle', () => {
    const result = sanitizeDependencies(
      graph({ A: ['D'], B: ['A'], C: ['B'], D: ['C', 'B'], E: ['D'] })
    )
    expect(isAcyclic(result.dependsOn)).toBe(true)
    expect(result.dependsOn).toEqual({ A: [], B: ['A'], C: ['B'], D: ['C', 'B'], E: ['D'] })
  })

  it('breaks every cycle of a tangled graph and keeps the edges outside them', () => {
    const result = sanitizeDependencies(
      graph({
        A: ['B', 'D'],
        B: ['C'],
        C: ['A', 'B'],
        D: [],
        E: ['D', 'F', 'E', 'NOPE'],
        F: ['E', 'A']
      })
    )
    expect(isAcyclic(result.dependsOn)).toBe(true)
    expect(result.dependsOn.A).toContain('D')
    expect(result.dependsOn.D).toEqual([])
    expect(result.dependsOn.F).toContain('A')
    // Order of the surviving dependencies is the order they were written in.
    expect(result.dependsOn.E.filter((key) => key !== 'F')).toEqual(['D'])
    expect(result.warnings).toContain('E listed itself as a dependency; ignored.')
    expect(result.warnings).toContain('E depends on unknown task "NOPE"; ignored.')
  })

  it('does not mutate its input', () => {
    const items = [
      { key: 'A', depends_on: ['B', 'A'] },
      { key: 'B', depends_on: ['A'] }
    ]
    const snapshot = JSON.stringify(items)
    sanitizeDependencies(items)
    expect(JSON.stringify(items)).toBe(snapshot)
  })

  it('handles an empty list and a long chain', () => {
    expect(sanitizeDependencies([])).toEqual({ dependsOn: {}, warnings: [] })
    const chain = Array.from({ length: 500 }, (_value, index) => ({
      key: `T${index}`,
      depends_on: index === 0 ? ['T499'] : [`T${index - 1}`]
    }))
    const result = sanitizeDependencies(chain)
    expect(isAcyclic(result.dependsOn)).toBe(true)
    expect(result.warnings).toHaveLength(1)
  })
})

describe('summarizeItems', () => {
  it('counts the selected items by what they need', () => {
    const items = [
      item('A', 'merged'),
      item('B', 'merged'),
      item('C', 'running'),
      item('D', 'checking'),
      item('E', 'ready'),
      item('F', 'verifying'),
      item('G', 'needs_input'),
      item('H', 'needs_attention'),
      item('I', 'pending'),
      item('J', 'skipped'),
      item('K', 'cancelled'),
      item('L', 'running', { selected: false }),
      item('M', 'pending', { selected: false })
    ]
    const summary = summarizeItems(items)
    expect(summary).toMatchObject({
      total: 11,
      merged: 2,
      inProgress: 4,
      attention: 2,
      pending: 1,
      skipped: 2
    })
    expect(summary.byStatus).toMatchObject({ merged: 2, running: 1, pending: 1, launching: 0 })
    expect(Object.keys(summary.byStatus).sort()).toEqual([...DOCUMENT_RUN_ITEM_STATUSES].sort())
    expect(
      summary.merged + summary.inProgress + summary.attention + summary.pending + summary.skipped
    ).toBe(summary.total)
  })

  it('is all zeros for no items', () => {
    const summary = summarizeItems([])
    expect(summary).toMatchObject({
      total: 0,
      merged: 0,
      inProgress: 0,
      attention: 0,
      pending: 0,
      skipped: 0
    })
    expect(Object.values(summary.byStatus).every((count) => count === 0)).toBe(true)
  })
})

describe('branch hints', () => {
  it('puts the task key first', () => {
    expect(ticketBranchHint('A2', 'Counters (stats rows)')).toBe('a2-counters-stats-rows')
    expect(ticketBranchHint('14', 'Fix login')).toBe('14-fix-login')
  })

  it('reduces non-ASCII text to what a branch name can hold', () => {
    expect(ticketBranchHint('A1', 'Chinese translation 中文')).toBe('a1-chinese-translation')
    expect(ticketBranchHint('B2', 'Café → Ünïcödé crème')).toBe('b2-cafe-unicode-creme')
    expect(ticketBranchHint('משימה', 'תרגום')).toBe('task')
    expect(ticketBranchHint('', '')).toBe('task')
    expect(ticketBranchHint(' ', '···')).toBe('task')
  })

  it('caps long titles without a trailing dash', () => {
    const hint = ticketBranchHint(
      'B2',
      'Brands → Products → Sizes (the product is the requirement)'
    )
    expect(hint).toBe('b2-brands-products-sizes-the-pro')
    expect(hint.length).toBeLessThanOrEqual(32)
    // The cut lands on a separator: it is dropped rather than left dangling.
    expect(ticketBranchHint('C1', `${'a'.repeat(28)} bbb`)).toBe(`c1-${'a'.repeat(28)}`)
    expect(ticketBranchHint('X', 'a'.repeat(100))).toMatch(/^x-a{30}$/)
  })

  it('yields only branch-safe characters', () => {
    for (const title of ['feat: add "quotes" & <tags>', '..//~^:?*[\\', 'tabs\tand\nnewlines']) {
      expect(ticketBranchHint('K1', title)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('names the integration branch after the document', () => {
    expect(integrationBranchHint('Tedooo · Factory area · Changes round 2')).toBe(
      'doc-tedooo-factory-area-changes-round-2'
    )
    expect(integrationBranchHint('  ')).toBe('doc-run')
    expect(integrationBranchHint('中文')).toBe('doc-run')
    const long = integrationBranchHint('A very long document title that goes on and on and on')
    expect(long).toBe('doc-a-very-long-document-title-that-goes')
    expect(long.length).toBeLessThanOrEqual(40)
  })
})
