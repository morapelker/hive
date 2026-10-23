// Editor bridge queue: an insertion for a project that is not on screen waits for that project
// and is never replaced by another project's insertion; each project reads its own oldest one;
// `consume` removes exactly that item; `pending` is the newest waiting insertion (what the single
// slot held) and setting it to null clears everything; per-project cap; clear(projectId).
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_PENDING_INSERTIONS_PER_PROJECT,
  selectPendingFor,
  useDataEditorBridge
} from './editor-bridge'

const bridge = () => useDataEditorBridge.getState()
const next = (projectId: string) => selectPendingFor(projectId)(bridge())

beforeEach(() => useDataEditorBridge.setState({ pending: null, queue: [] }))

describe('editor bridge', () => {
  it('keeps a proposal for a hidden project while another project inserts', () => {
    bridge().insert({ dataProjectId: 'A', text: 'SELECT a', mode: 'new-tab', origin: 'assistant' })
    bridge().insert({ dataProjectId: 'B', text: 'SELECT b', mode: 'replace' })
    expect(bridge().pending?.text).toBe('SELECT b')
    const b = next('B')!
    bridge().consume(b.seq)
    expect(next('B')).toBeNull()
    // A's proposal survived B's insertion and consumption
    expect(next('A')).toMatchObject({ text: 'SELECT a', mode: 'new-tab' })
    expect(bridge().pending?.text).toBe('SELECT a')
  })

  it('hands a project its insertions oldest first and consumes only the given one', () => {
    bridge().insert({ dataProjectId: 'A', text: '1', mode: 'new-tab' })
    bridge().insert({ dataProjectId: 'A', text: '2', mode: 'new-tab' })
    const first = next('A')!
    expect(first.text).toBe('1')
    // the selector returns the same object until it is consumed (stable for React)
    expect(next('A')).toBe(first)
    bridge().consume(first.seq)
    bridge().consume(first.seq)
    expect(next('A')?.text).toBe('2')
    bridge().consume(next('A')!.seq)
    expect(next('A')).toBeNull()
    expect(bridge().pending).toBeNull()
  })

  it('treats pending: null written from outside as an empty queue', () => {
    bridge().insert({ dataProjectId: 'A', text: 'old', mode: 'replace' })
    useDataEditorBridge.setState({ pending: null })
    expect(next('A')).toBeNull()
    bridge().insert({ dataProjectId: 'A', text: 'new', mode: 'replace' })
    expect(next('A')?.text).toBe('new')
    expect(bridge().queue).toHaveLength(1)
  })

  it('caps the waiting insertions per project and clears one project', () => {
    for (let i = 0; i < MAX_PENDING_INSERTIONS_PER_PROJECT + 3; i++)
      bridge().insert({ dataProjectId: 'A', text: `q${i}`, mode: 'new-tab' })
    bridge().insert({ dataProjectId: 'B', text: 'b', mode: 'new-tab' })
    expect(bridge().queue.filter((i) => i.dataProjectId === 'A')).toHaveLength(
      MAX_PENDING_INSERTIONS_PER_PROJECT
    )
    expect(next('A')?.text).toBe('q3')
    bridge().clear('A')
    expect(next('A')).toBeNull()
    expect(next('B')?.text).toBe('b')
    bridge().clear()
    expect(bridge().pending).toBeNull()
  })
})
