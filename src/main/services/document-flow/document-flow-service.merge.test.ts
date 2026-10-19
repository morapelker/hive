// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLASSIFICATION_JSON_SCHEMA,
  CLASSIFICATION_SYSTEM_PROMPT
} from '@shared/document-flow/classification'
import type { DocumentRunItem, DocumentRunVerdict } from '@shared/types/document-flow'
import type { DocumentRunItemRowPatch } from './db-port'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  createServiceHarness,
  createTestRepo,
  isolateGitConfig,
  seedRun,
  type ServiceHarness,
  type TestRepo
} from './test-support'

let restoreGitConfig: () => void
let repo: TestRepo
let harness: ServiceHarness
let integration: string
let runId: string

const DONE_MESSAGE = [
  'I added the rule and committed it.',
  '',
  'STATUS: DONE',
  'SUMMARY: Added the ramp-up rule.',
  'MIGRATIONS: db/migrations/002_ramp_up.sql',
  'MANUAL STEPS: Run the migration after deploy.',
  'ASSUMPTIONS: none',
  'QUESTIONS: none'
].join('\n')

const modelVerdict = (overrides: Partial<DocumentRunVerdict> = {}): string =>
  JSON.stringify({
    status: 'done',
    reason: 'The agent reports the work complete and committed.',
    question: null,
    summary: 'Added the ramp-up rule.',
    migrations: ['db/migrations/002_ramp_up.sql'],
    manualSteps: ['Run the migration after deploy.'],
    confidence: 'high',
    ...overrides
  })

beforeAll(() => {
  restoreGitConfig = isolateGitConfig()
})

afterAll(() => {
  restoreGitConfig()
})

/** A launched run on a real integration worktree, with four pending tickets. */
beforeEach(() => {
  repo = createTestRepo()
  harness = createServiceHarness({ repo })
  integration = repo.addWorktree('doc-factory', repo.baseSha)
  harness.worktrees.set('wt-integration', {
    id: 'wt-integration',
    path: integration,
    branch_name: 'doc-factory'
  })
  runId = seedRun(harness, {
    run: {
      status: 'running',
      base_branch: 'main',
      base_sha: repo.baseSha,
      integration_branch: 'doc-factory',
      integration_worktree_id: 'wt-integration',
      integration_worktree_path: integration,
      started_at: new Date().toISOString()
    },
    items: [
      { key: 'A1', title: 'Chinese "translation"' },
      { key: 'A2', title: 'Ramp-up rule', has_migration: true },
      { key: 'A3', title: 'Report', depends_on: ['A2'] },
      { key: 'A4', title: 'Not in this run', selected: false }
    ]
  }).run.id
})

afterEach(() => {
  harness.cleanup()
  repo.cleanup()
})

const itemByKey = (key: string): DocumentRunItem => {
  const item = harness.db.getDocumentRunItems(runId).find((candidate) => candidate.key === key)
  if (!item) throw new Error(`no item ${key}`)
  return item
}

/** Give a ticket a worktree cut from the integration branch, as the orchestrator does. */
function launchTicket(key: string, patch: DocumentRunItemRowPatch = {}): string {
  const branch = `${key.toLowerCase()}-task`
  const path = repo.addWorktree(branch, 'doc-factory')
  harness.worktrees.set(`wt-${key}`, { id: `wt-${key}`, path, branch_name: branch })
  harness.db.updateDocumentRunItem(itemByKey(key).id, {
    status: 'running',
    worktree_id: `wt-${key}`,
    branch_name: branch,
    session_id: `session-${key}`,
    ...patch
  })
  return path
}

