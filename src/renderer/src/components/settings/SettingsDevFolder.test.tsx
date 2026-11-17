// Settings › General's "Dev folder" row over a stand-in server: what it draws (and that it
// draws nothing until the server answered with a dev folder), what typing, Enter, Save,
// Escape, Browse and "Use default" send, where a refusal is shown, and the hint that opens
// "Move projects". The settings store is the bare stand-in the suites that mount
// Settings › General use; the flow behind "Move projects" is faked and tested on its own.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const flow = vi.hoisted(() => ({ openDevFolderMove: vi.fn(async () => undefined) }))
vi.mock('@/lib/dev-folder/move-projects', () => flow)

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: toasts }))

const settings = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (state: unknown) => unknown) =>
      selector ? selector(settings.state) : settings.state,
    { getState: () => settings.state }
  )
}))

import {
  getRendererRpcClient,
  resetRendererRpcClientForTests,
  setRendererRpcClient,
  type RendererRpcClient
} from '@/api/rpc-client'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { CLOSED_DEV_FOLDER_MOVE, useDevFolderMoveStore } from '@/lib/dev-folder/store'
import { DEV_FOLDER_RPC, type DevFolderState } from '@shared/types/dev-folder'
import { SettingsDevFolder } from './SettingsDevFolder'

const PICK = 'projectOps.openDirectoryDialog'
const DEFAULT = '/Users/me/hive-projects'

const stateOf = (over: Partial<DevFolderState> = {}): DevFolderState => ({
  path: DEFAULT,
  isDefault: true,
  defaultPath: DEFAULT,
  exists: true,
  previousPaths: [],
  leftBehind: { count: 0, folders: [] },
  ...over
})

const defaultClient = getRendererRpcClient()

/** The stand-in server: the dev folder it holds, and what each call answers. */
const server = {
  state: stateOf(),
  get: (): unknown => server.state,
  set: (_path: string | null): unknown => undefined,
  pick: (): unknown => null
}

// As the real server: a folder that is set becomes the folder in effect, and the one that was
// left is remembered.
const acceptAnyFolder = (path: string | null): unknown => {
  const left = server.state.path
  server.state = stateOf({
    path: path ?? DEFAULT,
    isDefault: path === null,
    previousPaths: [left]
  })
  return { success: true, state: server.state }
}

const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method === DEV_FOLDER_RPC.get) return server.get()
  if (method === DEV_FOLDER_RPC.set) return server.set((params as { path: string | null }).path)
  if (method === PICK) return server.pick()
  throw new Error(`unexpected method ${method}`)
})

const callsOf = (method: string): unknown[] =>
  request.mock.calls.filter(([name]) => name === method).map(([, params]) => params)
const methods = (): string[] => request.mock.calls.map(([name]) => name)

const input = (): HTMLInputElement => screen.getByTestId('dev-folder-path') as HTMLInputElement
const type = (text: string): void => {
  fireEvent.change(input(), { target: { value: text } })
}
const press = (key: string): boolean => fireEvent.keyDown(input(), { key })

/** Lets the answers that are ready arrive and be drawn. */
const settle = async (): Promise<void> => {
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
}

/** The row on screen, drawn from the folder the server holds. */
const mount = async (over: Partial<DevFolderState> = {}): Promise<void> => {
  server.state = stateOf(over)
  render(<SettingsDevFolder />)
  await screen.findByTestId('dev-folder')
}

// A promise that rejects with nobody listening fails the whole run, also when every test
// passed: seen here so that the test that caused it is the one that fails.
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => void unhandled.push(reason)

beforeEach(() => {
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
  server.state = stateOf()
  server.get = () => server.state
  server.set = acceptAnyFolder
  server.pick = () => null
  settings.state = { lastProjectDirectory: null, updateSetting: vi.fn(async () => undefined) }
  setRendererRpcClient({ request: request as never, subscribe: vi.fn() })
})

afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  process.off('unhandledRejection', onUnhandled)
  expect(unhandled).toEqual([])
  useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE })
  setRendererRpcClient(defaultClient)
  vi.clearAllMocks()
})

