import { beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { visibleTicketKeyOf, visibleTicketTitle } from './ticket-key-display'

const plain = { title: 'Fix login', ticket_prefix: 'TD', ticket_number: 12 }
const run = { ...plain, ticket_number: 7, external_provider: 'document-run', external_id: 'run-1' }
const child = { ...plain, parent_ticket_key: 'TD-7' }

describe('ticket key display helpers', () => {
  beforeEach(() => useSettingsStore.setState({ ticketKeyDisplay: 'always' }))

  it('always: every ticket shows its key', () => {
    expect(visibleTicketKeyOf(plain)).toBe('TD-12')
    expect(visibleTicketTitle(plain)).toBe('TD-12 · Fix login')
  })

  it('never: no ticket shows its key, the title stands alone', () => {
    useSettingsStore.setState({ ticketKeyDisplay: 'never' })
    expect(visibleTicketKeyOf(run)).toBeNull()
    expect(visibleTicketTitle(child)).toBe('Fix login')
    expect(visibleTicketTitle({ ...plain, title: '  ' })).toBe('A ticket')
  })

  it('orchestrator: only a run ticket and its children keep the key', () => {
    useSettingsStore.setState({ ticketKeyDisplay: 'orchestrator' })
    expect(visibleTicketKeyOf(plain)).toBeNull()
    expect(visibleTicketKeyOf(run)).toBe('TD-7')
    expect(visibleTicketTitle(child)).toBe('TD-12 · Fix login')
  })

  it('takes an explicit display instead of the store', () => {
    expect(visibleTicketKeyOf(plain, 'never')).toBeNull()
    expect(visibleTicketTitle(plain, 'A ticket', 'never')).toBe('Fix login')
  })

  it('reads nothing for a keyless ticket', () => {
    expect(visibleTicketKeyOf({ ...plain, ticket_number: null })).toBeNull()
    expect(visibleTicketTitle({ ...plain, ticket_prefix: null })).toBe('Fix login')
  })
})
