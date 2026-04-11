import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Only mock I/O boundaries — logger and spawnCLI ─────────────────────

const { mockSpawnCLI } = vi.hoisted(() => ({
  mockSpawnCLI: vi.fn()
}))

vi.mock('../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Only mock spawnCLI — let extractTitleFromJSON and sanitizeTitle run for real
vi.mock('../src/main/services/title-generation-shared', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    spawnCLI: mockSpawnCLI
  }
})

vi.mock('../src/main/services/claude-binary-resolver', () => ({
  resolveClaudeBinaryPath: () => '/usr/local/bin/claude'
}))

import { extractTitleFromJSON, sanitizeTitle } from '../src/main/services/title-generation-shared'

/**
 * This is the EXACT output from running:
 *   echo '...' | claude -p --output-format json --json-schema '...' --model haiku --effort low --dangerously-skip-permissions
 * Captured from a real invocation.
 */
const REAL_CLAUDE_OUTPUT = '{"type":"result","subtype":"success","is_error":false,"duration_ms":12256,"duration_api_ms":12236,"num_turns":3,"result":"","stop_reason":"end_turn","session_id":"70034931-74af-4165-b83d-2c453f1e8ef3","total_cost_usd":0.0190109,"usage":{"input_tokens":25,"cache_creation_input_tokens":4310,"cache_read_input_tokens":108584,"output_tokens":548,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":25,"outputTokens":548,"cacheReadInputTokens":108584,"cacheCreationInputTokens":4310,"webSearchRequests":0,"costUSD":0.0190109}},"permission_denials":[],"structured_output":{"title":"Quick greeting"},"terminal_reason":"completed","fast_mode_state":"off","uuid":"bebba93a-38c3-4135-b81d-312c5ecaba3b"}'

// ── Pure function tests (no mocks involved) ────────────────────────────

describe('Real CLI output parsing (non-mocked integration)', () => {
  it('extractTitleFromJSON handles real claude -p JSON envelope', () => {
    const title = extractTitleFromJSON(REAL_CLAUDE_OUTPUT)
    expect(title).toBe('Quick greeting')
  })

  it('full pipeline: extractTitleFromJSON → sanitizeTitle with real output', () => {
    const raw = extractTitleFromJSON(REAL_CLAUDE_OUTPUT)
    expect(raw).not.toBeNull()
    const title = sanitizeTitle(raw!)
    expect(title).toBe('Quick greeting')
  })

  it('extractTitleFromJSON handles envelope where result is empty string', () => {
    const output = JSON.stringify({
      type: 'result',
      result: '',
      structured_output: { title: 'Fix auth bug' }
    })
    const title = extractTitleFromJSON(output)
    expect(title).toBe('Fix auth bug')
  })

  it('extractTitleFromJSON handles envelope where result contains text (not JSON)', () => {
    const output = JSON.stringify({
      type: 'result',
      result: 'Here is the title',
      structured_output: { title: 'Auth token refresh' }
    })
    const title = extractTitleFromJSON(output)
    expect(title).toBe('Auth token refresh')
  })

  it('extractTitleFromJSON falls back to result as JSON when no structured_output', () => {
    const output = JSON.stringify({
      type: 'result',
      result: '{"title": "Postgres migration"}'
    })
    const title = extractTitleFromJSON(output)
    expect(title).toBe('Postgres migration')
  })

  it('extractTitleFromJSON returns null when result is non-JSON and no structured_output', () => {
    const output = JSON.stringify({
      type: 'result',
      result: 'just plain text with no json'
    })
    const title = extractTitleFromJSON(output)
    expect(title).toBeNull()
  })
})

// ── Full generateSessionTitle with real parsing, only spawnCLI mocked ──

describe('generateSessionTitle — real parsing, mocked spawn', () => {
  let generateSessionTitle: typeof import('../src/main/services/claude-session-title').generateSessionTitle

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../src/main/services/claude-session-title')
    generateSessionTitle = mod.generateSessionTitle
  })

  it('returns title from real claude -p output', async () => {
    mockSpawnCLI.mockResolvedValue(REAL_CLAUDE_OUTPUT)

    const title = await generateSessionTitle('hi')
    expect(title).toBe('Quick greeting')
  })

  it('returns title from minimal structured_output envelope', async () => {
    mockSpawnCLI.mockResolvedValue(JSON.stringify({
      type: 'result',
      result: '',
      structured_output: { title: 'Fix auth token refresh' }
    }))

    const title = await generateSessionTitle('Fix the auth token refresh bug')
    expect(title).toBe('Fix auth token refresh')
  })

  it('returns title from result-only envelope (no structured_output)', async () => {
    mockSpawnCLI.mockResolvedValue(JSON.stringify({
      type: 'result',
      result: '{"title": "Database migration setup"}'
    }))

    const title = await generateSessionTitle('Help me set up database migrations')
    expect(title).toBe('Database migration setup')
  })

  it('truncates long titles from real parsing at 50 chars', async () => {
    mockSpawnCLI.mockResolvedValue(JSON.stringify({
      structured_output: { title: 'A'.repeat(60) }
    }))

    const title = await generateSessionTitle('some message')
    expect(title).toBe('A'.repeat(50) + '...')
  })

  it('returns null when CLI returns JSON without title', async () => {
    mockSpawnCLI.mockResolvedValue(JSON.stringify({
      type: 'result',
      result: '',
      structured_output: {}
    }))

    const title = await generateSessionTitle('hello')
    expect(title).toBeNull()
  })

  it('returns null when CLI returns non-JSON', async () => {
    mockSpawnCLI.mockResolvedValue('Error: something went wrong')

    const title = await generateSessionTitle('hello')
    expect(title).toBeNull()
  })

  it('returns null when CLI throws', async () => {
    mockSpawnCLI.mockRejectedValue(new Error('spawn ENOENT'))

    const title = await generateSessionTitle('hello')
    expect(title).toBeNull()
  })

  it('extracts title when structured_output.title is double-wrapped JSON (the bug)', async () => {
    mockSpawnCLI.mockResolvedValue(JSON.stringify({
      type: 'result',
      result: '',
      structured_output: { title: '{"title": "Codex vs t3"}' }
    }))

    const title = await generateSessionTitle('compare codex and t3')
    expect(title).toBe('Codex vs t3')
  })

  it('sanitizes quotes from title', async () => {
    mockSpawnCLI.mockResolvedValue(JSON.stringify({
      structured_output: { title: '"Fix auth bug"' }
    }))

    const title = await generateSessionTitle('fix auth')
    expect(title).toBe('Fix auth bug')
  })

  it('takes first line when title has newlines', async () => {
    mockSpawnCLI.mockResolvedValue(JSON.stringify({
      structured_output: { title: 'First line\nSecond line' }
    }))

    const title = await generateSessionTitle('some message')
    expect(title).toBe('First line')
  })
})