describe('SettingsDevFolder: until the server answered with a dev folder', () => {
  const clients: [string, () => RendererRpcClient | null][] = [
    ['the default test client, which answers undefined', () => defaultClient],
    [
      'a client that answers { ok: true } to everything',
      () => ({ request: async <T,>() => ({ ok: true }) as T, subscribe: () => () => {} })
    ],
    [
      'a client that throws on every call',
      () => ({
        request: (<T,>(method: string): Promise<T> => {
          throw new Error(`unexpected method ${method}`)
        }) as RendererRpcClient['request'],
        subscribe: () => () => {}
      })
    ],
    [
      'a client that refuses every call',
      () => ({
        request: async <T,>(method: string): Promise<T> => {
          throw new Error(`FORBIDDEN ${method}`)
        },
        subscribe: () => () => {}
      })
    ],
    ['no client at all', () => null]
  ]

  it.each(clients)('draws nothing under %s', async (_label, makeClient) => {
    const client = makeClient()
    if (client) setRendererRpcClient(client)
    else resetRendererRpcClientForTests()

    const { container } = render(<SettingsDevFolder />)
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('dev-folder')).not.toBeInTheDocument()
    expect(unhandled).toEqual([])
  })

  it.each([
    ['a path that is not a text', { ...stateOf(), path: 7 }],
    ['no count of projects left behind', { ...stateOf(), leftBehind: undefined }],
    ['null', null]
  ])('draws nothing for an answer with %s', async (_label, answer) => {
    server.get = () => answer

    const { container } = render(<SettingsDevFolder />)
    await settle()

    expect(container).toBeEmptyDOMElement()
  })

  it('draws nothing before the answer, and the row once it arrived', async () => {
    let answer: (state: unknown) => void = () => undefined
    server.get = () => new Promise((resolve) => (answer = resolve))

    const { container } = render(<SettingsDevFolder />)
    await settle()
    expect(container).toBeEmptyDOMElement()

    await act(async () => answer(stateOf({ path: '/Users/me/Dev', isDefault: false })))

    expect(input()).toHaveValue('/Users/me/Dev')
    expect(screen.getByText('Dev folder')).toBeInTheDocument()
  })

  it('asks for the dev folder once on mount, and for no plan', async () => {
    await mount({ leftBehind: { count: 2, folders: ['/old'] } })
    await settle()

    expect(methods()).toEqual([DEV_FOLDER_RPC.get])
    expect(request).toHaveBeenCalledWith(DEV_FOLDER_RPC.get, {})
  })

  it('keeps quiet when its answer arrives after it was taken off the screen', async () => {
    let answer: (state: unknown) => void = () => undefined
    server.get = () => new Promise((resolve) => (answer = resolve))
    const { unmount } = render(<SettingsDevFolder />)

    unmount()
    answer(stateOf())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByTestId('dev-folder')).not.toBeInTheDocument()
  })
})

describe('SettingsDevFolder: the folder in effect', () => {
  it('shows the default folder with Browse, and nothing to save or to go back to', async () => {
    await mount()

    expect(input()).toHaveValue(DEFAULT)
    expect(input()).toHaveAccessibleName('Dev folder')
    expect(screen.getByTestId('dev-folder-browse')).toHaveTextContent('Browse…')
    expect(screen.queryByTestId('dev-folder-save')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-use-default')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-error')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-missing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-move-hint')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-move-open')).not.toBeInTheDocument()
  })

  it('offers "Use default" for a folder that is not the default', async () => {
    await mount({ path: '/Users/me/Dev', isDefault: false })

    expect(input()).toHaveValue('/Users/me/Dev')
    expect(screen.getByTestId('dev-folder-use-default')).toHaveTextContent('Use default')
  })

  it('says so when the folder is not on disk, as something that is yet to happen', async () => {
    await mount({ exists: false })

    expect(screen.getByTestId('dev-folder-missing').textContent).toBe(
      'This folder does not exist yet. Hive creates it the first time it puts a project there.'
    )
  })
})

