import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCUMENT_UPDATE_INTERRUPT_DETAIL } from '@shared/document-flow/planning'
import {
  buildDocumentUpdateContinuePrompt,
  buildDocumentUpdateNudgePrompt,
  buildDocumentUpdatePrompt
} from '@shared/document-flow/prompts'
import type { DocumentRunItem, SessionFinalMessage } from '@shared/types/document-flow'
import {
  DocumentFlowRunner,
  NO_SESSION_DOCUMENT_DETAIL,
  SETTLE_MS,
  isDocumentRunBusy
} from './runner'
import {
  INTEGRATION_BRANCH,
  PROJECT_ID,
  RUN_ID,
  TEST_NOW,
  advance,
  createWorld,
  makeItem,
  makeRun,
  makeVerdict,
  type RunnerWorld
} from './runner-fakes'

// The post-merge step: a merged ticket's own session updates the document the run was made
// from, one session at a time, and the run is finalized only once that lane has drained.

const PROMPTED_AT = '2026-05-04T09:59:00.000Z'
const SOURCE = '/docs/checkout.html'
const RUN_COPY = '/tmp/document-runs/run-1/document.md'

const readyItem = (
  key: string,
  overrides: Partial<DocumentRunItem> = {}
): Partial<DocumentRunItem> => ({
  key,
  status: 'ready',
  session_id: `s-${key}`,
  worktree_id: `wt-${key}`,
  branch_name: `${key.toLowerCase()}-task`,
  started_at: PROMPTED_AT,
  last_prompt_at: PROMPTED_AT,
  ...overrides
})

/** A ticket merged before the runner started, waiting in the document edit lane. */
const queuedItem = (
  key: string,
  overrides: Partial<DocumentRunItem> = {}
): Partial<DocumentRunItem> => ({
  ...readyItem(key),
  status: 'merged',
  merge_sha: `merge-${key}`,
  finished_at: PROMPTED_AT,
  document_update_status: 'queued',
  document_update_queued_at: PROMPTED_AT,
  ...overrides
})

const footer = (notes: string): string =>
  [
    'I updated the document.',
    '',
    'DOCUMENT: UPDATED',
    'VERIFIED: tests: 12 passed',
    'FOLLOW-UPS: none',
    `NOTES: ${notes}`
  ].join('\n')

/** The server's record of a turn that ended now, with its final message. */
const recordedTurn = (sessionId: string, text: string): SessionFinalMessage => ({
  session_id: sessionId,
  state: 'ended',
  text,
  completion: 'completed',
  api_error: null,
  hook_event: 'Stop',
  detail: null,
  background_work: null,
  updated_at: new Date(Date.now()).toISOString()
})

const promptedSessions = (world: RunnerWorld): string[] =>
  world.followups.map((followup) => followup.sessionId)

