/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs/promises')
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { readFile } from 'fs/promises'
import {
  readClaudeTranscript,
  encodePath,
  translateEntry,
  translateContentBlock
} from '../../../src/main/services/claude-transcript-reader'
import type {
  ClaudeJsonlEntry,
  ClaudeContentBlock
} from '../../../src/main/services/claude-transcript-reader'

const mockReadFile = vi.mocked(readFile)

// ── Helpers ────────────────────────────────────────────────────────

function makeUserEntry(overrides: Partial<ClaudeJsonlEntry> = {}): ClaudeJsonlEntry {
  return {
    type: 'user',
    uuid: 'user-uuid-1',
    timestamp: '2026-02-14T10:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Hello world' }]
    },
    isSidechain: false,
    ...overrides
  }
}

function makeAssistantEntry(overrides: Partial<ClaudeJsonlEntry> = {}): ClaudeJsonlEntry {
  return {
    type: 'assistant',
    uuid: 'assistant-uuid-1',
    timestamp: '2026-02-14T10:00:01.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there!' }]
    },
    isSidechain: false,
    ...overrides
  }
}

function buildJsonl(...entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n')
}

// ── Tests ──────────────────────────────────────────────────────────

describe('claude-transcript-reader', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // 1. Path encoding
  describe('encodePath', () => {
    it('replaces forward slashes with dashes', () => {
      expect(encodePath('/Users/mor/project')).toBe('-Users-mor-project')
    })

    it('encodes root path to a single dash', () => {
      expect(encodePath('/')).toBe('-')
    })

    it('handles deeply nested paths', () => {
      expect(encodePath('/a/b/c/d/e')).toBe('-a-b-c-d-e')
    })

    it('handles path without leading slash', () => {
      expect(encodePath('relative/path')).toBe('relative-path')
    })
  })

  // 2. JSONL parsing — correct number of messages
  describe('JSONL parsing', () => {
    it('parses user + assistant entries and returns correct count', async () => {
      const jsonl = buildJsonl(makeUserEntry(), makeAssistantEntry())
      mockReadFile.mockResolvedValue(jsonl)

      const result = await readClaudeTranscript('/Users/mor/project', 'session-123')
      expect(result).toHaveLength(2)
    })
  })

  // 3. Filtering
  describe('filtering', () => {
    it('excludes sidechain entries', async () => {
      const jsonl = buildJsonl(
        makeUserEntry(),
        makeAssistantEntry({ isSidechain: true, uuid: 'sidechain-1' }),
        makeAssistantEntry({ uuid: 'normal-1' })
      )
      mockReadFile.mockResolvedValue(jsonl)

      const result = await readClaudeTranscript('/path', 'sid')
      expect(result).toHaveLength(2)
      expect((result[0] as any).id).toBe('user-uuid-1')
      expect((result[1] as any).id).toBe('normal-1')
    })

    it('excludes non-user/assistant types', async () => {
      const jsonl = buildJsonl(
        makeUserEntry(),
        { type: 'progress', uuid: 'p1', timestamp: '2026-01-01T00:00:00Z' },
        { type: 'summary', uuid: 's1', timestamp: '2026-01-01T00:00:00Z' },
        { type: 'custom-title', uuid: 'c1', timestamp: '2026-01-01T00:00:00Z' },
        { type: 'queue-operation', uuid: 'q1', timestamp: '2026-01-01T00:00:00Z' },
        makeAssistantEntry()
      )
      mockReadFile.mockResolvedValue(jsonl)

      const result = await readClaudeTranscript('/path', 'sid')
      expect(result).toHaveLength(2)
    })
  })

  // 4. Text content translation
  describe('text content translation', () => {
    it('translates user message text content into parts array', () => {
      const entry = makeUserEntry({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' }
          ]
        }
      })

      const result = translateEntry(entry, 0) as any
      expect(result).not.toBeNull()
      expect(result.id).toBe('user-uuid-1')
      expect(result.role).toBe('user')
      expect(result.content).toBe('Hello world')
      expect(result.parts).toHaveLength(2)
      expect(result.parts[0]).toEqual({ type: 'text', text: 'Hello ' })
      expect(result.parts[1]).toEqual({ type: 'text', text: 'world' })
    })
  })

  // 5. Tool use translation
  describe('tool use translation', () => {
    it('translates tool_use blocks into toolUse shape with status success', () => {
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_abc',
              name: 'Read',
              input: { path: 'foo.ts' }
            }
          ]
        }
      })

      const result = translateEntry(entry, 0) as any
      expect(result).not.toBeNull()
      expect(result.parts).toHaveLength(1)

      const toolPart = result.parts[0]
      expect(toolPart.type).toBe('tool_use')
      expect(toolPart.toolUse).toBeDefined()
      expect(toolPart.toolUse.id).toBe('toolu_abc')
      expect(toolPart.toolUse.name).toBe('Read')
      expect(toolPart.toolUse.input).toEqual({ path: 'foo.ts' })
      expect(toolPart.toolUse.status).toBe('success')
    })

    it('provides default values for missing tool_use fields', () => {
      const block: ClaudeContentBlock = { type: 'tool_use' }
      const result = translateContentBlock(block, 5, '2026-02-14T10:00:01.000Z') as any

      expect(result.toolUse.id).toBe('tool-5')
      expect(result.toolUse.name).toBe('Unknown')
      expect(result.toolUse.input).toEqual({})
      expect(result.toolUse.status).toBe('success')
      expect(result.toolUse.startTime).toBe(new Date('2026-02-14T10:00:01.000Z').getTime())
    })

    it('uses 0 as startTime when timestamp is undefined', () => {
      const block: ClaudeContentBlock = { type: 'tool_use' }
      const result = translateContentBlock(block, 0, undefined) as any
      expect(result.toolUse.startTime).toBe(0)
    })

    it('uses 0 as startTime when timestamp is not parseable', () => {
      const block: ClaudeContentBlock = { type: 'tool_use' }
      const result = translateContentBlock(block, 0, 'not-a-date') as any
      expect(result.toolUse.startTime).toBe(0)
    })
  })

  // 6. Thinking/reasoning translation
  describe('thinking/reasoning translation', () => {
    it('translates thinking blocks to reasoning type', () => {
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: 'Here is my answer.' }
          ]
        }
      })

      const result = translateEntry(entry, 0) as any
      expect(result.parts).toHaveLength(2)
      expect(result.parts[0]).toEqual({
        type: 'reasoning',
        text: 'Let me think about this...'
      })
      expect(result.parts[1]).toEqual({ type: 'text', text: 'Here is my answer.' })
    })

    it('skips thinking blocks with non-string thinking field', () => {
      const block: ClaudeContentBlock = { type: 'thinking' }
      const result = translateContentBlock(block, 0, undefined)
      expect(result).toBeNull()
    })
  })

  // 7. Missing file returns []
  describe('missing file', () => {
    it('returns empty array when file does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'))

      const result = await readClaudeTranscript('/no/such/path', 'missing-session')
      expect(result).toEqual([])
    })
  })

  // 8. Malformed JSONL
  describe('malformed JSONL', () => {
    it('gracefully skips bad lines and returns valid entries', async () => {
      const lines = [
        JSON.stringify(makeUserEntry()),
        'this is not json {{{',
        '',
        JSON.stringify(makeAssistantEntry()),
        '{"incomplete": true'
      ].join('\n')
      mockReadFile.mockResolvedValue(lines)

      const result = await readClaudeTranscript('/path', 'sid')
      expect(result).toHaveLength(2)
    })
  })

  // 9. Message ordering preserved
  describe('message ordering', () => {
    it('returns messages in same order as JSONL file', async () => {
      const entries = [
        makeAssistantEntry({ uuid: 'a1', timestamp: '2026-02-14T10:00:02.000Z' }),
        makeUserEntry({ uuid: 'u1', timestamp: '2026-02-14T10:00:00.000Z' }),
        makeAssistantEntry({ uuid: 'a2', timestamp: '2026-02-14T10:00:01.000Z' })
      ]
      mockReadFile.mockResolvedValue(buildJsonl(...entries))

      const result = await readClaudeTranscript('/path', 'sid')
      expect(result).toHaveLength(3)
      expect((result[0] as any).id).toBe('a1')
      expect((result[1] as any).id).toBe('u1')
      expect((result[2] as any).id).toBe('a2')
    })
  })

  // 10. Empty content handling
  describe('empty content', () => {
    it('handles entries with empty content array', () => {
      const entry = makeUserEntry({
        message: { role: 'user', content: [] }
      })

      const result = translateEntry(entry, 0) as any
      expect(result).not.toBeNull()
      expect(result.content).toBe('')
      expect(result.parts).toEqual([])
    })

    it('handles entries with missing message.content', () => {
      const entry: ClaudeJsonlEntry = {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-02-14T10:00:00.000Z',
        message: { role: 'user' }
      }

      const result = translateEntry(entry, 1) as any
      expect(result).not.toBeNull()
      expect(result.content).toBe('')
      expect(result.parts).toEqual([])
    })

    it('handles entries with string content in message', () => {
      const entry: ClaudeJsonlEntry = {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-02-14T10:00:00.000Z',
        message: { role: 'user', content: 'plain string' as any }
      }

      const result = translateEntry(entry, 2) as any
      expect(result).not.toBeNull()
      expect(result.content).toBe('plain string')
      expect(result.parts).toEqual([])
    })
  })

  // Additional: tool_result blocks are skipped
  describe('tool_result blocks', () => {
    it('filters out tool_result content blocks', () => {
      const entry = makeAssistantEntry({
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Response' },
            { type: 'tool_result', tool_use_id: 'toolu_abc', content: 'result data' } as any
          ]
        }
      })

      const result = translateEntry(entry, 0) as any
      expect(result.parts).toHaveLength(1)
      expect(result.parts[0].type).toBe('text')
    })
  })

  // Fallback ID uses index
  describe('fallback ID', () => {
    it('uses entry-${index} when uuid is missing', () => {
      const entry = makeUserEntry({ uuid: undefined })
      const result = translateEntry(entry, 7) as any
      expect(result.id).toBe('entry-7')
    })
  })

  // Additional: timestamp and id fields
  describe('field mapping', () => {
    it('uses entry.uuid as id and entry.timestamp as timestamp', () => {
      const entry = makeUserEntry({
        uuid: 'my-unique-id',
        timestamp: '2026-06-15T12:30:00.000Z'
      })

      const result = translateEntry(entry, 0) as any
      expect(result.id).toBe('my-unique-id')
      expect(result.timestamp).toBe('2026-06-15T12:30:00.000Z')
    })

    it('uses message.role from the entry', () => {
      const entry = makeAssistantEntry()
      const result = translateEntry(entry, 1) as any
      expect(result.role).toBe('assistant')
    })
  })
})
