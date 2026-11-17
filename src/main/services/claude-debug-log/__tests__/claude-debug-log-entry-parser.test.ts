// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseUnifiedRateLimitHeaders,
  snapshotHasUsage
} from '../../claude-api-proxy/anthropic-rate-limit-headers'
import {
  CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH,
  isClaudeDebugLogSuccessStatusLine,
  parseClaudeDebugLogLine,
  type ClaudeDebugLogParseResult,
  type ClaudeDebugLogResponseEntry
} from '../claude-debug-log-entry-parser'

// Where the fixtures in ../__fixtures__ come from. The PRD's captures of a
// signed-in session (/tmp/live-spike) no longer exist, so these were captured
// again on 2026-11-17: Claude CLI 2.1.326 in its TUI, launched as the PRD
// prescribes (`ANTHROPIC_LOG=debug --debug-file <path> --debug=console.log`;
// the 500 and the plain debug lines come from a run without the filter),
// talking to a local stand-in for the API. Each line is exactly what the CLI
// wrote, with two edits: the stand-in's address is replaced by
// https://api.anthropic.com and a session uuid is zeroed. Every header VALUE
// is synthetic (organization ids, request ids and ray ids are placeholders;
// the rate-limit values follow the shapes in anthropic-rate-limit-headers.ts).
// No line here was produced by the real API.
//
// Nothing in this file prints a line: assertions compare parsed results only,
// so a failure shows field values, never raw log content.

const FIXTURES = join(__dirname, '..', '__fixtures__')

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
}

function fixtureLine(name: string): string {
  const lines = fixtureLines(name)
  if (lines.length !== 1) throw new Error(`${name}: expected one line, found ${lines.length}`)
  return lines[0]
}

function entryOf(line: string): ClaudeDebugLogResponseEntry {
  const result = parseClaudeDebugLogLine(line)
  if (result.kind !== 'entry') throw new Error(`expected an entry, got: ${result.reason}`)
  return result.entry
}

const UNRELATED: ClaudeDebugLogParseResult = { kind: 'not-entry', reason: 'unrelated' }
const MALFORMED: ClaudeDebugLogParseResult = { kind: 'not-entry', reason: 'malformed' }
const OVERSIZED: ClaudeDebugLogParseResult = { kind: 'not-entry', reason: 'oversized' }

const TIMESTAMP = '2026-11-17T10:48:33.768Z'
const OBSERVED_AT = Date.UTC(2026, 10, 17, 10, 48, 33, 768)

/**
 * A synthetic line built the way the CLI builds one: `util.format`-style text
 * (label, space, `util.inspect` of the details), written as a JSON string
 * literal when it contains a newline and as is otherwise. Used only for the
 * cases no capture covers.
 */
function sdkLine(label: string, details: unknown, timestamp = TIMESTAMP): string {
  const text = `console.log: [log_0a1b2c] ${label} ${inspect(details)}`
  return `${timestamp} [DEBUG] ${text.includes('\n') ? JSON.stringify(text) : text}`
}

function responseStart(headers: Record<string, unknown>): string {
  return sdkLine('response start', {
    url: 'https://api.anthropic.com/v1/messages?beta=true',
    status: 200,
    headers,
    durationMs: 1550
  })
}

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const ORG_B = '00000000-0000-4000-8000-00000000000b'

