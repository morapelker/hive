// The add/edit database connection wizard: a pasted URL detects the engine and fills the
// fields; per-field validation with aria-invalid blocks the step (Enter included); the test step
// shows the server version; saving creates the project and opens it. Edit mode never sees a
// stored secret: "•••• saved" → Replace sends the new value, Clear sends null, untouched sends
// nothing. SQLite "New file…" makes the test (or an untested save) create the file, while the
// saved connection never carries the create switch; the test step shows the server's notice
// (SSH host key accepted on first use).

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sampleDataProject } from '../data-project.sample'

const api = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  testConnection: vi.fn(),
  pickFile: vi.fn(),
  touch: vi.fn(),
  connect: vi.fn(),
  status: vi.fn(),
  onStatus: vi.fn(() => () => {}),
  list: vi.fn()
}))
vi.mock('@/api/data-projects-api', () => ({ dataProjectsApi: api }))

const projectApiMock = vi.hoisted(() => ({
  pickProjectIcon: vi.fn(),
  removeProjectIcon: vi.fn(),
  getProjectIconPath: vi.fn()
}))
vi.mock('@/api/project-api', () => ({ projectApi: projectApiMock }))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const { AddDataProjectWizard } = await import('./AddDataProjectWizard')
const { useDataProjectStore } = await import('@/stores/useDataProjectStore')

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  useDataProjectStore.getState().reset()
  useDataProjectStore.setState({ defaultsLoaded: true })
  api.touch.mockResolvedValue(undefined)
  api.connect.mockResolvedValue({ dataProjectId: 'x', state: 'connected' })
  api.testConnection.mockResolvedValue({
    ok: true,
    serverVersion: 'PostgreSQL 17.2',
    latencyMs: 12.4
  })
  projectApiMock.removeProjectIcon.mockResolvedValue({ success: true })
  projectApiMock.getProjectIconPath.mockResolvedValue(null)
})

afterEach(() => {
  cleanup()
})

const renderWizard = (): void => {
  render(<AddDataProjectWizard />)
}

