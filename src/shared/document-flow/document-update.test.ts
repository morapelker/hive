import { describe, expect, it } from 'vitest'

import { parseDocumentUpdateFooter } from './document-update'

// The DOCUMENT footer a merged ticket's session ends its document update with.

describe('parseDocumentUpdateFooter', () => {
  it('reads the block the prompt asks for', () => {
    const message = [
      'I struck A2 through and added its notes under the heading.',
      '',
      'DOCUMENT: UPDATED',
      'VERIFIED: tests: 12 passed; playwright: checkout flow',
      'FOLLOW-UPS: Add the empty state; Translate the new labels',
      'NOTES: Marked A2 done and added what was verified, with two screenshots.'
    ].join('\n')
    expect(parseDocumentUpdateFooter(message)).toEqual({
      outcome: 'updated',
      verified: 'tests: 12 passed; playwright: checkout flow',
      followUps: ['Add the empty state', 'Translate the new labels'],
      notes: 'Marked A2 done and added what was verified, with two screenshots.'
    })
  })

  it('reads each outcome, in any case', () => {
    expect(parseDocumentUpdateFooter('DOCUMENT: unchanged')?.outcome).toBe('unchanged')
    expect(parseDocumentUpdateFooter('Document: Failed.')?.outcome).toBe('failed')
    expect(parseDocumentUpdateFooter('document: updated')?.outcome).toBe('updated')
  })

  it('takes "none" for no follow-ups and an empty value for nothing said', () => {
    expect(
      parseDocumentUpdateFooter(
        ['DOCUMENT: UNCHANGED', 'VERIFIED: none', 'FOLLOW-UPS: none', 'NOTES:'].join('\n')
      )
    ).toEqual({ outcome: 'unchanged', verified: null, followUps: [], notes: null })
    // Only the DOCUMENT line: the rest is unknown.
    expect(parseDocumentUpdateFooter('DOCUMENT: FAILED')).toEqual({
      outcome: 'failed',
      verified: null,
      followUps: [],
      notes: null
    })
  })

  it('keeps "not verified" as what the agent said', () => {
    expect(parseDocumentUpdateFooter('DOCUMENT: UPDATED\nVERIFIED: not verified')?.verified).toBe(
      'not verified'
    )
  })

  it('tolerates markdown decoration', () => {
    const message = [
      '## Document: updated',
      '- **Verified:** `pnpm test` passed',
      '**FOLLOW-UPS:** none',
      '> `NOTES: Ticked the checklist of A2.`'
    ].join('\n')
    expect(parseDocumentUpdateFooter(message)).toEqual({
      outcome: 'updated',
      verified: 'pnpm test passed',
      followUps: [],
      notes: 'Ticked the checklist of A2.'
    })
  })

  it('reads a bulleted list of follow-ups under the label', () => {
    const message = [
      'DOCUMENT: UPDATED',
      'VERIFIED: tests: 3 passed',
      'FOLLOW-UPS:',
      '- Add the empty state',
      '* Translate the new labels',
      '',
      'NOTES: Struck A2 through.'
    ].join('\n')
    expect(parseDocumentUpdateFooter(message)).toMatchObject({
      followUps: ['Add the empty state', 'Translate the new labels'],
      notes: 'Struck A2 through.'
    })
  })

  it('lets the last block win, and ignores the quoted template', () => {
    const message = [
      'You asked me to end with:',
      'DOCUMENT: UPDATED | UNCHANGED | FAILED',
      'NOTES: one sentence on what you changed in the document, or why you could not',
      '',
      'First try:',
      'DOCUMENT: FAILED',
      'NOTES: The file was locked.',
      '',
      'Second try:',
      'DOCUMENT: UPDATED',
      'NOTES: Marked A2 done.'
    ].join('\n')
    expect(parseDocumentUpdateFooter(message)).toEqual({
      outcome: 'updated',
      verified: null,
      followUps: [],
      notes: 'Marked A2 done.'
    })
    // The template after the real block does not replace it.
    expect(
      parseDocumentUpdateFooter('DOCUMENT: UPDATED\nNOTES: Done.\nDOCUMENT: UPDATED | UNCHANGED')
    ).toEqual({ outcome: 'updated', verified: null, followUps: [], notes: 'Done.' })
  })

  it('reads lines the agent wrote above the DOCUMENT line', () => {
    expect(
      parseDocumentUpdateFooter(
        ['NOTES: Struck A2 through.', 'FOLLOW-UPS: Add a test', 'DOCUMENT: UPDATED'].join('\n')
      )
    ).toEqual({
      outcome: 'updated',
      verified: null,
      followUps: ['Add a test'],
      notes: 'Struck A2 through.'
    })
  })

  it('is null without a DOCUMENT line that commits to an outcome', () => {
    expect(parseDocumentUpdateFooter('')).toBeNull()
    expect(parseDocumentUpdateFooter('I updated the document.\nNOTES: done')).toBeNull()
    expect(parseDocumentUpdateFooter('DOCUMENT: UPDATED | UNCHANGED | FAILED')).toBeNull()
    expect(parseDocumentUpdateFooter('DOCUMENT: probably updated')).toBeNull()
    expect(parseDocumentUpdateFooter('STATUS: DONE\nSUMMARY: Added the page.')).toBeNull()
  })

  it('handles Windows line endings', () => {
    expect(
      parseDocumentUpdateFooter('DOCUMENT: UPDATED\r\nNOTES: Marked A2 done.\r\n')
    ).toMatchObject({ outcome: 'updated', notes: 'Marked A2 done.' })
  })
})
