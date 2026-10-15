import { beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/useSettingsStore'
import {
  parentTicketKeyVisible,
  ticketKeyVisible,
  visibleTicketKeyOf,
  visibleTicketKeysOf,
  visibleTicketTitle
} from './ticket-key-display'

const plain = {
  title: 'Fix login',
  ticket_prefix: 'TD',
  ticket_number: 12,
  parent_ticket_key: null,
  external_provider: null,
  external_id: null
}
const run = { ...plain, ticket_number: 7, external_provider: 'document-run', external_id: 'run-1' }
const child = { ...plain, parent_ticket_key: 'TD-7' }

describe('ticket key display helpers', () => {
  beforeEach(() => useSettingsStore.setState({ ticketKeyDisplay: 'always' }))

  it('always: every ticket shows its key, a child its parent too', () => {
    expect(visibleTicketKeyOf(plain)).toBe('TD-12')
    expect(visibleTicketTitle(plain)).toBe('TD-12 · Fix login')
    expect(visibleTicketKeysOf(child)).toEqual({ key: 'TD-12', parentKey: 'TD-7' })
    expect(visibleTicketTitle(child)).toBe('TD-12 · Fix login')
  })

  it('never: no ticket shows any key, the title stands alone', () => {
    useSettingsStore.setState({ ticketKeyDisplay: 'never' })
    expect(visibleTicketKeyOf(run)).toBeNull()
    expect(visibleTicketKeysOf(child)).toEqual({ key: null, parentKey: null })
    expect(visibleTicketTitle(child)).toBe('Fix login')
    expect(visibleTicketTitle({ ...plain, title: '  ' })).toBe('A ticket')
  })

  it('orchestrator: a run shows its key, a child only the run it belongs to, others nothing', () => {
    useSettingsStore.setState({ ticketKeyDisplay: 'orchestrator' })
    expect(visibleTicketKeyOf(plain)).toBeNull()
    expect(visibleTicketKeysOf(plain)).toEqual({ key: null, parentKey: null })
    expect(visibleTicketTitle(plain)).toBe('Fix login')

    expect(visibleTicketKeyOf(run)).toBe('TD-7')
    expect(visibleTicketTitle(run)).toBe('TD-7 · Fix login')

    expect(visibleTicketKeyOf(child)).toBeNull()
    expect(visibleTicketKeysOf(child)).toEqual({ key: null, parentKey: 'TD-7' })
    expect(visibleTicketTitle(child)).toBe('TD-7 › Fix login')
  })

  it('exposes the two rules separately', () => {
    expect(ticketKeyVisible('orchestrator', child)).toBe(false)
    expect(ticketKeyVisible('orchestrator', run)).toBe(true)
    expect(parentTicketKeyVisible('orchestrator', child)).toBe(true)
    expect(parentTicketKeyVisible('always', child)).toBe(true)
    expect(parentTicketKeyVisible('never', child)).toBe(false)
    expect(parentTicketKeyVisible('orchestrator', plain)).toBe(false)
  })

  it('takes an explicit display instead of the store', () => {
    expect(visibleTicketKeyOf(plain, 'never')).toBeNull()
    expect(visibleTicketTitle(plain, 'A ticket', 'never')).toBe('Fix login')
    expect(visibleTicketTitle(child, 'A ticket', 'orchestrator')).toBe('TD-7 › Fix login')
  })

  it('reads nothing for a keyless ticket', () => {
    expect(visibleTicketKeyOf({ ...plain, ticket_number: null })).toBeNull()
    expect(visibleTicketTitle({ ...plain, ticket_prefix: null })).toBe('Fix login')
  })

  it('a keyless orchestrator child still shows the run it belongs to', () => {
    useSettingsStore.setState({ ticketKeyDisplay: 'orchestrator' })
    const keyless = { ...child, ticket_number: null }
    expect(visibleTicketKeysOf(keyless)).toEqual({ key: null, parentKey: 'TD-7' })
    expect(visibleTicketTitle(keyless)).toBe('TD-7 › Fix login')
  })
})