describe('create', () => {
  it('detects the engine from a pasted URL and fills the fields', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'create' })
    renderWizard()

    await userEvent.type(
      screen.getByTestId('data-project-wizard-paste-url'),
      'postgres://app:secret@db.example.com:5433/shop?sslmode=require'
    )
    await userEvent.click(screen.getByTestId('data-project-wizard-paste-url-import'))

    expect(await screen.findByTestId('data-project-wizard-connection-step')).toBeInTheDocument()
    expect(screen.getByTestId('data-project-wizard')).toHaveAttribute('data-step', 'connection')
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument()
    expect(screen.getByTestId('data-project-wizard-host')).toHaveValue('db.example.com')
    expect(screen.getByTestId('data-project-wizard-port')).toHaveValue('5433')
    expect(screen.getByTestId('data-project-wizard-user')).toHaveValue('app')
    expect(screen.getByTestId('data-project-wizard-database')).toHaveValue('shop')
    expect(screen.getByTestId('data-project-wizard-password')).toHaveValue('secret')
  })

  it('rejects an unrecognisable URL with an inline error', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'create' })
    renderWizard()
    const input = screen.getByTestId('data-project-wizard-paste-url')
    await userEvent.type(input, 'not a url{Enter}')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('data-project-wizard')).toHaveAttribute('data-step', 'engine')
  })

  it('validates fields with aria-invalid and keeps the step on Enter', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'create' })
    renderWizard()
    await userEvent.click(screen.getByTestId('data-project-wizard-engine-mysql'))

    const host = screen.getByTestId('data-project-wizard-host')
    await userEvent.clear(host)
    fireEvent.keyDown(host, { key: 'Enter' })

    await waitFor(() => expect(host).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByText('Host is required')).toBeInTheDocument()
    expect(screen.getByTestId('data-project-wizard')).toHaveAttribute('data-step', 'connection')

    await userEvent.type(host, 'db.internal')
    fireEvent.keyDown(host, { key: 'Enter' })
    expect(await screen.findByTestId('data-project-wizard-test-step')).toBeInTheDocument()
  })

  it('tests the connection, then creates and opens the project', async () => {
    api.create.mockImplementation(async (input) =>
      sampleDataProject({ id: 'created', name: input.name, engine: input.engine })
    )
    useDataProjectStore.getState().openWizard({ mode: 'create', engine: 'postgres' })
    renderWizard()

    await userEvent.clear(screen.getByTestId('data-project-wizard-host'))
    await userEvent.type(screen.getByTestId('data-project-wizard-host'), 'db.example.com')
    await userEvent.type(screen.getByTestId('data-project-wizard-password'), 'pw')
    await userEvent.click(screen.getByTestId('data-project-wizard-next'))

    expect(await screen.findByTestId('data-project-wizard-test-success')).toBeInTheDocument()
    expect(screen.getByTestId('data-project-wizard-test-version')).toHaveTextContent(
      'PostgreSQL 17.2'
    )
    expect(api.testConnection).toHaveBeenCalledWith({
      engine: 'postgres',
      config: expect.objectContaining({ host: 'db.example.com', port: 5432 }),
      secrets: { password: 'pw' }
    })

    await userEvent.click(screen.getByTestId('data-project-wizard-next'))
    expect(await screen.findByTestId('data-project-wizard-details-step')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('data-project-wizard-environment-production'))
    expect(screen.getByTestId('data-project-wizard-safe-mode-half-safe')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await userEvent.click(screen.getByTestId('data-project-wizard-pinned'))
    await userEvent.click(screen.getByTestId('data-project-wizard-save'))

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.create.mock.calls[0][0]).toMatchObject({
      name: 'postgres @ db.example.com',
      engine: 'postgres',
      secrets: { password: 'pw' },
      environment: 'production',
      safeMode: 'half-safe',
      pinned: true,
      allowAiDataAccess: false
    })
    await waitFor(() => expect(useDataProjectStore.getState().wizard).toBeNull())
    expect(useDataProjectStore.getState().selectedDataProjectId).toBe('created')
  })

  it('shows the server error with a hint when the test fails, and can still continue', async () => {
    api.testConnection.mockResolvedValue({
      ok: false,
      error: 'connect ECONNREFUSED 127.0.0.1:3306'
    })
    useDataProjectStore.getState().openWizard({ mode: 'create', engine: 'mysql' })
    renderWizard()
    await userEvent.click(screen.getByTestId('data-project-wizard-next'))

    expect(await screen.findByTestId('data-project-wizard-test-error')).toBeInTheDocument()
    expect(screen.getByTestId('data-project-wizard-test-hint')).toHaveTextContent(
      /Nothing is listening/
    )
    await userEvent.click(screen.getByTestId('data-project-wizard-next'))
    expect(await screen.findByTestId('data-project-wizard-details-step')).toBeInTheDocument()
  })

  it('cleans up an uploaded icon that was never saved', async () => {
    projectApiMock.pickProjectIcon.mockImplementation(async (key: string) => ({
      success: true,
      filename: `${key}.png`
    }))
    useDataProjectStore.getState().openWizard({ mode: 'create', engine: 'sqlite' })
    renderWizard()
    await userEvent.type(screen.getByTestId('data-project-wizard-file-path'), '/tmp/a.sqlite')
    await userEvent.click(screen.getByTestId('data-project-wizard-next'))
    await userEvent.click(await screen.findByTestId('data-project-wizard-next'))
    await userEvent.click(await screen.findByTestId('data-project-icon-tab-upload'))
    await userEvent.click(screen.getByTestId('data-project-icon-upload'))
    await waitFor(() => expect(projectApiMock.pickProjectIcon).toHaveBeenCalled())
    const key = projectApiMock.pickProjectIcon.mock.calls[0][0] as string
    expect(key).toMatch(/^dp-/)

    await userEvent.click(screen.getByTestId('data-project-wizard-cancel'))
    await waitFor(() => expect(projectApiMock.removeProjectIcon).toHaveBeenCalledWith(key))
  })
})