const FIVE_HOUR_AND_WEEK_HEADERS = {
  'anthropic-ratelimit-unified-5h-reset': '1795003200',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.03',
  'anthropic-ratelimit-unified-7d-reset': '1795435200',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.37',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': '1795003200',
  'anthropic-ratelimit-unified-status': 'allowed'
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseClaudeDebugLogLine', () => {
  describe('response entries from captures', () => {
    it('reads a streaming success', () => {
      expect(entryOf(fixtureLine('response-start-streaming.txt'))).toEqual({
        kind: 'response-start',
        observedAt: Date.UTC(2026, 10, 17, 12, 39, 34, 892),
        status: 200,
        headers: FIVE_HOUR_AND_WEEK_HEADERS,
        organizationUuid: ORG_A
      })
    })

    it('reads a non-streaming success', () => {
      expect(entryOf(fixtureLine('response-start-non-streaming.txt'))).toEqual({
        kind: 'response-start',
        observedAt: Date.UTC(2026, 10, 17, 12, 40, 54, 759),
        status: 200,
        headers: FIVE_HOUR_AND_WEEK_HEADERS,
        organizationUuid: ORG_A
      })
    })

    it('keeps the Fable bucket of a Fable-model response', () => {
      expect(entryOf(fixtureLine('response-start-fable.txt'))).toEqual({
        kind: 'response-start',
        observedAt: Date.UTC(2026, 10, 17, 12, 39, 34, 901),
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-7d-reset': '1795435200',
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-utilization': '0.36',
          'anthropic-ratelimit-unified-7d_oi-reset': '1795435200',
          'anthropic-ratelimit-unified-7d_oi-status': 'allowed_warning',
          'anthropic-ratelimit-unified-7d_oi-surpassed-threshold': '0.5',
          'anthropic-ratelimit-unified-7d_oi-utilization': '0.71',
          'anthropic-ratelimit-unified-fallback-percentage': '0.5',
          'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
          'anthropic-ratelimit-unified-overage-status': 'rejected',
          'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
          'anthropic-ratelimit-unified-reset': '1795435200',
          'anthropic-ratelimit-unified-status': 'allowed'
        },
        organizationUuid: ORG_B
      })
    })

    it('reads an error response that carries no rate-limit headers (404)', () => {
      expect(entryOf(fixtureLine('response-error-404.txt'))).toEqual({
        kind: 'response-error',
        observedAt: Date.UTC(2026, 10, 17, 12, 39, 34, 891),
        status: 404,
        headers: {},
        organizationUuid: ORG_A
      })
    })

    it('reads an error response whose headers object is printed on one line', () => {
      expect(entryOf(fixtureLine('response-error-404-compact-headers.txt'))).toEqual({
        kind: 'response-error',
        observedAt: Date.UTC(2026, 10, 17, 12, 39, 34, 932),
        status: 404,
        headers: {},
        organizationUuid: null
      })
    })

    it('reads a plan-limit 429 with its rate-limit headers', () => {
      const entry = entryOf(fixtureLine('response-error-429-plan-limit.txt'))
      expect(entry.kind).toBe('response-error')
      expect(entry.observedAt).toBe(Date.UTC(2026, 10, 17, 12, 39, 34, 974))
      expect(entry.status).toBe(429)
      expect(entry.organizationUuid).toBe(ORG_A)
      expect(entry.headers).toEqual({
        'anthropic-ratelimit-unified-5h-reset': '1795003200',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-surpassed-threshold': '1.0',
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
        'anthropic-ratelimit-unified-7d-reset': '1795435200',
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.52',
        'anthropic-ratelimit-unified-fallback-percentage': '0.5',
        'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
        'anthropic-ratelimit-unified-overage-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': '1795003200',
        'anthropic-ratelimit-unified-status': 'rejected'
      })
    })

    it('reads an error whose text body is printed after the headers as a split string', () => {
      const entry = entryOf(fixtureLine('response-error-500-text-body.txt'))
      expect(entry.kind).toBe('response-error')
      expect(entry.status).toBe(500)
      expect(entry.organizationUuid).toBe('00000000-0000-4000-8000-000000000001')
      expect(entry.headers['anthropic-ratelimit-unified-7d-utilization']).toBe('0.37')
    })

    it('is not thrown off by header values in every quote style, and keeps only the unified headers', () => {
      // The capture carries a value with a single quote (double-quoted by the
      // CLI), one with both quote kinds (backticked), one with all three
      // (escaped), a backslash, and several values masked by the CLI.
      const entry = entryOf(fixtureLine('response-start-quote-styles.txt'))
      expect(entry.status).toBe(200)
      expect(entry.organizationUuid).toBe('00000000-0000-4000-8000-000000000001')
      expect(entry.headers).toEqual({
        'anthropic-ratelimit-unified-5h-reset': '1795000000',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.12',
        'anthropic-ratelimit-unified-7d-reset': '1795435200',
        'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
        'anthropic-ratelimit-unified-7d-surpassed-threshold': '0.25',
        'anthropic-ratelimit-unified-7d-utilization': '0.37',
        'anthropic-ratelimit-unified-7d_oi-reset': '1795435200',
        'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
        'anthropic-ratelimit-unified-7d_oi-utilization': '0.05',
        'anthropic-ratelimit-unified-fallback-percentage': '0.5',
        'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
        'anthropic-ratelimit-unified-overage-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': '1795000000',
        'anthropic-ratelimit-unified-status': 'allowed'
      })
    })

    it('tolerates the line terminator', () => {
      const line = fixtureLine('response-start-streaming.txt')
      const expected = entryOf(line)
      expect(entryOf(`${line}\n`)).toEqual(expected)
      expect(entryOf(`${line}\r\n`)).toEqual(expected)
    })
  })

  describe('feeding the existing rate-limit header parser', () => {
    it('yields the weekly window of a success', () => {
      const snapshot = parseUnifiedRateLimitHeaders(
        entryOf(fixtureLine('response-start-streaming.txt')).headers
      )
      expect(snapshot?.sevenDay).toEqual({
        utilizationPercent: 37,
        resetsAt: 1795435200,
        status: 'allowed',
        surpassedThreshold: null
      })
      expect(snapshot?.fiveHour).toEqual({
        utilizationPercent: 3,
        resetsAt: 1795003200,
        status: 'allowed',
        surpassedThreshold: null
      })
      expect(snapshot?.representativeClaim).toBe('five_hour')
      expect(snapshot?.scoped).toEqual({})
      expect(snapshotHasUsage(snapshot!)).toBe(true)
    })

    it('yields the same windows for a non-streaming success', () => {
      const streaming = entryOf(fixtureLine('response-start-streaming.txt')).headers
      const nonStreaming = entryOf(fixtureLine('response-start-non-streaming.txt')).headers
      expect(parseUnifiedRateLimitHeaders(nonStreaming)).toEqual(
        parseUnifiedRateLimitHeaders(streaming)
      )
    })

    it('yields the weekly and the model-scoped window of the Fable response', () => {
      const snapshot = parseUnifiedRateLimitHeaders(
        entryOf(fixtureLine('response-start-fable.txt')).headers
      )
      expect(snapshot?.sevenDay).toEqual({
        utilizationPercent: 36,
        resetsAt: 1795435200,
        status: 'allowed',
        surpassedThreshold: null
      })
      expect(snapshot?.scoped).toEqual({
        oi: {
          utilizationPercent: 71,
          resetsAt: 1795435200,
          status: 'allowed_warning',
          surpassedThreshold: 0.5
        }
      })
      expect(snapshot?.fiveHour).toBeUndefined()
      expect(snapshot?.representativeClaim).toBe('seven_day_overage_included')
      expect(snapshotHasUsage(snapshot!)).toBe(true)
    })

    it('yields the rejected verdict of the plan-limit 429', () => {
      const snapshot = parseUnifiedRateLimitHeaders(
        entryOf(fixtureLine('response-error-429-plan-limit.txt')).headers
      )
      expect(snapshot?.status).toBe('rejected')
      expect(snapshot?.fiveHour).toEqual({
        utilizationPercent: 100,
        resetsAt: 1795003200,
        status: 'rejected',
        surpassedThreshold: 1
      })
      expect(snapshot?.sevenDay?.utilizationPercent).toBe(52)
    })

    it('yields nothing for the 404s, which carry no unified header', () => {
      for (const name of ['response-error-404.txt', 'response-error-404-compact-headers.txt']) {
        expect(parseUnifiedRateLimitHeaders(entryOf(fixtureLine(name)).headers)).toBeNull()
      }
    })
  })

  describe('header values', () => {
    it('decodes a value with a single quote, with both quote kinds, with all three, and with a backslash', () => {
      const values = {
        single: "it's",
        both: `it's "q"`,
        all: 'it\'s "q" `b`',
        backslash: 'a\\b',
        nonAscii: 'café ✓'
      }
      const entry = entryOf(
        responseStart({
          'anthropic-ratelimit-unified-single': values.single,
          'anthropic-ratelimit-unified-both': values.both,
          'anthropic-ratelimit-unified-all': values.all,
          'anthropic-ratelimit-unified-backslash': values.backslash,
          'anthropic-ratelimit-unified-non-ascii': values.nonAscii
        })
      )
      expect(entry.headers).toEqual({
        'anthropic-ratelimit-unified-single': values.single,
        'anthropic-ratelimit-unified-both': values.both,
        'anthropic-ratelimit-unified-all': values.all,
        'anthropic-ratelimit-unified-backslash': values.backslash,
        'anthropic-ratelimit-unified-non-ascii': values.nonAscii
      })
    })

    it('treats a masked value as absent, whichever layer masked it', () => {
      const entry = entryOf(
        responseStart({
          'anthropic-organization-id': '[REDACTED]',
          'anthropic-ratelimit-unified-7d-reset': '[REDACTED]',
          'anthropic-ratelimit-unified-7d-status': '***',
          'anthropic-ratelimit-unified-7d-utilization': '0.37'
        })
      )
      expect(entry.organizationUuid).toBeNull()
      expect(entry.headers).toEqual({ 'anthropic-ratelimit-unified-7d-utilization': '0.37' })
      expect(parseUnifiedRateLimitHeaders(entry.headers)?.sevenDay).toEqual({
        utilizationPercent: 37,
        resetsAt: null,
        status: null,
        surpassedThreshold: null
      })
    })

    it('lower-cases header names', () => {
      const entry = entryOf(
        responseStart({
          'Anthropic-Organization-Id': ORG_A,
          'Anthropic-Ratelimit-Unified-7d-Utilization': '0.37'
        })
      )
      expect(entry.organizationUuid).toBe(ORG_A)
      expect(entry.headers).toEqual({ 'anthropic-ratelimit-unified-7d-utilization': '0.37' })
    })

    it('keeps unified headers it has never seen, so new buckets reach the header parser', () => {
      const entry = entryOf(
        responseStart({
          'anthropic-ratelimit-unified-7d_opus-utilization': '0.44',
          'anthropic-ratelimit-unified-some-future-field': 'x'
        })
      )
      expect(entry.headers).toEqual({
        'anthropic-ratelimit-unified-7d_opus-utilization': '0.44',
        'anthropic-ratelimit-unified-some-future-field': 'x'
      })
      expect(parseUnifiedRateLimitHeaders(entry.headers)?.scoped.opus?.utilizationPercent).toBe(44)
    })

    it('drops every other response header', () => {
      const entry = entryOf(
        responseStart({
          'anthropic-organization-id': ORG_A,
          'anthropic-ratelimit-requests-remaining': '49',
          'anthropic-ratelimit-unified-status': 'allowed',
          'cf-ray': '0000000000000001-TLV',
          'request-id': 'req_011CScrubbed0000000000001',
          server: 'cloudflare'
        })
      )
      expect(entry.headers).toEqual({ 'anthropic-ratelimit-unified-status': 'allowed' })
    })

    it('reads an entry printed entirely on one line', () => {
      // Short enough for util.inspect to keep on one line, so the CLI writes
      // the payload as is instead of as a JSON string literal.
      const empty = sdkLine('response start', { status: 204, headers: {} })
      expect(empty.includes('\\n') || empty.includes('"console.log')).toBe(false)
      expect(entryOf(empty)).toEqual({
        kind: 'response-start',
        observedAt: OBSERVED_AT,
        status: 204,
        headers: {},
        organizationUuid: null
      })

      // Hand-written: what a wider break length would print.
      const wide =
        `${TIMESTAMP} [DEBUG] console.log: [log_0a1b2c] response error (error; not retryable) ` +
        `{ url: 'https://api.anthropic.com/v1/messages?beta=true', status: 429, ` +
        `headers: { 'anthropic-organization-id': '${ORG_A}', ` +
        `'anthropic-ratelimit-unified-status': 'rejected', server: 'cloudflare' }, ` +
        `message: undefined, durationMs: 5 }`
      expect(entryOf(wide)).toEqual({
        kind: 'response-error',
        observedAt: OBSERVED_AT,
        status: 429,
        headers: { 'anthropic-ratelimit-unified-status': 'rejected' },
        organizationUuid: ORG_A
      })
    })

    it('reads a retried error response', () => {
      const entry = entryOf(
        sdkLine('response error (retrying, 2 attempts remaining)', {
          url: 'https://api.anthropic.com/v1/messages?beta=true',
          status: 529,
          headers: { 'anthropic-organization-id': ORG_A, 'x-should-retry': 'true' },
          durationMs: 8,
          retryOf: 'log_3b470a'
        })
      )
      expect(entry).toEqual({
        kind: 'response-error',
        observedAt: OBSERVED_AT,
        status: 529,
        headers: {},
        organizationUuid: ORG_A
      })
    })

    it('ignores a header whose value is not a string or is implausibly long', () => {
      const entry = entryOf(
        responseStart({
          'anthropic-ratelimit-unified-7d-reset': 1795435200,
          'anthropic-ratelimit-unified-7d-status': ['allowed', 'rejected'],
          'anthropic-ratelimit-unified-7d-utilization': '0.37',
          'anthropic-ratelimit-unified-upgrade-paths': 'x'.repeat(300)
        })
      )
      expect(entry.headers).toEqual({ 'anthropic-ratelimit-unified-7d-utilization': '0.37' })
    })

    it('skips a value util.inspect cut short and keeps reading the headers after it', () => {
      // Past 10,000 characters util.inspect prints the start of the string and
      // `... N more characters` after the closing quote.
      const entry = entryOf(
        responseStart({
          'anthropic-organization-id': `${ORG_A}${'0'.repeat(10_001)}`,
          'anthropic-ratelimit-unified-7d-status': 'x'.repeat(10_001),
          'anthropic-ratelimit-unified-7d-utilization': '0.37',
          'x-long': 'x'.repeat(20_000)
        })
      )
      expect(entry.organizationUuid).toBeNull()
      expect(entry.headers).toEqual({ 'anthropic-ratelimit-unified-7d-utilization': '0.37' })
    })

    it('returns no organization when the header is not id-shaped', () => {
      for (const value of ['', '   ', 'not an id', '<script>', 'x'.repeat(200)]) {
        expect(
          entryOf(responseStart({ 'anthropic-organization-id': value })).organizationUuid
        ).toBe(null)
      }
    })

    it('does not read headers out of an earlier string value', () => {
      const entry = entryOf(
        sdkLine('response start', {
          url: "https://api.anthropic.com/v1/messages?x=', status: 500, headers: { 'anthropic-organization-id': 'spoofed' } }",
          status: 200,
          headers: { 'anthropic-organization-id': ORG_A },
          durationMs: 3
        })
      )
      expect(entry.status).toBe(200)
      expect(entry.organizationUuid).toBe(ORG_A)
    })
  })

  describe('the status line of a successful response (health detection, T18)', () => {
    const STATUS_LINE = fixtureLines('not-entries.txt')[2]

    it('recognises the line the SDK writes for a response that succeeded', () => {
      expect(STATUS_LINE).toContain('succeeded with status 200')
      expect(isClaudeDebugLogSuccessStatusLine(STATUS_LINE)).toBe(true)
      expect(isClaudeDebugLogSuccessStatusLine(`${STATUS_LINE}\n`)).toBe(true)
      // Any level tag, any 2xx, a retry named in the bracket, no request id at all.
      for (const line of [
        STATUS_LINE.replace('[DEBUG]', '[INFO]'),
        STATUS_LINE.replace('status 200', 'status 201'),
        STATUS_LINE.replace('[log_49f1c6,', '[log_49f1c6, retryOf: log_38697c,'),
        `${TIMESTAMP} [DEBUG] console.log: [log_0a1b2c] get https://api.anthropic.com/v1/models succeeded with status 200 in 4ms`
      ]) {
        expect(isClaudeDebugLogSuccessStatusLine(line)).toBe(true)
      }
      // It stays no entry: it carries no headers.
      expect(parseClaudeDebugLogLine(STATUS_LINE)).toEqual(UNRELATED)
    })

    it('recognises nothing else in a log', () => {
      // Requests, failed responses, the raw stream line, parsed bodies, start-up lines.
      const others = fixtureLines('not-entries.txt').filter((line) => line !== STATUS_LINE)
      expect(others).toHaveLength(13)
      for (const line of others) expect(isClaudeDebugLogSuccessStatusLine(line)).toBe(false)
      for (const name of [
        'response-start-streaming.txt',
        'response-start-non-streaming.txt',
        'response-error-404.txt',
        'response-error-429-plan-limit.txt'
      ]) {
        expect(isClaudeDebugLogSuccessStatusLine(fixtureLine(name))).toBe(false)
      }
    })

    it('is not taken in by the words inside another line', () => {
      const words = 'post https://api.anthropic.com/v1/messages succeeded with status 200 in 9ms'
      for (const line of [
        // A prompt that quotes the words, inside the request the SDK logs.
        sdkLine('sending request', { body: { messages: [{ content: words }] } }),
        `${TIMESTAMP} [DEBUG] console.log: [log_0a1b2c] sending request ${words}`,
        // Hook or tool output, which is logged inside other entries.
        `${TIMESTAMP} [DEBUG] Hook Stop success: console.log: [log_0a1b2c] ${words}`,
        `${TIMESTAMP} [DEBUG] console.log: ${words}`,
        // Not the SDK's shape: no method, an upper-case method, no URL.
        `${TIMESTAMP} [DEBUG] console.log: [log_0a1b2c]  succeeded with status 200 in 9ms`,
        `${TIMESTAMP} [DEBUG] console.log: [log_0a1b2c] POST https://x succeeded with status 200`,
        `${TIMESTAMP} [DEBUG] console.log: [log_0a1b2c] post succeeded with status 200 in 9ms`,
        // Without the timestamp and level prefix.
        STATUS_LINE.slice(TIMESTAMP.length + 1),
        '',
        `${TIMESTAMP} [DEBUG] console.log: [log_0a1b2c`
      ]) {
        expect(isClaudeDebugLogSuccessStatusLine(line)).toBe(false)
      }
    })

    it('never throws and never reads an oversized line', () => {
      const long = STATUS_LINE + 'x'.repeat(CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH)
      expect(isClaudeDebugLogSuccessStatusLine(long)).toBe(false)
      for (const value of [null, undefined, 42, {}]) {
        expect(isClaudeDebugLogSuccessStatusLine(value as unknown as string)).toBe(false)
      }
      for (let length = 0; length < STATUS_LINE.length; length += 7) {
        expect(() => isClaudeDebugLogSuccessStatusLine(STATUS_LINE.slice(0, length))).not.toThrow()
      }
    })
  })

  describe('lines that are not an entry', () => {
    it('rejects request entries, status lines and unrelated debug lines without decoding them', () => {
      // sending request (streaming and not), the `succeeded with status` and
      // `failed with status` lines, the SDK's raw stream line, response parsed,
      // connection failures, and plain CLI debug lines.
      const lines = fixtureLines('not-entries.txt')
      expect(lines).toHaveLength(14)
      const jsonParse = vi.spyOn(JSON, 'parse')
      const results = lines.map((line) => parseClaudeDebugLogLine(line))
      expect(jsonParse).not.toHaveBeenCalled()
      expect(results).toEqual(lines.map(() => UNRELATED))
    })

    it('rejects response text that is not at the start of the payload', () => {
      // Hook and MCP output is logged inside other entries and can contain SDK
      // debug text of its own.
      const details = inspect({
        status: 200,
        headers: {
          'anthropic-organization-id': ORG_A,
          'anthropic-ratelimit-unified-7d-utilization': '0.99'
        }
      })
      const hookOutput = `Hook UserPromptSubmit (UserPromptSubmit) success:\n[log_0a1b2c] response start ${details}`
      const consoleOutput = `console.log: spoof\nconsole.log: [log_0a1b2c] response start ${details}`
      expect(parseClaudeDebugLogLine(`${TIMESTAMP} [DEBUG] ${JSON.stringify(hookOutput)}`)).toEqual(
        UNRELATED
      )
      expect(
        parseClaudeDebugLogLine(`${TIMESTAMP} [DEBUG] ${JSON.stringify(consoleOutput)}`)
      ).toEqual(UNRELATED)
    })

    it('rejects a line without the timestamp and level prefix', () => {
      const line = fixtureLine('response-start-streaming.txt')
      const payload = line.slice(line.indexOf('"console.log'))
      for (const candidate of [
        '',
        ' ',
        payload,
        `[DEBUG] ${payload}`,
        `${TIMESTAMP} ${payload}`,
        `${TIMESTAMP} [debug] ${payload}`,
        `${TIMESTAMP} [] ${payload}`,
        `${TIMESTAMP} [DEBUG]${payload}`,
        `${TIMESTAMP} [AVERYLONGLEVELTAG] ${payload}`,
        ` ${line}`,
        line.replace('2026-11-17T', '2026-11-17 at ')
      ]) {
        expect(parseClaudeDebugLogLine(candidate)).toEqual(UNRELATED)
      }
    })

    it('accepts any level tag the CLI writes', () => {
      const line = fixtureLine('response-start-streaming.txt')
      for (const level of ['VERBOSE', 'INFO', 'WARN', 'ERROR']) {
        expect(parseClaudeDebugLogLine(line.replace('[DEBUG]', `[${level}]`)).kind).toBe('entry')
      }
    })

    it('rejects truncated JSON at every cut point without throwing', () => {
      const line = fixtureLine('response-start-streaming.txt')
      const reasons = new Set<string>()
      for (let length = 0; length < line.length; length++) {
        const result = parseClaudeDebugLogLine(line.slice(0, length))
        if (result.kind !== 'not-entry') throw new Error(`cut at ${length} produced an entry`)
        reasons.add(result.reason)
      }
      expect([...reasons].sort()).toEqual(['malformed', 'unrelated'])
      // Once the line reads as a response entry, a cut is a parse failure.
      expect(parseClaudeDebugLogLine(line.slice(0, 400))).toEqual(MALFORMED)
      expect(parseClaudeDebugLogLine(line.slice(0, -1))).toEqual(MALFORMED)
    })

    it('rejects an entry whose details are cut short inside valid JSON', () => {
      const line = fixtureLine('response-start-streaming.txt')
      const payloadStart = line.indexOf('"console.log')
      const text = JSON.parse(line.slice(payloadStart)) as string
      for (const length of [45, 120, 400, text.length - 30]) {
        const cut = `${line.slice(0, payloadStart)}${JSON.stringify(text.slice(0, length))}`
        expect(parseClaudeDebugLogLine(cut)).toEqual(MALFORMED)
      }
    })

    it('rejects an entry with a changed shape', () => {
      const headers = { 'anthropic-ratelimit-unified-status': 'allowed' }
      const url = 'https://api.anthropic.com/v1/messages?beta=true'
      for (const line of [
        sdkLine('response start', { url, headers, durationMs: 1 }),
        sdkLine('response start', { url, status: 200, durationMs: 1 }),
        sdkLine('response start', { url, status: '200', headers }),
        sdkLine('response start', { url, status: 20, headers }),
        sdkLine('response start', { url, status: 2000, headers }),
        sdkLine('response start', { url, status: 200, headers: 'none' }),
        sdkLine('response start', { url, status: 200, headers: new Map([['a', 'b']]) }),
        sdkLine('response start', { wrapped: { url, status: 200, headers } }),
        sdkLine('response start', [url, 200, headers]),
        sdkLine('response start', 'text'),
        sdkLine('response error (', { url, status: 404, headers }),
        sdkLine(`response error (${'x'.repeat(500)})`, { url, status: 404, headers }),
        sdkLine('response start', { url, status: 200, headers }, '2026-13-45T99:99:99.999Z'),
        `${TIMESTAMP} [DEBUG] "console.log: [log_0a1b2c] response start {" trailing`,
        `${TIMESTAMP} [DEBUG] "console.log: [log_0a1b2c] response start {`
      ]) {
        expect(parseClaudeDebugLogLine(line)).toEqual(MALFORMED)
      }
    })

    /** A well-formed entry padded, inside a header value, to an exact line length. */
    function entryLineOfLength(length: number): string {
      const head =
        `${TIMESTAMP} [DEBUG] "console.log: [log_0a1b2c] response start {\\n  status: 200,\\n` +
        `  headers: {\\n    'anthropic-ratelimit-unified-7d-utilization': '0.37',\\n    'x-padding': '`
      const tail = `'\\n  },\\n  durationMs: 1\\n}"`
      return `${head}${'x'.repeat(length - head.length - tail.length)}${tail}`
    }

    it('rejects an oversized line unread', () => {
      const line = entryLineOfLength(CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH + 1)
      expect(line.length).toBe(CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH + 1)
      const jsonParse = vi.spyOn(JSON, 'parse')
      expect(parseClaudeDebugLogLine(line)).toEqual(OVERSIZED)
      expect(parseClaudeDebugLogLine('x'.repeat(CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH * 4))).toEqual(
        OVERSIZED
      )
      expect(jsonParse).not.toHaveBeenCalled()
    })

    it('still reads a line of exactly the maximum length', () => {
      const line = entryLineOfLength(CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH)
      expect(line.length).toBe(CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH)
      expect(entryOf(line)).toEqual({
        kind: 'response-start',
        observedAt: OBSERVED_AT,
        status: 200,
        headers: { 'anthropic-ratelimit-unified-7d-utilization': '0.37' },
        organizationUuid: null
      })
    })

    it('stays linear on hostile input that claims to be an entry', () => {
      const prefix = `${TIMESTAMP} [DEBUG] console.log: [log_0a1b2c] response start `
      const room = CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH - prefix.length - 64
      const hostile = [
        `{ status: 200, headers: { a: '${'\\'.repeat(room)}`,
        `{ status: 200, headers: { a: ${'{'.repeat(room)}`,
        `{ status: 200, headers: { ${"'a': 'b', ".repeat(room / 10)}`,
        `{ status: 200, headers: { ${"'anthropic-ratelimit-unified-x".repeat(room / 30)}`,
        `{ status: 200, headers: { ${"'anthropic-ratelimit-unified-7d-status': 'a' + ".repeat(room / 48)}`,
        `{ ${'a: [ { ( '.repeat(room / 10)}`,
        `{ ${Array.from({ length: 2000 }, (_, i) => `'anthropic-ratelimit-unified-${i}': 'v'`).join(', ')} }`
      ]
      const started = performance.now()
      for (const details of hostile) {
        expect(parseClaudeDebugLogLine(prefix + details)).toEqual(MALFORMED)
      }
      // Each is one pass over about a megabyte. Seconds would mean backtracking.
      expect(performance.now() - started).toBeLessThan(2000)
    })

    it('never throws on a damaged entry', () => {
      // Deterministic damage to real entries: characters overwritten, removed
      // or doubled at pseudo-random positions.
      const sources = [
        'response-start-quote-styles.txt',
        'response-error-500-text-body.txt',
        'response-error-404-compact-headers.txt'
      ].map(fixtureLine)
      const replacements = ['', "'", '"', '`', '\\', '{', '}', ',', ':', '\\n', ' +', '[', ']']
      let seed = 0x2f6e2b1
      const next = (bound: number): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed % bound
      }
      const kinds = new Set<string>()
      for (let round = 0; round < 3000; round++) {
        let line = sources[round % sources.length]
        for (let edits = 1 + next(3); edits > 0; edits--) {
          const at = next(line.length)
          const replacement = replacements[next(replacements.length)]
          line = `${line.slice(0, at)}${replacement}${line.slice(at + next(2))}`
        }
        const result = parseClaudeDebugLogLine(line)
        kinds.add(result.kind === 'entry' ? 'entry' : result.reason)
        if (result.kind === 'entry') {
          expect(Number.isInteger(result.entry.status)).toBe(true)
          expect(Object.values(result.entry.headers).every((v) => typeof v === 'string')).toBe(true)
        }
      }
      // The damage lands in every outcome, so each path ran without throwing.
      expect([...kinds].sort()).toEqual(['entry', 'malformed', 'unrelated'])
    })

    it('returns "not an entry" for input that is not a string', () => {
      for (const value of [undefined, null, 42, {}, [], Buffer.from('x')]) {
        expect(parseClaudeDebugLogLine(value as unknown as string)).toEqual(UNRELATED)
      }
    })
  })

  describe('raw line content', () => {
    // A marker that stands for a credential reaching the file after an
    // upstream masking regression (PRD SEC-6).
    const SECRET = 'PLANTED-CREDENTIAL-0000'

    function spyOnOutput(): Array<ReturnType<typeof vi.spyOn>> {
      return [
        vi.spyOn(console, 'log').mockImplementation(() => undefined),
        vi.spyOn(console, 'info').mockImplementation(() => undefined),
        vi.spyOn(console, 'debug').mockImplementation(() => undefined),
        vi.spyOn(console, 'warn').mockImplementation(() => undefined),
        vi.spyOn(console, 'error').mockImplementation(() => undefined),
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      ]
    }

    it('is neither logged nor returned for a line that fails to parse', () => {
      const good = responseStart({
        authorization: `Bearer ${SECRET}`,
        'anthropic-ratelimit-unified-7d-utilization': '0.37'
      })
      const malformed = [good.slice(0, -1), good.slice(0, good.indexOf(SECRET) + SECRET.length)]
      const spies = spyOnOutput()
      const results = malformed.map((line) => parseClaudeDebugLogLine(line))
      const calls = spies.map((spy) => spy.mock.calls.length)
      vi.restoreAllMocks()

      expect(calls).toEqual(spies.map(() => 0))
      expect(results.map((result) => JSON.stringify(result))).toEqual(
        malformed.map(() => '{"kind":"not-entry","reason":"malformed"}')
      )
    })

    it('is not logged for a line that parses, and an unmasked credential does not reach the result', () => {
      const line = responseStart({
        authorization: `Bearer ${SECRET}`,
        'anthropic-organization-id': ORG_A,
        'anthropic-ratelimit-unified-7d-utilization': '0.37',
        'set-cookie': `session=${SECRET}`,
        'x-api-key': SECRET
      })
      const spies = spyOnOutput()
      const result = parseClaudeDebugLogLine(line)
      const calls = spies.map((spy) => spy.mock.calls.length)
      vi.restoreAllMocks()

      expect(calls).toEqual(spies.map(() => 0))
      expect(JSON.stringify(result)).not.toContain(SECRET)
      expect(result).toEqual({
        kind: 'entry',
        entry: {
          kind: 'response-start',
          observedAt: OBSERVED_AT,
          status: 200,
          headers: { 'anthropic-ratelimit-unified-7d-utilization': '0.37' },
          organizationUuid: ORG_A
        }
      })
    })

    it('hands every rejection the same frozen result', () => {
      const first = parseClaudeDebugLogLine('one unrelated line')
      const second = parseClaudeDebugLogLine('another unrelated line')
      expect(first).toBe(second)
      expect(Object.isFrozen(first)).toBe(true)
    })
  })
})
