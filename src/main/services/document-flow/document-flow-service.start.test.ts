// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VERIFICATION_LEAD_PARAGRAPH,
  VERIFICATION_PARAGRAPHS,
  buildLaunchPrompt
} from '@shared/document-flow/prompts'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  type DocumentRunLaunchConfig
} from '@shared/types/document-flow'
import { getRpcRequestContext, rpcRequestContext } from '../../../server/rpc/request-context'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  TEST_PROJECT_ID,
  createServiceHarness,
  createTestRepo,
  isolateGitConfig,
  seedRun,
  type ServiceHarness,
  type TestRepo
} from './test-support'

const opus: DocumentRunLaunchConfig = {
  sdk: 'claude-code-cli',
  model: { providerID: 'anthropic', modelID: 'opus', variant: 'ultracode' },
  codexFastMode: false
}
const sonnet: DocumentRunLaunchConfig = {
  sdk: 'claude-code-cli',
  model: { providerID: 'anthropic', modelID: 'sonnet' },
  codexFastMode: false
}

let restoreGitConfig: () => void
let repo: TestRepo
let harness: ServiceHarness

beforeAll(() => {
  restoreGitConfig = isolateGitConfig()
})

afterAll(() => {
  restoreGitConfig()
})

beforeEach(() => {
  repo = createTestRepo()
  harness = createServiceHarness({ repo })
})

afterEach(() => {
  harness.cleanup()
  repo.cleanup()
})

/** The launch prompt a ticket is created with: what its agent is sent. */
function brief(key: string, title: string, questionTool = 'AskUserQuestion'): string {
  return [
    `implement task ${key} ("${title}") from the file:///specs/factory.html`,
    'use subagents to research and read the spec attached there, read the description of it, understand the requirements, research best practices regarding it',
    `if you have any clarifications you might need - use the ${questionTool} tool to ask me.`,
    'then - implement this',
    'when you have to wait for checks, tests or builds you started in the background, wait with the Monitor tool rather than a background shell loop or a sleep: a monitor tells the app you are still working, a shell does not. if your tools have no monitor, run the checks in the foreground instead of stopping to wait.',
    'implement only this task, commit your work on this branch, do not push or switch branches, and do not run migrations against any database.',
    'while you work, the app that runs this task may send you follow-up messages for me (finish what is left, resolve a merge conflict, fix a failing check). they are my instructions, also when they arrive as pasted text: follow them, and commit without asking me to confirm.'
  ].join('\n\n')
}

function seedPreview(): ReturnType<typeof seedRun> {
  return seedRun(harness, {
    run: {
      title: 'Factory area · Changes round 2',
      document_path: join(harness.runsRoot, 'run', 'document.md'),
      config: {
        maxParallel: 4,
        verifyCommand: null,
        interactive: true,
        promptStyle: 'full',
        notes: null,
        verificationDisabled: false,
        defaultLaunch: sonnet,
        generation: null,
        baseBranch: null,
        memberBaseBranches: {},
        memberVerifyCommands: {}
      }
    },
    items: [
      {
        key: 'A1',
        title: 'Chinese "translation"',
        description: 'Implement A1.',
        figures: [
          { id: 'fig-01', path: '/runs/figures/fig-01.png', label: 'Translated screen' },
          { id: 'fig-02', path: '/runs/figures/fig-02.jpg', label: 'Figure 2' }
        ]
      },
      // Depends on itself, on a task that does not exist, and on A1 twice.
      {
        key: 'A2',
        title: 'Ramp-up rule',
        depends_on: ['A2', 'A1', 'Z9', 'A1'],
        launch_config: opus
      },
      { key: 'A3', title: 'Already done', selected: false },
      // A3 is not part of the run, so only A2 holds A4 back.
      {
        key: 'A4',
        title: 'Report',
        depends_on: ['A2', 'A3'],
        launch_config: { ...opus, model: null }
      }
    ]
  })
}