describe('SQLite "New file…"', () => {
  const NEW_FILE = '/Users/me/data/new.sqlite'

  beforeEach(() => {
    api.testConnection.mockResolvedValue({ ok: true, serverVersion: 'SQLite 3.46.0' })
    api.create.mockImplementation(async (input) =>
      sampleDataProject({ id: 'created', name: input.name, engine: input.engine })
    )
  })

  const pickNewFile = async (): Promise<void> => {
    api.pickFile.mockResolvedValueOnce({ filePath: NEW_FILE })
    await userEvent.click(screen.getByTestId('data-project-wizard-file-path-create'))
    await waitFor(() =>
      expect(screen.getByTestId('data-project-wizard-file-path')).toHaveValue(NEW_FILE)
    )
    expect(api.pickFile).toHaveBeenLastCalledWith('sqlite', true)
  }

  it('lets the connection test create the file, and saves the connection without the switch', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'create', engine: 'sqlite' })
    renderWizard()
    await pickNewFile()
    await userEvent.click(screen.getByTestId('data-project-wizard-next'))

    expect(await screen.findByTestId('data-project-wizard-test-success')).toBeInTheDocument()
    expect(api.testConnection).toHaveBeenCalledTimes(1)
    expect(api.testConnection).toHaveBeenCalledWith({
      engine: 'sqlite',
      config: { filePath: NEW_FILE, database: 'main', options: { create: 'true' } },
      secrets: {}
    })

    await userEvent.click(screen.getByTestId('data-project-wizard-next'))
    await userEvent.click(await screen.findByTestId('data-project-wizard-save'))
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.create.mock.calls[0][0].config).toEqual({ filePath: NEW_FILE, database: 'main' })
    // Already created by the test: no second round trip.
    expect(api.testConnection).toHaveBeenCalledTimes(1)
  })

  it('creates the file before saving when the test was skipped (⌘Enter on the connection step)', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'create', engine: 'sqlite' })
    renderWizard()
    await pickNewFile()
    fireEvent.keyDown(screen.getByTestId('data-project-wizard-file-path'), {
      key: 'Enter',
      metaKey: true
    })

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ options: { create: 'true' } }) })
    )
    expect(api.testConnection.mock.invocationCallOrder[0]).toBeLessThan(
      api.create.mock.invocationCallOrder[0]
    )
    expect(api.create.mock.calls[0][0].config).toEqual({ filePath: NEW_FILE, database: 'main' })
  })

  it('does not save when the file cannot be created', async () => {
    api.testConnection.mockResolvedValue({ ok: false, error: 'EACCES: permission denied' })
    useDataProjectStore.getState().openWizard({ mode: 'create', engine: 'sqlite' })
    renderWizard()
    await pickNewFile()
    fireEvent.keyDown(screen.getByTestId('data-project-wizard-file-path'), {
      key: 'Enter',
      metaKey: true
    })

    expect(await screen.findByTestId('data-project-wizard-save-error')).toHaveTextContent(
      `Could not create ${NEW_FILE}: EACCES: permission denied`
    )
    expect(api.create).not.toHaveBeenCalled()
  })

  it('never creates a typed or browsed path (it must exist)', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'create', engine: 'sqlite' })
    renderWizard()
    await pickNewFile()
    // Editing the picked path by hand drops the "new file" intent.
    await userEvent.type(screen.getByTestId('data-project-wizard-file-path'), '3')
    await userEvent.click(screen.getByTestId('data-project-wizard-next'))
    await screen.findByTestId('data-project-wizard-test-success')
    expect(api.testConnection).toHaveBeenCalledWith({
      engine: 'sqlite',
      config: { filePath: `${NEW_FILE}3`, database: 'main' },
      secrets: {}
    })
  })
})

