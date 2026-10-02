// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { UsageData } from '@shared/types/usage'
import {
  extractClaudeAccountUuid,
  mergeUnifiedSnapshotIntoUsage,
  parseUnifiedRateLimitHeaders,
  snapshotHasUsage
} from '../anthropic-rate-limit-headers'

// Verbatim shape from a captured claude 2.1.287 exchange (see the POC log).
const CAPTURED_HEADERS = {
  'anthropic-organization-id': '7ab9492e-fa09-43c4-9958-a71735e98f68',
  'anthropic-ratelimit-unified-5h-reset': '1790902800',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.03',
  'anthropic-ratelimit-unified-7d-reset': '1791036000',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.39',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': '1790902800',
  'anthropic-ratelimit-unified-status': 'allowed',
  'content-type': 'text/event-stream; charset=utf-8',
  'request-id': 'req_011CfcFdD3w1YiofMwRzV8mf'
}

describe('parseUnifiedRateLimitHeaders', () => {
  it('maps fraction utilization to percent and epoch seconds to resets', () => {
    const snapshot = parseUnifiedRateLimitHeaders(CAPTURED_HEADERS)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.fiveHour).toEqual({
      utilizationPercent: 3,
      resetsAt: 1790902800,
      status: 'allowed',
      surpassedThreshold: null
    })
    expect(snapshot?.sevenDay).toEqual({
      utilizationPercent: 39,
      resetsAt: 1791036000,
      status: 'allowed',
      surpassedThreshold: null
    })
    expect(snapshot?.status).toBe('allowed')
    expect(snapshot?.representativeClaim).toBe('five_hour')
    expect(snapshot?.resetsAt).toBe(1790902800)
    expect(snapshot?.overage).toEqual({
      status: 'rejected',
      resetsAt: null,
      disabledReason: 'org_level_disabled',
      utilizationPercent: null
    })
    expect(snapshot?.scoped).toEqual({})
    expect(snapshotHasUsage(snapshot!)).toBe(true)
  })

  it('returns null when the response carries no unified headers', () => {
    expect(
      parseUnifiedRateLimitHeaders({
        'content-type': 'application/json',
        'x-should-retry': 'true',
        'retry-after': '30'
      })
    ).toBeNull()
  })

  it('parses model-scoped weekly buckets and the rejected verdict of a plan-limit 429', () => {
    const snapshot = parseUnifiedRateLimitHeaders({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
      'anthropic-ratelimit-unified-reset': '1791036000',
      'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
      'anthropic-ratelimit-unified-7d_oi-reset': '1791036000',
      'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
      'anthropic-ratelimit-unified-7d_oi-surpassed-threshold': '1.0',
      'anthropic-ratelimit-unified-5h-utilization': '0.4216',
      'anthropic-ratelimit-unified-5h-reset': '1790902800'
    })
    expect(snapshot?.status).toBe('rejected')
    expect(snapshot?.representativeClaim).toBe('seven_day_overage_included')
    expect(snapshot?.scoped).toEqual({
      oi: {
        utilizationPercent: 100,
        resetsAt: 1791036000,
        status: 'rejected',
        surpassedThreshold: 1
      }
    })
    expect(snapshot?.fiveHour?.utilizationPercent).toBe(42.16)
    expect(snapshot?.sevenDay).toBeUndefined()
  })

  it('tolerates array-valued and already-percent headers', () => {
    const snapshot = parseUnifiedRateLimitHeaders({
      'Anthropic-Ratelimit-Unified-5h-Utilization': ['37.5'],
      'anthropic-ratelimit-unified-5h-reset': ['1790902800000']
    })
    expect(snapshot?.fiveHour?.utilizationPercent).toBe(37.5)
    expect(snapshot?.fiveHour?.resetsAt).toBe(1790902800)
  })

  it('does not count a bare status header as usage', () => {
    const snapshot = parseUnifiedRateLimitHeaders({
      'anthropic-ratelimit-unified-status': 'allowed'
    })
    expect(snapshot).not.toBeNull()
    expect(snapshotHasUsage(snapshot!)).toBe(false)
  })
})