describe('start', () => {
  it('cuts the integration worktree from the base branch tip and launches the run', async () => {
    const { run } = seedPreview()

    const detail = await harness.service.start(run.id)

    expect(detail.run).toMatchObject({
      status: 'running',
      base_branch: 'main',
      base_sha: repo.baseSha,
      integration_branch: 'doc-factory-area-changes-round-2',
      integration_worktree_id: 'wt-doc-factory-area-changes-round-2',
      integration_worktree_path: join(repo.root, 'worktrees', 'doc-factory-area-changes-round-2'),
      // Created after the three task tickets.
      ticket_id: 'ticket-4',
      error: null
    })
    expect(detail.run.started_at).toBeTruthy()
    // Tickets stay pending: launching them is the orchestrator's job.
    expect(detail.items.map((item) => item.status)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending'
    ])

    const worktreePath = detail.run.integration_worktree_path!
    expect(repo.git(worktreePath, 'rev-parse', 'HEAD')).toBe(repo.baseSha)
    expect(repo.git(worktreePath, 'symbolic-ref', '--short', 'HEAD')).toBe(
      'doc-factory-area-changes-round-2'
    )
    expect(detail.events.map((event) => event.type)).toEqual([
      'dependency_warning',
      'dependency_warning',
      'base_resolved',
      'integration_created',
      'tickets_created',
      'run_ticket_created',
      'started'
    ])
  })

  it('asks for a worktree at the pinned base commit, with auto-pull off', async () => {
    const { run } = seedPreview()

    await harness.service.start(run.id)

    // Without `baseRef` the op would duplicate the root checkout, uncommitted files included;
    // with auto-pull it would run `git pull` there.
    expect(harness.worktreeRequests).toEqual([
      {
        projectId: TEST_PROJECT_ID,
        projectPath: repo.projectPath,
        projectName: 'project',
        branchName: 'main',
        nameHint: 'doc-factory-area-changes-round-2',
        autoPull: false,
        baseRef: repo.baseSha
      }
    ])
  })

  it('leaves the base branch and the dirty root checkout untouched', async () => {
    repo.write(repo.projectPath, {
      'src/app.ts': 'export const app = "work in progress"\n',
      'notes.txt': 'untracked\n'
    })
    const statusBefore = repo.git(repo.projectPath, 'status', '--porcelain')
    const { run } = seedPreview()

    const detail = await harness.service.start(run.id)

    expect(repo.git(repo.projectPath, 'rev-parse', 'refs/heads/main')).toBe(repo.baseSha)
    expect(repo.git(repo.projectPath, 'rev-parse', 'HEAD')).toBe(repo.baseSha)
    expect(repo.git(repo.projectPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(repo.git(repo.projectPath, 'status', '--porcelain')).toBe(statusBefore)
    expect(readFileSync(join(repo.projectPath, 'src/app.ts'), 'utf8')).toContain('work in progress')
    // The user's uncommitted work did not leak into the integration worktree.
    const worktreePath = detail.run.integration_worktree_path!
    expect(readFileSync(join(worktreePath, 'src/app.ts'), 'utf8')).toBe('export const app = 1\n')
    expect(existsSync(join(worktreePath, 'notes.txt'))).toBe(false)
  })

  it('uses the configured base branch, and origin/<base> when there is no local branch', async () => {
    const developSha = repo.commit(repo.addWorktree('develop', 'main'), 'on develop', {
      'develop.txt': 'x\n'
    })
    const { run } = seedPreview()
    harness.service.updateRun(run.id, { config: { baseBranch: 'develop' } })

    const detail = await harness.service.start(run.id)

    expect(detail.run).toMatchObject({ base_branch: 'develop', base_sha: developSha })
    expect(harness.worktreeRequests[0]).toMatchObject({
      branchName: 'develop',
      baseRef: developSha
    })

    // A branch that exists only as a remote-tracking ref.
    repo.git(repo.projectPath, 'update-ref', 'refs/remotes/origin/release', repo.baseSha)
    const second = seedPreview().run
    harness.service.updateRun(second.id, { config: { baseBranch: 'release' } })
    expect((await harness.service.start(second.id)).run).toMatchObject({
      base_branch: 'release',
      base_sha: repo.baseSha
    })
  })

  it('takes the branch the root checkout is on as the default base, never a guess', async () => {
    // A trunk that is not main, next to a worktree branch that sorts first.
    repo.commit(repo.addWorktree('akita', 'main'), 'someone else', { 'akita.txt': 'x\n' })
    repo.git(repo.projectPath, 'checkout', '-q', '-b', 'develop')
    const developSha = repo.commit(repo.projectPath, 'on develop', { 'develop.txt': 'x\n' })
    repo.git(repo.projectPath, 'branch', '-D', 'main')
    harness.overrides.getDefaultBranch = async () => 'akita'
    const { run } = seedPreview()

    const detail = await harness.service.start(run.id)

    expect(detail.run).toMatchObject({ base_branch: 'develop', base_sha: developSha })
    expect(harness.worktreeRequests[0]).toMatchObject({
      branchName: 'develop',
      baseRef: developSha
    })
  })

  it('falls back to main or master for a detached root checkout, else asks for a base branch', async () => {
    repo.git(repo.projectPath, 'checkout', '-q', '--detach', 'main')
    harness.overrides.getDefaultBranch = async () => 'akita'
    const first = seedPreview().run
    expect((await harness.service.start(first.id)).run.base_branch).toBe('main')

    // The last resort is only taken when the branch it names exists.
    repo.git(repo.projectPath, 'branch', '-m', 'main', 'trunk')
    const second = seedPreview().run
    await expect(harness.service.start(second.id)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Pick a base branch: project has a detached HEAD and no main or master branch.'
    })
    expect(harness.worktreeRequests).toHaveLength(1)

    harness.overrides.getDefaultBranch = async () => 'trunk'
    const third = seedPreview().run
    expect((await harness.service.start(third.id)).run.base_branch).toBe('trunk')
  })

  it('persists cleaned dependencies and reports what it dropped', async () => {
    const { run } = seedPreview()

    const detail = await harness.service.start(run.id)

    expect(Object.fromEntries(detail.items.map((item) => [item.key, item.depends_on]))).toEqual({
      A1: [],
      A2: ['A1'],
      A3: [],
      A4: ['A2', 'A3']
    })
    expect(
      detail.events.filter((event) => event.type === 'dependency_warning').map((e) => e.message)
    ).toEqual([
      'A2 listed itself as a dependency; ignored.',
      'A2 depends on unknown task "Z9"; ignored.'
    ])
  })

  it("words the brief for the app's default agent when the run names none", async () => {
    const { run } = seedRun(harness, {
      run: { config: { ...DEFAULT_DOCUMENT_RUN_CONFIG } },
      items: [{ key: 'A1', title: 'Report' }]
    })

    await harness.service.start(run.id, 'codex')

    expect(harness.ticketBatches[0].drafts[0].description).toBe(
      brief('A1', 'Report', 'request_user_input')
    )
  })

  it('tells the agent how to verify, after the brief and before the commit rules', async () => {
    const { run } = seedRun(harness, {
      run: { config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, defaultLaunch: sonnet } },
      items: [
        { key: 'A1', title: 'Report', verification: ['playwright', 'tests'] },
        { key: 'A2', title: 'Ramp-up rule' }
      ]
    })

    await harness.service.start(run.id)

    const [{ drafts }] = harness.ticketBatches
    expect(drafts[0].description).toBe(
      buildLaunchPrompt({
        key: 'A1',
        title: 'Report',
        sourcePath: '/specs/factory.html',
        promptStyle: 'full',
        interactive: true,
        sdk: 'claude-code-cli',
        verification: ['playwright', 'tests']
      })
    )
    // The lead, then one paragraph per chosen method, in the order of the methods.
    expect(drafts[0].description).toBe(
      brief('A1', 'Report').replace(
        'then - implement this',
        [
          'then - implement this',
          VERIFICATION_LEAD_PARAGRAPH,
          VERIFICATION_PARAGRAPHS.playwright,
          VERIFICATION_PARAGRAPHS.tests
        ].join('\n\n')
      )
    )
    expect(drafts[0].description).not.toContain(VERIFICATION_PARAGRAPHS.tcu)
    // A ticket with no method chosen is briefed as before.
    expect(drafts[1].description).toBe(brief('A2', 'Ramp-up rule'))
  })

  it('says nothing about verifying when the run skips verification, whatever the tickets chose', async () => {
    const { run } = seedRun(harness, {
      run: {
        config: {
          ...DEFAULT_DOCUMENT_RUN_CONFIG,
          defaultLaunch: sonnet,
          verificationDisabled: true
        }
      },
      items: [{ key: 'A1', title: 'Report', verification: ['playwright', 'tests'] }]
    })

    const detail = await harness.service.start(run.id)

    const [{ drafts }] = harness.ticketBatches
    expect(drafts[0].description).toBe(brief('A1', 'Report'))
    for (const paragraph of [
      VERIFICATION_LEAD_PARAGRAPH,
      ...Object.values(VERIFICATION_PARAGRAPHS)
    ]) {
      expect(drafts[0].description).not.toContain(paragraph)
    }
    // The choice is kept for when verification is turned back on.
    expect(detail.items[0].verification).toEqual(['playwright', 'tests'])
  })

  it("moves the ticket made with the run In Progress, on the integration worktree, instead of creating one", async () => {
    const { run } = seedPreview()
    harness.boardTickets.set('run-ticket', {
      id: 'run-ticket',
      projectId: TEST_PROJECT_ID,
      column: 'todo'
    })
    harness.db.updateDocumentRun(run.id, { ticket_id: 'run-ticket' })

    const detail = await harness.service.start(run.id)

    // Only the task tickets were created.
    expect(harness.ticketBatches).toHaveLength(1)
    expect(harness.ticketBatches[0].drafts.map((draft) => draft.draft_key)).toEqual([
      'A1',
      'A2',
      'A4'
    ])
    expect(detail.run.ticket_id).toBe('run-ticket')
    expect(harness.ticketUpdates).toContainEqual({
      projectId: TEST_PROJECT_ID,
      ticketId: 'run-ticket',
      patch: {
        worktree_id: detail.run.integration_worktree_id,
        description: `Document run of /specs/factory.html. Its branch ${detail.run.integration_branch} collects the merged work of the run's tickets; move this ticket to Done to merge it into main.`
      }
    })
    expect(harness.ticketMoves).toEqual([
      { projectId: TEST_PROJECT_ID, ticketId: 'run-ticket', column: 'in_progress' }
    ])
    expect(harness.boardTickets.get('run-ticket')).toMatchObject({ column: 'in_progress' })
    const types = detail.events.map((event) => event.type)
    expect(types).toContain('run_ticket_moved')
    expect(types).not.toContain('run_ticket_created')
  })

  it('creates a new ticket In Progress when the one made with the run was deleted from the board', async () => {
    const { run } = seedPreview()
    harness.db.updateDocumentRun(run.id, { ticket_id: 'gone-ticket' })

    const detail = await harness.service.start(run.id)

    expect(harness.ticketBatches).toHaveLength(2)
    expect(harness.ticketBatches[1].drafts[0]).toMatchObject({
      draft_key: `run-${run.id}`,
      column: 'in_progress',
      worktree_id: detail.run.integration_worktree_id
    })
    expect(detail.run.ticket_id).not.toBe('gone-ticket')
    expect(harness.boardTickets.get(detail.run.ticket_id!)).toMatchObject({
      column: 'in_progress'
    })
    expect(harness.ticketMoves).toEqual([])
  })

  it('creates one ticket per selected item, with attachments, model and selected dependencies', async () => {
    const { run } = seedPreview()

    const detail = await harness.service.start(run.id)

    // The task tickets, then the run's own ticket.
    expect(harness.ticketBatches).toHaveLength(2)
    const [{ projectId, drafts }] = harness.ticketBatches
    expect(projectId).toBe(TEST_PROJECT_ID)
    expect(drafts).toEqual([
      {
        draft_key: 'A1',
        project_id: TEST_PROJECT_ID,
        // Safe inside the launcher's <ticket title="…">.
        title: 'A1 · Chinese translation',
        description: brief('A1', 'Chinese "translation"'),
        column: 'todo',
        mode: 'build',
        attachments: [
          { type: 'image', url: '/runs/figures/fig-01.png', label: 'Translated screen' },
          { type: 'image', url: '/runs/figures/fig-02.jpg', label: 'Figure 2' },
          {
            type: 'file',
            url: join(harness.runsRoot, 'run', 'document.md'),
            label: 'Full spec (text)'
          }
        ],
        depends_on: [],
        // No launch config of its own: the run default.
        model_provider_id: 'anthropic',
        model_id: 'sonnet',
        model_variant: null
      },
      {
        draft_key: 'A2',
        project_id: TEST_PROJECT_ID,
        title: 'A2 · Ramp-up rule',
        description: brief('A2', 'Ramp-up rule'),
        column: 'todo',
        mode: 'build',
        attachments: [
          {
            type: 'file',
            url: join(harness.runsRoot, 'run', 'document.md'),
            label: 'Full spec (text)'
          }
        ],
        depends_on: ['A1'],
        model_provider_id: 'anthropic',
        model_id: 'opus',
        model_variant: 'ultracode'
      },
      {
        draft_key: 'A4',
        project_id: TEST_PROJECT_ID,
        title: 'A4 · Report',
        description: brief('A4', 'Report'),
        column: 'todo',
        mode: 'build',
        attachments: [
          {
            type: 'file',
            url: join(harness.runsRoot, 'run', 'document.md'),
            label: 'Full spec (text)'
          }
        ],
        // A3 is deselected: it gets no ticket, so nothing can depend on one.
        depends_on: ['A2']
        // Its launch config names no model: the ticket carries none.
      }
    ])
    expect(Object.fromEntries(detail.items.map((item) => [item.key, item.ticket_id]))).toEqual({
      A1: 'ticket-1',
      A2: 'ticket-2',
      A3: null,
      A4: 'ticket-3'
    })
  })

  it('does the worktree and board writes outside the calling request', async () => {
    const contexts: unknown[] = []
    harness.overrides.detach = (task) => rpcRequestContext.exit(task)
    harness.overrides.createTickets = async (_projectId, drafts) => {
      contexts.push(getRpcRequestContext())
      return { tickets: drafts.map((draft) => ({ id: `ticket-${draft.draft_key}` })) }
    }
    const { run } = seedPreview()

    await rpcRequestContext.run({ clientId: 'client-1', principal: null }, () =>
      harness.service.start(run.id)
    )

    // With the caller's client id on them, that client would ignore the `db:changed` events
    // and never reload its board. Two batches: the task tickets and the run's own ticket.
    expect(contexts).toEqual([undefined, undefined])
  })

  it('publishes every write', async () => {
    const { run, items } = seedPreview()

    await harness.service.start(run.id)

    const reasons = harness.published.map((event) => event.reason)
    // A2's cleaned dependencies, three ticket ids.
    expect(reasons.filter((reason) => reason === 'item')).toHaveLength(4)
    // Base, integration worktree, the run's ticket, status.
    expect(reasons.filter((reason) => reason === 'run')).toHaveLength(4)
    expect(reasons.filter((reason) => reason === 'event')).toHaveLength(7)
    expect(harness.published.every((event) => event.runId === run.id)).toBe(true)
    expect(harness.published).toContainEqual({
      runId: run.id,
      projectId: TEST_PROJECT_ID,
      reason: 'item',
      itemId: items[0].id
    })
  })

  it('shares one launch between two calls made at the same time', async () => {
    const { run } = seedPreview()

    const [first, second] = await Promise.all([
      harness.service.start(run.id),
      harness.service.start(run.id)
    ])

    expect(second).toEqual(first)
    expect(harness.worktreeRequests).toHaveLength(1)
    expect(harness.ticketBatches).toHaveLength(2)
  })

  describe("the run's own ticket", () => {
    it('is created In Progress on the integration worktree, marked as the ticket of the run', async () => {
      const { run } = seedPreview()

      const detail = await harness.service.start(run.id)

      const [, { projectId, drafts }] = harness.ticketBatches
      expect(projectId).toBe(TEST_PROJECT_ID)
      expect(drafts).toEqual([
        {
          draft_key: `run-${run.id}`,
          project_id: TEST_PROJECT_ID,
          title: 'Factory area · Changes round 2',
          description:
            "Document run of /specs/factory.html. Its branch doc-factory-area-changes-round-2 collects the merged work of the run's tickets; move this ticket to Done to merge it into main.",
          column: 'in_progress',
          // No session will ever run on it.
          mode: null,
          worktree_id: 'wt-doc-factory-area-changes-round-2',
          external_provider: 'document-run',
          external_id: run.id,
          external_url: '/specs/factory.html'
        }
      ])
      expect(detail.run.ticket_id).toBe('ticket-4')
      expect(harness.boardTickets.get('ticket-4')).toMatchObject({ column: 'in_progress' })
      // None of the run's items claims it.
      expect(detail.items.map((item) => item.ticket_id)).not.toContain('ticket-4')
    })

    it('is not created again by a start that continues after a failure', async () => {
      const { run } = seedPreview()
      await harness.service.start(run.id)
      const ticketId = harness.db.getDocumentRun(run.id)?.ticket_id
      // The status write was lost: the run is started again from the top.
      harness.db.updateDocumentRun(run.id, { status: 'preview' })

      const detail = await harness.service.start(run.id)

      expect(detail.run.ticket_id).toBe(ticketId)
      expect(harness.ticketBatches).toHaveLength(2)
      expect(detail.events.filter((event) => event.type === 'run_ticket_created')).toHaveLength(1)
    })

    it('fails the start when the board cannot create it, and creates it on the next one', async () => {
      const { run } = seedPreview()
      let calls = 0
      harness.overrides.createTickets = async (_projectId, drafts) => {
        calls++
        if (calls === 2) return { tickets: [] }
        return { tickets: drafts.map((draft) => ({ id: `ticket-${draft.draft_key}` })) }
      }

      await expect(harness.service.start(run.id)).rejects.toThrow(
        'The board did not create the ticket of the run.'
      )
      expect(harness.db.getDocumentRun(run.id)).toMatchObject({
        status: 'preview',
        ticket_id: null
      })

      const detail = await harness.service.start(run.id)

      expect(detail.run).toMatchObject({ status: 'running', ticket_id: `ticket-run-${run.id}` })
      // The task tickets of the first attempt were kept: only the run's ticket was missing.
      expect(calls).toBe(3)
    })
  })

  describe('when a step fails', () => {
    it('keeps the run in preview and continues from that step on the next start', async () => {
      const { run } = seedPreview()
      const { db } = harness
      let boardIsDown = true
      harness.overrides.createTickets = async (_projectId, drafts) => {
        if (boardIsDown) throw new Error('database is locked')
        return { tickets: drafts.map((draft) => ({ id: `ticket-${draft.draft_key}` })) }
      }

      await expect(harness.service.start(run.id)).rejects.toMatchObject({
        name: 'RpcRouteError',
        code: 'START_FAILED',
        message: 'database is locked'
      })

      const failed = db.getDocumentRun(run.id)
      expect(failed).toMatchObject({
        status: 'preview',
        base_sha: repo.baseSha,
        integration_branch: 'doc-factory-area-changes-round-2'
      })
      expect(failed?.started_at).toBeNull()
      expect(db.listDocumentRunEvents(run.id).at(-1)).toMatchObject({
        type: 'start_failed',
        message: 'Launch failed: database is locked'
      })

      boardIsDown = false
      const detail = await harness.service.start(run.id)

      expect(detail.run.status).toBe('running')
      // The integration worktree of the first attempt is reused, not created again.
      expect(harness.worktreeRequests).toHaveLength(1)
      expect(detail.run.integration_worktree_id).toBe(failed?.integration_worktree_id)
      expect(repo.git(repo.projectPath, 'worktree', 'list').split('\n')).toHaveLength(2)
      expect(detail.items.filter((item) => item.ticket_id).map((item) => item.key)).toEqual([
        'A1',
        'A2',
        'A4'
      ])
      // Cleaned once: the retry had nothing left to warn about.
      expect(detail.events.filter((event) => event.type === 'dependency_warning')).toHaveLength(2)
    })

    it('creates only the missing tickets and links them to the ones that exist', async () => {
      const { run, items } = seedPreview()
      harness.db.updateDocumentRunItem(items[0].id, { ticket_id: 'existing-a1' })

      await harness.service.start(run.id)

      const [{ drafts }] = harness.ticketBatches
      expect(drafts.map((draft) => [draft.draft_key, draft.depends_on])).toEqual([
        // A1 is not in this batch, so the batch cannot reference it…
        ['A2', []],
        ['A4', ['A2']]
      ])
      // …and the dependency is added between the two tickets afterwards.
      expect(harness.ticketLinks).toEqual([
        { projectId: TEST_PROJECT_ID, dependent: 'ticket-1', blocker: 'existing-a1' }
      ])
      expect(harness.db.getDocumentRunItem(items[0].id)?.ticket_id).toBe('existing-a1')
    })

    it('reports a worktree that could not be created', async () => {
      harness.overrides.createWorktreeFromBranch = async () => ({
        success: false,
        error: 'fatal: a branch named doc-x already exists'
      })
      const { run } = seedPreview()

      await expect(harness.service.start(run.id)).rejects.toThrow(
        'The integration worktree could not be created: fatal: a branch named doc-x already exists'
      )
      expect(harness.db.getDocumentRun(run.id)).toMatchObject({
        status: 'preview',
        integration_worktree_id: null
      })
      expect(harness.ticketBatches).toEqual([])
    })

    it('reports a base branch that does not exist', async () => {
      const { run } = seedPreview()
      harness.service.updateRun(run.id, { config: { baseBranch: 'no-such-branch' } })

      await expect(harness.service.start(run.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
        message: 'Branch "no-such-branch" was not found in project.'
      })
      expect(harness.worktreeRequests).toEqual([])
    })

    it('refuses a board that returned the wrong number of tickets', async () => {
      harness.overrides.createTickets = async () => ({ tickets: [{ id: 'only-one' }] })
      const { run } = seedPreview()

      await expect(harness.service.start(run.id)).rejects.toThrow(
        'The board created 1 tickets for 3 tasks; none were linked.'
      )
      expect(harness.db.getDocumentRunItems(run.id).every((item) => item.ticket_id === null)).toBe(
        true
      )
    })
  })

  it('finishes a start that stopped after the status was written', async () => {
    const { run } = seedRun(harness, { run: { status: 'running' }, items: [{}] })

    const detail = await harness.service.start(run.id)

    expect(detail.run).toMatchObject({ status: 'running', base_sha: repo.baseSha })
    expect(detail.run.integration_worktree_id).toBeTruthy()
    expect(detail.items[0].ticket_id).toBe('ticket-1')
  })

  it.each([
    ['extracting', 'The tickets are not ready yet.'],
    ['extract_failed', 'The tickets are not ready yet.'],
    ['paused', 'This run was already launched.'],
    ['completed', 'This run was already launched.'],
    ['cancelled', 'This run was already launched.']
  ] as const)('refuses a run that is %s', async (status, message) => {
    const { run } = seedRun(harness, { run: { status }, items: [{}] })

    await expect(harness.service.start(run.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message
    })
    expect(harness.worktreeRequests).toEqual([])
  })

  it('refuses a run that was already launched', async () => {
    const { run } = seedPreview()
    await harness.service.start(run.id)

    await expect(harness.service.start(run.id)).rejects.toThrow('This run was already launched.')
    expect(harness.worktreeRequests).toHaveLength(1)
  })

  it('refuses to launch with nothing selected', async () => {
    const { run } = seedRun(harness, { items: [{ selected: false }, { selected: false }] })

    await expect(harness.service.start(run.id)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Select at least one ticket to launch.'
    })
  })

  it('refuses a project that is gone or a connection without two members', async () => {
    const { run } = seedRun(harness, { items: [{}] })
    harness.projects.set(TEST_PROJECT_ID, {
      ...harness.projects.get(TEST_PROJECT_ID)!,
      kind: 'connection',
      member_project_ids: null
    })
    await expect(harness.service.start(run.id)).rejects.toThrow(
      'project needs at least two member projects to implement a document in; it has 0.'
    )

    harness.projects.delete(TEST_PROJECT_ID)
    await expect(harness.service.start(run.id)).rejects.toThrow(
      'The project of this run was not found.'
    )
    await expect(harness.service.start('missing')).rejects.toThrow('The run was not found.')
  })
})