describe('SettingsDevFolder: typing a folder', () => {
  it('holds what is typed as a draft: Save appears, nothing is sent', async () => {
    await mount()

    type('/Users/me/Dev')

    expect(input()).toHaveValue('/Users/me/Dev')
    expect(screen.getByTestId('dev-folder-save')).toBeEnabled()
    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([])
  })

  it('Save sends the draft, then reads the dev folder again and shows it', async () => {
    await mount()
    type('/Users/me/Dev')

    fireEvent.click(screen.getByTestId('dev-folder-save'))
    await waitFor(() => expect(screen.queryByTestId('dev-folder-save')).not.toBeInTheDocument())

    expect(methods()).toEqual([DEV_FOLDER_RPC.get, DEV_FOLDER_RPC.set, DEV_FOLDER_RPC.get])
    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([{ path: '/Users/me/Dev' }])
    expect(input()).toHaveValue('/Users/me/Dev')
    expect(screen.getByTestId('dev-folder-use-default')).toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-error')).not.toBeInTheDocument()
    expect(toasts.success).toHaveBeenCalledTimes(1)
    expect(toasts.success).toHaveBeenCalledWith('Dev folder changed', {
      description: '/Users/me/Dev'
    })
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('Enter sends the draft too', async () => {
    await mount()
    type('/Users/me/Dev')

    press('Enter')
    await waitFor(() => expect(screen.getByTestId('dev-folder-use-default')).toBeInTheDocument())

    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([{ path: '/Users/me/Dev' }])
    expect(input()).toHaveValue('/Users/me/Dev')
  })

  it('sends a typed path without the spaces around it', async () => {
    await mount()
    type('   ~/Dev folder \t')

    press('Enter')
    await waitFor(() => expect(callsOf(DEV_FOLDER_RPC.set)).toHaveLength(1))

    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([{ path: '~/Dev folder' }])
    await settle()
  })

  it('shows the folder the server says is in effect, not the text that was typed', async () => {
    server.set = () => {
      server.state = stateOf({ path: '/private/var/dev', isDefault: false })
      return { success: true, state: server.state }
    }
    await mount()
    type('/var/dev/')

    press('Enter')

    await waitFor(() => expect(input()).toHaveValue('/private/var/dev'))
    expect(screen.queryByTestId('dev-folder-save')).not.toBeInTheDocument()
  })

  it('takes what the re-read says over what the change answered', async () => {
    server.set = (path) => {
      const answer = { success: true, state: stateOf({ path: path ?? DEFAULT, isDefault: false }) }
      // What the server holds a moment later: the projects of the folder just left.
      server.state = stateOf({
        path: path ?? DEFAULT,
        isDefault: false,
        leftBehind: { count: 4, folders: [DEFAULT] }
      })
      return answer
    }
    await mount()
    type('/Users/me/Dev')

    press('Enter')

    expect(await screen.findByTestId('dev-folder-move-hint')).toHaveTextContent(
      `4 projects are still in ${DEFAULT}.`
    )
  })

  it('shows what the change answered when the re-read does not arrive', async () => {
    server.set = (path) => {
      server.get = () => {
        throw new Error('connection closed')
      }
      return { success: true, state: stateOf({ path: path ?? DEFAULT, isDefault: false }) }
    }
    await mount()
    type('/Users/me/Dev')

    press('Enter')

    await waitFor(() => expect(screen.getByTestId('dev-folder-use-default')).toBeInTheDocument())
    expect(input()).toHaveValue('/Users/me/Dev')
    expect(toasts.success).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['nothing', ''],
    ['only spaces', '   '],
    ['the folder in effect', DEFAULT],
    ['the folder in effect with spaces around it', `  ${DEFAULT} `]
  ])('sends nothing for %s, and shows the folder in effect again', async (_label, text) => {
    await mount()
    type(text)

    press('Enter')
    await settle()

    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([])
    expect(input()).toHaveValue(DEFAULT)
    expect(screen.queryByTestId('dev-folder-save')).not.toBeInTheDocument()
    expect(toasts.success).not.toHaveBeenCalled()
  })

  it('cannot save a draft of spaces by the button either', async () => {
    await mount()

    type('  ')

    expect(screen.getByTestId('dev-folder-save')).toBeDisabled()
  })

  it('leaving the field sends nothing and keeps the draft', async () => {
    await mount()
    type('/Users/me/half-typ')

    fireEvent.blur(input())
    await settle()

    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([])
    expect(input()).toHaveValue('/Users/me/half-typ')
    expect(screen.getByTestId('dev-folder-save')).toBeInTheDocument()
  })

  it('Escape puts the folder in effect back and sends nothing', async () => {
    await mount()
    type('/Users/me/half-typ')

    press('Escape')
    await settle()

    expect(input()).toHaveValue(DEFAULT)
    expect(screen.queryByTestId('dev-folder-save')).not.toBeInTheDocument()
    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([])
  })

  it('does not send Enter while a text is being composed', async () => {
    await mount()
    type('/Users/me/Dev')

    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    await settle()

    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([])
  })

  it('sends one change at a time, and waits with the field and the buttons meanwhile', async () => {
    let answer: (result: unknown) => void = () => undefined
    server.set = () => new Promise((resolve) => (answer = resolve))
    await mount({ path: '/Users/me/Old', isDefault: false })
    type('/Users/me/Dev')

    fireEvent.click(screen.getByTestId('dev-folder-save'))
    await settle()
    expect(input()).toHaveAttribute('readonly')
    expect(screen.getByTestId('dev-folder-save')).toBeDisabled()
    expect(screen.getByTestId('dev-folder-browse')).toBeDisabled()
    expect(screen.getByTestId('dev-folder-use-default')).toBeDisabled()
    press('Enter')
    fireEvent.click(screen.getByTestId('dev-folder-browse'))
    fireEvent.click(screen.getByTestId('dev-folder-use-default'))
    await settle()
    expect(callsOf(DEV_FOLDER_RPC.set)).toHaveLength(1)
    expect(callsOf(PICK)).toHaveLength(0)

    server.state = stateOf({ path: '/Users/me/Dev', isDefault: false })
    await act(async () => answer({ success: true, state: server.state }))
    await waitFor(() => expect(input()).not.toHaveAttribute('readonly'))

    expect(input()).toHaveValue('/Users/me/Dev')
    expect(screen.getByTestId('dev-folder-browse')).toBeEnabled()
  })
})

describe('SettingsDevFolder: a folder the server refuses', () => {
  const REFUSAL =
    'The dev folder cannot be your home folder: choose a folder inside it, such as ~/Dev.'

  it('shows the server’s sentence under the field and keeps the draft', async () => {
    server.set = () => ({ success: false, error: REFUSAL })
    await mount()
    type('~')

    press('Enter')

    expect(await screen.findByTestId('dev-folder-error')).toHaveTextContent(REFUSAL)
    expect(screen.getByTestId('dev-folder-error').textContent).toBe(REFUSAL)
    expect(input()).toHaveValue('~')
    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('dev-folder-save')).toBeInTheDocument()
    expect(toasts.success).not.toHaveBeenCalled()
    expect(toasts.error).not.toHaveBeenCalled()
    // The folder in effect did not change.
    expect(screen.queryByTestId('dev-folder-use-default')).not.toBeInTheDocument()
  })

  it('reads the dev folder again after a refusal too', async () => {
    server.set = () => ({ success: false, error: REFUSAL })
    await mount()
    type('~')

    press('Enter')
    await screen.findByTestId('dev-folder-error')

    expect(methods()).toEqual([DEV_FOLDER_RPC.get, DEV_FOLDER_RPC.set, DEV_FOLDER_RPC.get])
  })

  it('Escape takes the sentence away with the draft', async () => {
    server.set = () => ({ success: false, error: REFUSAL })
    await mount()
    type('~')
    press('Enter')
    await screen.findByTestId('dev-folder-error')

    press('Escape')

    expect(screen.queryByTestId('dev-folder-error')).not.toBeInTheDocument()
    expect(input()).toHaveValue(DEFAULT)
    expect(input()).toHaveAttribute('aria-invalid', 'false')
  })

  it('a folder that is accepted next takes the sentence away', async () => {
    server.set = () => ({ success: false, error: REFUSAL })
    await mount()
    type('~')
    press('Enter')
    await screen.findByTestId('dev-folder-error')

    server.set = acceptAnyFolder
    type('~/Dev')
    press('Enter')

    await waitFor(() => expect(screen.queryByTestId('dev-folder-error')).not.toBeInTheDocument())
    expect(input()).toHaveValue('~/Dev')
    expect(screen.queryByTestId('dev-folder-save')).not.toBeInTheDocument()
  })

  it('says what went wrong when the call itself fails', async () => {
    server.set = () => {
      throw new Error('Hive WebSocket transport closed.')
    }
    await mount()
    type('/Users/me/Dev')

    press('Enter')

    expect(await screen.findByTestId('dev-folder-error')).toHaveTextContent(
      'The dev folder could not be changed: Hive WebSocket transport closed.'
    )
    expect(input()).toHaveValue('/Users/me/Dev')
    expect(toasts.success).not.toHaveBeenCalled()
  })

  it.each([
    ['undefined', undefined],
    ['{ ok: true }', { ok: true }],
    ['a refusal without a sentence', { success: false }]
  ])('says the folder could not be changed for an answer of %s', async (_label, answer) => {
    server.set = () => answer
    await mount()
    type('/Users/me/Dev')

    press('Enter')

    expect(await screen.findByTestId('dev-folder-error')).toHaveTextContent(
      'The dev folder could not be changed.'
    )
    expect(toasts.success).not.toHaveBeenCalled()
  })
})

describe('SettingsDevFolder: Browse', () => {
  it('sets the folder that was picked, exactly as the panel gave it', async () => {
    server.pick = () => '/Volumes/Work/My Projects '
    await mount()

    fireEvent.click(screen.getByTestId('dev-folder-browse'))

    await waitFor(() => expect(input()).toHaveValue('/Volumes/Work/My Projects '))
    expect(callsOf(PICK)).toEqual([{}])
    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([{ path: '/Volumes/Work/My Projects ' }])
    expect(screen.queryByTestId('dev-folder-save')).not.toBeInTheDocument()
    expect(toasts.success).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the panel was cancelled', () => null],
    ['the window has no panel', () => undefined],
    ['the panel answered something that is not a path', () => ({ ok: true })],
    [
      'the panel could not be opened',
      () => {
        throw new Error('no desktop')
      }
    ]
  ])('does nothing when %s', async (_label, pick) => {
    server.pick = pick
    await mount()
    type('/Users/me/half-typ')

    fireEvent.click(screen.getByTestId('dev-folder-browse'))
    await settle()

    expect(callsOf(PICK)).toHaveLength(1)
    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([])
    expect(input()).toHaveValue('/Users/me/half-typ')
    expect(screen.queryByTestId('dev-folder-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('dev-folder-browse')).toBeEnabled()
  })

  it('leaves the picked folder in the field under the sentence when it is refused', async () => {
    server.pick = () => '/Users/me'
    server.set = () => ({ success: false, error: 'The dev folder cannot be your home folder.' })
    await mount()

    fireEvent.click(screen.getByTestId('dev-folder-browse'))

    expect(await screen.findByTestId('dev-folder-error')).toHaveTextContent(
      'The dev folder cannot be your home folder.'
    )
    expect(input()).toHaveValue('/Users/me')
  })
})

describe('SettingsDevFolder: Use default', () => {
  it('sends null, and the default folder is in effect again', async () => {
    await mount({ path: '/Users/me/Dev', isDefault: false })

    fireEvent.click(screen.getByTestId('dev-folder-use-default'))

    await waitFor(() => expect(input()).toHaveValue(DEFAULT))
    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([{ path: null }])
    expect(screen.queryByTestId('dev-folder-use-default')).not.toBeInTheDocument()
    expect(toasts.success).toHaveBeenCalledWith('Dev folder changed', { description: DEFAULT })
  })

  it('drops a draft that was being typed', async () => {
    await mount({ path: '/Users/me/Dev', isDefault: false })
    type('/Users/me/half-typ')

    fireEvent.click(screen.getByTestId('dev-folder-use-default'))

    await waitFor(() => expect(input()).toHaveValue(DEFAULT))
    expect(screen.queryByTestId('dev-folder-save')).not.toBeInTheDocument()
  })
})

describe('SettingsDevFolder: projects still in a folder used before', () => {
  it.each([
    [{ count: 3, folders: ['/Users/me/Old'] }, '3 projects are still in /Users/me/Old.'],
    [{ count: 1, folders: ['/Users/me/Old'] }, '1 project is still in /Users/me/Old.'],
    [{ count: 5, folders: ['/a', '/b'] }, '5 projects are still in 2 other folders.'],
    [{ count: 2, folders: [] }, '2 projects are still in a folder used before.']
  ])('says how many and where (%j)', async (leftBehind, sentence) => {
    await mount({ path: '/Users/me/Dev', isDefault: false, leftBehind })

    const hint = screen.getByTestId('dev-folder-move-hint')
    expect(hint).toHaveTextContent(sentence)
    expect(screen.getByTestId('dev-folder-move-open')).toHaveTextContent('Move projects…')
  })

  it('"Move projects…" opens the dialog through the flow', async () => {
    await mount({ leftBehind: { count: 3, folders: ['/Users/me/Old'] } })

    fireEvent.click(screen.getByTestId('dev-folder-move-open'))

    expect(flow.openDevFolderMove).toHaveBeenCalledTimes(1)
    // The row itself asks for no plan and moves nothing.
    expect(methods()).toEqual([DEV_FOLDER_RPC.get])
  })

  it('waits with "Move projects…" while the folder is being changed', async () => {
    let answer: (result: unknown) => void = () => undefined
    server.set = () => new Promise((resolve) => (answer = resolve))
    await mount({ leftBehind: { count: 3, folders: ['/Users/me/Old'] } })
    type('/Users/me/Dev')

    press('Enter')
    await settle()
    expect(screen.getByTestId('dev-folder-move-open')).toBeDisabled()
    fireEvent.click(screen.getByTestId('dev-folder-move-open'))
    expect(flow.openDevFolderMove).not.toHaveBeenCalled()

    server.state = stateOf({
      path: '/Users/me/Dev',
      isDefault: false,
      leftBehind: { count: 3, folders: ['/Users/me/Old'] }
    })
    await act(async () => answer({ success: true, state: server.state }))

    await waitFor(() => expect(screen.getByTestId('dev-folder-move-open')).toBeEnabled())
  })

  it('appears after a change that leaves projects behind', async () => {
    server.set = (path) => {
      server.state = stateOf({
        path: path ?? DEFAULT,
        isDefault: false,
        previousPaths: [DEFAULT],
        leftBehind: { count: 2, folders: [DEFAULT] }
      })
      return { success: true, state: server.state }
    }
    await mount()
    expect(screen.queryByTestId('dev-folder-move-hint')).not.toBeInTheDocument()
    type('/Users/me/Dev')

    press('Enter')

    expect(await screen.findByTestId('dev-folder-move-hint')).toHaveTextContent(
      `2 projects are still in ${DEFAULT}.`
    )
  })

  it('reads the dev folder again when "Move projects" is closed', async () => {
    await mount({ leftBehind: { count: 3, folders: ['/Users/me/Old'] } })
    expect(callsOf(DEV_FOLDER_RPC.get)).toHaveLength(1)

    // While the dialog is open nothing is read, and there is nothing more to open.
    act(() => useDevFolderMoveStore.setState({ phase: 'planning' }))
    act(() => useDevFolderMoveStore.setState({ phase: 'confirm' }))
    act(() => useDevFolderMoveStore.setState({ phase: 'running' }))
    act(() => useDevFolderMoveStore.setState({ phase: 'summary' }))
    await settle()
    expect(callsOf(DEV_FOLDER_RPC.get)).toHaveLength(1)
    expect(screen.getByTestId('dev-folder-move-open')).toBeDisabled()

    server.state = stateOf({ leftBehind: { count: 1, folders: ['/Users/me/Old'] } })
    act(() => useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE }))

    await waitFor(() =>
      expect(screen.getByTestId('dev-folder-move-hint')).toHaveTextContent(
        '1 project is still in /Users/me/Old.'
      )
    )
    expect(callsOf(DEV_FOLDER_RPC.get)).toHaveLength(2)
    expect(screen.getByTestId('dev-folder-move-open')).toBeEnabled()
  })

  it('takes the hint away once nothing is left behind', async () => {
    await mount({ leftBehind: { count: 3, folders: ['/Users/me/Old'] } })
    act(() => useDevFolderMoveStore.setState({ phase: 'summary' }))

    server.state = stateOf()
    act(() => useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE }))

    await waitFor(() =>
      expect(screen.queryByTestId('dev-folder-move-hint')).not.toBeInTheDocument()
    )
  })

  it('keeps the row and a draft when the re-read does not arrive', async () => {
    await mount({ leftBehind: { count: 3, folders: ['/Users/me/Old'] } })
    type('/Users/me/half-typ')
    act(() => useDevFolderMoveStore.setState({ phase: 'summary' }))

    server.get = () => {
      throw new Error('connection closed')
    }
    act(() => useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE }))
    await settle()

    expect(input()).toHaveValue('/Users/me/half-typ')
    expect(screen.getByTestId('dev-folder-move-hint')).toHaveTextContent('3 projects')
  })
})

