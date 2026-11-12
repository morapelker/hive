import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRunDetail, DocumentRunItem } from '@shared/types/document-flow'
import { documentFlowApi } from '@/api/document-flow-api'
import { makeDetail, makeItem, makeRun } from '@/components/document-flow/test-fixtures'
import { resolvePRContentGeneration } from '@/lib/pr-content-provider'
import {
  clampMaxParallel,
  selectActiveRuns,
  selectRunsForProject,
  useDocumentFlowStore
} from '../useDocumentFlowStore'
import { useSettingsStore } from '../useSettingsStore'

vi.mock('@/api/document-flow-api', () => ({
  documentFlowApi: {
    createRun: vi.fn(),
    retryExtraction: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    updateRun: vi.fn(),
    updateItem: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    finalize: vi.fn(),
    delete: vi.fn(),
    onUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/lib/pr-content-provider', () => ({
  resolvePRContentGeneration: vi.fn(() => ({ provider: 'claude-code', model: 'haiku' }))
}))

// The default launch model, as the quick launch would resolve it; what extraction runs with.
vi.mock('@/lib/launch-model', () => ({
  resolveDefaultLaunchModel: vi.fn(() => ({
    providerID: 'anthropic',
    modelID: 'opus',
    variant: 'high'
  }))
}))

const api = vi.mocked(documentFlowApi)

const initialState = useDocumentFlowStore.getState()
const initialSettingsState = useSettingsStore.getState()

/** A sorted list of the items' statuses, by key. */
const statuses = (detail: DocumentRunDetail | undefined): Record<string, string> =>
  Object.fromEntries((detail?.items ?? []).map((item) => [item.key, item.status]))

describe('useDocumentFlowStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDocumentFlowStore.setState(
      {
        ...initialState,
        runsById: {},
        loadedProjects: {},
        wizard: { open: false, projectId: null, runId: null },
        dashboardRunId: null,
        prefs: { ...initialState.prefs }
      },
      true
    )
    // updateItem applies whatever the server returns: echo the patch over the stored row.
    api.updateItem.mockImplementation(async (runId, itemId, patch) => {
      const current = useDocumentFlowStore
        .getState()
        .runsById[runId]?.items.find((item) => item.id === itemId)
      return { ...(current ?? makeItem()), ...patch } as DocumentRunItem
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    useDocumentFlowStore.setState(initialState, true)
    useSettingsStore.setState(initialSettingsState, true)
  })

  describe('loadRuns', () => {
    it('merges the listed runs in, keeps loaded events, and prunes runs the server dropped', async () => {
      const kept = makeDetail({ id: 'run-kept' })
      const stale = makeDetail({ id: 'run-stale' })
      const other = makeDetail({ id: 'run-other', project_id: 'project-2' })
      useDocumentFlowStore.setState({
        runsById: {
          'run-kept': {
            ...kept,
            events: [
              {
                id: 1,
                run_id: 'run-kept',
                item_id: null,
                at: '',
                type: 'launched',
                message: '',
                data: null
              }
            ]
          },
          'run-stale': stale,
          'run-other': other
        }
      })
      const refreshed = makeDetail({ id: 'run-kept', title: 'Renamed' })
      const added = makeDetail({ id: 'run-new' })
      api.list.mockResolvedValue([refreshed, added])

      await useDocumentFlowStore.getState().loadRuns('project-1')

      const { runsById, loadedProjects } = useDocumentFlowStore.getState()
      expect(api.list).toHaveBeenCalledWith('project-1')
      expect(Object.keys(runsById).sort()).toEqual(['run-kept', 'run-new', 'run-other'])
      expect(runsById['run-kept'].run.title).toBe('Renamed')
      expect(runsById['run-kept'].events).toHaveLength(1)
      expect(loadedProjects).toEqual({ 'project-1': true })
    })

    it('prunes across every project when no project is given', async () => {
      useDocumentFlowStore.setState({
        runsById: {
          'run-a': makeDetail({ id: 'run-a' }),
          'run-b': makeDetail({ id: 'run-b', project_id: 'project-2' })
        },
        loadedProjects: { 'project-1': true }
      })
      api.list.mockResolvedValue([makeDetail({ id: 'run-b', project_id: 'project-2' })])

      await useDocumentFlowStore.getState().loadRuns()

      expect(api.list).toHaveBeenCalledWith(undefined)
      expect(Object.keys(useDocumentFlowStore.getState().runsById)).toEqual(['run-b'])
      expect(useDocumentFlowStore.getState().loadedProjects).toEqual({ 'project-1': true })
    })

    it('never throws when the server fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      useDocumentFlowStore.setState({ runsById: { 'run-a': makeDetail({ id: 'run-a' }) } })
      api.list.mockRejectedValue(new Error('offline'))

      await expect(useDocumentFlowStore.getState().loadRuns('project-1')).resolves.toBeUndefined()

      expect(Object.keys(useDocumentFlowStore.getState().runsById)).toEqual(['run-a'])
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })
  })

  describe('refreshRun', () => {
    it('applies the detail, or forgets a run that is gone', async () => {
      useDocumentFlowStore.setState({
        runsById: { 'run-1': makeDetail() },
        dashboardRunId: 'run-1',
        wizard: { open: true, projectId: 'project-1', runId: 'run-1' }
      })
      api.get.mockResolvedValueOnce(makeDetail({ title: 'Fresh' }))

      const detail = await useDocumentFlowStore.getState().refreshRun('run-1')
      expect(detail?.run.title).toBe('Fresh')
      expect(useDocumentFlowStore.getState().runsById['run-1'].run.title).toBe('Fresh')

      api.get.mockResolvedValueOnce(null)
      expect(await useDocumentFlowStore.getState().refreshRun('run-1')).toBeNull()

      const state = useDocumentFlowStore.getState()
      expect(state.runsById).toEqual({})
      expect(state.dashboardRunId).toBeNull()
      expect(state.wizard).toEqual({ open: true, projectId: 'project-1', runId: null })
    })

    it('returns what it has when the server fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const existing = makeDetail()
      useDocumentFlowStore.setState({ runsById: { 'run-1': existing } })
      api.get.mockRejectedValue(new Error('offline'))

      expect(await useDocumentFlowStore.getState().refreshRun('run-1')).toBe(existing)
      error.mockRestore()
    })
  })

  describe('handleUpdated', () => {
    it('re-reads a run once for a burst of pushes', async () => {
      vi.useFakeTimers()
      api.get.mockResolvedValue(makeDetail({ title: 'Pushed' }))
      const { handleUpdated } = useDocumentFlowStore.getState()

      handleUpdated({ runId: 'run-1', projectId: 'project-1', reason: 'run' })
      handleUpdated({ runId: 'run-1', projectId: 'project-1', reason: 'item', itemId: 'item-A1' })
      handleUpdated({ runId: 'run-1', projectId: 'project-1', reason: 'event' })
      await vi.advanceTimersByTimeAsync(100)
      expect(api.get).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(50)

      expect(api.get).toHaveBeenCalledTimes(1)
      expect(api.get).toHaveBeenCalledWith('run-1')
      expect(useDocumentFlowStore.getState().runsById['run-1'].run.title).toBe('Pushed')
    })

    it('drops a deleted run at once, cancelling a pending re-read', async () => {
      vi.useFakeTimers()
      useDocumentFlowStore.setState({ runsById: { 'run-1': makeDetail() } })
      const { handleUpdated } = useDocumentFlowStore.getState()

      handleUpdated({ runId: 'run-1', projectId: 'project-1', reason: 'item' })
      handleUpdated({ runId: 'run-1', projectId: 'project-1', reason: 'deleted' })

      expect(useDocumentFlowStore.getState().runsById).toEqual({})
      await vi.advanceTimersByTimeAsync(500)
      expect(api.get).not.toHaveBeenCalled()
    })
  })

  describe('applyItem', () => {
    it('replaces a known item and inserts an unknown one in position order', () => {
      useDocumentFlowStore.setState({
        runsById: { 'run-1': makeDetail({}, [{ key: 'A1' }, { key: 'A3', position: 2 }]) }
      })
      const { applyItem } = useDocumentFlowStore.getState()

      applyItem(makeItem({ key: 'A3', position: 2, status: 'merged' }))
      applyItem(makeItem({ key: 'A2', position: 1 }))
      applyItem(makeItem({ key: 'Z', run_id: 'run-unknown' }))

      const items = useDocumentFlowStore.getState().runsById['run-1'].items
      expect(items.map((item) => item.key)).toEqual(['A1', 'A2', 'A3'])
      expect(items[2].status).toBe('merged')
      expect(useDocumentFlowStore.getState().runsById['run-unknown']).toBeUndefined()
    })
  })

  describe('wizard and dashboard', () => {
    it('opens the wizard for a project and closes it without forgetting the run', () => {
      const store = useDocumentFlowStore.getState()
      store.openWizard('project-1', 'run-1')
      expect(useDocumentFlowStore.getState().wizard).toEqual({
        open: true,
        projectId: 'project-1',
        runId: 'run-1'
      })

      store.closeWizard()
      expect(useDocumentFlowStore.getState().wizard).toEqual({
        open: false,
        projectId: 'project-1',
        runId: 'run-1'
      })
    })

    it('opening the dashboard refreshes the run', async () => {
      api.get.mockResolvedValue(makeDetail({ status: 'running' }))

      useDocumentFlowStore.getState().openDashboard('run-1')
      await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('run-1'))

      expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-1')
      useDocumentFlowStore.getState().closeDashboard()
      expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    })
  })

  describe('createRun and retryExtraction', () => {
    it('passes the resolved generation model and points the wizard at the new run', async () => {
      const available = { opencode: false, claude: false, codex: true }
      useSettingsStore.setState({ defaultAgentSdk: 'codex', availableAgentSdks: available })
      const created = makeDetail({ id: 'run-new', status: 'extracting' })
      api.createRun.mockResolvedValue(created)

      const detail = await useDocumentFlowStore.getState().createRun('project-1', '/docs/spec.html')

      expect(detail).toBe(created)
      // The default launch model of the default SDK, not the PR content model.
      expect(resolvePRContentGeneration).toHaveBeenCalledWith(
        { agentSdk: 'codex', providerID: 'anthropic', modelID: 'opus', variant: 'high' },
        'codex',
        available
      )
      expect(api.createRun).toHaveBeenCalledWith({
        projectId: 'project-1',
        documentPath: '/docs/spec.html',
        generation: { provider: 'claude-code', model: 'haiku' }
      })
      const state = useDocumentFlowStore.getState()
      expect(state.runsById['run-new']).toBe(created)
      expect(state.wizard).toEqual({ open: false, projectId: 'project-1', runId: 'run-new' })
    })

    it('resolves the generation with claude-code when no default SDK is set', async () => {
      // The persisted setting can be missing on an old install; the store type says otherwise.
      useSettingsStore.setState({
        defaultAgentSdk: null as unknown as 'opencode',
        availableAgentSdks: null
      })
      api.retryExtraction.mockResolvedValue(makeDetail({ status: 'extracting' }))

      await useDocumentFlowStore.getState().retryExtraction('run-1')

      // No default SDK degrades to opencode for the model, as every picker does.
      expect(resolvePRContentGeneration).toHaveBeenCalledWith(
        { agentSdk: 'opencode', providerID: 'anthropic', modelID: 'opus', variant: 'high' },
        'claude-code',
        null
      )
      expect(api.retryExtraction).toHaveBeenCalledWith({
        runId: 'run-1',
        generation: { provider: 'claude-code', model: 'haiku' }
      })
      expect(useDocumentFlowStore.getState().runsById['run-1'].run.status).toBe('extracting')
    })

    it('rejects when the server fails', async () => {
      api.createRun.mockRejectedValue(new Error('unsupported document'))

      await expect(
        useDocumentFlowStore.getState().createRun('project-1', '/docs/spec.pdf')
      ).rejects.toThrow('unsupported document')
      expect(useDocumentFlowStore.getState().runsById).toEqual({})
    })
  })

  describe('updateRun / updateItem', () => {
    it('applies the returned run over the existing items', async () => {
      useDocumentFlowStore.setState({ runsById: { 'run-1': makeDetail() } })
      api.updateRun.mockResolvedValue(makeRun({ title: 'Renamed' }))

      await useDocumentFlowStore.getState().updateRun('run-1', { title: 'Renamed' })

      const detail = useDocumentFlowStore.getState().runsById['run-1']
      expect(detail.run.title).toBe('Renamed')
      expect(detail.items).toHaveLength(3)
    })

    it('applies the returned item', async () => {
      useDocumentFlowStore.setState({ runsById: { 'run-1': makeDetail() } })

      const item = await useDocumentFlowStore
        .getState()
        .updateItem('run-1', 'item-A2', { selected: false })

      expect(item.selected).toBe(false)
      expect(statuses(useDocumentFlowStore.getState().runsById['run-1'])).toEqual({
        A1: 'pending',
        A2: 'pending',
        A3: 'pending'
      })
      expect(
        useDocumentFlowStore.getState().runsById['run-1'].items.find((i) => i.key === 'A2')
          ?.selected
      ).toBe(false)
    })

    it('pause and resume only toggle the status', async () => {
      api.updateRun.mockResolvedValue(makeRun({ status: 'paused' }))
      await useDocumentFlowStore.getState().pauseRun('run-1')
      expect(api.updateRun).toHaveBeenCalledWith('run-1', { status: 'paused' })

      api.updateRun.mockResolvedValue(makeRun({ status: 'running' }))
      await useDocumentFlowStore.getState().resumeRun('run-1')
      expect(api.updateRun).toHaveBeenLastCalledWith('run-1', { status: 'running' })
      expect(useDocumentFlowStore.getState().runsById['run-1'].run.status).toBe('running')
    })

    it('setRunMaxParallel sends only the clamped limit and leaves the next-run default alone', async () => {
      useDocumentFlowStore.setState({ runsById: { 'run-1': makeDetail({ status: 'running' }) } })
      const stored = makeDetail().run.config
      const prefs = useDocumentFlowStore.getState().prefs
      api.updateRun.mockResolvedValue(
        makeRun({ status: 'running', config: { ...stored, maxParallel: 6 } })
      )

      await useDocumentFlowStore.getState().setRunMaxParallel('run-1', 6)

      expect(api.updateRun).toHaveBeenCalledWith('run-1', { config: { maxParallel: 6 } })
      const detail = useDocumentFlowStore.getState().runsById['run-1']
      expect(detail.run.config).toEqual({ ...stored, maxParallel: 6 })
      expect(detail.items).toHaveLength(3)
      expect(useDocumentFlowStore.getState().prefs).toEqual(prefs)

      await useDocumentFlowStore.getState().setRunMaxParallel('run-1', 99)
      expect(api.updateRun).toHaveBeenLastCalledWith('run-1', { config: { maxParallel: 50 } })
      await useDocumentFlowStore.getState().setRunMaxParallel('run-1', 0)
      expect(api.updateRun).toHaveBeenLastCalledWith('run-1', { config: { maxParallel: 1 } })
    })

    it('setRunMaxParallel rejects when the server does, leaving the run as it was', async () => {
      useDocumentFlowStore.setState({ runsById: { 'run-1': makeDetail({ status: 'running' }) } })
      const before = useDocumentFlowStore.getState().runsById['run-1']
      api.updateRun.mockRejectedValue(new Error('offline'))

      await expect(useDocumentFlowStore.getState().setRunMaxParallel('run-1', 2)).rejects.toThrow(
        'offline'
      )
      expect(useDocumentFlowStore.getState().runsById['run-1']).toBe(before)
    })
  })

  describe('startRun', () => {
    it('applies the started run and remembers its settings as the next defaults', async () => {
      useDocumentFlowStore.setState({
        prefs: {
          ...initialState.prefs,
          verifyCommandByProject: { 'project-2': 'make check' }
        }
      })
      const started = makeDetail({
        status: 'running',
        config: {
          maxParallel: 99,
          verifyCommand: 'pnpm check',
          interactive: false,
          promptStyle: 'small',
          defaultLaunch: { sdk: 'codex', model: null, codexFastMode: true },
          generation: null,
          baseBranch: null,
          notes: null,
          verificationDisabled: false,
          memberBaseBranches: {},
          memberVerifyCommands: {}
        }
      })
      api.start.mockResolvedValue(started)

      useSettingsStore.setState({ defaultAgentSdk: 'codex' })
      await useDocumentFlowStore.getState().startRun('run-1')

      // The app's default agent words the brief of tickets without a launch config.
      expect(api.start).toHaveBeenCalledWith('run-1', 'codex')
      expect(useDocumentFlowStore.getState().runsById['run-1']).toBe(started)
      expect(useDocumentFlowStore.getState().prefs).toEqual({
        maxParallel: 50,
        interactive: false,
        promptStyle: 'small',
        defaultLaunch: { sdk: 'codex', model: null, codexFastMode: true },
        verifyCommandByProject: { 'project-2': 'make check', 'project-1': 'pnpm check' }
      })
    })

    it('remembers "no verify command" as an empty string', async () => {
      api.start.mockResolvedValue(
        makeDetail({ status: 'running', config: { ...makeRun().config, verifyCommand: null } })
      )

      await useDocumentFlowStore.getState().startRun('run-1')

      expect(useDocumentFlowStore.getState().prefs.verifyCommandByProject).toEqual({
        'project-1': ''
      })
    })
  })

  describe('cancelRun and deleteRun', () => {
    it('applies the cancelled run', async () => {
      api.cancel.mockResolvedValue(makeDetail({ status: 'cancelled' }))

      await useDocumentFlowStore.getState().cancelRun('run-1')

      expect(useDocumentFlowStore.getState().runsById['run-1'].run.status).toBe('cancelled')
    })

    it('forgets a deleted run', async () => {
      useDocumentFlowStore.setState({
        runsById: { 'run-1': makeDetail() },
        dashboardRunId: 'run-1'
      })
      api.delete.mockResolvedValue(true)

      await useDocumentFlowStore.getState().deleteRun('run-1')

      expect(useDocumentFlowStore.getState().runsById).toEqual({})
      expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    })
  })

  describe('item actions', () => {
    const flagged = (overrides: Partial<DocumentRunItem> = {}): Partial<DocumentRunItem> => ({
      key: 'A1',
      status: 'needs_attention',
      status_detail: 'Checks failed.',
      nudge_count: 2,
      conflict_attempts: 1,
      fix_attempts: 2,
      continue_attempts: 3,
      last_checked_at: '2026-05-04T10:00:00.000Z',
      retry_at: '2026-05-04T10:30:00.000Z',
      finished_at: '2026-05-04T10:31:00.000Z',
      ...overrides
    })

    it('retryItem re-judges an item that has a session, with fresh attempt counters', async () => {
      useDocumentFlowStore.setState({
        runsById: { 'run-1': makeDetail({}, [flagged({ session_id: 'session-1' })]) }
      })

      await useDocumentFlowStore.getState().retryItem('run-1', 'item-A1')

      expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', {
        status: 'checking',
        status_detail: null,
        nudge_count: 0,
        conflict_attempts: 0,
        conflict_head: null,
        fix_attempts: 0,
        continue_attempts: 0,
        last_checked_at: null,
        retry_at: null,
        wait_until: null,
        wait_timeouts: 0,
        finished_at: null
      })
      expect(statuses(useDocumentFlowStore.getState().runsById['run-1'])).toEqual({
        A1: 'checking'
      })
    })

    it('retryItem relaunches an item whose launch never produced a session', async () => {
      useDocumentFlowStore.setState({
        runsById: { 'run-1': makeDetail({}, [flagged({ session_id: null })]) }
      })

      await useDocumentFlowStore.getState().retryItem('run-1', 'item-A1')

      expect(api.updateItem).toHaveBeenCalledWith(
        'run-1',
        'item-A1',
        expect.objectContaining({ status: 'pending', continue_attempts: 0 })
      )
    })

    it('retryItem does nothing for an unknown item', async () => {
      useDocumentFlowStore.setState({ runsById: { 'run-1': makeDetail() } })

      await useDocumentFlowStore.getState().retryItem('run-1', 'item-nope')

      expect(api.updateItem).not.toHaveBeenCalled()
    })

    it('markItemDone queues the item for merging and says who decided', async () => {
      useDocumentFlowStore.setState({ runsById: { 'run-1': makeDetail({}, [flagged()]) } })

      await useDocumentFlowStore.getState().markItemDone('run-1', 'item-A1')

      expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', {
        status: 'ready',
        status_detail: 'Marked done by you.',
        nudge_count: 0,
        conflict_attempts: 0,
        conflict_head: null,
        fix_attempts: 0,
        continue_attempts: 0,
        last_checked_at: null,
        retry_at: null,
        wait_until: null,
        wait_timeouts: 0,
        finished_at: null
      })
    })

    it('skipItem closes the item', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-04T12:00:00.000Z'))
      useDocumentFlowStore.setState({ runsById: { 'run-1': makeDetail() } })

      await useDocumentFlowStore.getState().skipItem('run-1', 'item-A2')

      expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A2', {
        status: 'skipped',
        status_detail: 'Skipped by you.',
        finished_at: '2026-05-04T12:00:00.000Z'
      })
    })

    it('retryDocumentUpdate puts a merged item back at the end of the document edit lane', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-04T12:00:00.000Z'))
      useDocumentFlowStore.setState({
        runsById: {
          'run-1': makeDetail({}, [
            {
              key: 'A1',
              status: 'merged',
              status_detail: 'Merged as it stood: checks were not run.',
              document_update_status: 'failed',
              document_update_detail: 'The document was not changed.',
              document_update_attempts: 1
            }
          ])
        }
      })

      await useDocumentFlowStore.getState().retryDocumentUpdate('run-1', 'item-A1')

      // Nothing of the item's own step: its status, detail and attempt counters stay
      expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', {
        document_update_status: 'queued',
        document_update_queued_at: '2026-05-04T12:00:00.000Z',
        document_update_attempts: 0,
        document_update_detail: null,
        document_update_report: null,
        document_update_finished_at: null
      })
    })

    it('skipDocumentUpdate takes the item out of the document edit lane, still merged', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-04T12:00:00.000Z'))
      useDocumentFlowStore.setState({
        runsById: {
          'run-1': makeDetail({}, [
            { key: 'A1', status: 'merged', document_update_status: 'updating' }
          ])
        }
      })

      await useDocumentFlowStore.getState().skipDocumentUpdate('run-1', 'item-A1')

      expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', {
        document_update_status: 'skipped',
        document_update_detail: 'Skipped by you.',
        document_update_finished_at: '2026-05-04T12:00:00.000Z'
      })
    })

    it('rejects when the server refuses the patch', async () => {
      useDocumentFlowStore.setState({ runsById: { 'run-1': makeDetail() } })
      api.updateItem.mockRejectedValue(new Error('run is finished'))

      await expect(useDocumentFlowStore.getState().skipItem('run-1', 'item-A2')).rejects.toThrow(
        'run is finished'
      )
      expect(statuses(useDocumentFlowStore.getState().runsById['run-1']).A2).toBe('pending')
    })
  })

  describe('finishRunNow', () => {
    it('skips every open selected item, then finalizes', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-04T12:00:00.000Z'))
      const detail = makeDetail({ status: 'running' }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'running' },
        { key: 'A3', status: 'needs_input', selected: false },
        { key: 'A4', status: 'skipped' },
        { key: 'A5', status: 'pending' }
      ])
      api.get.mockResolvedValue(detail)
      api.finalize.mockResolvedValue({
        ...detail,
        run: { ...detail.run, status: 'completed_with_issues' }
      })

      await useDocumentFlowStore.getState().finishRunNow('run-1')

      expect(api.updateItem.mock.calls.map(([, itemId]) => itemId)).toEqual(['item-A2', 'item-A5'])
      expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A2', {
        status: 'skipped',
        status_detail: 'Skipped when the run was finished early.',
        finished_at: '2026-05-04T12:00:00.000Z'
      })
      expect(api.finalize).toHaveBeenCalledWith('run-1')
      expect(useDocumentFlowStore.getState().runsById['run-1'].run.status).toBe(
        'completed_with_issues'
      )
    })

    it('pauses a running run first, and leaves a ticket whose merge already landed alone', async () => {
      const detail = makeDetail({ status: 'running' }, [
        { key: 'A1', status: 'verifying', merge_sha: 'abc123' },
        { key: 'A2', status: 'merging' },
        { key: 'A3', status: 'fixing', merge_sha: 'def456' }
      ])
      useDocumentFlowStore.setState({ runsById: { 'run-1': detail } })
      const calls: string[] = []
      api.updateRun.mockImplementation(async () => {
        calls.push('pause')
        return { ...detail.run, status: 'paused' }
      })
      api.get.mockResolvedValue({ ...detail, run: { ...detail.run, status: 'paused' } })
      api.updateItem.mockImplementation(async (_runId: string, itemId: string) => {
        calls.push(`skip ${itemId}`)
        return { ...detail.items[1], status: 'skipped' }
      })
      api.finalize.mockImplementation(async () => {
        calls.push('finalize')
        return { ...detail, run: { ...detail.run, status: 'completed_with_issues' } }
      })

      await useDocumentFlowStore.getState().finishRunNow('run-1')

      expect(api.updateRun).toHaveBeenCalledWith('run-1', { status: 'paused' })
      expect(calls).toEqual(['pause', 'skip item-A2', 'finalize'])
    })

    it('works from the loaded run when the re-read fails, and gives up when it has none', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      api.get.mockRejectedValue(new Error('offline'))
      api.finalize.mockResolvedValue(makeDetail({ status: 'completed' }))

      await useDocumentFlowStore.getState().finishRunNow('run-1')
      expect(api.finalize).not.toHaveBeenCalled()

      useDocumentFlowStore.setState({
        runsById: { 'run-1': makeDetail({ status: 'running' }, [{ key: 'A1', status: 'merged' }]) }
      })
      await useDocumentFlowStore.getState().finishRunNow('run-1')

      expect(api.updateItem).not.toHaveBeenCalled()
      expect(api.finalize).toHaveBeenCalledTimes(1)
      error.mockRestore()
    })
  })

  describe('prefs and persistence', () => {
    it('setPrefs merges, and only prefs and the unfolded run cards are persisted', () => {
      useDocumentFlowStore.setState({ runsById: { 'run-1': makeDetail() } })
      useDocumentFlowStore.getState().setPrefs({ interactive: false })

      expect(useDocumentFlowStore.getState().prefs).toEqual({
        ...initialState.prefs,
        interactive: false
      })
      const persisted = JSON.parse(localStorage.getItem('hive-document-flow') ?? '{}') as {
        state?: Record<string, unknown>
      }
      // The prefs, and which run cards are unfolded on the board
      expect(Object.keys(persisted.state ?? {})).toEqual(['prefs', 'expandedRunTickets'])
      expect(persisted.state?.prefs).toEqual(useDocumentFlowStore.getState().prefs)
    })

    it('clampMaxParallel keeps the value in range', () => {
      expect(clampMaxParallel(0)).toBe(1)
      expect(clampMaxParallel(3.6)).toBe(4)
      expect(clampMaxParallel(99)).toBe(50)
      expect(clampMaxParallel(Number.NaN)).toBe(4)
    })
  })

  describe('selectors', () => {
    it('lists a project’s runs newest first and the runs being driven oldest first', () => {
      const runsById = {
        old: makeDetail({ id: 'old', status: 'running', created_at: '2026-01-01T00:00:00.000Z' }),
        mid: makeDetail({ id: 'mid', status: 'paused', created_at: '2026-02-01T00:00:00.000Z' }),
        done: makeDetail({
          id: 'done',
          status: 'completed',
          created_at: '2026-03-01T00:00:00.000Z'
        }),
        other: makeDetail({
          id: 'other',
          project_id: 'project-2',
          status: 'running',
          created_at: '2026-04-01T00:00:00.000Z'
        })
      }

      expect(selectRunsForProject(runsById, 'project-1').map((d) => d.run.id)).toEqual([
        'done',
        'mid',
        'old'
      ])
      expect(selectActiveRuns(runsById).map((d) => d.run.id)).toEqual(['old', 'mid', 'other'])
    })
  })
})
