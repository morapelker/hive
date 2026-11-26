import { describe, test, expect } from 'vitest'
import { upsertChildToolPart } from '@/lib/child-tool-stream'
import type { StreamingPart } from '@/lib/opencode-transcript'

const pending = { type: 'tool', tool: 'Bash', callID: 'call-1', state: { status: 'pending' } }
const running = {
  type: 'tool',
  tool: 'Bash',
  callID: 'call-1',
  state: {
    status: 'running',
    input: { command: 'ls -la', description: 'List files' },
    time: { start: 100 }
  }
}
const completed = {
  type: 'tool',
  tool: 'Bash',
  callID: 'call-1',
  state: {
    status: 'completed',
    input: { command: 'ls -la', description: 'List files' },
    output: 'README.md',
    time: { start: 100, end: 250 }
  }
}

describe('upsertChildToolPart', () => {
  test('a pending tool with no input starts with an empty input', () => {
    const parts = upsertChildToolPart([], pending)

    expect(parts).toHaveLength(1)
    expect(parts[0].toolUse).toMatchObject({
      id: 'call-1',
      name: 'Bash',
      input: {},
      status: 'running'
    })
  })

  test('the same tool gains its input, status and output as events arrive', () => {
    let parts: StreamingPart[] = upsertChildToolPart([], pending)
    parts = upsertChildToolPart(parts, running)

    expect(parts).toHaveLength(1)
    expect(parts[0].toolUse?.input).toEqual({ command: 'ls -la', description: 'List files' })
    expect(parts[0].toolUse?.status).toBe('running')

    parts = upsertChildToolPart(parts, completed)

    expect(parts).toHaveLength(1)
    expect(parts[0].toolUse).toMatchObject({
      id: 'call-1',
      input: { command: 'ls -la', description: 'List files' },
      status: 'success',
      output: 'README.md',
      endTime: 250
    })
  })

  test('a later event without input keeps the input already known', () => {
    let parts = upsertChildToolPart([], running)
    parts = upsertChildToolPart(parts, {
      tool: 'Bash',
      callID: 'call-1',
      state: { status: 'completed', output: 'done' }
    })

    expect(parts[0].toolUse?.input).toEqual({ command: 'ls -la', description: 'List files' })
    expect(parts[0].toolUse?.output).toBe('done')
  })

  test('records the error of a failed tool', () => {
    let parts = upsertChildToolPart([], running)
    parts = upsertChildToolPart(parts, {
      callID: 'call-1',
      state: { status: 'error', error: 'boom' }
    })

    expect(parts[0].toolUse).toMatchObject({ status: 'error', error: 'boom' })
  })

  // ToolCard is memoized: an in-place mutation would never re-render it
  test('replaces the tool object instead of mutating it', () => {
    const first = upsertChildToolPart([], pending)
    const firstTool = first[0].toolUse
    const second = upsertChildToolPart(first, running)

    expect(second).not.toBe(first)
    expect(second[0].toolUse).not.toBe(firstTool)
    expect(firstTool?.input).toEqual({})
  })

  test('keeps other parts and adds a second tool after them', () => {
    const text: StreamingPart = { type: 'text', text: 'thinking' }
    let parts = upsertChildToolPart([text], running)
    parts = upsertChildToolPart(parts, { tool: 'Read', callID: 'call-2', state: {} })

    expect(parts.map((p) => p.toolUse?.id ?? p.type)).toEqual(['text', 'call-1', 'call-2'])
    expect(parts[0]).toBe(text)
  })

  test('reads state fields placed on the part itself', () => {
    const parts = upsertChildToolPart([], {
      id: 'call-3',
      name: 'Grep',
      status: 'running',
      input: { pattern: 'foo' }
    })

    expect(parts[0].toolUse).toMatchObject({
      id: 'call-3',
      name: 'Grep',
      input: { pattern: 'foo' }
    })
  })
})
