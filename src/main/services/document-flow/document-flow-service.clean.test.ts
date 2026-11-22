// @vitest-environment node
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALREADY_IMPLEMENTED_DETAIL } from '@shared/document-flow/planning'
import type {
  DocumentRun,
  DocumentRunItem,
  DocumentRunItemMember
} from '@shared/types/document-flow'
import type { DocumentRunItemRowPatch } from './db-port'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  TEST_CONNECTION_PROJECT_ID,
  createServiceHarness,
  createTestRepo,
  isolateGitConfig,
  seedRun,
  type ServiceHarness,
  type TestRepo
} from './test-support'

// Once a run is finished with a ticket, its worktree is cleaned of what git does not track
// (`cleanItemWorktree`): once per ticket, and never anywhere but the ticket's own worktree.

const IGNORE = ['node_modules/', 'dist/', '.env', '.env.*', ''].join('\n')

/** What a finished ticket leaves in its worktree: tracked work, and all that git does not track. */
const LEFTOVERS: Record<string, string> = {
  'node_modules/pkg/index.js': 'module.exports = 1\n',
  'dist/app.js': 'built\n',
  'apps/web/dist/chunk.js': 'built\n',
  'scratch/notes.txt': 'untracked, not ignored\n',
  '.env': 'SECRET=1\n',
  'apps/web/.env.local': 'PORT=3000\n'
}
const REMOVED = ['node_modules', 'dist', 'apps/web/dist', 'scratch']
const KEPT = ['.env', 'apps/web/.env.local', 'src/app.ts', '.gitignore']

const expectCleaned = (path: string): void => {
  for (const gone of REMOVED) expect(existsSync(join(path, gone)), gone).toBe(false)
  for (const kept of KEPT) expect(existsSync(join(path, kept)), kept).toBe(true)
}
const expectUntouched = (path: string): void => {
  for (const file of Object.keys(LEFTOVERS)) expect(existsSync(join(path, file)), file).toBe(true)
}

let restoreGitConfig: () => void

beforeAll(() => {
  restoreGitConfig = isolateGitConfig()
})

afterAll(() => {
  restoreGitConfig()
})

