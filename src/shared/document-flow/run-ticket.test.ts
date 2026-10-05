import { describe, expect, it } from 'vitest'
import { DOCUMENT_RUN_STATUSES } from '../types/document-flow'
import {
  DOCUMENT_RUN_TICKET_PROVIDER,
  documentRunIdOf,
  isActiveRunStatus,
  isDocumentRunTicket,
  isEndedRunStatus
} from './run-ticket'

describe('run tickets', () => {
  it('recognises the ticket of a run by its external source and reads the run id from it', () => {
    const ticket = { external_provider: DOCUMENT_RUN_TICKET_PROVIDER, external_id: 'run-1' }

    expect(DOCUMENT_RUN_TICKET_PROVIDER).toBe('document-run')
    expect(isDocumentRunTicket(ticket)).toBe(true)
    expect(documentRunIdOf(ticket)).toBe('run-1')
  })

  it.each([
    ['an ordinary ticket', { external_provider: null, external_id: null }],
    ['an imported ticket', { external_provider: 'github', external_id: '42' }],
    ['a ticket without the fields', {}],
    ['no ticket', null],
    ['an undefined ticket', undefined]
  ])('leaves %s alone', (_name, ticket) => {
    expect(isDocumentRunTicket(ticket)).toBe(false)
    expect(documentRunIdOf(ticket)).toBeNull()
  })

  it('has no run id for a marked ticket that lost it', () => {
    const ticket = { external_provider: DOCUMENT_RUN_TICKET_PROVIDER, external_id: '' }

    expect(isDocumentRunTicket(ticket)).toBe(true)
    expect(documentRunIdOf(ticket)).toBeNull()
  })
})

describe('run statuses', () => {
  it('splits the launched statuses into active and ended, and counts the rest as neither', () => {
    const active = DOCUMENT_RUN_STATUSES.filter(isActiveRunStatus)
    const ended = DOCUMENT_RUN_STATUSES.filter(isEndedRunStatus)

    expect(active).toEqual(['running', 'paused'])
    expect(ended).toEqual(['completed', 'completed_with_issues', 'cancelled'])
    expect(
      DOCUMENT_RUN_STATUSES.filter(
        (status) => !isActiveRunStatus(status) && !isEndedRunStatus(status)
      )
    ).toEqual(['extracting', 'extract_failed', 'preview'])
  })
})