describe('mergeUnifiedSnapshotIntoUsage', () => {
  const previous: UsageData = {
    five_hour: { utilization: 70, resets_at: '2026-10-01T20:00:00.000Z' },
    seven_day: { utilization: 20, resets_at: '2026-10-05T10:00:00.000Z' },
    extra_usage: { is_enabled: true, utilization: 12, used_credits: 1.5, monthly_limit: 50 },
    scoped: [
      { label: 'Fable', used_percent: 55, resets_at: '2026-10-04T00:00:00.000Z' },
      { label: 'Opus', used_percent: 10, resets_at: null }
    ]
  }

  it('replaces the named windows and keeps everything the headers do not describe', () => {
    const snapshot = parseUnifiedRateLimitHeaders(CAPTURED_HEADERS)!
    const merged = mergeUnifiedSnapshotIntoUsage(previous, snapshot)
    expect(merged.five_hour).toEqual({ utilization: 3, resets_at: '2026-10-02T01:00:00.000Z' })
    expect(merged.seven_day).toEqual({ utilization: 39, resets_at: '2026-10-03T14:00:00.000Z' })
    expect(merged.extra_usage).toEqual(previous.extra_usage)
    expect(merged.scoped).toEqual(previous.scoped)
    // Never mutates the previous snapshot.
    expect(previous.five_hour.utilization).toBe(70)
  })

  it('updates a scoped bucket by label and appends unknown-to-poll ones', () => {
    const snapshot = parseUnifiedRateLimitHeaders({
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.6',
      'anthropic-ratelimit-unified-7d_oi-reset': '1791036000',
      'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.25',
      'anthropic-ratelimit-unified-7d_mystery-utilization': '0.9'
    })!
    const merged = mergeUnifiedSnapshotIntoUsage(previous, snapshot)
    // Windows without header numbers carry over from the poll.
    expect(merged.five_hour).toEqual(previous.five_hour)
    expect(merged.seven_day).toEqual(previous.seven_day)
    expect(merged.scoped).toEqual([
      { label: 'Fable', used_percent: 60, resets_at: '2026-10-03T14:00:00.000Z' },
      { label: 'Opus', used_percent: 10, resets_at: null },
      { label: 'Sonnet', used_percent: 25, resets_at: null }
    ])
  })

  it('builds a usable snapshot with no prior poll', () => {
    const snapshot = parseUnifiedRateLimitHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-5h-reset': '1790902800'
    })!
    expect(mergeUnifiedSnapshotIntoUsage(null, snapshot)).toEqual({
      five_hour: { utilization: 50, resets_at: '2026-10-02T01:00:00.000Z' },
      seven_day: { utilization: 0, resets_at: null }
    })
  })
})

describe('extractClaudeAccountUuid', () => {
  const metadata = {
    user_id: JSON.stringify({
      device_id: '523479bb71645476d922dc7758fdaee172ae4ecb3ac7c7edd2896c9fcc269985',
      account_uuid: '718FD88E-2076-4451-BC5F-066158379585',
      session_id: 'a9beb13d-93a0-4deb-b052-c7a6ceae330a'
    })
  }

  it('finds the uuid even when metadata trails a large messages array', () => {
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: 'x'.repeat(200_000) }],
        metadata,
        stream: true
      })
    )
    expect(extractClaudeAccountUuid(body)).toBe('718fd88e-2076-4451-bc5f-066158379585')
  })

  it('skips a quoted user_id inside message text and keeps scanning', () => {
    const body = Buffer.from(
      JSON.stringify({
        messages: [{ role: 'user', content: 'the field "user_id": "not json" is here' }],
        metadata
      })
    )
    expect(extractClaudeAccountUuid(body)).toBe('718fd88e-2076-4451-bc5f-066158379585')
  })

  it('returns null without metadata, with an empty uuid, or for non-JSON bodies', () => {
    expect(
      extractClaudeAccountUuid(Buffer.from(JSON.stringify({ model: 'x', messages: [] })))
    ).toBeNull()
    expect(
      extractClaudeAccountUuid(
        Buffer.from(JSON.stringify({ metadata: { user_id: JSON.stringify({ account_uuid: '' }) } }))
      )
    ).toBeNull()
    expect(extractClaudeAccountUuid(Buffer.from('not json "user_id": {'))).toBeNull()
    expect(extractClaudeAccountUuid(Buffer.alloc(0))).toBeNull()
  })
})
