// What the "New PRD → orchestrator ticket" form says under its fields: the line under "Name"
// for every state of the name and of the directory the session would run in, and the sentence
// for documents that are already on disk under the name.
import { describe, expect, it } from 'vitest'
import type { PrdFlowTargetResult } from '@/lib/prd-flow/target'
import { prdFlowExistingFilesError, prdFlowFilesLine } from './prd-flow-form'

const MAIN: PrdFlowTargetResult = {
  ok: true,
  target: {
    checkout: { kind: 'worktree', worktreeId: 'wt-main' },
    cwd: '/repo/main',
    memberDirs: []
  }
}

const NO_BASE: PrdFlowTargetResult = {
  ok: false,
  error: 'This project has no base instance to run in.'
}

describe('prdFlowFilesLine', () => {
  it('says nothing before a name is typed and the directory is known', () => {
    expect(prdFlowFilesLine({ name: '', prefix: '', target: null })).toBeNull()
    expect(prdFlowFilesLine({ name: '   ', prefix: '', target: null })).toBeNull()
  })

  it('names the directory the session runs in while there is no name yet', () => {
    expect(prdFlowFilesLine({ name: '', prefix: '', target: MAIN })).toEqual({
      text: 'The session runs in /repo/main',
      blocking: false
    })
  })

  it('names the two files as soon as the name gives a prefix', () => {
    expect(prdFlowFilesLine({ name: 'code mode', prefix: 'CODE_MODE', target: null })).toEqual({
      text: 'CODE_MODE_PRD.html, then CODE_MODE_TASKS.html',
      blocking: false
    })
  })

  it('adds the directory once it is known', () => {
    expect(prdFlowFilesLine({ name: 'code mode', prefix: 'CODE_MODE', target: MAIN })).toEqual({
      text: 'CODE_MODE_PRD.html, then CODE_MODE_TASKS.html, in /repo/main',
      blocking: false
    })
  })

  it('says a name without a letter or a digit gives no file name', () => {
    expect(prdFlowFilesLine({ name: ' -> ', prefix: '', target: MAIN })).toEqual({
      text: 'The name needs at least one letter or digit.',
      blocking: true
    })
    expect(prdFlowFilesLine({ name: '---', prefix: '', target: null })).toEqual({
      text: 'The name needs at least one letter or digit.',
      blocking: true
    })
  })

  it('says why the flow cannot run in the project, whatever is typed', () => {
    const refused = { text: 'This project has no base instance to run in.', blocking: true }
    expect(prdFlowFilesLine({ name: '', prefix: '', target: NO_BASE })).toEqual(refused)
    expect(prdFlowFilesLine({ name: '---', prefix: '', target: NO_BASE })).toEqual(refused)
    expect(prdFlowFilesLine({ name: 'code mode', prefix: 'CODE_MODE', target: NO_BASE })).toEqual(
      refused
    )
  })
})

describe('prdFlowExistingFilesError', () => {
  it('is null when neither document is there', () => {
    expect(prdFlowExistingFilesError([])).toBeNull()
  })

  it('names the one document that is there, and the directory it is in', () => {
    expect(prdFlowExistingFilesError(['/repo/main/CODE_MODE_TASKS.html'])).toBe(
      'CODE_MODE_TASKS.html already exists in /repo/main. Pick another name, or remove the file.'
    )
  })

  it('names both when both are there', () => {
    expect(
      prdFlowExistingFilesError([
        '/repo/main/CODE_MODE_PRD.html',
        '/repo/main/CODE_MODE_TASKS.html'
      ])
    ).toBe(
      'CODE_MODE_PRD.html and CODE_MODE_TASKS.html already exist in /repo/main. Pick another name, or remove the files.'
    )
  })

  it('names the member repository a document was found in', () => {
    expect(
      prdFlowExistingFilesError([
        '/conn/base/api/CODE_MODE_PRD.html',
        '/conn/base/web/CODE_MODE_PRD.html'
      ])
    ).toBe(
      'CODE_MODE_PRD.html already exists in /conn/base/api. Pick another name, or remove the file.'
    )
  })

  it('reads the file name and the directory off a Windows path too', () => {
    expect(prdFlowExistingFilesError(['C:\\repo\\CODE_MODE_PRD.html'])).toBe(
      'CODE_MODE_PRD.html already exists in C:\\repo. Pick another name, or remove the file.'
    )
  })
})