describe('test step notice', () => {
  it('shows the SSH host key fingerprint accepted on first use', async () => {
    const notice =
      'SSH host key of bastion:22 (SHA256:Zm9vYmFy) is not in ~/.ssh/known_hosts; accepted on first use.'
    api.testConnection.mockResolvedValue({ ok: true, serverVersion: 'PostgreSQL 17.2', notice })
    useDataProjectStore.getState().openWizard({ mode: 'create', engine: 'postgres' })
    renderWizard()
    await userEvent.click(screen.getByTestId('data-project-wizard-next'))

    expect(await screen.findByTestId('data-project-wizard-test-notice')).toHaveTextContent(notice)
  })

  it('shows nothing extra without a notice', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'create', engine: 'postgres' })
    renderWizard()
    await userEvent.click(screen.getByTestId('data-project-wizard-next'))
    await screen.findByTestId('data-project-wizard-test-success')
    expect(screen.queryByTestId('data-project-wizard-test-notice')).not.toBeInTheDocument()
  })
})

describe('edit', () => {
  const project = sampleDataProject({
    id: 'dp-edit',
    name: 'Billing',
    secretState: 'stored'
  })

  beforeEach(() => {
    useDataProjectStore.setState({ projects: [project] })
    api.update.mockImplementation(async (_id: string, patch: object) => ({ ...project, ...patch }))
  })

  it('shows the saved password without fetching it and sends nothing when untouched', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'edit', projectId: 'dp-edit' })
    renderWizard()

    expect(screen.getByTestId('data-project-wizard-password-saved')).toHaveTextContent('saved')
    expect(screen.queryByTestId('data-project-wizard-password')).not.toBeInTheDocument()
    expect(screen.queryByTestId('data-project-wizard-engine-step')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('data-project-wizard-save'))
    await waitFor(() => expect(useDataProjectStore.getState().wizard).toBeNull())
    // Nothing changed: no update round trip, so open connections stay open.
    expect(api.update).not.toHaveBeenCalled()
  })

  it('Replace sends the new password', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'edit', projectId: 'dp-edit' })
    renderWizard()

    await userEvent.click(screen.getByTestId('data-project-wizard-password-replace'))
    await userEvent.type(screen.getByTestId('data-project-wizard-password'), 'n3w')
    await userEvent.click(screen.getByTestId('data-project-wizard-save'))

    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1))
    expect(api.update).toHaveBeenCalledWith('dp-edit', { secrets: { password: 'n3w' } })
  })

  it('Clear sends null for the password', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'edit', projectId: 'dp-edit' })
    renderWizard()

    await userEvent.click(screen.getByTestId('data-project-wizard-password-clear'))
    expect(screen.getByTestId('data-project-wizard-password-saved')).toHaveTextContent(
      'Will be removed'
    )
    await userEvent.click(screen.getByTestId('data-project-wizard-save'))

    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1))
    expect(api.update).toHaveBeenCalledWith('dp-edit', { secrets: { password: null } })
  })

  it('tests with the stored secrets (dataProjectId) unless a new one was typed', async () => {
    useDataProjectStore.getState().openWizard({ mode: 'edit', projectId: 'dp-edit' })
    renderWizard()
    await userEvent.click(screen.getByTestId('data-project-wizard-next'))
    await screen.findByTestId('data-project-wizard-test-success')
    expect(api.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ dataProjectId: 'dp-edit', secrets: {} })
    )
  })

  it('reports a project that disappeared', () => {
    useDataProjectStore.getState().openWizard({ mode: 'edit', projectId: 'gone' })
    renderWizard()
    expect(screen.getByTestId('data-project-wizard-missing')).toBeInTheDocument()
  })
})

describe('closing', () => {
  it('Cancel closes the wizard', async () => {
    useDataProjectStore.getState().openWizard()
    renderWizard()
    await userEvent.click(screen.getByTestId('data-project-wizard-cancel'))
    expect(useDataProjectStore.getState().wizard).toBeNull()
    await act(async () => {})
    expect(screen.queryByTestId('data-project-wizard')).not.toBeInTheDocument()
  })
})