// Settings can be opened again while the dialog is open (a run goes on when Settings is closed),
// and is then drawn over it.
describe('SettingsDevFolder: while "Move projects" is open', () => {
  const PHASES = ['planning', 'confirm', 'running', 'summary'] as const
  const LEFT_BEHIND = { count: 3, folders: ['/Users/me/Old'] }

  const mountWhile = async (phase: (typeof PHASES)[number]): Promise<void> => {
    useDevFolderMoveStore.setState({ phase })
    await mount({ path: '/Users/me/Dev', isDefault: false, leftBehind: LEFT_BEHIND })
  }

  it.each(PHASES)(
    'mounted while the dialog is in "%s", draws the row with nothing to change',
    async (phase) => {
      await mountWhile(phase)
      await settle()

      expect(methods()).toEqual([DEV_FOLDER_RPC.get])
      expect(input()).toHaveValue('/Users/me/Dev')
      expect(input()).toHaveAttribute('readonly')
      expect(screen.getByTestId('dev-folder-browse')).toBeDisabled()
      expect(screen.getByTestId('dev-folder-use-default')).toBeDisabled()
      expect(screen.getByTestId('dev-folder-move-hint')).toHaveTextContent(
        '3 projects are still in /Users/me/Old.'
      )
      expect(screen.getByTestId('dev-folder-move-open')).toBeDisabled()

      fireEvent.click(screen.getByTestId('dev-folder-browse'))
      fireEvent.click(screen.getByTestId('dev-folder-use-default'))
      fireEvent.click(screen.getByTestId('dev-folder-move-open'))
      await settle()

      expect(methods()).toEqual([DEV_FOLDER_RPC.get])
      expect(flow.openDevFolderMove).not.toHaveBeenCalled()
    }
  )

  it('does not read again while the dialog goes from one step to the next', async () => {
    await mountWhile('planning')

    act(() => useDevFolderMoveStore.setState({ phase: 'confirm' }))
    act(() => useDevFolderMoveStore.setState({ phase: 'running' }))
    act(() => useDevFolderMoveStore.setState({ phase: 'summary' }))
    await settle()

    expect(callsOf(DEV_FOLDER_RPC.get)).toHaveLength(1)
  })

  it('reads the dev folder again and gives the row back once the dialog is closed', async () => {
    await mountWhile('running')
    expect(callsOf(DEV_FOLDER_RPC.get)).toHaveLength(1)

    act(() => useDevFolderMoveStore.setState({ phase: 'summary' }))
    server.state = stateOf({
      path: '/Users/me/Dev',
      isDefault: false,
      leftBehind: { count: 1, folders: ['/Users/me/Old'] }
    })
    act(() => useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE }))

    await waitFor(() =>
      expect(screen.getByTestId('dev-folder-move-hint')).toHaveTextContent(
        '1 project is still in /Users/me/Old.'
      )
    )
    expect(callsOf(DEV_FOLDER_RPC.get)).toHaveLength(2)
    expect(input()).not.toHaveAttribute('readonly')
    expect(screen.getByTestId('dev-folder-browse')).toBeEnabled()
    expect(screen.getByTestId('dev-folder-use-default')).toBeEnabled()
    expect(screen.getByTestId('dev-folder-move-open')).toBeEnabled()
  })

  it('keeps a folder typed before the dialog opened, and sends it only after it closed', async () => {
    await mount({ leftBehind: LEFT_BEHIND })
    type('/Users/me/Dev')
    expect(screen.getByTestId('dev-folder-save')).toBeEnabled()

    act(() => useDevFolderMoveStore.setState({ phase: 'confirm' }))
    expect(input()).toHaveAttribute('readonly')
    expect(screen.getByTestId('dev-folder-save')).toBeDisabled()
    expect(screen.getByTestId('dev-folder-browse')).toBeDisabled()
    press('Enter')
    fireEvent.click(screen.getByTestId('dev-folder-save'))
    fireEvent.click(screen.getByTestId('dev-folder-browse'))
    await settle()
    expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([])
    expect(callsOf(PICK)).toEqual([])
    expect(input()).toHaveValue('/Users/me/Dev')

    act(() => useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE }))
    await waitFor(() => expect(screen.getByTestId('dev-folder-save')).toBeEnabled())
    expect(input()).toHaveValue('/Users/me/Dev')
    press('Enter')

    await waitFor(() => expect(callsOf(DEV_FOLDER_RPC.set)).toEqual([{ path: '/Users/me/Dev' }]))
    await waitFor(() => expect(screen.queryByTestId('dev-folder-save')).not.toBeInTheDocument())
  })
})

