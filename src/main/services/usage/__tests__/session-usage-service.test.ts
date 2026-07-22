import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DatabaseService } from '../../../db/database'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import { encodePath } from '../../claude-transcript-reader'
import {
  flushSessionUsageReport,
  __resetSessionUsageServiceForTests
} from '../session-usage-service'
import { __resetModelPricingLoaderForTests } from '../model-pricing-loader'
import { setModelPricingTable } from '../pricing'
import pricingFixture from './model-pricing-fixture.json'

vi.mock('../../git-service', () => ({
  GitService: vi.fn().mockImplementation(() => ({
    getRemoteUrl: vi.fn().mockResolvedValue({ success: true, url: 'git@github.com:x/y.git' })
  }))
}))

const IN = 1e-5
const OUT = 5e-5

/**
 * The service resolves prices from the server before reporting. Answer the
 * HiveModelPrices query from the fixture and forward everything else (the
 * report mutation) to the per-test mock, so call-count assertions on the
 * inner mock keep seeing only report calls.
 */
function withModelPrices(
  reportMock: ReturnType<typeof vi.fn>,
  prices: unknown = { pricesJson: JSON.stringify(pricingFixture), fetchedAt: '2026-07-21T00:00:00Z' }
): (endpoint: string, token: string, document: string, variables: unknown) => Promise<unknown> {
  return (endpoint, token, document, variables) => {
    if (document.includes('HiveModelPrices')) return Promise.resolve({ modelPrices: prices })
    return reportMock(endpoint, token, document, variables)
  }
}

let root: string
let prevConfigDir: string | undefined

function entry(id: string, input: number, output: number, ts = '2026-07-21T10:05:00Z'): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      requestId: `req-${id}`,
      message: {
        id,
        model: 'claude-fable-5',
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      }
    }) + '\n'
  )
}

interface StateRow {
  stateJson: string
  lastReportedJson: string | null
}

function makeDb(worktreePath: string): {
  db: DatabaseService
  stateRows: Map<string, StateRow>
} {
  const stateRows = new Map<string, StateRow>()
  const db = {
    getSetting: vi.fn((key: string) =>
      key === APP_SETTINGS_DB_KEY
        ? JSON.stringify({
            hiveEnterpriseServerUrl: 'https://enterprise.example.com',
            hiveAuthToken: 'token-1',
            hiveOrganizationId: 'org-1'
          })
        : null
    ),
    getSession: vi.fn(() => ({
      id: 'hive-1',
      worktree_id: 'wt-1',
      project_id: 'proj-1',
      connection_id: null,
      agent_sdk: 'claude-code-cli',
      claude_session_id: 'claude-sess-1',
      opencode_session_id: null,
      mode: 'build',
      remote_launch: null
    })),
    getWorktree: vi.fn(() => ({ id: 'wt-1', path: worktreePath, branch_name: 'feat/x', project_id: 'proj-1' })),
    getProject: vi.fn(() => ({ id: 'proj-1', name: 'Proj', path: worktreePath })),
    getConnection: vi.fn(() => null),
    getSessionUsageState: vi.fn((id: string) => stateRows.get(id) ?? null),
    setSessionUsageState: vi.fn((id: string, stateJson: string, lastReportedJson: string | null) => {
      stateRows.set(id, { stateJson, lastReportedJson })
    })
  } as unknown as DatabaseService
  return { db, stateRows }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'usage-service-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config')
  __resetSessionUsageServiceForTests()
  // Each test starts with no price table: it must arrive via withModelPrices.
  __resetModelPricingLoaderForTests()
  setModelPricingTable({})
})

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  rmSync(root, { recursive: true, force: true })
  __resetSessionUsageServiceForTests()
})

function writeTranscript(worktreePath: string, content: string): string {
  const dir = join(root, 'claude-config', 'projects', encodePath(worktreePath))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'claude-sess-1.jsonl')
  writeFileSync(file, content)
  return file
}

