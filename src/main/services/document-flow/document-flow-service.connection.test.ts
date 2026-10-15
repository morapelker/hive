// @vitest-environment node
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { integrationBranchHint } from '@shared/document-flow/planning'
import { connectionWorkspaceParagraph } from '@shared/document-flow/prompts'
import type {
  DocumentRun,
  DocumentRunItem,
  DocumentRunItemMember
} from '@shared/types/document-flow'
import type { DocumentRunItemRowPatch, DocumentRunRowPatch } from './db-port'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  TEST_CONNECTION_PROJECT_ID,
  TEST_MEMBER_PROJECTS,
  createServiceHarness,
  createTestRepo,
  isolateGitConfig,
  seedRun,
  type ServiceHarness,
  type TestRepo
} from './test-support'

// A run on a connection project: the integration "worktree" is an instance over one worktree
// per member repository, and every git step happens per member — the merge all or nothing.

const [WEB, API] = TEST_MEMBER_PROJECTS
const INTEGRATION = integrationBranchHint('Factory spec')

let restoreGitConfig: () => void
let web: TestRepo
let api: TestRepo
let harness: ServiceHarness

beforeAll(() => {
  restoreGitConfig = isolateGitConfig()
})

afterAll(() => {
  restoreGitConfig()
})

beforeEach(() => {
  web = createTestRepo()
  api = createTestRepo()
  harness = createServiceHarness({ members: [web, api] })
})

afterEach(() => {
  harness.cleanup()
  web.cleanup()
  api.cleanup()
})

const repoOf = (projectId: string): TestRepo => (projectId === WEB.id ? web : api)

/** A preview run on the connection project with tickets A1, A2 (and A3, deselected). */
function seedPreview(runPatch: DocumentRunRowPatch = {}): DocumentRun {
  return seedRun(harness, {
    run: { project_id: TEST_CONNECTION_PROJECT_ID, ...runPatch },
    items: [
      { key: 'A1', title: 'Chinese translation' },
      { key: 'A2', title: 'Ramp-up rule', has_migration: true },
      { key: 'A3', title: 'Not in this run', selected: false }
    ]
  }).run
}

/** A launched run: two integration worktrees linked into one instance. */
async function launchRun(): Promise<DocumentRun> {
  const run = seedPreview()
  const detail = await harness.service.start(run.id)
  return detail.run
}

const currentRun = (runId: string): DocumentRun => harness.db.getDocumentRun(runId)!
const itemByKey = (runId: string, key: string): DocumentRunItem => {
  const item = harness.db.getDocumentRunItems(runId).find((candidate) => candidate.key === key)
  if (!item) throw new Error(`no item ${key}`)
  return item
}
const memberOf = (run: DocumentRun, projectId: string) =>
  run.members!.find((member) => member.project_id === projectId)!
const integrationPathOf = (run: DocumentRun, projectId: string): string =>
  memberOf(run, projectId).integration_worktree_path
const headOf = (run: DocumentRun, projectId: string): string =>
  repoOf(projectId).git(integrationPathOf(run, projectId), 'rev-parse', 'HEAD')
const eventTypes = (runId: string): string[] =>
  harness.db.listDocumentRunEvents(runId).map((event) => event.type)