describe('SettingsDevFolder: the folder "New project" starts from', () => {
  const updateSetting = (): ReturnType<typeof vi.fn> =>
    settings.state.updateSetting as ReturnType<typeof vi.fn>

  it('follows to the new dev folder when it was the one just left', async () => {
    settings.state.lastProjectDirectory = '/Users/me/Old'
    await mount({ path: '/Users/me/Old', isDefault: false })
    type('/Users/me/Dev')

    press('Enter')
    await waitFor(() => expect(input()).toHaveValue('/Users/me/Dev'))

    expect(updateSetting()).toHaveBeenCalledTimes(1)
    expect(updateSetting()).toHaveBeenCalledWith('lastProjectDirectory', '/Users/me/Dev')
  })

  it('follows back to the default folder with "Use default"', async () => {
    settings.state.lastProjectDirectory = '/Users/me/Dev'
    await mount({ path: '/Users/me/Dev', isDefault: false })

    fireEvent.click(screen.getByTestId('dev-folder-use-default'))
    await waitFor(() => expect(input()).toHaveValue(DEFAULT))

    expect(updateSetting()).toHaveBeenCalledWith('lastProjectDirectory', DEFAULT)
  })

  it.each([
    ['another folder', '/Users/me/Elsewhere'],
    ['a folder inside the one just left', '/Users/me/Old/sub'],
    ['nothing', null]
  ])('stays as it is when it is %s', async (_label, lastProjectDirectory) => {
    settings.state.lastProjectDirectory = lastProjectDirectory
    await mount({ path: '/Users/me/Old', isDefault: false })
    type('/Users/me/Dev')

    press('Enter')
    await waitFor(() => expect(input()).toHaveValue('/Users/me/Dev'))

    expect(updateSetting()).not.toHaveBeenCalled()
  })

  it('stays as it is when the folder was refused', async () => {
    settings.state.lastProjectDirectory = '/Users/me/Old'
    server.set = () => ({ success: false, error: 'No.' })
    await mount({ path: '/Users/me/Old', isDefault: false })
    type('/Users/me/Dev')

    press('Enter')
    await screen.findByTestId('dev-folder-error')

    expect(updateSetting()).not.toHaveBeenCalled()
  })

  it('stays as it is when the change turned out to be the same folder', async () => {
    settings.state.lastProjectDirectory = '/Users/me/Old'
    // Another spelling of the folder in effect: the server accepts it and changes nothing.
    server.set = () => ({ success: true, state: server.state })
    await mount({ path: '/Users/me/Old', isDefault: false })
    type('/Users/me/old/')

    press('Enter')
    await waitFor(() => expect(input()).toHaveValue('/Users/me/Old'))

    expect(updateSetting()).not.toHaveBeenCalled()
    expect(toasts.success).not.toHaveBeenCalled()
  })

  it('changes the dev folder all the same when the settings store cannot be written', async () => {
    settings.state = {
      lastProjectDirectory: '/Users/me/Old',
      updateSetting: vi.fn(() => {
        throw new Error('store is gone')
      })
    }
    await mount({ path: '/Users/me/Old', isDefault: false })
    type('/Users/me/Dev')

    press('Enter')

    await waitFor(() => expect(input()).toHaveValue('/Users/me/Dev'))
    expect(screen.queryByTestId('dev-folder-error')).not.toBeInTheDocument()
  })

  it('changes the dev folder under a settings store that holds nothing', async () => {
    // What the suites that mount Settings › General give this row.
    settings.state = {}
    await mount()
    type('/Users/me/Dev')

    press('Enter')

    await waitFor(() => expect(input()).toHaveValue('/Users/me/Dev'))
    expect(toasts.success).toHaveBeenCalledTimes(1)
  })
})