const integrationHead = (): string => repo.git(integration, 'rev-parse', 'HEAD')
/** A linked worktree's `.git` is a file: MERGE_HEAD lives in the repository's own directory. */
const mergeInProgress = (cwd: string): boolean => {
  try {
    repo.git(cwd, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')
    return true
  } catch {
    return false
  }
}
const eventTypes = (): string[] =>
  harness.db.listDocumentRunEvents(runId).map((event) => event.type)

describe('classify', () => {
  const WAITING_MESSAGE =
    'The wait is armed; the merge commit is the only step left and it depends on those results.'
  const waitingVerdict = (): string =>
    modelVerdict({
      status: 'waiting',
      reason: 'It waits for the typecheck, the tests and the lint.'
    })
  const recordTurn = (background_work: number | null): void => {
    harness.db.upsertSessionFinalMessage({
      session_id: 'session-A2',
      text: WAITING_MESSAGE,
      completion: 'completed',
      api_error: null,
      hook_event: 'Stop',
      background_work
    })
  }

  it('keeps a wait for background work while the session reports some running', async () => {
    launchTicket('A2')
    recordTurn(4)
    harness.replies.push(waitingVerdict())

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A2').id,
      finalMessage: WAITING_MESSAGE
    })

    expect(verdict).toMatchObject({ status: 'waiting', question: null, source: 'model' })
    expect(harness.generateCalls[0].prompt).toContain('Background work: 4 background shell(s)')
    expect(itemByKey('A2').verdict?.status).toBe('waiting')
  })

  it('reads a wait as partial when nothing runs in the session that could wake it', async () => {
    launchTicket('A2')
    recordTurn(0)
    harness.replies.push(waitingVerdict())

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A2').id,
      finalMessage: WAITING_MESSAGE
    })

    expect(verdict).toMatchObject({ status: 'partial', source: 'model' })
    expect(verdict.reason).toBe(
      'It waits for the typecheck, the tests and the lint, but no background work of its session is running, so nothing will wake it.'
    )
    expect(harness.generateCalls[0].prompt).toContain('Background work: 0 background shell(s)')
  })

  it('takes the wait at its word when the session cannot report its background work', async () => {
    launchTicket('A2')
    recordTurn(null)
    harness.replies.push(waitingVerdict())

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A2').id,
      finalMessage: WAITING_MESSAGE
    })

    expect(verdict.status).toBe('waiting')
    expect(harness.generateCalls[0].prompt).not.toContain('Background work:')
  })

  it('judges the given final message with the generation model and stores the verdict', async () => {
    const path = launchTicket('A2')
    repo.commit(path, 'rule', { 'src/rule.ts': 'export const rule = 1\n' })
    repo.write(path, { 'scratch.txt': 'uncommitted\n' })
    harness.db.updateDocumentRun(runId, {
      config: {
        ...harness.db.getDocumentRun(runId)!.config,
        generation: { provider: 'codex', model: 'gpt-5.4-mini', effort: 'low' }
      }
    })
    harness.replies.push(modelVerdict())
    const before = harness.published.length

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A2').id,
      finalMessage: DONE_MESSAGE
    })

    expect(verdict).toMatchObject({
      status: 'done',
      summary: 'Added the ramp-up rule.',
      migrations: ['db/migrations/002_ramp_up.sql'],
      manualSteps: ['Run the migration after deploy.'],
      confidence: 'high',
      source: 'model'
    })
    expect(itemByKey('A2').verdict).toEqual(verdict)

    const [call] = harness.generateCalls
    expect(call.systemPrompt).toBe(CLASSIFICATION_SYSTEM_PROMPT)
    expect(call.provider).toBe('codex')
    expect(call.options).toEqual({
      modelOverride: 'gpt-5.4-mini',
      effort: 'low',
      outputSchema: CLASSIFICATION_JSON_SCHEMA,
      cwd: tmpdir(),
      timeoutMs: 90_000,
      maxRetries: 1
    })
    expect(call.prompt).toContain('Ticket: A2 — Ramp-up rule')
    expect(call.prompt).toContain(DONE_MESSAGE)
    // The git facts of the ticket worktree.
    expect(call.prompt).toContain('integration branch does not have: 1')
    expect(call.prompt).toContain('Uncommitted changes in the ticket worktree: yes')

    expect(harness.db.listDocumentRunEvents(runId).at(-1)).toMatchObject({
      type: 'verdict',
      item_id: itemByKey('A2').id,
      message: 'A2: done — The agent reports the work complete and committed.',
      data: { status: 'done', source: 'model' }
    })
    expect(harness.published.slice(before).map((event) => event.reason)).toEqual(['item', 'event'])
  })

  it("reads the session's final message server-side when none is given", async () => {
    harness.overrides.resolveFinalMessage = async ({ sessionId, worktreePath }) =>
      sessionId === 'session-A1' && worktreePath === null ? DONE_MESSAGE : null
    harness.db.updateDocumentRunItem(itemByKey('A1').id, { session_id: 'session-A1' })
    harness.replies.push(modelVerdict())

    const verdict = await harness.service.classify({ runId, itemId: itemByKey('A1').id })

    expect(verdict.source).toBe('model')
    expect(harness.generateCalls[0].prompt).toContain(DONE_MESSAGE)
    // No worktree: no git facts to state.
    expect(harness.generateCalls[0].prompt).not.toContain('Git facts')
  })

  it('falls back to blocked when there is no final message to judge', async () => {
    harness.db.updateDocumentRunItem(itemByKey('A1').id, { session_id: 'session-A1' })

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A1').id,
      finalMessage: '   '
    })

    expect(verdict).toMatchObject({
      status: 'blocked',
      source: 'fallback',
      confidence: 'low',
      reason: "Could not read the session's final message."
    })
    expect(harness.generateCalls).toEqual([])
    expect(itemByKey('A1').verdict).toEqual(verdict)
  })

  it("uses the agent's STATUS footer when the model fails", async () => {
    launchTicket('A2')
    harness.replies.push(new Error('codex timed out after 90000ms'))

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A2').id,
      finalMessage: DONE_MESSAGE
    })

    expect(verdict).toMatchObject({
      status: 'done',
      source: 'footer',
      confidence: 'low',
      summary: 'Added the ramp-up rule.',
      migrations: ['db/migrations/002_ramp_up.sql'],
      manualSteps: ['Run the migration after deploy.']
    })
    expect(harness.db.listDocumentRunEvents(runId).at(-1)?.data).toMatchObject({
      source: 'footer'
    })
  })

  it("uses the footer when the model's reply is not a verdict", async () => {
    launchTicket('A2')
    harness.replies.push('I think the agent is probably done?')

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A2').id,
      finalMessage: 'Blocked on credentials.\n\nSTATUS: BLOCKED\nQUESTIONS: Need the API key.'
    })

    expect(verdict).toMatchObject({
      status: 'blocked',
      source: 'footer',
      question: 'Need the API key.'
    })
  })

  it('takes a plain finished message as done when the model fails and the branch has work', async () => {
    const path = launchTicket('A2')
    repo.commit(path, 'rule', { 'src/rule.ts': 'export const rule = 1\n' })
    harness.replies.push(new Error('No AI provider available'))

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A2').id,
      finalMessage: 'All done, everything works.'
    })

    expect(verdict).toMatchObject({ status: 'done', source: 'fallback', confidence: 'low' })
    expect(verdict.reason).toContain('No AI provider available')
    expect(verdict.reason).toContain('the branch carries commits')
  })

  it('still surfaces a question asked in text when the model fails', async () => {
    launchTicket('A2')
    harness.replies.push(new Error('No AI provider available'))

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A2').id,
      finalMessage: 'I added the totals.\n\nWhich currency should they use?'
    })

    expect(verdict).toMatchObject({
      status: 'needs_input',
      source: 'fallback',
      question: 'Which currency should they use?'
    })
  })

  it('fails closed when the model fails and the message may report a problem', async () => {
    const path = launchTicket('A2')
    repo.commit(path, 'rule', { 'src/rule.ts': 'export const rule = 1\n' })
    harness.replies.push(new Error('No AI provider available'))

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A2').id,
      finalMessage: 'I could not finish the export dialog.'
    })

    expect(verdict).toMatchObject({ status: 'blocked', source: 'fallback', confidence: 'low' })
    expect(verdict.reason).toContain('No AI provider available')
  })

  it('fails closed when the model fails and the branch carries no work', async () => {
    launchTicket('A1')
    harness.replies.push(new Error('No AI provider available'))

    const verdict = await harness.service.classify({
      runId,
      itemId: itemByKey('A1').id,
      finalMessage: 'All done, everything works.'
    })

    expect(verdict).toMatchObject({ status: 'blocked', source: 'fallback', confidence: 'low' })
    expect(verdict.reason).toContain('the branch carries no work')
  })

  it('refuses a ticket that has no session yet', async () => {
    await expect(
      harness.service.classify({ runId, itemId: itemByKey('A1').id, finalMessage: 'x' })
    ).rejects.toThrow('A1 has no session to judge yet.')
  })

  it('runs at most three classifications at once', async () => {
    launchTicket('A1')
    launchTicket('A2')
    launchTicket('A3')
    harness.db.updateDocumentRunItem(itemByKey('A4').id, { session_id: 'session-A4' })
    let inFlight = 0
    let peak = 0
    harness.overrides.generate = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight--
      return modelVerdict()
    }

    const verdicts = await Promise.all(
      ['A1', 'A2', 'A3', 'A4'].map((key) =>
        harness.service.classify({ runId, itemId: itemByKey(key).id, finalMessage: DONE_MESSAGE })
      )
    )

    expect(verdicts.every((verdict) => verdict.status === 'done')).toBe(true)
    expect(peak).toBe(3)
  })
})