describe('DocumentFlowRunner: updating the document', () => {
  let runner: DocumentFlowRunner | null = null

  const start = (world: RunnerWorld): void => {
    runner = new DocumentFlowRunner(world.ports)
    runner.start()
  }

  /** The agent edits the document and ends its turn; the end settles. */
  const editAndEnd = async (world: RunnerWorld, sessionId: string): Promise<void> => {
    world.editDocument()
    world.endTurn(sessionId)
    await advance(SETTLE_MS + 1000)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TEST_NOW))
  })

  afterEach(() => {
    runner?.stop()
    runner = null
    vi.useRealTimers()
  })

  describe('the document edit lane', () => {
    it('prompts one merged ticket at a time, with the source document, and finalizes once the lane drains', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B')] })
      world.putDocument()
      start(world)

      await advance(1000)

      expect(world.statuses()).toEqual({ A: 'merged', B: 'merged' })
      expect(world.documentUpdates()).toEqual({ A: 'updating', B: 'queued' })
      expect(promptedSessions(world)).toEqual(['s-A'])
      const prompt = world.followups[0].prompt
      expect(prompt).toBe(
        buildDocumentUpdatePrompt({
          key: 'A',
          title: 'Task A',
          sourcePath: SOURCE,
          documentCopyPath: RUN_COPY,
          format: 'html',
          encoding: 'utf-8',
          insideRepo: false,
          integrationBranch: INTEGRATION_BRANCH,
          branchName: 'a-task',
          mergeSha: 'merge-A',
          memberMerges: null,
          verdict: null,
          verification: [],
          verifyCommand: null,
          fixAttempts: 0,
          assetsDir: '/docs/checkout.assets',
          otherTasks: ['B'],
          today: '2026-05-04',
          interactive: true,
          alreadyImplemented: false
        })
      )
      expect(prompt).toContain(`The document: \`${SOURCE}\``)
      // The run's copy is named only as the file not to edit.
      expect(prompt.split(RUN_COPY)).toHaveLength(2)
      expect(prompt).toContain(`(\`${RUN_COPY}\`): do not edit that one`)
      expect(world.item('A')).toMatchObject({
        document_update_hash: 'sha-1',
        document_update_detail: null,
        last_prompt_at: expect.any(String),
        continue_attempts: 0
      })
      // The document was backed up for A before it was prompted.
      expect(world.api.inspectSource).toHaveBeenCalledWith(RUN_ID, 'A')
      expect(world.events.map((event) => event.type)).toContain('document_backed_up')

      // However long A's edit takes, B waits and the run is not finished.
      await advance(60_000)
      expect(promptedSessions(world)).toEqual(['s-A'])
      expect(world.api.finalize).not.toHaveBeenCalled()

      world.turns.set('s-A', recordedTurn('s-A', footer('Marked A done.')))
      await editAndEnd(world, 's-A')

      expect(world.item('A')).toMatchObject({
        status: 'merged',
        document_update_status: 'done',
        document_update_detail: 'Marked A done.',
        document_update_report: {
          outcome: 'updated',
          verified: 'tests: 12 passed',
          followUps: [],
          notes: 'Marked A done.'
        },
        document_update_finished_at: expect.any(String)
      })
      expect(promptedSessions(world)).toEqual(['s-A', 's-B'])
      expect(world.item('B').document_update_hash).toBe('sha-2')
      expect(world.api.finalize).not.toHaveBeenCalled()

      await editAndEnd(world, 's-B')

      expect(world.documentUpdates()).toEqual({ A: 'done', B: 'done' })
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
      expect(world.detail().run.status).toBe('completed')
    })

    it('reminds an agent that left the document unchanged once, then fails the update', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)
      expect(promptedSessions(world)).toEqual(['s-A'])

      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.followups[1]).toEqual({
        sessionId: 's-A',
        ticketId: 'ticket-A',
        prompt: buildDocumentUpdateNudgePrompt(SOURCE, false, true)
      })
      expect(world.item('A')).toMatchObject({
        document_update_status: 'updating',
        document_update_attempts: 1
      })
      expect(world.api.finalize).not.toHaveBeenCalled()

      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.followups).toHaveLength(2)
      expect(world.item('A')).toMatchObject({
        status: 'merged',
        document_update_status: 'failed',
        document_update_detail: 'The document was not changed.'
      })
      expect(world.notices).toContainEqual({
        level: 'warning',
        message: 'A could not update the document: The document was not changed.'
      })
      // A failed update is not a flagged ticket: the run finishes, and says what it left.
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
      await advance(1000)
      expect(world.notices).toContainEqual({
        level: 'warning',
        message:
          "Document run finished: 1 merged; 1 could not update the document (see the run's dashboard)"
      })
    })

    it("words a failed update with the agent's own notes", async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)
      expect(world.followups).toHaveLength(2)

      world.turns.set(
        's-A',
        recordedTurn(
          's-A',
          'DOCUMENT: FAILED\nVERIFIED: not verified\nFOLLOW-UPS: none\nNOTES: The file is locked by another editor.'
        )
      )
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.item('A')).toMatchObject({
        document_update_status: 'failed',
        document_update_detail: 'The file is locked by another editor.',
        document_update_report: { outcome: 'failed' }
      })
    })

    it('holds the lane for as long as the editing session waits on the user', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B')] })
      world.putDocument()
      start(world)
      await advance(1000)

      world.setSignal('s-A', { kind: 'blocked', reason: 'question', detail: 'Which section?' })
      await advance(2 * 60 * 60_000)

      expect(world.item('A')).toMatchObject({
        document_update_status: 'updating',
        document_update_detail: 'Waiting for you: Which section?'
      })
      expect(world.item('B').document_update_status).toBe('queued')
      expect(promptedSessions(world)).toEqual(['s-A'])
      expect(world.api.finalize).not.toHaveBeenCalled()
      // Said once, not on every tick.
      expect(world.notices.filter((notice) => notice.message.includes('Which section?'))).toEqual([
        {
          level: 'info',
          message:
            'A is waiting for you while it updates the document: Waiting for you: Which section?'
        }
      ])

      // Answered: the wait is over, and the edit goes on to its end.
      world.setSignal('s-A', { kind: 'working' })
      await advance(1000)
      expect(world.item('A').document_update_detail).toBeNull()

      await editAndEnd(world, 's-A')
      expect(world.item('A').document_update_status).toBe('done')
      expect(promptedSessions(world)).toEqual(['s-A', 's-B'])
    })

    it('holds the lane after the user interrupted the edit, until they send it a message', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B')] })
      world.putDocument()
      start(world)
      await advance(1000)

      world.endTurn('s-A', { completion: 'none', reason: 'user_interrupt' })
      await advance(30 * 60_000)

      expect(world.item('A')).toMatchObject({
        document_update_status: 'updating',
        document_update_detail: DOCUMENT_UPDATE_INTERRUPT_DETAIL
      })
      expect(promptedSessions(world)).toEqual(['s-A'])
      expect(world.api.finalize).not.toHaveBeenCalled()

      world.setSignal('s-A', { kind: 'working' })
      await advance(1000)
      expect(world.item('A').document_update_detail).toBeNull()

      await editAndEnd(world, 's-A')
      expect(world.item('A').document_update_status).toBe('done')
      expect(promptedSessions(world)).toEqual(['s-A', 's-B'])
    })

    it('resumes an edit that ended on an API error with the document continue prompt', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)

      world.endTurn('s-A', { apiError: 'overloaded' })
      await advance(SETTLE_MS + 1000)
      expect(world.item('A')).toMatchObject({
        document_update_status: 'updating',
        retry_at: expect.any(String)
      })
      expect(world.item('A').document_update_detail).toMatch(/^API error \(overloaded\)/)

      await advance(2 * 60_000)

      expect(world.followups[1]).toEqual({
        sessionId: 's-A',
        ticketId: 'ticket-A',
        prompt: buildDocumentUpdateContinuePrompt('api_error', true)
      })
      expect(world.item('A')).toMatchObject({
        continue_attempts: 1,
        document_update_attempts: 1,
        retry_at: null,
        document_update_detail: null
      })

      // The continue does not use up the "unchanged" reminder.
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)
      expect(world.followups[2].prompt).toBe(buildDocumentUpdateNudgePrompt(SOURCE, false, true))
    })

    it('fails the update, not the ticket, when the prompt cannot be sent', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      world.ports.sendFollowup.mockRejectedValueOnce(new Error('The worktree is archived'))
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'merged',
        document_update_status: 'failed',
        document_update_detail: 'Could not send a message to the session: The worktree is archived'
      })
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
    })

    it('fails the update, not the ticket, when the step itself throws', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.api.inspectSource.mockRejectedValueOnce(new Error('EIO: i/o error'))
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'merged',
        status_detail: null,
        document_update_status: 'failed',
        document_update_detail: 'EIO: i/o error'
      })
    })

    it('skips the update when the document is gone, and the run finishes', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'merged',
        document_update_status: 'skipped',
        document_update_detail: `Document not found: ${SOURCE}`
      })
      expect(world.followups).toHaveLength(0)
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
    })

    it('skips a read-only document', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument({ writable: false })
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        document_update_status: 'skipped',
        document_update_detail: 'The document is read-only.'
      })
      expect(world.followups).toHaveLength(0)
    })

    it('skips a merged ticket that has no session', async () => {
      const world = createWorld({ items: [readyItem('A', { session_id: null })] })
      world.putDocument()
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'merged',
        document_update_status: 'skipped',
        document_update_detail: NO_SESSION_DOCUMENT_DETAIL
      })
      expect(world.api.inspectSource).not.toHaveBeenCalled()
    })

    it('lets the user skip the update mid-edit: the next ticket goes once that turn is over, and its end changes nothing', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B')] })
      world.putDocument()
      start(world)
      await advance(1000)
      expect(promptedSessions(world)).toEqual(['s-A'])

      world.setItem('A', {
        document_update_status: 'skipped',
        document_update_detail: 'Skipped by you.'
      })
      // A's session is still at its edit: B's would write the same file at the same time.
      await advance(30_000)
      expect(promptedSessions(world)).toEqual(['s-A'])

      world.editDocument()
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)
      expect(promptedSessions(world)).toEqual(['s-A', 's-B'])
      expect(world.item('A')).toMatchObject({
        document_update_status: 'skipped',
        document_update_detail: 'Skipped by you.'
      })
    })

    it('does not finalize the run while an update skipped mid-edit is still writing the document', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)

      world.setItem('A', {
        document_update_status: 'skipped',
        document_update_detail: 'Skipped by you.'
      })
      await advance(30_000)
      expect(world.api.finalize).not.toHaveBeenCalled()

      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
    })

    it('never prompts the next ticket off a re-read older than the write that started an edit', async () => {
      const world = createWorld({ items: [queuedItem('A'), queuedItem('B')] })
      world.putDocument()
      start(world)
      await advance(1000)
      expect(promptedSessions(world)).toEqual(['s-A'])

      // A refresh that left the server before A's update started lands after it.
      world.setItem('A', { document_update_status: 'queued' })
      await advance(1000)
      expect(promptedSessions(world)).toEqual(['s-A'])
    })

    it('passes over a queued ticket whose session waits on the user, and says what it waits for', async () => {
      const world = createWorld({ items: [queuedItem('A'), queuedItem('B')] })
      world.putDocument()
      world.setSignal('s-A', { kind: 'blocked', reason: 'permission', detail: 'Allow Bash?' })
      start(world)

      await advance(1000)

      expect(promptedSessions(world)).toEqual(['s-B'])
      expect(world.item('A')).toMatchObject({
        document_update_status: 'queued',
        document_update_detail: 'Waiting for you: Allow Bash?'
      })

      // Once B is done and A's session is still blocked, the run waits on the user.
      await editAndEnd(world, 's-B')
      expect(promptedSessions(world)).toEqual(['s-B'])
      expect(isDocumentRunBusy(world.detail())).toBe(false)
      expect(world.api.finalize).not.toHaveBeenCalled()

      // Answered: A's session works, then ends its turn, and A gets its turn.
      world.setSignal('s-A', { kind: 'working' })
      await advance(1000)
      expect(world.item('A').document_update_detail).toBeNull()
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)
      expect(promptedSessions(world)).toEqual(['s-B', 's-A'])
    })

    it('says that it does not update a document in another encoding than UTF-8', async () => {
      const world = createWorld({ items: [queuedItem('A')] })
      world.putDocument({ encoding: 'windows-1252' })
      start(world)

      await advance(1000)

      expect(world.followups).toHaveLength(0)
      expect(world.item('A')).toMatchObject({
        document_update_status: 'skipped',
        document_update_detail:
          'The document is encoded as windows-1252; only UTF-8 documents are updated.'
      })
    })

    it('accepts an agent that found the document already up to date, without a reminder', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)

      world.turns.set(
        's-A',
        recordedTurn(
          's-A',
          [
            'DOCUMENT: UNCHANGED',
            'VERIFIED: not verified',
            'FOLLOW-UPS: none',
            'NOTES: A was already marked done by the last run.'
          ].join('\n')
        )
      )
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.followups).toHaveLength(1)
      expect(world.item('A')).toMatchObject({
        document_update_status: 'skipped',
        document_update_detail: 'A was already marked done by the last run.'
      })
    })

    it("lets a skip made while the turn end is being judged stand over the step's result", async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)

      // The look at the file after the turn is slow; the user skips meanwhile.
      const inspect = world.api.inspectSource.getMockImplementation()
      let release: () => void = () => {}
      world.api.inspectSource.mockImplementationOnce(async (runId, backupKey) => {
        await new Promise<void>((done) => {
          release = done
        })
        return inspect ? inspect(runId, backupKey) : Promise.reject(new Error('no fake'))
      })
      await editAndEnd(world, 's-A')
      expect(world.item('A').document_update_status).toBe('updating')

      world.setItem('A', {
        document_update_status: 'skipped',
        document_update_detail: 'Skipped by you.'
      })
      release()
      await advance(1000)

      expect(world.item('A')).toMatchObject({
        document_update_status: 'skipped',
        document_update_detail: 'Skipped by you.'
      })
    })

    it('waits for a session that is still working before it prompts it', async () => {
      const world = createWorld({ items: [queuedItem('A')] })
      world.putDocument()
      world.setSignal('s-A', { kind: 'working' })
      start(world)

      await advance(30_000)
      expect(world.followups).toHaveLength(0)
      expect(world.item('A').document_update_status).toBe('queued')
      expect(world.api.inspectSource).not.toHaveBeenCalled()

      world.endTurn('s-A')
      await advance(11_000)
      expect(promptedSessions(world)).toEqual(['s-A'])
    })

    it('moves the ticket back to merged after the edit pulled it out of that column', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)
      expect(world.tickets.get('ticket-A')?.column).toBe('merged')
      world.ports.moveTicket.mockClear()

      // The prompt read as the user's: the board reopened the ticket.
      const ticket = world.tickets.get('ticket-A')
      if (ticket) world.tickets.set('ticket-A', { ...ticket, column: 'review' })
      await editAndEnd(world, 's-A')

      expect(world.ports.moveTicket).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 'merged', {
        skipCompletionEffects: true,
        keepSession: true
      })
      expect(world.tickets.get('ticket-A')?.column).toBe('merged')
    })

    it('leaves a ticket the user moved to done where it is', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)
      world.ports.moveTicket.mockClear()

      const ticket = world.tickets.get('ticket-A')
      if (ticket) world.tickets.set('ticket-A', { ...ticket, column: 'done' })
      await editAndEnd(world, 's-A')

      expect(world.item('A').document_update_status).toBe('done')
      expect(world.ports.moveTicket).not.toHaveBeenCalled()
      expect(world.tickets.get('ticket-A')?.column).toBe('done')
    })

    it('leaves a ticket that stayed in merged where it is', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)
      world.ports.moveTicket.mockClear()

      await editAndEnd(world, 's-A')

      expect(world.item('A').document_update_status).toBe('done')
      expect(world.ports.moveTicket).not.toHaveBeenCalled()
    })
  })

  // The run's own move to merged skips the board's completion effects (the session is still
  // to update the document), so the run closes the session itself once that update is over —
  // as a plain move to Merged closes any ticket's session.
  describe("the merged ticket's session once its update is over", () => {
    it('closes the session once the document update is done', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)
      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()

      await editAndEnd(world, 's-A')

      expect(world.item('A').document_update_status).toBe('done')
      expect(world.ports.closeTicketSession).toHaveBeenCalledTimes(1)
      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 's-A')
      // The run finished right after: its end sweep does not close the session a second time.
      await advance(30_000)
      expect(world.ports.closeTicketSession).toHaveBeenCalledTimes(1)
    })

    it('closes the session once a nudged update failed', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)
      expect(world.item('A').document_update_status).toBe('updating')
      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()

      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.item('A').document_update_status).toBe('failed')
      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 's-A')
    })

    it('closes the session of a merged ticket whose update was skipped over a read-only document', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument({ writable: false })
      start(world)

      await advance(1000)

      expect(world.item('A').document_update_status).toBe('skipped')
      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 's-A')
    })

    it('has nothing to close for a merged ticket without a session', async () => {
      const world = createWorld({ items: [readyItem('A', { session_id: null })] })
      world.putDocument()
      start(world)

      await advance(30_000)

      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()
    })

    it('closes the session where the user moved the ticket on to done meanwhile', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)

      const ticket = world.tickets.get('ticket-A')
      if (ticket) world.tickets.set('ticket-A', { ...ticket, column: 'done' })
      await editAndEnd(world, 's-A')

      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 's-A')
    })

    it('closes the session after putting a ticket the edit pulled out of merged back there', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)

      const ticket = world.tickets.get('ticket-A')
      if (ticket) world.tickets.set('ticket-A', { ...ticket, column: 'review' })
      await editAndEnd(world, 's-A')

      expect(world.tickets.get('ticket-A')?.column).toBe('merged')
      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 's-A')
    })

    it('puts a ticket the edit pulled out of merged back there before closing, when the document was already up to date', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)
      world.ports.moveTicket.mockClear()

      const ticket = world.tickets.get('ticket-A')
      if (ticket) world.tickets.set('ticket-A', { ...ticket, column: 'review' })
      world.turns.set(
        's-A',
        recordedTurn('s-A', ['DOCUMENT: UNCHANGED', 'NOTES: already marked'].join('\n'))
      )
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.item('A').document_update_status).toBe('skipped')
      expect(world.ports.moveTicket).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 'merged', {
        skipCompletionEffects: true,
        keepSession: true
      })
      expect(world.tickets.get('ticket-A')?.column).toBe('merged')
      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 's-A')
    })

    it('closes the session of an update the user skipped mid-edit once its turn is over', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B')] })
      world.putDocument()
      start(world)
      await advance(1000)
      expect(world.documentUpdates()).toEqual({ A: 'updating', B: 'queued' })

      // The dashboard's Skip: the row leaves the lane while the session is still at the edit.
      world.setItem('A', {
        document_update_status: 'skipped',
        document_update_detail: 'Skipped by you.',
        document_update_finished_at: new Date(Date.now()).toISOString()
      })
      await advance(5000)
      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()

      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 's-A')
      expect(
        world.ports.closeTicketSession.mock.calls.filter((call) => call[1] === 'ticket-A')
      ).toHaveLength(1)
    })

    it('leaves the session of a ticket the user took back to todo', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)

      const ticket = world.tickets.get('ticket-A')
      if (ticket) world.tickets.set('ticket-A', { ...ticket, column: 'todo' })
      await editAndEnd(world, 's-A')

      expect(world.item('A').document_update_status).toBe('done')
      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()
    })

    it('closes the sessions of the merged tickets still in the lane when the run is cancelled, once', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B')] })
      world.putDocument()
      start(world)
      await advance(1000)
      expect(world.documentUpdates()).toEqual({ A: 'updating', B: 'queued' })
      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()

      // The server's cancel: the run ends, and every update still in the lane is skipped
      // there, past the runner's own finish step.
      const cancelled = 'The run was cancelled before this task updated the document.'
      const finishedAt = new Date(Date.now()).toISOString()
      for (const key of ['A', 'B']) {
        world.setItem(key, {
          document_update_status: 'skipped',
          document_update_detail: cancelled,
          document_update_finished_at: finishedAt
        })
      }
      world.setRun({ status: 'cancelled' })
      await advance(1000)

      // B never got its prompt: closed now. A is still at its edit: left alone for now.
      expect(world.ports.closeTicketSession).toHaveBeenCalledTimes(1)
      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-B', 's-B')

      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.ports.closeTicketSession).toHaveBeenCalledTimes(2)
      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 's-A')

      await advance(30_000)
      expect(world.ports.closeTicketSession).toHaveBeenCalledTimes(2)
    })

    it('sweeps a run it saw paused (across an app restart) once it is cancelled, loading its board first', async () => {
      const world = createWorld({
        run: { status: 'paused' },
        items: [queuedItem('A'), queuedItem('B')]
      })
      for (const id of ['ticket-A', 'ticket-B']) {
        const ticket = world.tickets.get(id)
        if (ticket) world.tickets.set(id, { ...ticket, column: 'merged' })
      }
      start(world)
      await advance(1000)
      expect(world.ports.loadProject).not.toHaveBeenCalled()
      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()

      const cancelled = 'The run was cancelled before this task updated the document.'
      const finishedAt = new Date(Date.now()).toISOString()
      for (const key of ['A', 'B']) {
        world.setItem(key, {
          document_update_status: 'skipped',
          document_update_detail: cancelled,
          document_update_finished_at: finishedAt
        })
      }
      world.setRun({ status: 'cancelled' })
      await advance(1000)

      expect(world.ports.loadProject).toHaveBeenCalledWith(PROJECT_ID)
      expect(world.ports.closeTicketSession).toHaveBeenCalledTimes(2)
      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 's-A')
      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-B', 's-B')
    })

    it('closes the session of an edit stopped for the user when the run was cancelled, once the user is done with it', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.putDocument()
      start(world)
      await advance(1000)
      expect(world.documentUpdates()).toEqual({ A: 'updating' })
      world.setSignal('s-A', { kind: 'blocked', reason: 'permission', detail: 'Allow Bash?' })
      await advance(1000)

      world.setItem('A', {
        document_update_status: 'skipped',
        document_update_detail: 'The run was cancelled before this task updated the document.',
        document_update_finished_at: new Date(Date.now()).toISOString()
      })
      world.setRun({ status: 'cancelled' })
      await advance(1000)
      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()

      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.ports.closeTicketSession).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 's-A')
    })

    it('leaves alone an update that ended before this runner started: a previous runner closed that session, and the user may have reopened it', async () => {
      const world = createWorld({
        items: [
          queuedItem('A', {
            document_update_status: 'done',
            document_update_finished_at: PROMPTED_AT
          })
        ]
      })
      const ticket = world.tickets.get('ticket-A')
      if (ticket) world.tickets.set('ticket-A', { ...ticket, column: 'merged' })
      world.putDocument()
      start(world)

      await advance(30_000)

      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()
    })

    it('does not sweep the sessions of a run it never drove', async () => {
      const world = createWorld({
        run: { status: 'cancelled' },
        items: [queuedItem('A', { document_update_status: 'skipped' })]
      })
      start(world)

      await advance(30_000)

      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()
    })
  })

  describe('already implemented tickets', () => {
    it('queues a ticket an unattended run closed for having nothing to merge, and says so in the prompt', async () => {
      const world = createWorld({
        items: [readyItem('A', { verdict: makeVerdict() })],
        config: { interactive: false }
      })
      world.putDocument({ format: 'markdown' })
      world.api.prepareMerge.mockResolvedValue({
        state: 'no_changes',
        conflictedFiles: [],
        committed: false,
        commitsAhead: 0
      })
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'skipped',
        document_update_status: 'updating'
      })
      expect(promptedSessions(world)).toEqual(['s-A'])
      const prompt = world.followups[0].prompt
      expect(prompt).toContain(
        'your branch had nothing new to merge: the task was already implemented'
      )
      expect(prompt).toContain('Do not ask me anything')
      expect(prompt).toContain('This is a Markdown file')
      expect(world.api.finalize).not.toHaveBeenCalled()

      await editAndEnd(world, 's-A')
      expect(world.item('A').document_update_status).toBe('done')
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
    })

    it('does not update the document for a ticket the user skipped', async () => {
      const world = createWorld({ items: [readyItem('A'), { key: 'B', status: 'skipped' }] })
      world.putDocument()
      start(world)

      await advance(1000)

      expect(world.item('B').document_update_status).toBeNull()
      expect(promptedSessions(world)).toEqual(['s-A'])
    })
  })

  describe('pauses, restarts and other runs', () => {
    it('starts no document update while the run is paused', async () => {
      const world = createWorld({ items: [queuedItem('A')], run: { status: 'paused' } })
      world.putDocument()
      start(world)

      await advance(30_000)
      expect(world.followups).toHaveLength(0)
      expect(world.api.inspectSource).not.toHaveBeenCalled()

      world.setRun({ status: 'running' })
      await advance(1000)
      expect(promptedSessions(world)).toEqual(['s-A'])
    })

    it('keeps watching an update that was under way when a new runner took over, without prompting again', async () => {
      const world = createWorld({
        items: [
          queuedItem('A', {
            document_update_status: 'updating',
            document_update_hash: 'sha-1',
            last_prompt_at: PROMPTED_AT
          }),
          queuedItem('B')
        ]
      })
      world.putDocument()
      world.setSignal('s-A', { kind: 'working' })
      start(world)

      await advance(30_000)
      expect(world.followups).toHaveLength(0)
      expect(world.item('B').document_update_status).toBe('queued')

      await editAndEnd(world, 's-A')
      expect(world.item('A').document_update_status).toBe('done')
      expect(promptedSessions(world)).toEqual(['s-B'])
    })

    it('resumes an edit that the app restart cut off', async () => {
      const world = createWorld({
        items: [
          queuedItem('A', {
            document_update_status: 'updating',
            document_update_hash: 'sha-1',
            // Prompted before the server (re)started, and no signal since.
            last_prompt_at: '2026-05-04T08:59:00.000Z'
          })
        ]
      })
      world.putDocument()
      start(world)

      await advance(1000)

      expect(world.followups).toEqual([
        {
          sessionId: 's-A',
          ticketId: 'ticket-A',
          prompt: buildDocumentUpdateContinuePrompt('interrupted', true)
        }
      ])
      expect(world.item('A')).toMatchObject({
        document_update_status: 'updating',
        continue_attempts: 1
      })
    })

    it('never has two runs made from the same document edit it at once', async () => {
      const world = createWorld({ items: [queuedItem('A')] })
      world.addRun('run-2', { items: [queuedItem('C')] })
      world.putDocument()
      start(world)

      await advance(1000)

      expect(world.followups).toHaveLength(1)
      const [first] = promptedSessions(world)
      const [firstRun, other] = first === 's-A' ? [RUN_ID, 's-C'] : ['run-2', 's-A']
      expect(world.item(first === 's-A' ? 'A' : 'C', firstRun).document_update_status).toBe(
        'updating'
      )

      await advance(60_000)
      expect(world.followups).toHaveLength(1)

      await editAndEnd(world, first)
      expect(promptedSessions(world)).toEqual([first, other])
    })

    it('waits for an edit another run has under way on the same document', async () => {
      const world = createWorld({ items: [queuedItem('A')] })
      world.addRun('run-2', {
        items: [
          queuedItem('C', {
            document_update_status: 'updating',
            document_update_hash: 'sha-1',
            last_prompt_at: PROMPTED_AT
          })
        ]
      })
      world.putDocument()
      world.setSignal('s-C', { kind: 'working' })
      start(world)

      await advance(30_000)
      expect(world.followups).toHaveLength(0)

      await editAndEnd(world, 's-C')
      expect(world.item('C', 'run-2').document_update_status).toBe('done')
      expect(promptedSessions(world)).toEqual(['s-A'])
    })

    it('tells the queued update which ticket of another run edits the document', async () => {
      const world = createWorld({ items: [queuedItem('A')] })
      world.addRun('run-2', {
        run: { status: 'paused' },
        items: [
          queuedItem('C', {
            document_update_status: 'updating',
            document_update_hash: 'sha-1',
            last_prompt_at: PROMPTED_AT
          })
        ]
      })
      world.putDocument()
      start(world)

      await advance(1000)

      expect(world.followups).toHaveLength(0)
      expect(world.item('A').document_update_detail).toBe(
        'Waiting for another run made from this document: C is editing it.'
      )
    })

    it('holds the run status summary back while another run is editing the document', async () => {
      const world = createWorld({ items: [readyItem('A', { status: 'merged' })] })
      world.addRun('run-2', {
        items: [
          queuedItem('C', {
            document_update_status: 'updating',
            document_update_hash: 'sha-1',
            last_prompt_at: PROMPTED_AT
          })
        ]
      })
      world.putDocument()
      world.setSignal('s-C', { kind: 'working' })
      start(world)

      await advance(30_000)
      expect(world.api.finalize).not.toHaveBeenCalledWith(RUN_ID)

      await editAndEnd(world, 's-C')
      expect(world.api.finalize).toHaveBeenCalledWith(RUN_ID)
    })

    it('lets runs made from different documents edit them at the same time', async () => {
      const world = createWorld({ items: [queuedItem('A')] })
      world.addRun('run-2', {
        run: { source_path: '/docs/other.html' },
        items: [queuedItem('C')]
      })
      world.putDocument()
      world.putDocument({}, '/docs/other.html')
      start(world)

      await advance(1000)

      expect(promptedSessions(world).sort()).toEqual(['s-A', 's-C'])
    })
  })
})

describe('isDocumentRunBusy with document updates', () => {
  const detail = (items: Partial<DocumentRunItem>[]): Parameters<typeof isDocumentRunBusy>[0] => ({
    run: makeRun(),
    items: items.map((item, position) => makeItem({ position, ...item })),
    events: []
  })

  it('is busy while a merged ticket waits to update the document or updates it', () => {
    expect(
      isDocumentRunBusy(detail([{ key: 'A', status: 'merged', document_update_status: 'queued' }]))
    ).toBe(true)
    expect(
      isDocumentRunBusy(
        detail([{ key: 'A', status: 'merged', document_update_status: 'updating' }])
      )
    ).toBe(true)
  })

  it('is not busy once the lane has drained, or while the editing session waits on the user', () => {
    expect(
      isDocumentRunBusy(detail([{ key: 'A', status: 'merged', document_update_status: 'done' }]))
    ).toBe(false)
    expect(
      isDocumentRunBusy(
        detail([
          {
            key: 'A',
            status: 'merged',
            document_update_status: 'updating',
            document_update_detail: DOCUMENT_UPDATE_INTERRUPT_DETAIL
          },
          { key: 'B', status: 'merged', document_update_status: 'queued' }
        ])
      )
    ).toBe(false)
  })
})
