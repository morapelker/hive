// @vitest-environment node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DocumentRunLaunchConfig,
  DocumentRunStatus,
  DocumentRunVerdict
} from '@shared/types/document-flow'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { appStartedAtFromEnv } from './document-flow-service'
import { TEST_PROJECT_ID, createServiceHarness, seedRun, type ServiceHarness } from './test-support'

const launchConfig: DocumentRunLaunchConfig = {
  sdk: 'claude-code-cli',
  model: { providerID: 'anthropic', modelID: 'opus', variant: 'ultracode' },
  codexFastMode: false
}

const verdict: DocumentRunVerdict = {
  status: 'done',
  reason: 'The footer says DONE.',
  question: null,
  summary: 'Added the rule.',
  migrations: [],
  manualSteps: [],
  confidence: 'high',
  source: 'model',
  classifiedAt: '2026-10-05T10:00:00.000Z'
}

let harness: ServiceHarness

beforeEach(() => {
  harness = createServiceHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('get and list', () => {
  it('returns a run with its items and its newest 200 events, oldest first', () => {
    const { run } = seedRun(harness, { items: [{}, {}] })
    for (let index = 1; index <= 205; index++) {
      harness.db.appendDocumentRunEvent({ run_id: run.id, type: 'note', message: `event ${index}` })
    }

    const detail = harness.service.get(run.id)

    expect(detail?.run.id).toBe(run.id)
    expect(detail?.items.map((item) => item.key)).toEqual(['A1', 'A2'])
    expect(detail?.events).toHaveLength(200)
    expect(detail?.events[0].message).toBe('event 6')
    expect(detail?.events.at(-1)?.message).toBe('event 205')
    expect(harness.service.get('missing')).toBeNull()
  })

  it('lists runs newest first, without events, filtered by project', async () => {
    const first = seedRun(harness, { items: [{}] }).run
    harness.db.appendDocumentRunEvent({ run_id: first.id, type: 'note', message: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = seedRun(harness).run
    const other = seedRun(harness, { run: { project_id: 'project-2' } }).run

    const listed = harness.service.list(TEST_PROJECT_ID)

    expect(listed.map((detail) => detail.run.id)).toEqual([second.id, first.id])
    expect(listed[1].items).toHaveLength(1)
    expect(listed.every((detail) => detail.events.length === 0)).toBe(true)
    expect(harness.service.list().map((detail) => detail.run.id)).toContain(other.id)
  })
})

describe('updateRun', () => {
  it('renames a run in any status, keeping the title safe for prompts', () => {
    const { run } = seedRun(harness, { run: { status: 'completed' } })

    const updated = harness.service.updateRun(run.id, { title: '  Factory "area"\n<round 2> ' })

    expect(updated.title).toBe('Factory area round 2')
    expect(harness.published).toEqual([
      { runId: run.id, projectId: TEST_PROJECT_ID, reason: 'run' }
    ])
    expect(() => harness.service.updateRun(run.id, { title: ' "" ' })).toThrow(
      'The run needs a title.'
    )
  })

  it('merges a config patch over the stored config', () => {
    const { run } = seedRun(harness)

    const updated = harness.service.updateRun(run.id, {
      config: {
        verifyCommand: '  pnpm run lint  ',
        interactive: false,
        promptStyle: 'small',
        defaultLaunch: launchConfig
      }
    })

    expect(updated.config).toEqual({
      maxParallel: 4,
      verifyCommand: 'pnpm run lint',
      interactive: false,
      promptStyle: 'small',
      defaultLaunch: launchConfig,
      generation: null,
      baseBranch: null,
      notes: null,
      verificationDisabled: false
    })
    // A second patch keeps what the first one set.
    expect(
      harness.service.updateRun(run.id, { config: { generation: { provider: 'codex' } } }).config
    ).toMatchObject({
      verifyCommand: 'pnpm run lint',
      interactive: false,
      promptStyle: 'small',
      generation: { provider: 'codex' }
    })
    // A cleared command is the user's explicit "no verification": kept apart from "never chosen",
    // which the preview fills with the remembered or suggested command on its next mount.
    expect(
      harness.service.updateRun(run.id, { config: { verifyCommand: '   ' } }).config
    ).toMatchObject({ verifyCommand: '' })
    expect(
      harness.service.updateRun(run.id, { config: { verifyCommand: null } }).config
    ).toMatchObject({ verifyCommand: null })
  })

  it('turns verification off for the whole run and keeps it off through later patches', () => {
    const { run } = seedRun(harness, { run: { status: 'running' } })

    expect(
      harness.service.updateRun(run.id, { config: { verificationDisabled: true } }).config
    ).toMatchObject({ verificationDisabled: true })
    expect(harness.service.updateRun(run.id, { config: { maxParallel: 2 } }).config).toMatchObject({
      verificationDisabled: true,
      maxParallel: 2
    })
    expect(
      harness.service.updateRun(run.id, { config: { verificationDisabled: false } }).config
        .verificationDisabled
    ).toBe(false)
  })

  it.each([
    [0, 1],
    [-3, 1],
    [2.6, 3],
    [8, 8],
    [50, 50],
    [99, 50]
  ])('clamps maxParallel %s to %s', (given, stored) => {
    const { run } = seedRun(harness)

    expect(
      harness.service.updateRun(run.id, { config: { maxParallel: given } }).config.maxParallel
    ).toBe(stored)
  })

  it('changes the base branch only while the run is in preview', () => {
    const preview = seedRun(harness).run
    expect(
      harness.service.updateRun(preview.id, { config: { baseBranch: ' develop ' } }).config
        .baseBranch
    ).toBe('develop')
    expect(
      harness.service.updateRun(preview.id, { config: { baseBranch: '' } }).config.baseBranch
    ).toBeNull()

    const running = seedRun(harness, { run: { status: 'running' } }).run
    expect(() =>
      harness.service.updateRun(running.id, { config: { baseBranch: 'develop' } })
    ).toThrow('The base branch can only be changed while the run is in preview.')
    // Sending the stored value back (a form that saves every field) is not a change.
    expect(
      harness.service.updateRun(running.id, { config: { baseBranch: null, maxParallel: 2 } }).config
    ).toMatchObject({ baseBranch: null, maxParallel: 2 })
  })

  it('pauses and resumes a launched run, logging both', () => {
    const { run } = seedRun(harness, { run: { status: 'running' } })

    expect(harness.service.updateRun(run.id, { status: 'paused' }).status).toBe('paused')
    expect(harness.service.updateRun(run.id, { status: 'running' }).status).toBe('running')

    expect(
      harness.db.listDocumentRunEvents(run.id).map((event) => [event.type, event.message])
    ).toEqual([
      ['paused', 'Run paused'],
      ['resumed', 'Run resumed']
    ])
    expect(harness.published.map((event) => event.reason)).toEqual(['run', 'event', 'run', 'event'])
  })

  it('logs a changed maxParallel of a launched run, and only a change', () => {
    const { run } = seedRun(harness, { run: { status: 'running' } })
    const before = run.config

    const raised = harness.service.updateRun(run.id, { config: { maxParallel: 6 } })
    // Only the limit moved: the rest of the config is the run's own.
    expect(raised.config).toEqual({ ...before, maxParallel: 6 })
    expect(raised.status).toBe('running')
    harness.service.updateRun(run.id, { config: { maxParallel: 6 } })
    harness.service.updateRun(run.id, { status: 'paused' })
    harness.service.updateRun(run.id, { config: { maxParallel: 99 } })

    expect(
      harness.db.listDocumentRunEvents(run.id).map((event) => [event.type, event.message])
    ).toEqual([
      ['max_parallel_changed', `Parallel tickets changed from ${before.maxParallel} to 6`],
      ['paused', 'Run paused'],
      ['max_parallel_changed', 'Parallel tickets changed from 6 to 50']
    ])
    expect(harness.db.listDocumentRunEvents(run.id)[0].data).toEqual({
      from: before.maxParallel,
      to: 6
    })
  })

  it('does not log the maxParallel a preview is still being set up with', () => {
    const { run } = seedRun(harness)

    expect(
      harness.service.updateRun(run.id, { config: { maxParallel: 7 } }).config.maxParallel
    ).toBe(7)

    expect(harness.db.listDocumentRunEvents(run.id)).toEqual([])
  })

  it('treats the status it already has as nothing to do', () => {
    const { run } = seedRun(harness, { run: { status: 'paused' } })

    expect(harness.service.updateRun(run.id, { status: 'paused' }).status).toBe('paused')

    expect(harness.published).toEqual([])
    expect(harness.db.listDocumentRunEvents(run.id)).toEqual([])
  })

  it.each<DocumentRunStatus>([
    'extracting',
    'extract_failed',
    'preview',
    'completed',
    'completed_with_issues',
    'cancelled'
  ])('refuses to pause or resume a run that is %s', (status) => {
    const { run } = seedRun(harness, { run: { status } })

    for (const target of ['paused', 'running'] as const) {
      expect(() => harness.service.updateRun(run.id, { status: target })).toThrow(
        'Only a launched run can be paused or resumed'
      )
    }
    expect(harness.db.getDocumentRun(run.id)?.status).toBe(status)
  })

  it('reports an unknown run', () => {
    expect(() => harness.service.updateRun('missing', { title: 'x' })).toThrow(
      'The run was not found.'
    )
  })
})

describe('updateItem', () => {
  it('edits a ticket while the run is in preview', () => {
    const { run, items } = seedRun(harness, { items: [{}, {}, {}] })

    const updated = harness.service.updateItem(run.id, items[1].id, {
      title: ' Ramp-up "rule"\n<v2> ',
      summary: 'New summary',
      description: 'New description',
      selected: false,
      launch_config: launchConfig,
      // Itself, an unknown key and a duplicate are dropped.
      depends_on: ['A1', 'A2', 'Z9', 'A1', 'A3']
    })

    expect(updated).toMatchObject({
      title: 'Ramp-up rule v2',
      summary: 'New summary',
      description: 'New description',
      selected: false,
      launch_config: launchConfig,
      depends_on: ['A1', 'A3']
    })
    expect(harness.published).toEqual([
      { runId: run.id, projectId: TEST_PROJECT_ID, reason: 'item', itemId: items[1].id }
    ])
    // Nothing about its status changed, so nothing is logged.
    expect(harness.db.listDocumentRunEvents(run.id)).toEqual([])
  })

  it('refuses an empty title', () => {
    const { run, items } = seedRun(harness, { items: [{}] })

    expect(() => harness.service.updateItem(run.id, items[0].id, { title: ' <> ' })).toThrow(
      'A ticket needs a title.'
    )
  })

  it('stores the verification choice in canonical order, without duplicates or unknown methods', () => {
    const { run, items } = seedRun(harness, { items: [{ verification: ['tests'] }] })

    const updated = harness.service.updateItem(run.id, items[0].id, {
      verification: ['tests', 'tcu', 'tests', 'bogus' as never]
    })

    expect(updated.verification).toEqual(['tcu', 'tests'])
    // What extraction proposed is never edited.
    expect(updated.verification_suggested).toEqual(['tests'])
    expect(harness.db.getDocumentRunItem(items[0].id)?.verification).toEqual(['tcu', 'tests'])
    expect(
      harness.service.updateItem(run.id, items[0].id, { verification: [] }).verification
    ).toEqual([])
  })

  it('changes the verification of a launched run only for tickets that still wait their turn', () => {
    const { run, items } = seedRun(harness, {
      run: { status: 'running' },
      items: [
        { verification: ['tests'] },
        { status: 'running', verification: ['tests'] },
        { status: 'merged', verification: ['tests'] }
      ]
    })

    expect(
      harness.service.updateItem(run.id, items[0].id, { verification: ['playwright'] }).verification
    ).toEqual(['playwright'])
    expect(() =>
      harness.service.updateItem(run.id, items[1].id, { verification: ['playwright'] })
    ).toThrow('A2 has launched; its verification can no longer be changed.')
    expect(() => harness.service.updateItem(run.id, items[2].id, { verification: [] })).toThrow(
      'A3 has launched; its verification can no longer be changed.'
    )
    expect(harness.db.getDocumentRunItem(items[1].id)?.verification).toEqual(['tests'])
    expect(harness.db.getDocumentRunItem(items[2].id)?.verification).toEqual(['tests'])
  })

  it('refuses a verification change while the tickets are still being extracted', () => {
    const { run, items } = seedRun(harness, { run: { status: 'extracting' }, items: [{}] })

    expect(() =>
      harness.service.updateItem(run.id, items[0].id, { verification: ['tests'] })
    ).toThrow('Tickets can only be edited while the run is in preview.')
    expect(harness.db.getDocumentRunItem(items[0].id)?.verification).toEqual([])
  })

  it.each<DocumentRunStatus>(['extracting', 'running', 'paused', 'completed', 'cancelled'])(
    'refuses content edits once the run is %s',
    (status) => {
      const { run, items } = seedRun(harness, { run: { status }, items: [{}] })

      for (const patch of [
        { title: 'x' },
        { summary: 'x' },
        { description: 'x' },
        { depends_on: [] },
        { selected: false },
        { launch_config: null }
      ]) {
        expect(() => harness.service.updateItem(run.id, items[0].id, patch)).toThrow(
          'Tickets can only be edited while the run is in preview.'
        )
      }
      expect(harness.db.getDocumentRunItem(items[0].id)).toMatchObject({
        title: 'Task 1',
        selected: true
      })
    }
  )

  it.each<DocumentRunStatus>(['extracting', 'extract_failed', 'preview'])(
    'refuses orchestration fields while the run is %s',
    (status) => {
      const { run, items } = seedRun(harness, { run: { status }, items: [{}] })

      expect(() => harness.service.updateItem(run.id, items[0].id, { status: 'running' })).toThrow(
        'This run has not been launched yet.'
      )
      expect(() => harness.service.updateItem(run.id, items[0].id, { session_id: 's1' })).toThrow(
        'This run has not been launched yet.'
      )
    }
  )

  it('stores orchestration fields after launch and logs every status change', () => {
    const { run, items } = seedRun(harness, { run: { status: 'running' }, items: [{}] })
    const [item] = items

    const launched = harness.service.updateItem(run.id, item.id, {
      status: 'running',
      ticket_id: 'ticket-1',
      worktree_id: 'wt-1',
      session_id: 'session-1',
      branch_name: 'a1-task-1',
      started_at: '2026-10-05T10:00:00.000Z',
      last_prompt_at: '2026-10-05T10:00:01.000Z'
    })
    expect(launched).toMatchObject({
      status: 'running',
      ticket_id: 'ticket-1',
      worktree_id: 'wt-1',
      session_id: 'session-1',
      branch_name: 'a1-task-1',
      started_at: '2026-10-05T10:00:00.000Z'
    })

    // Bookkeeping without a status change is not an event.
    harness.service.updateItem(run.id, item.id, {
      verdict,
      nudge_count: 1,
      conflict_attempts: 2,
      fix_attempts: 1,
      continue_attempts: 3,
      last_checked_at: '2026-10-05T10:05:00.000Z',
      retry_at: null
    })
    harness.service.updateItem(run.id, item.id, { status: 'running' })
    const waiting = harness.service.updateItem(run.id, item.id, {
      status: 'needs_input',
      status_detail: 'Which locale should be the default?'
    })
    expect(waiting).toMatchObject({
      status: 'needs_input',
      status_detail: 'Which locale should be the default?',
      verdict,
      nudge_count: 1,
      conflict_attempts: 2,
      fix_attempts: 1,
      continue_attempts: 3
    })
    harness.service.updateItem(run.id, item.id, { status: 'merged', status_detail: null })

    expect(harness.db.listDocumentRunEvents(run.id)).toMatchObject([
      {
        type: 'running',
        item_id: item.id,
        message: 'A1 → running',
        data: { from: 'pending', to: 'running' }
      },
      {
        type: 'needs_input',
        item_id: item.id,
        message: 'A1 → needs input: Which locale should be the default?'
      },
      { type: 'merged', item_id: item.id, message: 'A1 → merged' }
    ])
    expect(harness.db.getDocumentRunItem(item.id)?.status_detail).toBeNull()
  })

  it('still accepts orchestration fields after the run finished', () => {
    const { run, items } = seedRun(harness, {
      run: { status: 'completed_with_issues' },
      items: [{ status: 'needs_attention' }]
    })

    expect(harness.service.updateItem(run.id, items[0].id, { status: 'skipped' }).status).toBe(
      'skipped'
    )
  })

  it('returns the item untouched for an empty patch', () => {
    const { run, items } = seedRun(harness, { items: [{}] })

    expect(harness.service.updateItem(run.id, items[0].id, {})).toEqual(items[0])
    expect(harness.published).toEqual([])
  })

  it('refuses an item of another run', () => {
    const first = seedRun(harness, { items: [{}] })
    const second = seedRun(harness, { items: [{}] })

    expect(() =>
      harness.service.updateItem(first.run.id, second.items[0].id, { title: 'x' })
    ).toThrow('The ticket was not found.')
    expect(() => harness.service.updateItem(first.run.id, 'missing', { title: 'x' })).toThrow(
      'The ticket was not found.'
    )
  })
})

describe('claimRunner', () => {
  it('grants the lease to one client and reports when this server started', () => {
    const { run } = seedRun(harness, { run: { status: 'running' } })

    const first = harness.service.claimRunner(run.id, 'client-a')
    const second = harness.service.claimRunner(run.id, 'client-b')
    const renewed = harness.service.claimRunner(run.id, 'client-a')

    expect(first).toMatchObject({ owned: true, ownerClientId: 'client-a' })
    expect(second).toMatchObject({ owned: false, ownerClientId: 'client-a' })
    expect(renewed).toMatchObject({ owned: true, ownerClientId: 'client-a' })
    expect(new Date(first.serverStartedAt).toISOString()).toBe(first.serverStartedAt)
    expect(second.serverStartedAt).toBe(first.serverStartedAt)
    // A new owner is news; a renewal and a refused claim are not.
    expect(harness.published).toEqual([
      { runId: run.id, projectId: TEST_PROJECT_ID, reason: 'run' }
    ])
  })

  it("reports the app's own start time when it was stamped, not this child's", () => {
    const { run } = seedRun(harness, { run: { status: 'running' } })
    const ownStart = harness.service.claimRunner(run.id, 'client-a').serverStartedAt
    // The sessions live in the main process, which outlives a restart of this server child.
    harness.overrides.getAppStartedAt = () => '2026-10-05T08:00:00.000Z'

    expect(harness.service.claimRunner(run.id, 'client-a').serverStartedAt).toBe(
      '2026-10-05T08:00:00.000Z'
    )
    expect(ownStart).not.toBe('2026-10-05T08:00:00.000Z')
  })

  it("reads the app's start time from the environment the main process hands the server child", () => {
    // Per instance: several app instances share the database, not an environment.
    expect(appStartedAtFromEnv({ HIVE_APP_STARTED_AT: '2026-10-05T08:00:00.000Z' })).toBe(
      '2026-10-05T08:00:00.000Z'
    )
    expect(appStartedAtFromEnv({ HIVE_APP_STARTED_AT: ' 2026-10-05T08:00:00.000Z ' })).toBe(
      '2026-10-05T08:00:00.000Z'
    )
    // Missing or not a date: the stamped setting, then this child's own start, stand in.
    expect(appStartedAtFromEnv({})).toBeNull()
    expect(appStartedAtFromEnv({ HIVE_APP_STARTED_AT: '' })).toBeNull()
    expect(appStartedAtFromEnv({ HIVE_APP_STARTED_AT: 'at boot' })).toBeNull()
  })

  it('hands a lease over once its owner has been silent for 45 seconds', () => {
    let now = new Date('2026-10-05T10:00:00.000Z')
    harness.overrides.now = () => now
    const { run } = seedRun(harness, { run: { status: 'running' } })
    harness.service.claimRunner(run.id, 'client-a')

    now = new Date('2026-10-05T10:00:44.000Z')
    expect(harness.service.claimRunner(run.id, 'client-b').owned).toBe(false)

    now = new Date('2026-10-05T10:00:46.000Z')
    expect(harness.service.claimRunner(run.id, 'client-b')).toMatchObject({
      owned: true,
      ownerClientId: 'client-b'
    })
    expect(harness.db.getDocumentRun(run.id)?.runner_heartbeat_at).toBe('2026-10-05T10:00:46.000Z')
  })

  it('reports an unknown run', () => {
    expect(() => harness.service.claimRunner('missing', 'client-a')).toThrow(
      'The run was not found.'
    )
  })
})

describe('sessionTurn', () => {
  it('returns the recorded turn end of a session, or null', () => {
    harness.db.upsertSessionFinalMessage({
      session_id: 'session-1',
      text: 'Done.',
      completion: 'completed',
      api_error: null,
      hook_event: 'Stop'
    })

    expect(harness.service.sessionTurn('session-1')).toMatchObject({
      session_id: 'session-1',
      text: 'Done.',
      completion: 'completed',
      hook_event: 'Stop'
    })
    expect(harness.service.sessionTurn('session-2')).toBeNull()
  })
})

describe('logEvent', () => {
  it('appends to the audit log and publishes', () => {
    const { run, items } = seedRun(harness, { run: { status: 'running' }, items: [{}] })

    harness.service.logEvent({
      runId: run.id,
      itemId: items[0].id,
      type: 'launched',
      message: 'A1 launched',
      data: { sessionId: 'session-1' }
    })
    harness.service.logEvent({ runId: run.id, type: 'note', message: 'Waiting for a free slot' })

    expect(harness.db.listDocumentRunEvents(run.id)).toMatchObject([
      {
        type: 'launched',
        item_id: items[0].id,
        message: 'A1 launched',
        data: { sessionId: 'session-1' }
      },
      { type: 'note', item_id: null, message: 'Waiting for a free slot', data: null }
    ])
    expect(harness.published).toEqual([
      { runId: run.id, projectId: TEST_PROJECT_ID, reason: 'event', itemId: items[0].id },
      { runId: run.id, projectId: TEST_PROJECT_ID, reason: 'event' }
    ])
  })

  it('reports an unknown run instead of failing inside the database', () => {
    expect(() => harness.service.logEvent({ runId: 'missing', type: 'x', message: 'y' })).toThrow(
      'The run was not found.'
    )
  })
})

describe('cancel', () => {
  it('cancels the run and every selected ticket that is not finished', () => {
    const { run, items } = seedRun(harness, {
      run: { status: 'running' },
      items: [
        { status: 'merged' },
        { status: 'running' },
        { status: 'needs_attention' },
        { status: 'skipped' },
        { status: 'pending' },
        { status: 'pending', selected: false }
      ]
    })

    const detail = harness.service.cancel(run.id)

    expect(detail.run.status).toBe('cancelled')
    expect(detail.run.finished_at).toBeTruthy()
    expect(detail.items.map((item) => item.status)).toEqual([
      'merged',
      'cancelled',
      'cancelled',
      'skipped',
      'cancelled',
      'pending'
    ])
    expect(detail.items[1].finished_at).toBe(detail.run.finished_at)
    expect(detail.events.at(-1)).toMatchObject({ type: 'cancelled' })
    expect(detail.events.at(-1)?.message).toContain('3 unfinished tickets were stopped')
    // Three items, the run and the event.
    expect(harness.published.map((event) => event.reason)).toEqual([
      'item',
      'item',
      'item',
      'run',
      'event'
    ])
    expect(harness.published[0]).toEqual({
      runId: run.id,
      projectId: TEST_PROJECT_ID,
      reason: 'item',
      itemId: items[1].id
    })
  })

  it('is a no-op for a run that is already cancelled', () => {
    const { run } = seedRun(harness, { run: { status: 'cancelled' } })

    expect(harness.service.cancel(run.id).run.status).toBe('cancelled')
    expect(harness.published).toEqual([])
  })

  it.each<DocumentRunStatus>(['completed', 'completed_with_issues'])(
    'refuses a run that is %s',
    (status) => {
      const { run } = seedRun(harness, { run: { status } })

      expect(() => harness.service.cancel(run.id)).toThrow('This run has already finished.')
    }
  )
})

describe('delete', () => {
  it('removes the rows and the run directory, and publishes the deletion', async () => {
    const { run } = seedRun(harness, { run: { status: 'cancelled' }, items: [{}] })
    mkdirSync(join(run.run_dir, 'figures'), { recursive: true })
    writeFileSync(join(run.run_dir, 'document.md'), 'text')
    harness.db.appendDocumentRunEvent({ run_id: run.id, type: 'note', message: 'x' })

    await expect(harness.service.delete(run.id)).resolves.toBe(true)

    expect(harness.db.getDocumentRun(run.id)).toBeNull()
    expect(harness.db.getDocumentRunItems(run.id)).toEqual([])
    expect(harness.db.listDocumentRunEvents(run.id)).toEqual([])
    expect(existsSync(run.run_dir)).toBe(false)
    expect(existsSync(harness.runsRoot)).toBe(true)
    expect(harness.published).toEqual([
      { runId: run.id, projectId: TEST_PROJECT_ID, reason: 'deleted' }
    ])
    await expect(harness.service.delete(run.id)).resolves.toBe(false)
  })

  it('keeps the run directory when the run created board tickets, which attach its files', async () => {
    const { run } = seedRun(harness, {
      run: { status: 'completed_with_issues' },
      items: [{ ticket_id: 'ticket-1', status: 'merged' }, { status: 'needs_attention' }]
    })
    mkdirSync(join(run.run_dir, 'figures'), { recursive: true })
    writeFileSync(join(run.run_dir, 'document.md'), 'text')

    await expect(harness.service.delete(run.id)).resolves.toBe(true)

    expect(harness.db.getDocumentRun(run.id)).toBeNull()
    expect(harness.db.getDocumentRunItems(run.id)).toEqual([])
    expect(existsSync(join(run.run_dir, 'document.md'))).toBe(true)
    expect(harness.published).toEqual([
      { runId: run.id, projectId: TEST_PROJECT_ID, reason: 'deleted' }
    ])
  })

  it('removes the directory of a run with tickets when asked to: the project is going with them', async () => {
    const { run } = seedRun(harness, {
      run: { status: 'completed' },
      items: [{ ticket_id: 'ticket-1', status: 'merged' }]
    })
    mkdirSync(join(run.run_dir, 'figures'), { recursive: true })
    writeFileSync(join(run.run_dir, 'document.md'), 'text')

    await expect(harness.service.delete(run.id, { removeFiles: true })).resolves.toBe(true)

    expect(harness.db.getDocumentRun(run.id)).toBeNull()
    expect(existsSync(run.run_dir)).toBe(false)
    expect(harness.published).toEqual([
      { runId: run.id, projectId: TEST_PROJECT_ID, reason: 'deleted' }
    ])
  })

  it.each<DocumentRunStatus>(['running', 'paused'])('refuses a run that is %s', async (status) => {
    const { run } = seedRun(harness, { run: { status } })

    await expect(harness.service.delete(run.id)).rejects.toThrow(
      'Cancel the run before deleting it.'
    )
    expect(harness.db.getDocumentRun(run.id)).not.toBeNull()
  })

  it('deletes a run whose tickets are still being extracted', async () => {
    const { run } = seedRun(harness, { run: { status: 'extracting' } })

    await expect(harness.service.delete(run.id)).resolves.toBe(true)
    expect(harness.db.getDocumentRun(run.id)).toBeNull()
  })

  it('never deletes a directory outside the runs root', async () => {
    const precious = join(harness.scratch, 'precious')
    mkdirSync(precious)
    writeFileSync(join(precious, 'keep.txt'), 'keep')
    const { run } = seedRun(harness, { run: { status: 'preview' } })
    harness.db.runs.get(run.id)!.run_dir = precious

    await expect(harness.service.delete(run.id)).resolves.toBe(true)

    expect(existsSync(join(precious, 'keep.txt'))).toBe(true)
    expect(harness.db.getDocumentRun(run.id)).toBeNull()
  })

  it('lets a run whose extraction was lost to a restart be deleted', async () => {
    const { run } = seedRun(harness, { run: { status: 'extracting' } })
    harness.db.runs.get(run.id)!.updated_at = new Date(Date.now() - 60_000).toISOString()

    await expect(harness.service.delete(run.id)).resolves.toBe(true)
  })
})

describe('suggestVerifyCommand', () => {
  const projectPath = (): string => harness.projects.get(TEST_PROJECT_ID)!.path

  function project(scripts: Record<string, string> | null, lockfile?: string): void {
    mkdirSync(projectPath(), { recursive: true })
    if (scripts) {
      writeFileSync(join(projectPath(), 'package.json'), JSON.stringify({ name: 'p', scripts }))
    }
    if (lockfile) writeFileSync(join(projectPath(), lockfile), '')
  }

  it.each([
    [
      { typecheck: 'tsc --noEmit', lint: 'eslint .' },
      'pnpm-lock.yaml',
      'pnpm install && pnpm run typecheck && pnpm run lint'
    ],
    [
      { 'type-check': 'tsc', lint: 'eslint .' },
      'yarn.lock',
      'yarn install && yarn run type-check && yarn run lint'
    ],
    [{ tsc: 'tsc', test: 'vitest' }, 'bun.lockb', 'bun install && bun run tsc'],
    [{ lint: 'eslint .' }, 'bun.lock', 'bun install && bun run lint'],
    [
      { tsc: 'tsc', typecheck: 'tsc --noEmit', 'type-check': 'tsc' },
      undefined,
      'npm install && npm run typecheck'
    ]
  ])('suggests the checks %j defines (%s)', async (scripts, lockfile, expected) => {
    project(scripts, lockfile)

    await expect(harness.service.suggestVerifyCommand(TEST_PROJECT_ID)).resolves.toBe(expected)
  })

  it('prefers pnpm when several lockfiles are present', async () => {
    project({ lint: 'eslint .' }, 'yarn.lock')
    writeFileSync(join(projectPath(), 'pnpm-lock.yaml'), '')

    await expect(harness.service.suggestVerifyCommand(TEST_PROJECT_ID)).resolves.toBe(
      'pnpm install && pnpm run lint'
    )
  })

  it('suggests nothing without a package.json, without checks, or for an unknown project', async () => {
    await expect(harness.service.suggestVerifyCommand(TEST_PROJECT_ID)).resolves.toBeNull()

    project({ build: 'vite build', test: 'vitest' }, 'pnpm-lock.yaml')
    await expect(harness.service.suggestVerifyCommand(TEST_PROJECT_ID)).resolves.toBeNull()

    writeFileSync(join(projectPath(), 'package.json'), '{ not json')
    await expect(harness.service.suggestVerifyCommand(TEST_PROJECT_ID)).resolves.toBeNull()

    writeFileSync(join(projectPath(), 'package.json'), JSON.stringify({ scripts: ['lint'] }))
    await expect(harness.service.suggestVerifyCommand(TEST_PROJECT_ID)).resolves.toBeNull()

    await expect(harness.service.suggestVerifyCommand('unknown')).resolves.toBeNull()
  })
})
