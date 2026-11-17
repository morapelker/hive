import { beforeEach, describe, expect, test, vi } from 'vitest'

const scriptApiMock = vi.hoisted(() => ({
  runSetup: vi.fn(),
  onOutput: vi.fn()
}))

vi.mock('@/api/script-api', () => ({ scriptApi: scriptApiMock }))

import { fireSetupScript } from './useWorktreeStore'
import { useProjectStore } from './useProjectStore'
import { useSettingsStore } from './useSettingsStore'

type StoreProject = ReturnType<typeof useProjectStore.getState>['projects'][number]

function seedProject(setupScript: string | null): void {
  useProjectStore.setState({
    projects: [{ id: 'p1', name: 'P1', path: '/p1', setup_script: setupScript } as StoreProject]
  })
}

describe('fireSetupScript — default setup script', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scriptApiMock.runSetup.mockResolvedValue({ success: true })
    scriptApiMock.onOutput.mockReturnValue(() => {})
    useSettingsStore.setState({ defaultSetupScript: '# deps\npnpm install\n\npnpm run build' })
  })

  test('runs the default for a project that never had a setup script', () => {
    seedProject(null)
    fireSetupScript('p1', 'wt1', '/p1/wt1')
    expect(scriptApiMock.runSetup).toHaveBeenCalledWith(
      ['pnpm install', 'pnpm run build'],
      '/p1/wt1',
      'wt1'
    )
  })

  test("runs the project's own script instead of the default", () => {
    seedProject('bun install')
    fireSetupScript('p1', 'wt1', '/p1/wt1')
    expect(scriptApiMock.runSetup).toHaveBeenCalledWith(['bun install'], '/p1/wt1', 'wt1')
  })

  test('runs nothing for a project whose setup script was cleared', () => {
    seedProject('')
    fireSetupScript('p1', 'wt1', '/p1/wt1')
    expect(scriptApiMock.runSetup).not.toHaveBeenCalled()
  })

  test('runs nothing when there is no default and no project script', () => {
    useSettingsStore.setState({ defaultSetupScript: '' })
    seedProject(null)
    fireSetupScript('p1', 'wt1', '/p1/wt1')
    expect(scriptApiMock.runSetup).not.toHaveBeenCalled()
  })
})