describe('cleanItemWorktree', () => {
  let repo: TestRepo
  let harness: ServiceHarness
  let integration: string
  let runId: string

  const seed = (source_kind: DocumentRun['source_kind'] = 'document'): void => {
    runId = seedRun(harness, {
      run: {
        source_kind,
        status: 'running',
        base_branch: 'main',
        base_sha: repo.baseSha,
        integration_branch: 'doc-factory',
        integration_worktree_id: 'wt-integration',
        integration_worktree_path: integration,
        started_at: new Date().toISOString()
      },
      items: [{ key: 'A1' }, { key: 'A2' }]
    }).run.id
  }

  beforeEach(() => {
    repo = createTestRepo()
    repo.commit(repo.projectPath, 'ignore rules', { '.gitignore': IGNORE })
    harness = createServiceHarness({ repo })
    integration = repo.addWorktree('doc-factory', 'main')
    harness.worktrees.set('wt-integration', {
      id: 'wt-integration',
      path: integration,
      branch_name: 'doc-factory'
    })
    seed()
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

  /** A ticket worktree with committed work and the leftovers of a build, in the given state. */
  function ticketWorktree(key: string, patch: DocumentRunItemRowPatch): string {
    const branch = `${key.toLowerCase()}-task`
    const path = repo.addWorktree(branch, 'doc-factory')
    harness.worktrees.set(`wt-${key}`, { id: `wt-${key}`, path, branch_name: branch })
    repo.commit(path, key, { [`src/${key.toLowerCase()}.ts`]: '1\n' })
    repo.write(path, LEFTOVERS)
    harness.db.updateDocumentRunItem(itemByKey(key).id, {
      worktree_id: `wt-${key}`,
      branch_name: branch,
      session_id: `session-${key}`,
      ...patch
    })
    return path
  }

  const FINISHED: DocumentRunItemRowPatch = {
    status: 'merged',
    merge_sha: 'merge-sha',
    document_update_status: 'done'
  }
  const clean = (key: string) => harness.service.cleanItemWorktree(runId, itemByKey(key).id)
  const eventsOf = (type: string) =>
    harness.db.listDocumentRunEvents(runId).filter((event) => event.type === type)

  it('removes what git does not track, keeps env files and tracked files, and records it', async () => {
    const path = ticketWorktree('A1', FINISHED)
    // An uncommitted edit to a tracked file is not the clean's to throw away.
    repo.write(path, { 'src/app.ts': 'export const app = 2\n' })
    const before = harness.published.length

    expect(await clean('A1')).toEqual({ state: 'cleaned' })

    expectCleaned(path)
    expect(existsSync(join(path, 'src/a1.ts'))).toBe(true)
    expect(readFileSync(join(path, 'src/app.ts'), 'utf8')).toBe('export const app = 2\n')
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1\n')
    // All that is left outside git: the env files (`apps/` holds nothing but one).
    expect(repo.git(path, 'status', '--porcelain', '--ignored')).toBe(
      ['M src/app.ts', '!! .env', '!! apps/'].join('\n')
    )
    expect(itemByKey('A1').worktree_cleaned_at).toEqual(expect.any(String))
    expect(eventsOf('worktree_cleaned')).toEqual([
      expect.objectContaining({ item_id: itemByKey('A1').id, data: { paths: [path] } })
    ])
    expect(harness.published.slice(before).map((event) => event.reason)).toEqual(['item', 'event'])
    // Nobody else's checkout was touched.
    expect(repo.git(integration, 'status', '--porcelain')).toBe('')
    expect(repo.git(repo.projectPath, 'status', '--porcelain')).toBe('')
  })

  it('cleans a ticket once: what is rebuilt there afterwards stays', async () => {
    const path = ticketWorktree('A1', FINISHED)
    expect(await clean('A1')).toEqual({ state: 'cleaned' })
    const cleanedAt = itemByKey('A1').worktree_cleaned_at

    // The user took the session up again, and it rebuilt.
    repo.write(path, LEFTOVERS)

    expect(await clean('A1')).toEqual({ state: 'already' })
    expectUntouched(path)
    expect(itemByKey('A1').worktree_cleaned_at).toBe(cleanedAt)
    expect(eventsOf('worktree_cleaned')).toHaveLength(1)
  })

  it('lets only one of two calls made at once clean', async () => {
    ticketWorktree('A1', FINISHED)

    const results = await Promise.all([clean('A1'), clean('A1')])

    expect(results.map((result) => result.state).sort()).toEqual(['already', 'cleaned'])
    expect(eventsOf('worktree_cleaned')).toHaveLength(1)
  })

  it.each([
    ['failed', { ...FINISHED, document_update_status: 'failed' }],
    ['skipped', { ...FINISHED, document_update_status: 'skipped' }],
    [
      'done, for a ticket closed as already implemented',
      {
        status: 'skipped',
        status_detail: ALREADY_IMPLEMENTED_DETAIL,
        document_update_status: 'done'
      }
    ]
  ] satisfies [string, DocumentRunItemRowPatch][])(
    'cleans when the document update ended %s',
    async (_name, patch) => {
      const path = ticketWorktree('A1', patch)

      expect(await clean('A1')).toEqual({ state: 'cleaned' })
      expectCleaned(path)
    }
  )

  it.each([
    ['is still running', { status: 'running' }],
    [
      'is merged with its document update queued',
      { ...FINISHED, document_update_status: 'queued' }
    ],
    [
      'is merged with its document update under way',
      { ...FINISHED, document_update_status: 'updating' }
    ],
    ['was skipped by the user', { status: 'skipped', status_detail: 'Skipped by you.' }],
    ['is not part of the run', { ...FINISHED, selected: false }]
  ] satisfies [string, DocumentRunItemRowPatch][])(
    'refuses a ticket that %s, leaving it to be cleaned once the run is finished with it',
    async (_name, patch) => {
      const path = ticketWorktree('A1', patch)

      await expect(clean('A1')).rejects.toThrow('The run is not finished with A1')

      expectUntouched(path)
      expect(itemByKey('A1').worktree_cleaned_at).toBeNull()
    }
  )

  it('never cleans the integration worktree, even for an item that names it', async () => {
    repo.write(integration, LEFTOVERS)
    harness.db.updateDocumentRunItem(itemByKey('A1').id, {
      ...FINISHED,
      worktree_id: 'wt-integration'
    })

    expect(await clean('A1')).toEqual({ state: 'none' })

    expectUntouched(integration)
  })

  it('never cleans the project root or a default worktree', async () => {
    repo.write(repo.projectPath, LEFTOVERS)
    harness.worktrees.set('wt-root', { id: 'wt-root', path: repo.projectPath, branch_name: 'main' })
    harness.db.updateDocumentRunItem(itemByKey('A1').id, { ...FINISHED, worktree_id: 'wt-root' })
    const other = repo.addWorktree('default-elsewhere', 'main')
    repo.write(other, LEFTOVERS)
    harness.worktrees.set('wt-default', {
      id: 'wt-default',
      path: other,
      branch_name: 'default-elsewhere',
      is_default: true
    })
    harness.db.updateDocumentRunItem(itemByKey('A2').id, { ...FINISHED, worktree_id: 'wt-default' })

    expect(await clean('A1')).toEqual({ state: 'none' })
    expect(await clean('A2')).toEqual({ state: 'none' })

    expectUntouched(repo.projectPath)
    expectUntouched(other)
  })

  it('has nothing to clean for an archived worktree or one gone from disk, and does not ask twice', async () => {
    const archived = ticketWorktree('A1', FINISHED)
    harness.worktrees.set('wt-A1', { ...harness.worktrees.get('wt-A1')!, status: 'archived' })
    const gone = ticketWorktree('A2', FINISHED)
    rmSync(gone, { recursive: true, force: true })

    expect(await clean('A1')).toEqual({ state: 'none' })
    expect(await clean('A2')).toEqual({ state: 'none' })

    expectUntouched(archived)
    expect(itemByKey('A1').worktree_cleaned_at).toEqual(expect.any(String))
    expect(await clean('A1')).toEqual({ state: 'already' })
    expect(eventsOf('worktree_cleaned')).toEqual([])
  })

  it('refuses a directory that is not the root of a worktree, and records the failure once', async () => {
    const path = ticketWorktree('A1', FINISHED)
    // The row points inside the checkout: git would clean only that corner of it.
    harness.worktrees.set('wt-A1', {
      id: 'wt-A1',
      path: join(path, 'apps'),
      branch_name: 'a1-task'
    })

    expect(await clean('A1')).toEqual({
      state: 'failed',
      error: `${join(path, 'apps')}: it is not the root of a worktree`
    })

    expectUntouched(path)
    expect(eventsOf('worktree_clean_failed')).toHaveLength(1)
    expect(await clean('A1')).toEqual({ state: 'already' })
  })

  it('reports a clean git failed at, and does not try again', async () => {
    const path = ticketWorktree('A1', FINISHED)
    const cleanUntrackedAndIgnored = vi
      .spyOn(harness.service['git'], 'cleanUntrackedAndIgnored')
      .mockRejectedValueOnce(new Error('git clean exited with code 1: Permission denied'))

    expect(await clean('A1')).toEqual({
      state: 'failed',
      error: `${path}: git clean exited with code 1: Permission denied`
    })
    expect(await clean('A1')).toEqual({ state: 'already' })

    expect(cleanUntrackedAndIgnored).toHaveBeenCalledTimes(1)
    expectUntouched(path)
    cleanUntrackedAndIgnored.mockRestore()
  })

  describe('in a run made from board tickets', () => {
    beforeEach(() => seed('tickets'))

    it('cleans a merged ticket: there is no document update to wait for', async () => {
      const path = ticketWorktree('A1', { status: 'merged', merge_sha: 'merge-sha' })

      expect(await clean('A1')).toEqual({ state: 'cleaned' })
      expectCleaned(path)
    })

    it('cleans a ticket closed as already implemented, not one the user skipped', async () => {
      const implemented = ticketWorktree('A1', {
        status: 'skipped',
        status_detail: ALREADY_IMPLEMENTED_DETAIL
      })
      const skipped = ticketWorktree('A2', { status: 'skipped', status_detail: 'Skipped by you.' })

      expect(await clean('A1')).toEqual({ state: 'cleaned' })
      await expect(clean('A2')).rejects.toThrow('The run is not finished with A2')

      expectCleaned(implemented)
      expectUntouched(skipped)
    })
  })
})

describe('cleanItemWorktree on a connection run', () => {
  let web: TestRepo
  let api: TestRepo
  let harness: ServiceHarness

  beforeEach(() => {
    web = createTestRepo()
    api = createTestRepo()
    for (const repo of [web, api]) {
      repo.commit(repo.projectPath, 'ignore rules', { '.gitignore': IGNORE })
    }
    harness = createServiceHarness({ members: [web, api] })
  })

  afterEach(() => {
    harness.cleanup()
    web.cleanup()
    api.cleanup()
  })

  it('cleans every member worktree of the ticket instance, and no integration worktree', async () => {
    const seeded = seedRun(harness, {
      run: { project_id: TEST_CONNECTION_PROJECT_ID },
      items: [{ key: 'A1' }]
    })
    const { run } = await harness.service.start(seeded.run.id)
    const repos = new Map(
      run.members!.map((member, index) => [member.project_id, [web, api][index]])
    )
    const paths: string[] = []
    const members = run.members!.map((member): DocumentRunItemMember => {
      const repo = repos.get(member.project_id)!
      const path = repo.addWorktree('a1-task', member.integration_branch)
      const id = `wt-${member.project_name}-A1`
      harness.worktrees.set(id, { id, path, branch_name: 'a1-task', project_id: member.project_id })
      repo.write(path, LEFTOVERS)
      repo.write(member.integration_worktree_path, LEFTOVERS)
      paths.push(path)
      return {
        project_id: member.project_id,
        worktree_id: id,
        branch_name: 'a1-task',
        pre_merge_sha: null,
        merge_sha: null
      }
    })
    const item = harness.db.getDocumentRunItems(run.id)[0]
    harness.db.updateDocumentRunItem(item.id, {
      status: 'merged',
      merge_sha: 'merge-sha',
      document_update_status: 'done',
      connection_id: 'connection-A1',
      members,
      branch_name: 'a1-task'
    })

    expect(await harness.service.cleanItemWorktree(run.id, item.id)).toEqual({ state: 'cleaned' })

    expect(paths).toHaveLength(2)
    for (const path of paths) expectCleaned(path)
    for (const member of run.members!) expectUntouched(member.integration_worktree_path)
    expect(
      harness.db.listDocumentRunEvents(run.id).find((event) => event.type === 'worktree_cleaned')
    ).toMatchObject({ item_id: item.id, data: { paths: expect.arrayContaining(paths) } })
  })
})