describe('session usage service', () => {
  it('reports full cumulative buckets, then only rereads the delta on the next stop', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    const transcript = writeTranscript(worktreePath, entry('m1', 100, 10) + entry('m2', 200, 20))
    const { db, stateRows } = makeDb(worktreePath)
    const requestGraphql = vi.fn().mockResolvedValue({ reportSessionUsage: { recorded: true } })
    const deps = { db, requestGraphql: withModelPrices(requestGraphql) }

    await flushSessionUsageReport('hive-1', deps)

    expect(requestGraphql).toHaveBeenCalledTimes(1)
    const firstInput = requestGraphql.mock.calls[0][3].input
    expect(firstInput.sessionId).toBe('hive-1')
    expect(firstInput.provider).toBe('anthropic')
    expect(firstInput.projectName).toBe('Proj')
    expect(firstInput.buckets).toHaveLength(1)
    expect(firstInput.buckets[0]).toMatchObject({
      model: 'claude-fable-5',
      bucketTs: '2026-07-21T10:00:00.000Z',
      inputTokens: 300,
      outputTokens: 30
    })
    expect(firstInput.buckets[0].costUsd).toBeCloseTo(300 * IN + 30 * OUT, 9)

    const savedState = JSON.parse(stateRows.get('hive-1')!.stateJson)
    const cursorAfterFirst = savedState.claude.files[transcript].offset
    expect(cursorAfterFirst).toBeGreaterThan(0)

    // Append one more turn; the next report must resend CUMULATIVE totals
    // while having read only the appended bytes.
    appendFileSync(transcript, entry('m3', 50, 5))
    await flushSessionUsageReport('hive-1', deps)

    expect(requestGraphql).toHaveBeenCalledTimes(2)
    const secondInput = requestGraphql.mock.calls[1][3].input
    expect(secondInput.buckets[0]).toMatchObject({ inputTokens: 350, outputTokens: 35 })
    const savedState2 = JSON.parse(stateRows.get('hive-1')!.stateJson)
    expect(savedState2.claude.files[transcript].offset).toBeGreaterThan(cursorAfterFirst)
  })

  it('does not resend when nothing changed', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    writeTranscript(worktreePath, entry('m1', 100, 10))
    const { db } = makeDb(worktreePath)
    const requestGraphql = vi.fn().mockResolvedValue({ reportSessionUsage: { recorded: true } })
    const deps = { db, requestGraphql: withModelPrices(requestGraphql) }

    await flushSessionUsageReport('hive-1', deps)
    await flushSessionUsageReport('hive-1', deps)

    expect(requestGraphql).toHaveBeenCalledTimes(1)
  })

  it('retries with the same cumulative totals after a failed send', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    writeTranscript(worktreePath, entry('m1', 100, 10))
    const { db } = makeDb(worktreePath)
    const requestGraphql = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ reportSessionUsage: { recorded: true } })
    const deps = { db, requestGraphql: withModelPrices(requestGraphql) }

    await flushSessionUsageReport('hive-1', deps)
    expect(requestGraphql).toHaveBeenCalledTimes(1)

    // Retry: same totals resent even though the file did not change (cursor
    // already advanced — totals come from persisted state, not a re-read).
    await flushSessionUsageReport('hive-1', deps)
    expect(requestGraphql).toHaveBeenCalledTimes(2)
    expect(requestGraphql.mock.calls[1][3].input.buckets[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 10
    })
  })

  it('recovers identical totals from a full reparse after state loss', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    writeTranscript(worktreePath, entry('m1', 100, 10) + entry('m2', 200, 20))
    const { db, stateRows } = makeDb(worktreePath)
    const requestGraphql = vi.fn().mockResolvedValue({ reportSessionUsage: { recorded: true } })
    const deps = { db, requestGraphql: withModelPrices(requestGraphql) }

    await flushSessionUsageReport('hive-1', deps)
    const firstBuckets = requestGraphql.mock.calls[0][3].input.buckets

    // Simulate local state loss (e.g. wiped hive.db) + a fresh full reparse.
    stateRows.clear()
    await flushSessionUsageReport('hive-1', deps)
    expect(requestGraphql).toHaveBeenCalledTimes(2)
    expect(requestGraphql.mock.calls[1][3].input.buckets).toEqual(firstBuckets)
  })

  it('skips terminal/opencode/remote sessions', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    const { db } = makeDb(worktreePath)
    ;(db.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'hive-1',
      worktree_id: 'wt-1',
      project_id: 'proj-1',
      connection_id: null,
      agent_sdk: 'opencode',
      claude_session_id: null,
      opencode_session_id: 'oc-1',
      mode: 'build',
      remote_launch: null
    })
    const requestGraphql = vi.fn()
    await flushSessionUsageReport('hive-1', { db, requestGraphql })
    expect(requestGraphql).not.toHaveBeenCalled()
  })

  it('skips parsing entirely when enterprise is not configured', async () => {
    // Prices live on the server, so without an enterprise connection there is
    // nothing to price with (and nobody to report to) — nothing is parsed.
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    writeTranscript(worktreePath, entry('m1', 100, 10))
    const { db, stateRows } = makeDb(worktreePath)
    ;(db.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify({}))
    const requestGraphql = vi.fn()

    await flushSessionUsageReport('hive-1', { db, requestGraphql })
    expect(requestGraphql).not.toHaveBeenCalled()
    expect(stateRows.has('hive-1')).toBe(false)
  })

  it('defers the report until the server can provide model prices', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    writeTranscript(worktreePath, entry('m1', 100, 10))
    const { db, stateRows } = makeDb(worktreePath)
    const requestGraphql = vi.fn().mockResolvedValue({ reportSessionUsage: { recorded: true } })

    // Server has no price table yet (never fetched + outside source down).
    await flushSessionUsageReport('hive-1', {
      db,
      requestGraphql: withModelPrices(requestGraphql, null)
    })
    expect(requestGraphql).not.toHaveBeenCalled()
    expect(stateRows.has('hive-1')).toBe(false)

    // Prices become available: the same stop path reports the full totals.
    await flushSessionUsageReport('hive-1', {
      db,
      requestGraphql: withModelPrices(requestGraphql)
    })
    expect(requestGraphql).toHaveBeenCalledTimes(1)
    expect(requestGraphql.mock.calls[0][3].input.buckets[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 10
    })
    expect(requestGraphql.mock.calls[0][3].input.buckets[0].costUsd).toBeCloseTo(
      100 * IN + 10 * OUT,
      9
    )
  })
})
