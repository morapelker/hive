import { describe, expect, it } from 'vitest'

import { joinPath, prdFlowDocumentCandidates, prdFlowDocumentPath, prdFlowFileName } from './paths'

// Where a PRD flow expects its two documents and where else it looks: at the top of the
// directory its session runs in, then, in a connection directory, inside each member
// repository in member order. The flow advances on the first of these paths that exists, and
// names the first one in its prompts.

const GIT_FLOW = { cwd: '/Users/mor/code/shop', prefix: 'CODE_MODE', memberDirs: [] }
const CONNECTION_FLOW = {
  cwd: '/Users/mor/.hive/connections/shop',
  prefix: 'CODE_MODE',
  memberDirs: ['web', 'api']
}

describe('joinPath', () => {
  it('joins a directory and a name with a slash', () => {
    expect(joinPath('/Users/mor/code/shop', 'CODE_MODE_PRD.html')).toBe(
      '/Users/mor/code/shop/CODE_MODE_PRD.html'
    )
  })

  it('does not double the separator a directory already ends with', () => {
    expect(joinPath('/Users/mor/code/shop/', 'a.html')).toBe('/Users/mor/code/shop/a.html')
    expect(joinPath('/Users/mor/code/shop//', 'a.html')).toBe('/Users/mor/code/shop/a.html')
    expect(joinPath('/', 'a.html')).toBe('/a.html')
  })

  it('joins with a backslash where the directory itself is written with them', () => {
    expect(joinPath('C:\\Users\\mor\\shop', 'a.html')).toBe('C:\\Users\\mor\\shop\\a.html')
    expect(joinPath('C:\\Users\\mor\\shop\\', 'a.html')).toBe('C:\\Users\\mor\\shop\\a.html')
    expect(joinPath('C:\\', 'a.html')).toBe('C:\\a.html')
  })

  it('keeps the slash for a directory written with both, and for one with no separator', () => {
    expect(joinPath('C:/Users/mor\\shop', 'a.html')).toBe('C:/Users/mor\\shop/a.html')
    expect(joinPath('shop', 'a.html')).toBe('shop/a.html')
  })

  it('leaves spaces and letters of other scripts in the directory as they are', () => {
    expect(joinPath('/Users/mor/My Projects/חנות', 'מצב_קוד_PRD.html')).toBe(
      '/Users/mor/My Projects/חנות/מצב_קוד_PRD.html'
    )
  })
})

describe('prdFlowFileName', () => {
  it('names the PRD and the tasks document of a prefix', () => {
    expect(prdFlowFileName('prd', 'CODE_MODE')).toBe('CODE_MODE_PRD.html')
    expect(prdFlowFileName('tasks', 'CODE_MODE')).toBe('CODE_MODE_TASKS.html')
  })
})

describe('prdFlowDocumentPath', () => {
  it("is the file at the top of the session's directory", () => {
    expect(prdFlowDocumentPath(GIT_FLOW, 'prd')).toBe('/Users/mor/code/shop/CODE_MODE_PRD.html')
    expect(prdFlowDocumentPath(GIT_FLOW, 'tasks')).toBe('/Users/mor/code/shop/CODE_MODE_TASKS.html')
  })

  it('is at the top of a connection directory too, not inside a member', () => {
    expect(prdFlowDocumentPath(CONNECTION_FLOW, 'tasks')).toBe(
      '/Users/mor/.hive/connections/shop/CODE_MODE_TASKS.html'
    )
  })
})

describe('prdFlowDocumentCandidates', () => {
  it('is the one expected path for a git project', () => {
    expect(prdFlowDocumentCandidates(GIT_FLOW, 'prd')).toEqual([
      '/Users/mor/code/shop/CODE_MODE_PRD.html'
    ])
    expect(prdFlowDocumentCandidates(GIT_FLOW, 'tasks')).toEqual([
      '/Users/mor/code/shop/CODE_MODE_TASKS.html'
    ])
  })

  it('looks at the top of a connection directory first, then in each member, in member order', () => {
    expect(prdFlowDocumentCandidates(CONNECTION_FLOW, 'prd')).toEqual([
      '/Users/mor/.hive/connections/shop/CODE_MODE_PRD.html',
      '/Users/mor/.hive/connections/shop/web/CODE_MODE_PRD.html',
      '/Users/mor/.hive/connections/shop/api/CODE_MODE_PRD.html'
    ])
    expect(
      prdFlowDocumentCandidates({ ...CONNECTION_FLOW, memberDirs: ['api', 'web'] }, 'tasks')
    ).toEqual([
      '/Users/mor/.hive/connections/shop/CODE_MODE_TASKS.html',
      '/Users/mor/.hive/connections/shop/api/CODE_MODE_TASKS.html',
      '/Users/mor/.hive/connections/shop/web/CODE_MODE_TASKS.html'
    ])
  })

  it('always starts with the path the prompts name', () => {
    for (const flow of [GIT_FLOW, CONNECTION_FLOW]) {
      for (const document of ['prd', 'tasks'] as const) {
        expect(prdFlowDocumentCandidates(flow, document)[0]).toBe(
          prdFlowDocumentPath(flow, document)
        )
      }
    }
  })

  it('never looks for one document under the name of the other', () => {
    const prd = prdFlowDocumentCandidates(CONNECTION_FLOW, 'prd')
    const tasks = prdFlowDocumentCandidates(CONNECTION_FLOW, 'tasks')

    expect(prd.every((path) => path.endsWith('/CODE_MODE_PRD.html'))).toBe(true)
    expect(tasks.every((path) => path.endsWith('/CODE_MODE_TASKS.html'))).toBe(true)
  })

  it('joins the members of a directory written with backslashes the same way', () => {
    expect(
      prdFlowDocumentCandidates(
        { cwd: 'C:\\connections\\shop', prefix: 'CODE_MODE', memberDirs: ['web'] },
        'prd'
      )
    ).toEqual([
      'C:\\connections\\shop\\CODE_MODE_PRD.html',
      'C:\\connections\\shop\\web\\CODE_MODE_PRD.html'
    ])
  })
})