const mergeInProgress = (repo: TestRepo, cwd: string): boolean => {
  try {
    repo.git(cwd, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')
    return true
  } catch {
    return false
  }
}

/**
 * Give a ticket an instance with a worktree per member, each cut from that member's integration
 * branch, as the orchestrator does. Returns the ticket worktree paths by member project id.
 */
function launchTicket(
  run: DocumentRun,
  key: string,
  patch: DocumentRunItemRowPatch = {}
): Record<string, string> {
  const branch = `${key.toLowerCase()}-task`
  const paths: Record<string, string> = {}
  const members = run.members!.map((member): DocumentRunItemMember => {
    const repo = repoOf(member.project_id)
    const path = repo.addWorktree(branch, member.integration_branch)
    const id = `wt-${member.project_name}-${key}`
    harness.worktrees.set(id, { id, path, branch_name: branch, project_id: member.project_id })
    paths[member.project_id] = path
    return {
      project_id: member.project_id,
      worktree_id: id,
      branch_name: branch,
      pre_merge_sha: null,
      merge_sha: null
    }
  })
  harness.db.updateDocumentRunItem(itemByKey(run.id, key).id, {
    status: 'running',
    connection_id: `connection-${key}`,
    members,
    branch_name: branch,
    session_id: `session-${key}`,
    ...patch
  })
  return paths
}

describe('start on a connection project', () => {
  it('cuts an integration worktree per member from its base and links them into one instance', async () => {
    const run = await launchRun()

    expect(harness.worktreeRequests).toEqual([
      {
        projectId: WEB.id,
        projectPath: web.projectPath,
        projectName: 'web',
        branchName: 'main',
        nameHint: INTEGRATION,
        autoPull: false,
        baseRef: web.baseSha
      },
      {
        projectId: API.id,
        projectPath: api.projectPath,
        projectName: 'api',
        branchName: 'main',
        nameHint: INTEGRATION,
        autoPull: false,
        baseRef: api.baseSha
      }
    ])
    expect(harness.connectionRequests).toEqual([
      {
        worktreeIds: [`wt-web-${INTEGRATION}`, `wt-api-${INTEGRATION}`],
        savedProjectId: TEST_CONNECTION_PROJECT_ID
      }
    ])
    const connection = harness.connections.get('connection-1')!
    expect(run).toMatchObject({
      status: 'running',
      base_branch: 'main',
      base_sha: null,
      integration_branch: INTEGRATION,
      integration_worktree_id: null,
      integration_worktree_path: null,
      integration_connection_id: 'connection-1',
      integration_connection_path: connection.path,
      members: [
        {
          project_id: WEB.id,
          project_name: 'web',
          project_path: web.projectPath,
          symlink_name: 'web',
          base_branch: 'main',
          base_sha: web.baseSha,
          integration_branch: INTEGRATION,
          integration_worktree_id: `wt-web-${INTEGRATION}`,
          integration_worktree_path: harness.worktrees.get(`wt-web-${INTEGRATION}`)!.path
        },
        {
          project_id: API.id,
          project_name: 'api',
          project_path: api.projectPath,
          symlink_name: 'api',
          base_branch: 'main',
          base_sha: api.baseSha,
          integration_branch: INTEGRATION,
          integration_worktree_id: `wt-api-${INTEGRATION}`,
          integration_worktree_path: harness.worktrees.get(`wt-api-${INTEGRATION}`)!.path
        }
      ]
    })
    // The instance directory links each member's integration worktree under the member's name.
    for (const member of run.members!) {
      expect(realpathSync(join(connection.path, member.symlink_name))).toBe(
        member.integration_worktree_path
      )
      expect(
        repoOf(member.project_id).git(member.integration_worktree_path, 'rev-parse', 'HEAD')
      ).toBe(member.base_sha)
    }
    // Named after the run, like the branches.
    expect(harness.connectionRenames).toEqual([
      { connectionId: 'connection-1', name: 'Factory spec' }
    ])
    expect(eventTypes(run.id)).toEqual([
      'base_resolved',
      'integration_created',
      'tickets_created',
      'run_ticket_created',
      'started'
    ])
    expect(harness.db.listDocumentRunEvents(run.id)[1].message).toBe(
      `Integration instance created at ${connection.path}: web on ${INTEGRATION}, api on ${INTEGRATION}`
    )
  })

  it('honours a base branch picked per member and labels the run with the distinct ones', async () => {
    const develop = api.commit(api.projectPath, 'develop', {
      'src/api.ts': 'export const api = 2\n'
    })
    api.git(api.projectPath, 'branch', 'develop', develop)
    api.git(api.projectPath, 'reset', '--hard', api.baseSha)
    const seeded = seedPreview()
    harness.service.updateRun(seeded.id, {
      config: { memberBaseBranches: { [API.id]: 'develop' } }
    })

    const run = (await harness.service.start(seeded.id)).run

    expect(run.base_branch).toBe('main + develop')
    expect(memberOf(run, WEB.id)).toMatchObject({ base_branch: 'main', base_sha: web.baseSha })
    expect(memberOf(run, API.id)).toMatchObject({ base_branch: 'develop', base_sha: develop })
    expect(harness.worktreeRequests[1]).toMatchObject({ branchName: 'develop', baseRef: develop })
    expect(harness.db.listDocumentRunEvents(run.id)[0].message).toBe(
      `Base: web main at ${web.baseSha.slice(0, 8)}, api develop at ${develop.slice(0, 8)}`
    )
  })

  it('briefs every ticket about the connection directory and gives the run a ticket without a worktree', async () => {
    const run = await launchRun()

    const [tickets, runTicket] = harness.ticketBatches
    expect(tickets.drafts.map((draft) => draft.draft_key)).toEqual(['A1', 'A2'])
    const paragraph = connectionWorkspaceParagraph([
      { symlinkName: 'web', projectName: 'web' },
      { symlinkName: 'api', projectName: 'api' }
    ])
    for (const draft of tickets.drafts) expect(draft.description).toContain(paragraph)

    expect(runTicket.drafts).toHaveLength(1)
    expect(runTicket.drafts[0]).toMatchObject({
      draft_key: `run-${run.id}`,
      worktree_id: null,
      external_provider: 'document-run',
      external_id: run.id
    })
    expect(runTicket.drafts[0].description).toBe(
      `Document run of /specs/factory.html. Its integration instance at ${run.integration_connection_path} collects the merged work of the run's tickets, one branch per member repository — web: ${INTEGRATION} (from main), api: ${INTEGRATION} (from main); move this ticket to Done to merge each into its base branch.`
    )
    expect(run.ticket_id).toBe('ticket-3')
  })

  it('does not mark the run when the instance cannot be created, and a retry starts over', async () => {
    const seeded = seedPreview()
    harness.overrides.createConnection = async () => ({ success: false, error: 'disk full' })

    await expect(harness.service.start(seeded.id)).rejects.toMatchObject({
      code: 'START_FAILED',
      message: 'The integration instance could not be created: disk full'
    })
    expect(currentRun(seeded.id)).toMatchObject({
      status: 'preview',
      integration_connection_id: null,
      integration_connection_path: null,
      members: null,
      ticket_id: null
    })
    expect(harness.ticketBatches).toEqual([])

    delete harness.overrides.createConnection
    const run = (await harness.service.start(seeded.id)).run
    expect(run.status).toBe('running')
    expect(run.integration_connection_id).toBe('connection-1')
    // Fresh worktrees: the first attempt's are left behind, never reused half-known.
    expect(run.members!.map((member) => member.integration_worktree_id)).toEqual([
      `wt-web-${INTEGRATION}-2`,
      `wt-api-${INTEGRATION}-2`
    ])
    expect(harness.worktreeRequests).toHaveLength(4)
  })

  it('refuses to change a member base branch once launched, and merges the member maps otherwise', async () => {
    const seeded = seedPreview()
    const config = harness.service.updateRun(seeded.id, {
      config: {
        memberVerifyCommands: { [WEB.id]: '  pnpm check ', [API.id]: null },
        memberBaseBranches: { [API.id]: ' main ' }
      }
    }).config
    expect(config.memberVerifyCommands).toEqual({ [WEB.id]: 'pnpm check', [API.id]: null })
    expect(config.memberBaseBranches).toEqual({ [API.id]: 'main' })
    expect(
      harness.service.updateRun(seeded.id, {
        config: { memberVerifyCommands: { [API.id]: 'make' } }
      }).config.memberVerifyCommands
    ).toEqual({ [WEB.id]: 'pnpm check', [API.id]: 'make' })

    await harness.service.start(seeded.id)
    expect(() =>
      harness.service.updateRun(seeded.id, {
        config: { memberBaseBranches: { [API.id]: 'develop' } }
      })
    ).toThrow('The base branch can only be changed while the run is in preview.')
    // Writing the same branches back is not a change.
    expect(() =>
      harness.service.updateRun(seeded.id, { config: { memberBaseBranches: { [API.id]: 'main' } } })
    ).not.toThrow()
    // The verify commands stay editable mid-run.
    expect(
      harness.service.updateRun(seeded.id, { config: { memberVerifyCommands: { [WEB.id]: '' } } })
        .config.memberVerifyCommands
    ).toEqual({ [WEB.id]: '', [API.id]: 'make' })
  })
})

describe('addMember on a connection run', () => {
  const MOBILE = { id: 'member-mobile', name: 'mobile' }
  let mobile: TestRepo

  beforeEach(() => {
    mobile = createTestRepo()
    harness.addProject(MOBILE, mobile)
  })

  afterEach(() => {
    mobile.cleanup()
  })

  /** Register the instance `launchTicket` named for the ticket, so a member can be linked into it. */
  function registerInstance(run: DocumentRun, key: string, paths: Record<string, string>): void {
    const id = `connection-${key}`
    const path = join(harness.scratch, 'connections', id)
    mkdirSync(path, { recursive: true })
    const members = run.members!.map((member) => {
      symlinkSync(paths[member.project_id], join(path, member.symlink_name))
      return {
        project_id: member.project_id,
        worktree_id: `wt-${member.project_name}-${key}`,
        symlink_name: member.symlink_name
      }
    })
    harness.connections.set(id, {
      id,
      name: id,
      path,
      status: 'active',
      saved_project_id: TEST_CONNECTION_PROJECT_ID,
      members
    })
  }

  it('cuts the repository an integration worktree, links it into the instance and the project, and gives the tickets at work a worktree in it', async () => {
    const run = await launchRun()
    registerInstance(run, 'A1', launchTicket(run, 'A1'))
    // A2 is merged already: nothing is added to it. A3 is not in the run.
    registerInstance(run, 'A2', launchTicket(run, 'A2', { status: 'merged' }))
    const before = harness.worktreeRequests.length

    const detail = await harness.service.addMember(run.id, { projectId: MOBILE.id })

    // The connection project first: a ticket launched from now on builds its instance from it.
    expect(harness.projectMemberAdds).toEqual([
      { projectId: TEST_CONNECTION_PROJECT_ID, memberProjectId: MOBILE.id }
    ])
    expect(
      JSON.parse(harness.projects.get(TEST_CONNECTION_PROJECT_ID)!.member_project_ids!)
    ).toEqual([WEB.id, API.id, MOBILE.id])

    // Its integration worktree, cut like the others were at launch, then a worktree for A1 cut
    // from that integration branch and named after the ticket.
    expect(harness.worktreeRequests.slice(before)).toEqual([
      {
        projectId: MOBILE.id,
        projectPath: mobile.projectPath,
        projectName: 'mobile',
        branchName: 'main',
        nameHint: INTEGRATION,
        autoPull: false,
        baseRef: mobile.baseSha
      },
      {
        projectId: MOBILE.id,
        projectPath: mobile.projectPath,
        projectName: 'mobile',
        branchName: 'main',
        nameHint: 'a1-task',
        autoPull: false,
        baseRef: mobile.baseSha
      }
    ])
    expect(harness.connectionMemberAdds).toEqual([
      { connectionId: 'connection-1', worktreeId: `wt-mobile-${INTEGRATION}` },
      { connectionId: 'connection-A1', worktreeId: 'wt-mobile-a1-task' }
    ])

    const worktree = harness.worktrees.get(`wt-mobile-${INTEGRATION}`)!
    expect(detail.run.members).toHaveLength(3)
    expect(detail.run.members![2]).toEqual({
      project_id: MOBILE.id,
      project_name: 'mobile',
      project_path: mobile.projectPath,
      symlink_name: 'mobile',
      base_branch: 'main',
      base_sha: mobile.baseSha,
      integration_branch: INTEGRATION,
      integration_worktree_id: worktree.id,
      integration_worktree_path: worktree.path
    })
    expect(detail.run).toMatchObject({
      status: 'running',
      base_branch: 'main',
      integration_branch: INTEGRATION,
      integration_connection_id: 'connection-1'
    })
    expect(detail.run.config.memberBaseBranches[MOBILE.id]).toBe('main')
    // Linked into the instance directory under the member's name, on its integration branch.
    const connection = harness.connections.get('connection-1')!
    expect(realpathSync(join(connection.path, 'mobile'))).toBe(worktree.path)
    expect(mobile.git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(INTEGRATION)

    // A1's instance has the member now; A2's (merged) is left alone.
    const a1 = itemByKey(run.id, 'A1')
    expect(a1.members).toHaveLength(3)
    expect(a1.members![2]).toEqual({
      project_id: MOBILE.id,
      worktree_id: 'wt-mobile-a1-task',
      branch_name: 'a1-task',
      pre_merge_sha: null,
      merge_sha: null
    })
    expect(realpathSync(join(harness.connections.get('connection-A1')!.path, 'mobile'))).toBe(
      harness.worktrees.get('wt-mobile-a1-task')!.path
    )
    expect(itemByKey(run.id, 'A2').members).toHaveLength(2)
    expect(existsSync(join(harness.connections.get('connection-A2')!.path, 'mobile'))).toBe(false)

    // The run's ticket names the new member's branches too.
    expect(harness.ticketUpdates).toContainEqual({
      projectId: TEST_CONNECTION_PROJECT_ID,
      ticketId: run.ticket_id,
      patch: { description: expect.stringContaining(`mobile: ${INTEGRATION} (from main)`) }
    })
    const events = harness.db.listDocumentRunEvents(run.id).filter((e) => e.type === 'member_added')
    expect(events.map((event) => event.item_id)).toEqual([null, a1.id])
    expect(events[0].message).toContain('mobile joined the run')
  })

  it('cuts from the branch given, and remembers it as the member base branch', async () => {
    const run = await launchRun()
    const developSha = mobile.commit(mobile.projectPath, 'develop', { 'dev.txt': 'dev\n' })
    mobile.git(mobile.projectPath, 'branch', 'develop')
    mobile.git(mobile.projectPath, 'reset', '--hard', mobile.baseSha)

    const detail = await harness.service.addMember(run.id, {
      projectId: MOBILE.id,
      baseBranch: 'develop'
    })

    expect(harness.worktreeRequests.at(-1)).toMatchObject({
      projectId: MOBILE.id,
      branchName: 'develop',
      baseRef: developSha
    })
    expect(detail.run.members![2]).toMatchObject({ base_branch: 'develop', base_sha: developSha })
    expect(detail.run.base_branch).toBe('main + develop')
    expect(detail.run.config.memberBaseBranches[MOBILE.id]).toBe('develop')
  })

  it('refuses a repository that is already in, a connection project, an unknown branch, and a run that is not at work', async () => {
    const run = await launchRun()

    await expect(harness.service.addMember(run.id, { projectId: WEB.id })).rejects.toThrow(
      'web is already a member of this run.'
    )
    await expect(
      harness.service.addMember(run.id, { projectId: TEST_CONNECTION_PROJECT_ID })
    ).rejects.toThrow('A connection project cannot be added as a repository.')
    await expect(harness.service.addMember(run.id, { projectId: 'nope' })).rejects.toThrow(
      'The project was not found.'
    )
    await expect(
      harness.service.addMember(run.id, { projectId: MOBILE.id, baseBranch: 'release' })
    ).rejects.toThrow('Branch "release" was not found in mobile.')
    expect(eventTypes(run.id)).toContain('member_add_failed')
    expect(currentRun(run.id).members).toHaveLength(2)

    const preview = seedPreview()
    await expect(harness.service.addMember(preview.id, { projectId: MOBILE.id })).rejects.toThrow(
      'The run has not been launched yet'
    )
    harness.db.updateDocumentRun(run.id, { status: 'completed' })
    await expect(harness.service.addMember(run.id, { projectId: MOBILE.id })).rejects.toThrow(
      'A finished run cannot take another repository.'
    )
    expect(harness.worktreeRequests.filter((r) => r.projectId === MOBILE.id)).toEqual([])
  })

  it('does not mark the run when the worktree cannot be linked into the instance', async () => {
    const run = await launchRun()
    harness.overrides.addConnectionMember = async () => ({ success: false, error: 'disk full' })

    await expect(harness.service.addMember(run.id, { projectId: MOBILE.id })).rejects.toThrow(
      'The integration worktree of mobile could not be linked into the instance: disk full'
    )

    const current = currentRun(run.id)
    expect(current.members).toHaveLength(2)
    expect(current.config.memberBaseBranches[MOBILE.id]).toBeUndefined()
    expect(eventTypes(run.id)).toContain('member_add_failed')
    // The project did join: a retry starts from there.
    expect(harness.projectMemberAdds).toHaveLength(1)
  })

  it('goes on with the other tickets when one cannot take the member, and says so on that ticket', async () => {
    const run = await launchRun()
    registerInstance(run, 'A1', launchTicket(run, 'A1'))
    // A2 names an instance that no longer exists.
    launchTicket(run, 'A2')

    const detail = await harness.service.addMember(run.id, { projectId: MOBILE.id })

    expect(detail.run.members).toHaveLength(3)
    expect(itemByKey(run.id, 'A1').members).toHaveLength(3)
    expect(itemByKey(run.id, 'A2').members).toHaveLength(2)
    const failed = harness.db
      .listDocumentRunEvents(run.id)
      .filter((event) => event.type === 'member_add_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ item_id: itemByKey(run.id, 'A2').id })
    expect(failed[0].message).toContain('A2 got no worktree in mobile')
  })
})

describe('reconcileRunTickets on a connection run', () => {
  it('re-creates a missing run ticket while the instance is active, and re-points the ticket worktrees', async () => {
    const run = await launchRun()
    launchTicket(run, 'A1')
    for (const worktree of harness.worktrees.values()) {
      if (worktree.id.endsWith('-A1')) worktree.base_branch = INTEGRATION
    }
    harness.db.updateDocumentRun(run.id, { ticket_id: null })

    await harness.service.reconcileRunTickets()

    expect(currentRun(run.id).ticket_id).toBe('ticket-4')
    expect(harness.ticketBatches.at(-1)!.drafts[0]).toMatchObject({
      draft_key: `run-${run.id}`,
      worktree_id: null,
      column: 'in_progress'
    })
    expect(harness.baseBranchWrites).toEqual([
      { worktreeId: 'wt-web-A1', baseBranch: 'main' },
      { worktreeId: 'wt-api-A1', baseBranch: 'main' }
    ])
  })

  it('leaves a run alone once its instance is archived or gone', async () => {
    const run = await launchRun()
    harness.db.updateDocumentRun(run.id, { ticket_id: null })
    harness.connections.get('connection-1')!.status = 'archived'
    await harness.service.reconcileRunTickets()
    expect(currentRun(run.id).ticket_id).toBeNull()

    harness.connections.delete('connection-1')
    await harness.service.reconcileRunTickets()
    expect(currentRun(run.id).ticket_id).toBeNull()
    expect(harness.ticketBatches).toHaveLength(2)
  })
})

describe('classify on a connection run', () => {
  it('reads the final message from the ticket instance and sums the git facts over the members', async () => {
    const run = await launchRun()
    const paths = launchTicket(run, 'A1')
    web.commit(paths[WEB.id], 'web work', { 'src/web.ts': 'export const web = 1\n' })
    api.commit(paths[API.id], 'api work 1', { 'src/api.ts': 'export const api = 1\n' })
    api.commit(paths[API.id], 'api work 2', { 'src/api.ts': 'export const api = 2\n' })
    api.write(paths[API.id], { 'scratch.txt': 'uncommitted\n' })
    harness.connections.set('connection-A1', {
      id: 'connection-A1',
      name: 'A1',
      path: '/connections/a1',
      status: 'active',
      saved_project_id: TEST_CONNECTION_PROJECT_ID,
      members: []
    })
    const finalMessageRequests: unknown[] = []
    harness.overrides.resolveFinalMessage = async (input) => {
      finalMessageRequests.push(input)
      return 'Done.\n\nSTATUS: DONE'
    }
    harness.replies.push(
      JSON.stringify({
        status: 'done',
        reason: 'Committed in both repositories.',
        question: null,
        summary: 'Done.',
        migrations: [],
        manualSteps: [],
        confidence: 'high'
      })
    )

    const verdict = await harness.service.classify({
      runId: run.id,
      itemId: itemByKey(run.id, 'A1').id
    })

    expect(verdict.status).toBe('done')
    expect(finalMessageRequests).toEqual([
      { sessionId: 'session-A1', worktreePath: '/connections/a1' }
    ])
    expect(harness.generateCalls[0].prompt).toContain(
      'Commits on the ticket branch that the integration branch does not have: 3'
    )
    expect(harness.generateCalls[0].prompt).toContain(
      'Uncommitted changes in the ticket worktree: yes'
    )
  })
})

describe('merge on a connection run', () => {
  it('merges only the members the ticket touched and records every member pre-merge commit', async () => {
    const run = await launchRun()
    const paths = launchTicket(run, 'A1')
    const webTip = web.commit(paths[WEB.id], 'web work', { 'src/web.ts': 'export const web = 1\n' })
    const webBefore = headOf(run, WEB.id)
    const apiBefore = headOf(run, API.id)
    const item = itemByKey(run.id, 'A1')

    const check = await harness.service.prepareMerge(run.id, item.id)
    expect(check).toEqual({
      state: 'clean',
      conflictedFiles: [],
      integrationHead: `web=${webBefore},api=${apiBefore}`,
      members: [
        {
          project_id: WEB.id,
          project_name: 'web',
          symlink_name: 'web',
          integrationBranch: INTEGRATION,
          integrationHead: webBefore,
          state: 'clean',
          conflictedFiles: [],
          commitsAhead: 1
        },
        {
          project_id: API.id,
          project_name: 'api',
          symlink_name: 'api',
          integrationBranch: INTEGRATION,
          integrationHead: apiBefore,
          state: 'no_changes',
          conflictedFiles: [],
          commitsAhead: 0
        }
      ],
      committed: false,
      commitsAhead: 1
    })

    const result = await harness.service.merge(run.id, item.id)
    const webAfter = headOf(run, WEB.id)
    expect(result).toEqual({ success: true, mergeSha: `web=${webAfter}` })
    expect(webAfter).not.toBe(webBefore)
    expect(web.git(integrationPathOf(run, WEB.id), 'rev-parse', 'HEAD^2')).toBe(webTip)
    expect(headOf(run, API.id)).toBe(apiBefore)

    const merged = itemByKey(run.id, 'A1')
    expect(merged.members).toEqual([
      {
        project_id: WEB.id,
        worktree_id: 'wt-web-A1',
        branch_name: 'a1-task',
        pre_merge_sha: webBefore,
        merge_sha: webAfter
      },
      {
        project_id: API.id,
        worktree_id: 'wt-api-A1',
        branch_name: 'a1-task',
        pre_merge_sha: apiBefore,
        merge_sha: null
      }
    ])
    expect(merged.pre_merge_sha).toBe(`web=${webBefore},api=${apiBefore}`)
    expect(merged.merge_sha).toBe(`web=${webAfter}`)
    const event = harness.db.listDocumentRunEvents(run.id).at(-1)!
    expect(event).toMatchObject({
      type: 'merged',
      item_id: item.id,
      message: `A1 merged into ${INTEGRATION} of web`
    })

    // Asked again: the merge is recognised, nothing moves.
    expect(await harness.service.prepareMerge(run.id, item.id)).toMatchObject({
      state: 'clean',
      alreadyMerged: true,
      commitsAhead: 0
    })
    expect(await harness.service.merge(run.id, item.id)).toEqual({
      success: true,
      alreadyMerged: true,
      mergeSha: `web=${webAfter}`
    })
    expect(headOf(run, WEB.id)).toBe(webAfter)
  })

  it('reports no changes when the ticket brought nothing to any member', async () => {
    const run = await launchRun()
    launchTicket(run, 'A1')
    const item = itemByKey(run.id, 'A1')

    expect(await harness.service.prepareMerge(run.id, item.id)).toMatchObject({
      state: 'no_changes',
      commitsAhead: 0,
      integrationHead: `web=${headOf(run, WEB.id)},api=${headOf(run, API.id)}`
    })
    expect(await harness.service.merge(run.id, item.id)).toEqual({
      success: true,
      alreadyMerged: true
    })
    expect(itemByKey(run.id, 'A1').pre_merge_sha).toBeNull()
  })

  it('rolls the first member back when the second conflicts, and prefixes the files', async () => {
    const run = await launchRun()
    const paths = launchTicket(run, 'A1')
    web.commit(paths[WEB.id], 'web work', { 'src/app.ts': 'export const app = 2\n' })
    api.commit(paths[API.id], 'api work', { 'src/shared.ts': 'export const shared = "ticket"\n' })
    // Meanwhile api's integration branch changed the same line.
    api.commit(integrationPathOf(run, API.id), 'other ticket', {
      'src/shared.ts': 'export const shared = "other"\n'
    })
    const webBefore = headOf(run, WEB.id)
    const apiBefore = headOf(run, API.id)
    const item = itemByKey(run.id, 'A1')

    const check = await harness.service.prepareMerge(run.id, item.id)
    expect(check).toMatchObject({
      state: 'conflict',
      conflictedFiles: ['api/src/shared.ts'],
      integrationHead: `web=${webBefore},api=${apiBefore}`,
      commitsAhead: 2
    })
    expect(
      check.members!.map((member) => [member.symlink_name, member.state, member.conflictedFiles])
    ).toEqual([
      ['web', 'clean', []],
      ['api', 'conflict', ['src/shared.ts']]
    ])

    const result = await harness.service.merge(run.id, item.id)
    expect(result).toEqual({ success: false, conflictedFiles: ['api/src/shared.ts'] })
    // web was merged and reset again; api's merge was aborted.
    expect(headOf(run, WEB.id)).toBe(webBefore)
    expect(headOf(run, API.id)).toBe(apiBefore)
    expect(mergeInProgress(api, integrationPathOf(run, API.id))).toBe(false)
    expect(mergeInProgress(web, integrationPathOf(run, WEB.id))).toBe(false)
    const after = itemByKey(run.id, 'A1')
    expect(after.members!.map((member) => [member.pre_merge_sha, member.merge_sha])).toEqual([
      [null, null],
      [null, null]
    ])
    expect(after.pre_merge_sha).toBeNull()
    expect(after.merge_sha).toBeNull()
    const failed = harness.db.listDocumentRunEvents(run.id).at(-1)!
    expect(failed).toMatchObject({
      type: 'merge_failed',
      message: `A1 conflicts with ${INTEGRATION} of api in 1 file(s); the merge into web was undone`,
      data: {
        conflictedFiles: ['api/src/shared.ts'],
        member: { project_id: API.id, symlink_name: 'api' },
        undone: ['web']
      }
    })
  })

  it('refuses a ticket that lacks a worktree in a member', async () => {
    const run = await launchRun()
    launchTicket(run, 'A1')
    const item = itemByKey(run.id, 'A1')
    harness.db.updateDocumentRunItem(item.id, { members: item.members!.slice(0, 1) })

    expect(await harness.service.prepareMerge(run.id, item.id)).toMatchObject({
      state: 'error',
      error: 'A1 has no worktree in api to merge.'
    })
    expect(await harness.service.merge(run.id, item.id)).toEqual({
      success: false,
      error: 'A1 has no worktree in api to merge.'
    })
  })

  it('names the member when a check fails in it', async () => {
    const run = await launchRun()
    const paths = launchTicket(run, 'A1')
    api.git(paths[API.id], 'checkout', '--detach')
    const item = itemByKey(run.id, 'A1')

    expect(await harness.service.prepareMerge(run.id, item.id)).toMatchObject({
      state: 'error',
      error: 'api: The worktree of A1 has a detached HEAD checked out, not a1-task.'
    })
  })
})

describe('verify on a connection run', () => {
  const runs: { command: string; cwd: string }[] = []

  beforeEach(() => {
    runs.length = 0
    harness.overrides.runVerify = async (command, cwd) => {
      runs.push({ command, cwd })
      const fails = command.includes('fail')
      return {
        exitCode: fails ? 2 : 0,
        timedOut: false,
        output: `${command} in ${cwd}`,
        durationMs: 10
      }
    }
  })

  it('is skipped while no member has a command', async () => {
    const run = await launchRun()
    harness.db.updateDocumentRun(run.id, {
      config: {
        ...run.config,
        verifyCommand: 'ignored for a connection',
        memberVerifyCommands: { [WEB.id]: '  ' }
      }
    })

    expect(await harness.service.verify(run.id)).toMatchObject({ skipped: true, ok: true })
    expect(runs).toEqual([])
  })

  it('runs each member command in its integration worktree and stops at the first failure', async () => {
    const run = await launchRun()
    harness.db.updateDocumentRun(run.id, {
      config: {
        ...run.config,
        memberVerifyCommands: { [WEB.id]: 'pnpm check', [API.id]: 'make fail' }
      }
    })

    const result = await harness.service.verify(run.id)

    expect(runs).toEqual([
      { command: 'pnpm check', cwd: integrationPathOf(run, WEB.id) },
      { command: 'make fail', cwd: integrationPathOf(run, API.id) }
    ])
    expect(result).toEqual({
      skipped: false,
      ok: false,
      exitCode: 2,
      timedOut: false,
      output: `make fail in ${integrationPathOf(run, API.id)}`,
      durationMs: 20,
      failedMember: {
        project_id: API.id,
        project_name: 'api',
        symlink_name: 'api',
        command: 'make fail'
      }
    })
    const events = harness.db.listDocumentRunEvents(run.id).slice(-2)
    expect(events.map((event) => [event.type, event.message])).toEqual([
      ['verify_passed', 'Verify passed in web: pnpm check'],
      ['verify_failed', 'Verify failed (exit code 2) in api: make fail']
    ])
    expect(events[1].data).toMatchObject({
      command: 'make fail',
      sha: headOf(run, API.id),
      heads: `web=${headOf(run, WEB.id)},api=${headOf(run, API.id)}`,
      commands: 'web: pnpm check; api: make fail',
      member: { project_id: API.id, symlink_name: 'api' }
    })
  })

  it('passes when every member command passes, running only the members that have one', async () => {
    const run = await launchRun()
    harness.db.updateDocumentRun(run.id, {
      config: { ...run.config, memberVerifyCommands: { [API.id]: 'make test' } }
    })

    const result = await harness.service.verify(run.id)

    expect(runs).toEqual([{ command: 'make test', cwd: integrationPathOf(run, API.id) }])
    expect(result).toEqual({
      skipped: false,
      ok: true,
      exitCode: 0,
      timedOut: false,
      output: `make test in ${integrationPathOf(run, API.id)}`,
      durationMs: 10,
      failedMember: null
    })
  })

  it('refuses when a member integration worktree is not on its branch', async () => {
    const run = await launchRun()
    harness.db.updateDocumentRun(run.id, {
      config: { ...run.config, memberVerifyCommands: { [WEB.id]: 'pnpm check' } }
    })
    api.git(integrationPathOf(run, API.id), 'checkout', '--detach')

    await expect(harness.service.verify(run.id)).rejects.toThrow(
      `The integration worktree of api has a detached HEAD checked out, not ${INTEGRATION}.`
    )
    expect(runs).toEqual([])
  })
})

describe('commitIntegration on a connection run', () => {
  it('commits what is left in every member integration worktree', async () => {
    const run = await launchRun()
    web.write(integrationPathOf(run, WEB.id), { 'fix.txt': 'web fix\n' })
    api.write(integrationPathOf(run, API.id), { 'fix.txt': 'api fix\n' })
    const webBefore = headOf(run, WEB.id)

    const result = await harness.service.commitIntegration(run.id, 'Fix verify')

    expect(result).toEqual({ success: true, committed: true })
    expect(headOf(run, WEB.id)).not.toBe(webBefore)
    expect(web.git(integrationPathOf(run, WEB.id), 'status', '--porcelain')).toBe('')
    expect(api.git(integrationPathOf(run, API.id), 'status', '--porcelain')).toBe('')
    expect(
      harness.db
        .listDocumentRunEvents(run.id, 200, 'integration_commit')
        .map((event) => event.message)
    ).toEqual([
      `Committed on ${INTEGRATION} of web: Fix verify`,
      `Committed on ${INTEGRATION} of api: Fix verify`
    ])
    expect(await harness.service.commitIntegration(run.id, 'Nothing')).toEqual({
      success: true,
      committed: false
    })
  })
})

describe('rollbackMerge on a connection run', () => {
  it('resets every member that recorded a merge and clears the shas', async () => {
    const run = await launchRun()
    const paths = launchTicket(run, 'A1')
    web.commit(paths[WEB.id], 'web work', { 'src/web.ts': 'export const web = 1\n' })
    api.commit(paths[API.id], 'api work', { 'src/api.ts': 'export const api = 1\n' })
    const webBefore = headOf(run, WEB.id)
    const apiBefore = headOf(run, API.id)
    const item = itemByKey(run.id, 'A1')
    expect(await harness.service.merge(run.id, item.id)).toMatchObject({ success: true })
    const merged = itemByKey(run.id, 'A1')
    expect(merged.merge_sha).toBe(`web=${headOf(run, WEB.id)},api=${headOf(run, API.id)}`)
    web.write(integrationPathOf(run, WEB.id), { 'leftover.txt': 'from a fix session\n' })

    const result = await harness.service.rollbackMerge(run.id, item.id)

    expect(result).toEqual({ success: true })
    expect(headOf(run, WEB.id)).toBe(webBefore)
    expect(headOf(run, API.id)).toBe(apiBefore)
    expect(existsSync(join(integrationPathOf(run, WEB.id), 'leftover.txt'))).toBe(false)
    const after = itemByKey(run.id, 'A1')
    expect(after.pre_merge_sha).toBeNull()
    expect(after.merge_sha).toBeNull()
    expect(after.members!.map((member) => [member.pre_merge_sha, member.merge_sha])).toEqual([
      [null, null],
      [null, null]
    ])
    const rolledBack = harness.db.listDocumentRunEvents(run.id, 200, 'rolled_back')
    expect(rolledBack).toHaveLength(1)
    expect(rolledBack[0]).toMatchObject({
      message: 'The merge of A1 was rolled back in web, api',
      data: {
        resetTo: merged.pre_merge_sha,
        mergeSha: merged.merge_sha,
        members: [
          { project_id: WEB.id, symlink_name: 'web', resetTo: webBefore },
          { project_id: API.id, symlink_name: 'api', resetTo: apiBefore }
        ]
      }
    })

    // Nothing left to roll back.
    expect(await harness.service.rollbackMerge(run.id, item.id)).toEqual({
      success: false,
      error: 'A1 has no recorded merge to roll back.'
    })
  })

  it('refuses while another ticket was merged after it in any member, and resets nothing', async () => {
    const run = await launchRun()
    const first = launchTicket(run, 'A1')
    web.commit(first[WEB.id], 'web work', { 'src/web.ts': 'export const web = 1\n' })
    api.commit(first[API.id], 'api work', { 'src/api.ts': 'export const api = 1\n' })
    expect(await harness.service.merge(run.id, itemByKey(run.id, 'A1').id)).toMatchObject({
      success: true
    })
    const second = launchTicket(run, 'A2')
    // Only api gets a second merge: the refusal comes from that member.
    api.commit(second[API.id], 'more api', { 'src/api2.ts': 'export const api2 = 1\n' })
    expect(await harness.service.merge(run.id, itemByKey(run.id, 'A2').id)).toMatchObject({
      success: true
    })
    const webHead = headOf(run, WEB.id)
    const apiHead = headOf(run, API.id)

    const result = await harness.service.rollbackMerge(run.id, itemByKey(run.id, 'A1').id)

    expect(result).toEqual({
      success: false,
      error: 'A2 was merged after A1; rolling back would drop it too.'
    })
    expect(headOf(run, WEB.id)).toBe(webHead)
    expect(headOf(run, API.id)).toBe(apiHead)
    expect(itemByKey(run.id, 'A1').merge_sha).not.toBeNull()
  })

  it('keeps a retried ticket from bringing a rolled-back member merge back', async () => {
    const run = await launchRun()
    const first = launchTicket(run, 'A1')
    api.commit(first[API.id], 'api work', { 'src/api.ts': 'export const api = 1\n' })
    const a1 = itemByKey(run.id, 'A1')
    expect(await harness.service.merge(run.id, a1.id)).toMatchObject({ success: true })
    const a1Merge = itemByKey(run.id, 'A1').members![1].merge_sha!
    // A2 is cut from the integration branches while A1's merge sits on api's.
    const second = launchTicket(run, 'A2')
    api.commit(second[API.id], 'a2 api', { 'src/a2.ts': 'export const a2 = 1\n' })
    expect(await harness.service.rollbackMerge(run.id, a1.id)).toEqual({ success: true })

    const check = await harness.service.prepareMerge(run.id, itemByKey(run.id, 'A2').id)

    expect(check.state).toBe('error')
    expect(check.error).toContain(
      `api: The branch of A2 contains the merge of A1 that was rolled back after its checks failed. Rebase it onto ${INTEGRATION} in api without that merge`
    )
    expect(check.error).toContain(a1Merge.slice(0, 12))
  })
})

describe('finalize on a connection run', () => {
  it('reports every member, sums the totals and prefixes the migrations', async () => {
    const run = await launchRun()
    const paths = launchTicket(run, 'A1')
    web.commit(paths[WEB.id], 'web work', { 'src/web.ts': 'export const web = 1\n' })
    api.commit(paths[API.id], 'api work', {
      'src/api.ts': 'export const api = 1\n',
      'db/migrations/002_ramp_up.sql': 'alter table t add c int;\n'
    })
    const a1 = itemByKey(run.id, 'A1')
    expect(await harness.service.merge(run.id, a1.id)).toMatchObject({ success: true })
    harness.db.updateDocumentRunItem(a1.id, { status: 'merged' })
    harness.db.updateDocumentRunItem(itemByKey(run.id, 'A2').id, {
      status: 'needs_attention',
      status_detail: 'gave up'
    })
    harness.db.updateDocumentRun(run.id, {
      config: {
        ...run.config,
        memberVerifyCommands: { [WEB.id]: 'pnpm check', [API.id]: 'make test' }
      }
    })
    expect(await harness.service.verify(run.id)).toMatchObject({ ok: true })
    // The base of api moved since the run started; web's did not.
    api.commit(api.projectPath, 'hotfix on main', { 'HOTFIX.md': 'x\n' })

    const detail = await harness.service.finalize(run.id)

    const webHead = headOf(run, WEB.id)
    const apiHead = headOf(run, API.id)
    expect(detail.run.status).toBe('completed_with_issues')
    expect(detail.run.report).toMatchObject({
      integrationBranch: INTEGRATION,
      integrationWorktreePath: run.integration_connection_path,
      baseBranch: 'main',
      baseSha: '',
      headSha: webHead,
      baseMoved: true,
      merged: [{ key: 'A1', mergeSha: `web=${webHead},api=${apiHead}` }],
      unmerged: [{ key: 'A2', status: 'needs_attention', reason: 'gave up' }],
      migrations: ['api/db/migrations/002_ramp_up.sql'],
      stats: { filesChanged: 3, insertions: 3, deletions: 0, commits: 4 },
      verify: { command: 'web: pnpm check; api: make test', ok: true },
      members: [
        {
          project_id: WEB.id,
          project_name: 'web',
          symlink_name: 'web',
          integrationBranch: INTEGRATION,
          integrationWorktreePath: integrationPathOf(run, WEB.id),
          baseBranch: 'main',
          baseSha: web.baseSha,
          headSha: webHead,
          baseMoved: false,
          stats: { filesChanged: 1, insertions: 1, deletions: 0, commits: 2 }
        },
        {
          project_id: API.id,
          project_name: 'api',
          symlink_name: 'api',
          integrationBranch: INTEGRATION,
          integrationWorktreePath: integrationPathOf(run, API.id),
          baseBranch: 'main',
          baseSha: api.baseSha,
          headSha: apiHead,
          baseMoved: true,
          stats: { filesChanged: 2, insertions: 2, deletions: 0, commits: 2 }
        }
      ]
    })
    // The run's ticket leaves In Progress for Review, as for a git project.
    expect(harness.ticketMoves).toEqual([
      { projectId: TEST_CONNECTION_PROJECT_ID, ticketId: run.ticket_id, column: 'review' }
    ])
  })

  it('counts a ticket whose member merges landed even though its row never said so', async () => {
    const run = await launchRun()
    const paths = launchTicket(run, 'A1')
    web.commit(paths[WEB.id], 'web work', { 'src/web.ts': 'export const web = 1\n' })
    const a1 = itemByKey(run.id, 'A1')
    expect(await harness.service.merge(run.id, a1.id)).toMatchObject({ success: true })
    harness.db.updateDocumentRunItem(a1.id, { status: 'verifying' })
    harness.db.updateDocumentRunItem(itemByKey(run.id, 'A2').id, { status: 'skipped' })

    const detail = await harness.service.finalize(run.id)

    expect(detail.items.find((item) => item.key === 'A1')).toMatchObject({
      status: 'merged',
      status_detail: 'Merged, but its checks were not confirmed before the run ended.'
    })
    expect(detail.run.report?.merged.map((entry) => entry.key)).toEqual(['A1'])
  })
})