describe('prepareMerge', () => {
  it('reports a branch that merges cleanly', async () => {
    const path = launchTicket('A1')
    repo.commit(path, 'A1 work', { 'src/i18n.ts': 'export const zh = {}\n' })

    const check = await harness.service.prepareMerge(runId, itemByKey('A1').id)

    expect(check).toEqual({
      state: 'clean',
      conflictedFiles: [],
      // The commit the dry run was made against: a conflicting session merges this, not the
      // branch, whose tip may be another ticket's unverified merge by then.
      integrationHead: repo.baseSha,
      committed: false,
      commitsAhead: 1
    })
    expect(integrationHead()).toBe(repo.baseSha)
  })

  it('commits what the agent left uncommitted, then checks', async () => {
    const path = launchTicket('A1')
    repo.write(path, {
      'src/i18n.ts': 'export const zh = {}\n',
      'src/app.ts': 'export const app = "zh"\n'
    })

    const check = await harness.service.prepareMerge(runId, itemByKey('A1').id)

    expect(check).toMatchObject({ state: 'clean', committed: true, commitsAhead: 1 })
    expect(repo.git(path, 'status', '--porcelain')).toBe('')
    expect(repo.git(path, 'log', '-1', '--format=%s')).toBe('A1 · Chinese "translation"')
    expect(harness.db.listDocumentRunEvents(runId).at(-1)).toMatchObject({
      type: 'auto_commit',
      item_id: itemByKey('A1').id
    })
  })

  it('reports a branch without changes', async () => {
    launchTicket('A1')

    expect(await harness.service.prepareMerge(runId, itemByKey('A1').id)).toEqual({
      state: 'no_changes',
      conflictedFiles: [],
      integrationHead: repo.baseSha,
      committed: false,
      commitsAhead: 0
    })
  })

  it('names the conflicting files without touching either tree', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1 edits shared', { 'src/shared.ts': 'export const shared = "a1"\n' })
    repo.commit(a2, 'A2 edits shared', { 'src/shared.ts': 'export const shared = "a2"\n' })
    expect((await harness.service.merge(runId, itemByKey('A1').id)).success).toBe(true)

    const check = await harness.service.prepareMerge(runId, itemByKey('A2').id)

    expect(check).toEqual({
      state: 'conflict',
      conflictedFiles: ['src/shared.ts'],
      integrationHead: itemByKey('A1').merge_sha,
      committed: false,
      commitsAhead: 1
    })
    expect(repo.git(integration, 'status', '--porcelain')).toBe('')
    expect(repo.git(a2, 'status', '--porcelain')).toBe('')
  })

  it('reports a ticket worktree left mid-merge with unresolved conflicts instead of committing them', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1 edits shared', { 'src/shared.ts': 'export const shared = "a1"\n' })
    repo.commit(a2, 'A2 edits shared', { 'src/shared.ts': 'export const shared = "a2"\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    // The agent ran `git merge doc-factory` and stopped half-way.
    expect(() => repo.git(a2, 'merge', 'doc-factory')).toThrow()

    const check = await harness.service.prepareMerge(runId, itemByKey('A2').id)

    expect(check).toEqual({
      state: 'conflict',
      conflictedFiles: ['src/shared.ts'],
      // The commit the session is told to merge, here of all places: it is about to retry.
      integrationHead: itemByKey('A1').merge_sha,
      committed: false,
      commitsAhead: 1
    })
    expect(readFileSync(join(a2, 'src/shared.ts'), 'utf8')).toContain('<<<<<<<')
  })

  it('recognises a branch that was merged before a crash', async () => {
    const path = launchTicket('A1')
    repo.commit(path, 'A1 work', { 'src/i18n.ts': 'export const zh = {}\n' })
    await harness.service.merge(runId, itemByKey('A1').id)

    const check = await harness.service.prepareMerge(runId, itemByKey('A1').id)

    expect(check).toEqual({
      state: 'clean',
      alreadyMerged: true,
      conflictedFiles: [],
      integrationHead: itemByKey('A1').merge_sha,
      committed: false,
      commitsAhead: 0
    })
  })

  it('refuses a branch that carries a rolled-back merge of another ticket', async () => {
    const a1 = launchTicket('A1')
    repo.commit(a1, 'A1', { 'src/a1.ts': 'broken\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    const mergeOfA1 = itemByKey('A1').merge_sha!
    // A2 was launched while A1's merge sat on the integration branch, still being verified.
    const a2 = launchTicket('A2')
    repo.commit(a2, 'A2', { 'src/a2.ts': '2\n' })
    expect(await harness.service.rollbackMerge(runId, itemByKey('A1').id)).toEqual({
      success: true
    })
    expect(existsSync(join(integration, 'src/a1.ts'))).toBe(false)

    const check = await harness.service.prepareMerge(runId, itemByKey('A2').id)

    expect(check.state).toBe('error')
    expect(check.error).toBe(
      `The branch of A2 contains the merge of A1 that was rolled back after its checks failed. Rebase it onto doc-factory without that merge (git rebase --onto ${repo.baseSha.slice(0, 12)} ${mergeOfA1.slice(0, 12)}) and retry, or skip it.`
    )
    // The real merge fails closed too, in case the check was skipped.
    expect(await harness.service.merge(runId, itemByKey('A2').id)).toEqual({
      success: false,
      error: check.error
    })
    expect(integrationHead()).toBe(repo.baseSha)
    expect(existsSync(join(integration, 'src/a1.ts'))).toBe(false)

    // Rebuilt without the merge, as the message says, the branch is welcome.
    repo.git(a2, 'rebase', '--onto', repo.baseSha, mergeOfA1)
    expect(await harness.service.prepareMerge(runId, itemByKey('A2').id)).toMatchObject({
      state: 'clean',
      commitsAhead: 1
    })
    expect((await harness.service.merge(runId, itemByKey('A2').id)).success).toBe(true)
    expect(existsSync(join(integration, 'src/a2.ts'))).toBe(true)
    expect(existsSync(join(integration, 'src/a1.ts'))).toBe(false)
  })

  it('still accepts the rolled-back ticket itself, and a merge that legitimately came back', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1', { 'src/a1.ts': 'broken\n' })
    repo.commit(a2, 'A2', { 'src/a2.ts': '2\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    const mergeOfA1 = itemByKey('A1').merge_sha!
    // A2's session merged the integration branch in (a conflict prompt) while A1 sat on it.
    repo.git(a2, 'merge', '--no-ff', '-m', 'Merge doc-factory into a2-task', mergeOfA1)
    await harness.service.rollbackMerge(runId, itemByKey('A1').id)

    // Its own rollback never holds a ticket back: a fixed A1 is merged again.
    repo.commit(a1, 'A1 fixed', { 'src/a1.ts': 'fixed\n' })
    expect(await harness.service.prepareMerge(runId, itemByKey('A1').id)).toMatchObject({
      state: 'clean'
    })
    expect((await harness.service.merge(runId, itemByKey('A1').id)).success).toBe(true)

    // A2 would have been refused before; now the branch has what the old merge brought in
    // (and more), so A2 adds nothing that was rolled back.
    expect(await harness.service.prepareMerge(runId, itemByKey('A2').id)).toMatchObject({
      state: 'clean'
    })
    expect((await harness.service.merge(runId, itemByKey('A2').id)).success).toBe(true)
    expect(readFileSync(join(integration, 'src/a1.ts'), 'utf8')).toBe('fixed\n')
  })

  it('treats the recorded merge of a flagged ticket that is no longer on the branch as rolled back', async () => {
    const a1 = launchTicket('A1')
    repo.commit(a1, 'A1', { 'src/a1.ts': 'broken\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    const mergeOfA1 = itemByKey('A1').merge_sha!
    const a2 = launchTicket('A2')
    repo.commit(a2, 'A2', { 'src/a2.ts': '2\n' })
    // The branch was reset by hand and the rollback never logged; the row still names the merge.
    repo.git(integration, 'reset', '-q', '--hard', repo.baseSha)
    harness.db.updateDocumentRunItem(itemByKey('A1').id, {
      status: 'needs_attention',
      merge_sha: mergeOfA1
    })

    const check = await harness.service.prepareMerge(runId, itemByKey('A2').id)

    expect(check.state).toBe('error')
    expect(check.error).toContain('contains the merge of A1 that was rolled back')
  })

  it('still refuses the rolled-back merge once the log has outgrown the newest thousand events', async () => {
    const a1 = launchTicket('A1')
    repo.commit(a1, 'A1', { 'src/a1.ts': 'broken\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    const a2 = launchTicket('A2')
    repo.commit(a2, 'A2', { 'src/a2.ts': '2\n' })
    await harness.service.rollbackMerge(runId, itemByKey('A1').id)
    // A long run: the rollback event is the only record of the merge (the row forgot it),
    // and the rest of the log has long pushed it past the newest thousand.
    for (let index = 0; index < 1000; index++) {
      harness.db.appendDocumentRunEvent({ run_id: runId, type: 'status', message: `#${index}` })
    }
    expect(harness.db.listDocumentRunEvents(runId, 1000).map((event) => event.type)).not.toContain(
      'rolled_back'
    )

    const check = await harness.service.prepareMerge(runId, itemByKey('A2').id)

    expect(check.state).toBe('error')
    expect(check.error).toContain('contains the merge of A1 that was rolled back')
    expect((await harness.service.merge(runId, itemByKey('A2').id)).success).toBe(false)
    expect(integrationHead()).toBe(repo.baseSha)
    expect(existsSync(join(integration, 'src/a1.ts'))).toBe(false)
  })

  it.each([
    ['no worktree', () => undefined, 'A1 has no branch to merge.'],
    [
      'a worktree that is gone',
      () => {
        launchTicket('A1')
        harness.worktrees.set('wt-A1', { id: 'wt-A1', path: '/nowhere/a1', branch_name: 'a1-task' })
      },
      'The worktree of A1 is missing: /nowhere/a1'
    ],
    [
      'a missing integration worktree',
      () => {
        launchTicket('A1')
        harness.db.updateDocumentRun(runId, { integration_worktree_path: '/nowhere/integration' })
      },
      'The integration worktree is missing: /nowhere/integration'
    ],
    [
      'a worktree on another branch',
      () => {
        const path = launchTicket('A1')
        repo.git(path, 'checkout', '-q', '-b', 'something-else')
      },
      'has branch something-else checked out, not a1-task'
    ]
  ])('returns an error for %s', async (_name, arrange, message) => {
    arrange()

    const check = await harness.service.prepareMerge(runId, itemByKey('A1').id)

    expect(check.state).toBe('error')
    expect(check.error).toContain(message)
  })
})

describe('merge', () => {
  it('merges with a merge commit and records both shas', async () => {
    const path = launchTicket('A1')
    const tip = repo.commit(path, 'A1 work', { 'src/i18n.ts': 'export const zh = {}\n' })
    const before = harness.published.length

    const result = await harness.service.merge(runId, itemByKey('A1').id)

    expect(result).toEqual({ success: true, mergeSha: integrationHead() })
    expect(repo.git(integration, 'log', '-1', '--format=%P').split(' ')).toEqual([
      repo.baseSha,
      tip
    ])
    expect(repo.git(integration, 'log', '-1', '--format=%s')).toBe(
      'Merge A1 · Chinese "translation"'
    )
    expect(itemByKey('A1')).toMatchObject({
      pre_merge_sha: repo.baseSha,
      merge_sha: result.mergeSha
    })
    expect(harness.db.listDocumentRunEvents(runId).at(-1)).toMatchObject({
      type: 'merged',
      item_id: itemByKey('A1').id,
      data: { mergeSha: result.mergeSha, preMergeSha: repo.baseSha }
    })
    expect(harness.published.slice(before).map((event) => event.reason)).toEqual(['item', 'event'])
  })

  it('is idempotent: a second call reports the existing merge', async () => {
    const path = launchTicket('A1')
    repo.commit(path, 'A1 work', { 'src/i18n.ts': 'export const zh = {}\n' })
    const first = await harness.service.merge(runId, itemByKey('A1').id)
    // The bookkeeping of the first merge was lost (a crash between git and the database).
    harness.db.updateDocumentRunItem(itemByKey('A1').id, { merge_sha: null, pre_merge_sha: null })

    const second = await harness.service.merge(runId, itemByKey('A1').id)

    expect(second).toEqual({ success: true, alreadyMerged: true, mergeSha: first.mergeSha })
    expect(integrationHead()).toBe(first.mergeSha)
    expect(itemByKey('A1')).toMatchObject({
      merge_sha: first.mergeSha,
      pre_merge_sha: repo.baseSha
    })
  })

  it('reports a branch with nothing new as already merged', async () => {
    launchTicket('A1')

    expect(await harness.service.merge(runId, itemByKey('A1').id)).toEqual({
      success: true,
      alreadyMerged: true
    })
    expect(integrationHead()).toBe(repo.baseSha)
  })

  it('aborts a conflicting merge and names the files', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1 edits shared', { 'src/shared.ts': 'export const shared = "a1"\n' })
    repo.commit(a2, 'A2 edits shared', { 'src/shared.ts': 'export const shared = "a2"\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    const before = integrationHead()

    const result = await harness.service.merge(runId, itemByKey('A2').id)

    expect(result).toEqual({ success: false, conflictedFiles: ['src/shared.ts'] })
    expect(integrationHead()).toBe(before)
    expect(repo.git(integration, 'status', '--porcelain')).toBe('')
    expect(mergeInProgress(integration)).toBe(false)
    expect(itemByKey('A2').merge_sha).toBeNull()
    expect(harness.db.listDocumentRunEvents(runId).at(-1)).toMatchObject({
      type: 'merge_failed',
      data: { conflictedFiles: ['src/shared.ts'] }
    })
  })

  it('merges the branch once its session resolved the conflicts', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1 edits shared', { 'src/shared.ts': 'export const shared = "a1"\n' })
    repo.commit(a2, 'A2 edits shared', { 'src/shared.ts': 'export const shared = "a2"\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    expect((await harness.service.merge(runId, itemByKey('A2').id)).success).toBe(false)

    // What the ticket's own session does when asked to resolve.
    expect(() => repo.git(a2, 'merge', 'doc-factory')).toThrow()
    repo.commit(a2, 'Merge doc-factory into a2', {
      'src/shared.ts': 'export const shared = "a1+a2"\n'
    })

    const result = await harness.service.merge(runId, itemByKey('A2').id)

    expect(result.success).toBe(true)
    expect(readFileSync(join(integration, 'src/shared.ts'), 'utf8')).toContain('a1+a2')
    expect(repo.git(integration, 'log', '-1', '--format=%s')).toBe('Merge A2 · Ramp-up rule')
  })

  it('cleans up a merge left in progress and commits stray changes before merging', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1 edits shared', { 'src/shared.ts': 'export const shared = "a1"\n' })
    repo.commit(a2, 'A2 adds a file', { 'src/rule.ts': 'export const rule = 1\n' })
    // A previous attempt died mid-merge, and a fix session left a file behind.
    expect(() => repo.git(integration, 'merge', '--no-ff', 'a2-task')).not.toThrow()
    repo.git(integration, 'reset', '-q', '--hard', repo.baseSha)
    repo.commit(a2, 'A2 edits shared too', { 'src/shared.ts': 'export const shared = "a2"\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    expect(() => repo.git(integration, 'merge', 'a2-task')).toThrow()
    expect(mergeInProgress(integration)).toBe(true)
    repo.git(integration, 'merge', '--abort')
    repo.write(integration, { 'src/fix.ts': 'export const fixed = true\n' })
    const a3 = launchTicket('A3')
    repo.commit(a3, 'A3 report', { 'src/report.ts': 'export const report = 1\n' })

    const result = await harness.service.merge(runId, itemByKey('A3').id)

    expect(result.success).toBe(true)
    expect(repo.git(integration, 'status', '--porcelain')).toBe('')
    expect(repo.git(integration, 'log', '--format=%s', '--first-parent', '-3').split('\n')).toEqual(
      [
        'Merge A3 · Report',
        'Save uncommitted changes before merging A3',
        'Merge A1 · Chinese "translation"'
      ]
    )
    expect(eventTypes()).toContain('integration_commit')
    // The pre-merge sha is the HEAD after the safety commit.
    expect(itemByKey('A3').pre_merge_sha).toBe(repo.git(integration, 'rev-parse', 'HEAD^1'))
  })

  it('serialises merges of one run', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    const a3 = launchTicket('A3')
    repo.commit(a1, 'A1', { 'src/a1.ts': '1\n' })
    repo.commit(a2, 'A2', { 'src/a2.ts': '2\n' })
    repo.commit(a3, 'A3', { 'src/a3.ts': '3\n' })

    const results = await Promise.all(
      ['A1', 'A2', 'A3'].map((key) => harness.service.merge(runId, itemByKey(key).id))
    )

    expect(results.every((result) => result.success)).toBe(true)
    expect(repo.git(integration, 'log', '--format=%s', '--first-parent').split('\n')).toEqual([
      'Merge A3 · Report',
      'Merge A2 · Ramp-up rule',
      'Merge A1 · Chinese "translation"',
      'base'
    ])
    // Each merge was based on the one before it.
    expect(itemByKey('A2').pre_merge_sha).toBe(itemByKey('A1').merge_sha)
    expect(itemByKey('A3').pre_merge_sha).toBe(itemByKey('A2').merge_sha)
  })

  it('refuses to merge when the integration worktree is on another branch', async () => {
    const path = launchTicket('A1')
    repo.commit(path, 'A1 work', { 'src/i18n.ts': 'x\n' })
    repo.git(integration, 'checkout', '-q', '-b', 'wandered-off')

    const result = await harness.service.merge(runId, itemByKey('A1').id)

    expect(result.success).toBe(false)
    expect(result.error).toContain('has branch wandered-off checked out, not doc-factory')
    expect(repo.git(repo.projectPath, 'rev-parse', 'refs/heads/doc-factory')).toBe(repo.baseSha)
  })

  it('reports a branch that does not exist', async () => {
    harness.db.updateDocumentRunItem(itemByKey('A1').id, { branch_name: 'never-created' })

    expect(await harness.service.merge(runId, itemByKey('A1').id)).toEqual({
      success: false,
      error: 'Branch never-created was not found.'
    })
  })

  it('refuses an unknown run or ticket', async () => {
    await expect(harness.service.merge('missing', itemByKey('A1').id)).rejects.toThrow(
      'The run was not found.'
    )
    await expect(harness.service.merge(runId, 'missing')).rejects.toThrow(
      'The ticket was not found.'
    )
  })
})

describe('verify', () => {
  it('is skipped when the run has no verify command', async () => {
    const calls: unknown[] = []
    harness.overrides.runVerify = async (...args) => {
      calls.push(args)
      return { exitCode: 0, timedOut: false, output: '', durationMs: 1 }
    }

    expect(await harness.service.verify(runId)).toEqual({
      skipped: true,
      ok: true,
      exitCode: null,
      timedOut: false,
      output: '',
      durationMs: 0
    })
    expect(calls).toEqual([])
    expect(eventTypes()).toEqual([])
  })

  it('runs the command in the integration worktree and logs a pass', async () => {
    const calls: [string, string][] = []
    harness.overrides.runVerify = async (command, cwd) => {
      calls.push([command, cwd])
      return { exitCode: 0, timedOut: false, output: 'all green', durationMs: 120 }
    }
    harness.service.updateRun(runId, { config: { verifyCommand: ' pnpm run lint ' } })

    const result = await harness.service.verify(runId)

    expect(calls).toEqual([['pnpm run lint', integration]])
    expect(result).toEqual({
      skipped: false,
      ok: true,
      exitCode: 0,
      timedOut: false,
      output: 'all green',
      durationMs: 120
    })
    expect(harness.db.listDocumentRunEvents(runId).at(-1)).toMatchObject({
      type: 'verify_passed',
      message: 'Verify passed: pnpm run lint',
      // The commit it ran on: the report only trusts a result for the branch as it is.
      data: { command: 'pnpm run lint', sha: repo.baseSha, exitCode: 0, output: 'all green' }
    })
  })

  it.each([
    [
      'a failing command',
      { exitCode: 2, timedOut: false, output: 'src/x.ts: error TS2322', durationMs: 50 },
      'Verify failed (exit code 2): pnpm run lint'
    ],
    [
      'a command that timed out',
      { exitCode: null, timedOut: true, output: 'still running…', durationMs: 1_800_000 },
      'Verify timed out: pnpm run lint'
    ]
  ])('logs %s with its output', async (_name, outcome, message) => {
    harness.overrides.runVerify = async () => outcome
    harness.service.updateRun(runId, { config: { verifyCommand: 'pnpm run lint' } })

    const result = await harness.service.verify(runId)

    expect(result).toEqual({ skipped: false, ok: false, ...outcome })
    expect(harness.db.listDocumentRunEvents(runId).at(-1)).toMatchObject({
      type: 'verify_failed',
      message,
      data: { output: outcome.output, timedOut: outcome.timedOut }
    })
  })

  it('refuses to run without an integration worktree', async () => {
    harness.service.updateRun(runId, { config: { verifyCommand: 'pnpm run lint' } })
    harness.db.updateDocumentRun(runId, { integration_worktree_path: '/nowhere' })

    await expect(harness.service.verify(runId)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'The integration worktree is missing: /nowhere'
    })
  })
})

describe('commitIntegration', () => {
  it('commits what a fix session left behind, and nothing when the tree is clean', async () => {
    repo.write(integration, { 'src/fix.ts': 'export const fixed = true\n' })

    const committed = await harness.service.commitIntegration(runId, 'Fix checks after A1')
    const clean = await harness.service.commitIntegration(runId, 'Nothing')

    expect(committed).toEqual({ success: true, committed: true })
    expect(clean).toEqual({ success: true, committed: false })
    expect(repo.git(integration, 'log', '-1', '--format=%s')).toBe('Fix checks after A1')
    expect(repo.git(integration, 'status', '--porcelain')).toBe('')
    expect(harness.db.listDocumentRunEvents(runId)).toMatchObject([
      { type: 'integration_commit', message: 'Committed on doc-factory: Fix checks after A1' }
    ])
  })

  it('concludes a resolved merge that was not committed', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1 edits shared', { 'src/shared.ts': 'export const shared = "a1"\n' })
    repo.commit(a2, 'A2 edits shared', { 'src/shared.ts': 'export const shared = "a2"\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    expect(() => repo.git(integration, 'merge', 'a2-task')).toThrow()
    repo.write(integration, { 'src/shared.ts': 'export const shared = "resolved"\n' })
    repo.git(integration, 'add', 'src/shared.ts')

    const result = await harness.service.commitIntegration(runId, 'Resolve A2')

    expect(result).toEqual({ success: true, committed: true })
    expect(mergeInProgress(integration)).toBe(false)
    expect(repo.git(integration, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2)
  })

  it('refuses to commit over unresolved conflicts', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1 edits shared', { 'src/shared.ts': 'export const shared = "a1"\n' })
    repo.commit(a2, 'A2 edits shared', { 'src/shared.ts': 'export const shared = "a2"\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    expect(() => repo.git(integration, 'merge', 'a2-task')).toThrow()

    const result = await harness.service.commitIntegration(runId, 'Oops')

    expect(result).toEqual({
      success: false,
      committed: false,
      error: 'Unresolved merge conflicts in: src/shared.ts'
    })
  })
})

describe('rollbackMerge', () => {
  it('resets the integration branch to the pre-merge commit and removes leftovers', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1', { 'src/a1.ts': '1\n' })
    repo.commit(a2, 'A2', { 'src/a2.ts': '2\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    const afterA1 = integrationHead()
    await harness.service.merge(runId, itemByKey('A2').id)
    // What a failed fix session leaves behind.
    repo.write(integration, {
      'src/a2.ts': 'half fixed\n',
      'scratch/notes.txt': 'x\n'
    })
    const before = harness.published.length

    const result = await harness.service.rollbackMerge(runId, itemByKey('A2').id)

    expect(result).toEqual({ success: true })
    expect(integrationHead()).toBe(afterA1)
    expect(repo.git(integration, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(integration, 'src/a2.ts'))).toBe(false)
    expect(existsSync(join(integration, 'scratch'))).toBe(false)
    expect(existsSync(join(integration, 'src/a1.ts'))).toBe(true)
    expect(itemByKey('A2')).toMatchObject({ merge_sha: null, pre_merge_sha: null })
    expect(itemByKey('A1')).toMatchObject({ merge_sha: afterA1 })
    expect(harness.db.listDocumentRunEvents(runId).at(-1)).toMatchObject({
      type: 'rolled_back',
      item_id: itemByKey('A2').id,
      data: { resetTo: afterA1 }
    })
    expect(harness.published.slice(before).map((event) => event.reason)).toEqual(['item', 'event'])
    // The ticket branch keeps its work for another attempt.
    expect(repo.git(a2, 'rev-list', '--count', 'doc-factory..a2-task')).toBe('1')
    // The base branch and the root checkout were never touched.
    expect(repo.git(repo.projectPath, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha)
    expect(repo.git(repo.projectPath, 'status', '--porcelain')).toBe('')
  })

  it('aborts a merge in progress first', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1 edits shared', { 'src/shared.ts': 'export const shared = "a1"\n' })
    repo.commit(a2, 'A2 edits shared', { 'src/shared.ts': 'export const shared = "a2"\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    expect(() => repo.git(integration, 'merge', 'a2-task')).toThrow()

    expect(await harness.service.rollbackMerge(runId, itemByKey('A1').id)).toEqual({
      success: true
    })
    expect(integrationHead()).toBe(repo.baseSha)
    expect(mergeInProgress(integration)).toBe(false)
  })

  it('refuses a ticket without a recorded merge', async () => {
    launchTicket('A1')

    expect(await harness.service.rollbackMerge(runId, itemByKey('A1').id)).toEqual({
      success: false,
      error: 'A1 has no recorded merge to roll back.'
    })
  })

  it('refuses when a later merge would be dropped too', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1', { 'src/a1.ts': '1\n' })
    repo.commit(a2, 'A2', { 'src/a2.ts': '2\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    await harness.service.merge(runId, itemByKey('A2').id)
    const head = integrationHead()

    const result = await harness.service.rollbackMerge(runId, itemByKey('A1').id)

    expect(result).toEqual({
      success: false,
      error: 'A2 was merged after A1; rolling back would drop it too.'
    })
    expect(integrationHead()).toBe(head)
  })

  it('forgets the merge as soon as the branch is reset, even when the clean-up fails', async () => {
    const a1 = launchTicket('A1')
    const a3 = launchTicket('A3')
    repo.commit(a1, 'A1', { 'src/a1.ts': '1\n' })
    repo.commit(a3, 'A3', { 'src/a3.ts': '3\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    const mergeOfA1 = itemByKey('A1').merge_sha
    // What a verify command can leave behind: an untracked directory git cannot remove.
    const stubborn = join(integration, 'ro')
    mkdirSync(join(stubborn, 'sub'), { recursive: true })
    writeFileSync(join(stubborn, 'sub', 'f'), 'x')
    chmodSync(join(stubborn, 'sub'), 0o500)
    let result
    try {
      result = await harness.service.rollbackMerge(runId, itemByKey('A1').id)
    } finally {
      chmodSync(join(stubborn, 'sub'), 0o700)
    }

    expect(result).toEqual({ success: true })
    expect(integrationHead()).toBe(repo.baseSha)
    expect(existsSync(join(integration, 'src/a1.ts'))).toBe(false)
    expect(itemByKey('A1')).toMatchObject({ merge_sha: null, pre_merge_sha: null })
    expect(eventTypes().slice(-2)).toEqual(['rolled_back', 'rollback_leftovers'])
    expect(harness.db.listDocumentRunEvents(runId).at(-2)?.data).toMatchObject({
      mergeSha: mergeOfA1
    })
    expect(harness.db.listDocumentRunEvents(runId).at(-1)?.message).toContain(
      'could not all be removed'
    )

    // A later rollback is not blocked by the merge that is gone.
    rmSync(stubborn, { recursive: true, force: true })
    await harness.service.merge(runId, itemByKey('A3').id)
    expect(await harness.service.rollbackMerge(runId, itemByKey('A3').id)).toEqual({
      success: true
    })
    expect(integrationHead()).toBe(repo.baseSha)
  })

  it('ignores a stale recorded merge that is no longer on the branch', async () => {
    const a1 = launchTicket('A1')
    const a3 = launchTicket('A3')
    repo.commit(a1, 'A1', { 'src/a1.ts': '1\n' })
    repo.commit(a3, 'A3', { 'src/a3.ts': '3\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    const mergeOfA1 = itemByKey('A1').merge_sha
    await harness.service.rollbackMerge(runId, itemByKey('A1').id)
    // The row of a rollback whose result was lost still names the merge.
    harness.db.updateDocumentRunItem(itemByKey('A1').id, { merge_sha: mergeOfA1 })
    await harness.service.merge(runId, itemByKey('A3').id)

    expect(await harness.service.rollbackMerge(runId, itemByKey('A3').id)).toEqual({
      success: true
    })
    expect(integrationHead()).toBe(repo.baseSha)
  })

  it('refuses when the pre-merge commit is no longer on the branch', async () => {
    const a1 = launchTicket('A1')
    repo.commit(a1, 'A1', { 'src/a1.ts': '1\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    const unrelated = repo.commit(repo.addWorktree('elsewhere', 'main'), 'elsewhere', {
      'x.txt': 'x\n'
    })
    harness.db.updateDocumentRunItem(itemByKey('A1').id, { pre_merge_sha: unrelated })
    const head = integrationHead()

    const result = await harness.service.rollbackMerge(runId, itemByKey('A1').id)

    expect(result.success).toBe(false)
    expect(result.error).toContain('no longer contains the commit A1 was merged onto')
    expect(integrationHead()).toBe(head)
  })

  it.each([
    [
      'the project root',
      () => harness.db.updateDocumentRun(runId, { integration_worktree_path: repo.projectPath }),
      'Refusing to reset the project root.'
    ],
    [
      'a directory inside the worktree',
      () =>
        harness.db.updateDocumentRun(runId, {
          integration_worktree_path: join(integration, 'src')
        }),
      'it is not the root of a worktree'
    ],
    [
      'a worktree on another branch',
      () => repo.git(integration, 'checkout', '-q', '-b', 'wandered-off'),
      'has branch wandered-off checked out, not doc-factory'
    ]
  ])('never resets %s', async (_name, arrange, message) => {
    const a1 = launchTicket('A1')
    repo.commit(a1, 'A1', { 'src/a1.ts': '1\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    repo.write(repo.projectPath, { 'precious.txt': 'do not delete\n' })
    const rootStatus = repo.git(repo.projectPath, 'status', '--porcelain')
    arrange()

    const result = await harness.service.rollbackMerge(runId, itemByKey('A1').id)

    expect(result.success).toBe(false)
    expect(result.error).toContain(message)
    expect(repo.git(repo.projectPath, 'status', '--porcelain')).toBe(rootStatus)
    expect(existsSync(join(repo.projectPath, 'precious.txt'))).toBe(true)
    expect(repo.git(repo.projectPath, 'rev-parse', 'HEAD')).toBe(repo.baseSha)
    expect(itemByKey('A1').merge_sha).not.toBeNull()
  })
})

describe('finalize', () => {
  const verdict = (overrides: Partial<DocumentRunVerdict>): DocumentRunVerdict => ({
    status: 'done',
    reason: 'Done.',
    question: null,
    summary: null,
    migrations: [],
    manualSteps: [],
    confidence: 'high',
    source: 'model',
    classifiedAt: '2026-10-05T10:00:00.000Z',
    ...overrides
  })

  it('builds the report and completes a run whose selected tickets all merged', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1', {
      'src/i18n.ts': 'export const zh = {}\n',
      'src/app.ts': 'export const app = "zh"\n'
    })
    repo.commit(a2, 'A2', {
      'db/migrations/002_ramp_up.sql': 'alter table factory add ramp_up int;\n',
      'db/migrations/meta/_journal.json': '{}\n',
      'src/rule.ts': 'export const rule = 1\n'
    })
    for (const key of ['A1', 'A2']) {
      await harness.service.merge(runId, itemByKey(key).id)
    }
    harness.db.updateDocumentRunItem(itemByKey('A1').id, {
      status: 'merged',
      verdict: verdict({ summary: 'Translated the screens.', manualSteps: ['Ask QA to check zh.'] })
    })
    harness.db.updateDocumentRunItem(itemByKey('A2').id, {
      status: 'merged',
      verdict: verdict({
        summary: 'Added the rule.',
        migrations: ['db/migrations/002_ramp_up.sql', 'Run `pnpm db:migrate`'],
        manualSteps: ['Ask QA to check zh.', 'Run the migration.']
      })
    })
    harness.db.updateDocumentRunItem(itemByKey('A3').id, { status: 'merged' })
    harness.db.updateDocumentRun(runId, {
      config: { ...harness.db.getDocumentRun(runId)!.config, verifyCommand: 'pnpm run lint' }
    })
    harness.overrides.runVerify = async () => ({
      exitCode: 0,
      timedOut: false,
      output: 'ok',
      durationMs: 5
    })
    await harness.service.verify(runId)
    const before = harness.published.length

    const detail = await harness.service.finalize(runId)

    expect(detail.run.status).toBe('completed')
    expect(detail.run.finished_at).toBeTruthy()
    const head = integrationHead()
    expect(detail.run.report).toEqual({
      generatedAt: expect.any(String),
      integrationBranch: 'doc-factory',
      integrationWorktreePath: integration,
      baseBranch: 'main',
      baseSha: repo.baseSha,
      headSha: head,
      baseMoved: false,
      merged: [
        {
          key: 'A1',
          title: 'Chinese "translation"',
          mergeSha: itemByKey('A1').merge_sha,
          summary: 'Translated the screens.'
        },
        {
          key: 'A2',
          title: 'Ramp-up rule',
          mergeSha: itemByKey('A2').merge_sha,
          summary: 'Added the rule.'
        },
        { key: 'A3', title: 'Report', mergeSha: null, summary: null }
      ],
      unmerged: [],
      // Found in the diff, with the journal the migration brought along left out; then what the
      // agents reported, without the duplicate.
      migrations: ['db/migrations/002_ramp_up.sql', 'Run `pnpm db:migrate`'],
      manualSteps: ['Ask QA to check zh.', 'Run the migration.'],
      stats: { filesChanged: 5, insertions: 5, deletions: 1, commits: 4 },
      verify: { command: 'pnpm run lint', ok: true, output: 'ok' }
    })
    expect(detail.events.at(-1)).toMatchObject({
      type: 'completed',
      message: 'Run finished: 3 of 3 tickets merged into doc-factory'
    })
    // The run, then its log: the run status for the document (seeded at a path that does not
    // exist, so it could not be written), then "Run finished".
    expect(harness.published.slice(before).map((event) => event.reason)).toEqual([
      'run',
      'event',
      'event'
    ])
    expect(detail.events.at(-2)?.type).toBe('document_summary_failed')
    // The base branch is still where it was.
    expect(repo.git(repo.projectPath, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha)
  })

  it('completes with issues, listing what did not merge, when the base branch moved', async () => {
    const a1 = launchTicket('A1')
    repo.commit(a1, 'A1', { 'src/i18n.ts': 'x\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    harness.db.updateDocumentRunItem(itemByKey('A1').id, { status: 'merged' })
    harness.db.updateDocumentRunItem(itemByKey('A2').id, {
      status: 'needs_attention',
      status_detail: 'Verify failed twice.',
      verdict: verdict({ reason: 'Tests fail.' })
    })
    harness.db.updateDocumentRunItem(itemByKey('A3').id, {
      status: 'needs_input',
      verdict: verdict({ status: 'needs_input', reason: 'Asks which locale to use.' })
    })
    // The user kept working on main meanwhile.
    repo.commit(repo.projectPath, 'user work on main', { 'README.md': '# moved\n' })
    harness.db.updateDocumentRun(runId, { status: 'paused' })

    const detail = await harness.service.finalize(runId)

    expect(detail.run.status).toBe('completed_with_issues')
    expect(detail.run.report).toMatchObject({
      baseMoved: true,
      merged: [{ key: 'A1' }],
      unmerged: [
        { key: 'A2', status: 'needs_attention', reason: 'Verify failed twice.' },
        { key: 'A3', status: 'needs_input', reason: 'Asks which locale to use.' }
      ],
      stats: { commits: 2 },
      verify: null
    })
    expect(detail.events.at(-1)?.message).toBe(
      'Run finished: 1 of 3 tickets merged into doc-factory'
    )
  })

  it('reads the verify result of the current head back from the audit log after a restart', async () => {
    harness.db.updateDocumentRun(runId, {
      config: { ...harness.db.getDocumentRun(runId)!.config, verifyCommand: 'pnpm run lint' }
    })
    const log = (type: string, data: unknown): void => {
      harness.db.appendDocumentRunEvent({ run_id: runId, type, message: type, data })
    }
    log('verify_passed', { command: 'pnpm run lint', sha: 'older-commit', output: 'fine' })
    log('verify_failed', { command: 'pnpm run lint', sha: repo.baseSha, output: '1 error' })
    // The orchestrator's own event of the same type carries neither command nor output.
    log('verify_failed', { exitCode: 1, timedOut: false })
    for (const key of ['A1', 'A2', 'A3']) {
      harness.db.updateDocumentRunItem(itemByKey(key).id, { status: 'skipped' })
    }

    const detail = await harness.service.finalize(runId)

    expect(detail.run.report?.verify).toEqual({
      command: 'pnpm run lint',
      ok: false,
      output: '1 error'
    })
  })

  it('finds the verify result of the head under a thousand later events', async () => {
    harness.db.updateDocumentRun(runId, {
      config: { ...harness.db.getDocumentRun(runId)!.config, verifyCommand: 'pnpm run lint' }
    })
    harness.db.appendDocumentRunEvent({
      run_id: runId,
      type: 'verify_passed',
      message: 'verify_passed',
      data: { command: 'pnpm run lint', sha: repo.baseSha, output: 'fine' }
    })
    for (let index = 0; index < 1000; index++) {
      harness.db.appendDocumentRunEvent({ run_id: runId, type: 'status', message: `#${index}` })
    }
    for (const key of ['A1', 'A2', 'A3']) {
      harness.db.updateDocumentRunItem(itemByKey(key).id, { status: 'skipped' })
    }

    const detail = await harness.service.finalize(runId)

    expect(detail.run.report?.verify).toEqual({
      command: 'pnpm run lint',
      ok: true,
      output: 'fine'
    })
  })

  it('reports the checks of the branch as it is, not the failed run that was rolled back', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1', { 'src/a1.ts': '1\n' })
    repo.commit(a2, 'A2', { 'src/broken.ts': 'broken\n' })
    harness.db.updateDocumentRun(runId, {
      config: { ...harness.db.getDocumentRun(runId)!.config, verifyCommand: 'pnpm run lint' }
    })
    harness.overrides.runVerify = async (_command, cwd) =>
      existsSync(join(cwd, 'src/broken.ts'))
        ? { exitCode: 1, timedOut: false, output: 'src/broken.ts: error', durationMs: 5 }
        : { exitCode: 0, timedOut: false, output: 'ok', durationMs: 5 }
    await harness.service.merge(runId, itemByKey('A1').id)
    expect((await harness.service.verify(runId)).ok).toBe(true)
    harness.db.updateDocumentRunItem(itemByKey('A1').id, { status: 'merged' })
    await harness.service.merge(runId, itemByKey('A2').id)
    expect((await harness.service.verify(runId)).ok).toBe(false)
    expect(await harness.service.rollbackMerge(runId, itemByKey('A2').id)).toEqual({
      success: true
    })
    harness.db.updateDocumentRunItem(itemByKey('A2').id, {
      status: 'needs_attention',
      status_detail: 'Checks still fail; the merge was rolled back.'
    })
    harness.db.updateDocumentRunItem(itemByKey('A3').id, { status: 'skipped' })

    const detail = await harness.service.finalize(runId)

    expect(detail.run.report).toMatchObject({
      headSha: itemByKey('A1').merge_sha,
      // The run that passed on this very commit, found in the audit log.
      verify: { command: 'pnpm run lint', ok: true, output: 'ok' }
    })

    // A commit nobody verified has no verify result to show.
    harness.db.updateDocumentRun(runId, { status: 'running' })
    repo.commit(integration, 'hand edit', { 'src/manual.ts': 'x\n' })
    expect((await harness.service.finalize(runId)).run.report?.verify).toBeNull()
  })

  it('counts a ticket whose merge is on the branch as merged, whatever its row says', async () => {
    const a1 = launchTicket('A1')
    const a2 = launchTicket('A2')
    repo.commit(a1, 'A1', { 'src/i18n.ts': 'x\n' })
    repo.commit(a2, 'A2', { 'src/rule.ts': 'y\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    await harness.service.merge(runId, itemByKey('A2').id)
    // The run was finished early while A1 was being verified, and A2's rollback had failed.
    harness.db.updateDocumentRunItem(itemByKey('A1').id, { status: 'skipped' })
    harness.db.updateDocumentRunItem(itemByKey('A2').id, {
      status: 'needs_attention',
      status_detail: 'Checks still fail; the merge could not be rolled back.'
    })
    harness.db.updateDocumentRunItem(itemByKey('A3').id, { status: 'skipped' })

    const detail = await harness.service.finalize(runId)

    expect(detail.run.report?.merged.map((entry) => entry.key)).toEqual(['A1', 'A2'])
    expect(detail.run.report?.unmerged.map((entry) => entry.key)).toEqual(['A3'])
    expect(itemByKey('A1')).toMatchObject({
      status: 'merged',
      status_detail: 'Merged, but its checks were not confirmed before the run ended.'
    })
    expect(itemByKey('A2')).toMatchObject({
      status: 'merged',
      status_detail:
        'Merged, but its checks were not confirmed before the run ended. Checks still fail; the merge could not be rolled back.'
    })
    // The skip is fine; the merges nobody confirmed are the issue.
    expect(detail.run.status).toBe('completed_with_issues')
  })

  it('leaves a rolled-back ticket unmerged', async () => {
    const a1 = launchTicket('A1')
    repo.commit(a1, 'A1', { 'src/i18n.ts': 'x\n' })
    await harness.service.merge(runId, itemByKey('A1').id)
    const mergeSha = itemByKey('A1').merge_sha
    await harness.service.rollbackMerge(runId, itemByKey('A1').id)
    // A stale merge commit id must not be mistaken for a merge that is still on the branch.
    harness.db.updateDocumentRunItem(itemByKey('A1').id, {
      status: 'needs_attention',
      merge_sha: mergeSha
    })
    for (const key of ['A2', 'A3']) {
      harness.db.updateDocumentRunItem(itemByKey(key).id, { status: 'skipped' })
    }

    const detail = await harness.service.finalize(runId)

    expect(detail.run.report?.merged).toEqual([])
    expect(itemByKey('A1').status).toBe('needs_attention')
  })

  it('still closes a run whose integration worktree was removed by hand', async () => {
    harness.db.updateDocumentRun(runId, { integration_worktree_path: '/nowhere' })
    for (const key of ['A1', 'A2', 'A3']) {
      harness.db.updateDocumentRunItem(itemByKey(key).id, { status: 'cancelled' })
    }

    const detail = await harness.service.finalize(runId)

    expect(detail.run.status).toBe('completed_with_issues')
    // The branch still exists in the repository, so its tip is known.
    expect(detail.run.report?.headSha).toBe(repo.baseSha)
    expect(detail.run.report?.integrationWorktreePath).toBe('/nowhere')
  })

  it.each(['preview', 'completed', 'cancelled'] as const)(
    'refuses a run that is %s',
    async (status) => {
      harness.db.updateDocumentRun(runId, { status })

      await expect(harness.service.finalize(runId)).rejects.toThrow(
        'Only a launched run that has not finished yet can be finalized.'
      )
    }
  )
})