// The row sits in the Settings dialog, which closes on Escape. The dialog listens on the
// document before the field sees the key.
describe('SettingsDevFolder: Escape inside the Settings dialog', () => {
  const onOpenChange = vi.fn()

  const mountInDialog = async (): Promise<void> => {
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>General</DialogDescription>
          <SettingsDevFolder />
        </DialogContent>
      </Dialog>
    )
    await screen.findByTestId('dev-folder')
  }

  it('reverts a draft and leaves Settings open; a second Escape closes Settings', async () => {
    const user = userEvent.setup()
    await mountInDialog()
    await user.click(input())
    await user.keyboard('x')
    expect(input()).toHaveValue(`${DEFAULT}x`)

    await user.keyboard('{Escape}')
    expect(input()).toHaveValue(DEFAULT)
    expect(onOpenChange).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('still reaches the field after a refusal, because the field kept the focus', async () => {
    const user = userEvent.setup()
    server.set = () => ({ success: false, error: 'No.' })
    await mountInDialog()
    await user.click(input())
    await user.keyboard('x{Enter}')
    await screen.findByTestId('dev-folder-error')
    expect(input()).toHaveFocus()

    await user.keyboard('{Escape}')

    expect(screen.queryByTestId('dev-folder-error')).not.toBeInTheDocument()
    expect(input()).toHaveValue(DEFAULT)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('leaves Escape to Settings when the key is pressed somewhere else', async () => {
    const user = userEvent.setup()
    await mountInDialog()
    await user.click(input())
    await user.keyboard('x')

    await user.tab()
    expect(input()).not.toHaveFocus()
    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
