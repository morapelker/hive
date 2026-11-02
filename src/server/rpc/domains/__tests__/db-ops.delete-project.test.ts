import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRun } from '../../../../shared/types/document-flow'

const dbMocks = vi.hoisted(() => ({
  project: { id: 'project-1', kind: 'git', path: '/repo' } as {
    id: string
    kind: string
    path: string
  } | null,
  runs: [] as DocumentRun[],
  // Like the real one: newest first, never more than 200 at a time.
  listDocumentRuns: vi.fn((projectId: string, limit = 50) =>
    dbMocks.runs
      .filter((run) => run.project_id === projectId)
      .slice(0, Math.max(1, Math.min(200, limit)))
  ),
  deleteProject: vi.fn(() => true)
}))

const flowMocks = vi.hoisted(() => ({
  calls: [] as string[],
  getDocumentFlowService: vi.fn()
}))

vi.mock('../../../../main/db', () => ({
  getDatabase: () => ({
    getProject: () => dbMocks.project,
    getSessionsByProject: () => [],
    listDocumentRuns: dbMocks.listDocumentRuns,
    deleteProject: dbMocks.deleteProject
  })
}))

vi.mock('../../../../main/services/document-flow/document-flow-service', () => ({
  getDocumentFlowService: flowMocks.getDocumentFlowService
}))

import { makeLiveDbRpcService } from '../db'

const run = (id: string, status: DocumentRun['status']): DocumentRun =>
  ({ id, project_id: 'project-1', status }) as DocumentRun

/** A service whose delete removes the row, as the real one does. */
const liveService = (): {
  cancel: (runId: string) => void
  delete: (runId: string, options?: { removeFiles?: boolean }) => Promise<boolean>
} => ({
  cancel: (runId) => {
    flowMocks.calls.push(`cancel ${runId}`)
  },
  delete: async (runId, options) => {
    flowMocks.calls.push(`delete ${runId}${options?.removeFiles ? ' with files' : ''}`)
    dbMocks.runs = dbMocks.runs.filter((candidate) => candidate.id !== runId)
    return true
  }
})

afterEach(() => {
  vi.clearAllMocks()
  dbMocks.runs = []
  flowMocks.calls = []
})

describe('db.deleteProject', () => {
  it('closes the document runs of the project through their service before the rows cascade', async () => {
    dbMocks.runs = [
      run('run-live', 'running'),
      run('run-paused', 'paused'),
      run('run-done', 'completed')
    ]
    flowMocks.getDocumentFlowService.mockResolvedValue(liveService())

    const deleted = await Effect.runPromise(makeLiveDbRpcService().deleteProject('project-1'))

    expect(deleted).toBe(true)
    // Cancelled first where needed (delete refuses a live run), every run removed, in order,
    // files included: the board tickets that would keep them are going with the project.
    expect(flowMocks.calls).toEqual([
      'cancel run-live',
      'delete run-live with files',
      'cancel run-paused',
      'delete run-paused with files',
      'delete run-done with files'
    ])
    // Reuses the live service and its publisher: the renderer hears each `deleted`.
    expect(flowMocks.getDocumentFlowService).toHaveBeenCalledWith()
    expect(dbMocks.deleteProject).toHaveBeenCalledWith('project-1')
    expect(dbMocks.deleteProject.mock.invocationCallOrder[0]).toBeGreaterThan(
      flowMocks.getDocumentFlowService.mock.invocationCallOrder[0]
    )
  })

  it('removes every run of the project, page by page, past the 200 the list hands out', async () => {
    dbMocks.runs = Array.from({ length: 450 }, (_, index) => run(`run-${index}`, 'completed'))
    flowMocks.getDocumentFlowService.mockResolvedValue(liveService())

    const deleted = await Effect.runPromise(makeLiveDbRpcService().deleteProject('project-1'))

    expect(deleted).toBe(true)
    expect(flowMocks.calls).toHaveLength(450)
    expect(new Set(flowMocks.calls).size).toBe(450)
    // 200, 200, 50, then an empty page.
    expect(dbMocks.listDocumentRuns).toHaveBeenCalledTimes(4)
    expect(dbMocks.runs).toEqual([])
    expect(dbMocks.deleteProject).toHaveBeenCalledWith('project-1')
  })

  it('stops instead of looping when a run is still there after its delete', async () => {
    dbMocks.runs = [run('run-stuck', 'completed')]
    flowMocks.getDocumentFlowService.mockResolvedValue({
      cancel: () => undefined,
      delete: async () => false
    })

    await expect(
      Effect.runPromise(makeLiveDbRpcService().deleteProject('project-1'))
    ).rejects.toThrow('Document run run-stuck could not be removed with the project.')
    expect(dbMocks.listDocumentRuns).toHaveBeenCalledTimes(2)
    expect(dbMocks.deleteProject).not.toHaveBeenCalled()
  })

  it('does not touch the document flow for a project that is already gone', async () => {
    dbMocks.project = null
    dbMocks.deleteProject.mockReturnValueOnce(false)
    try {
      const deleted = await Effect.runPromise(makeLiveDbRpcService().deleteProject('missing'))

      expect(deleted).toBe(false)
      expect(flowMocks.getDocumentFlowService).not.toHaveBeenCalled()
    } finally {
      dbMocks.project = { id: 'project-1', kind: 'git', path: '/repo' }
    }
  })
})
