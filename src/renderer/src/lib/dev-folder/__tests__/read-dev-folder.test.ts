// What a clone dialog gets when it asks for a folder to start from, under every answer the
// window can meet: the server's, a refusal, no server at all, and the answers
// of the test doubles other suites install (undefined, `{ ok: true }`, a throw).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getRendererRpcClient,
  resetRendererRpcClientForTests,
  setRendererRpcClient
} from '@/api/rpc-client'
import { DEV_FOLDER_RPC, type DevFolderState } from '@shared/types/dev-folder'
import { readExistingDevFolder } from '../read-dev-folder'

// The client test/setup.ts installs for every renderer test file: unknown methods answer undefined.
const defaultClient = getRendererRpcClient()

const devFolderState = (overrides: Partial<DevFolderState> = {}): DevFolderState => ({
  path: '/Users/me/code',
  isDefault: false,
  defaultPath: '/Users/me/hive-projects',
  exists: true,
  previousPaths: [],
  leftBehind: { count: 0, folders: [] },
  ...overrides
})

const answerWith = (answer: unknown): ReturnType<typeof vi.fn> => {
  const request: ReturnType<typeof vi.fn> = vi.fn(async () => answer)
  setRendererRpcClient({ request, subscribe: vi.fn() })
  return request
}

describe('readExistingDevFolder', () => {
  afterEach(() => {
    setRendererRpcClient(defaultClient)
  })

  it('answers the dev folder when it is on disk', async () => {
    const request = answerWith(devFolderState())

    await expect(readExistingDevFolder()).resolves.toBe('/Users/me/code')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(DEV_FOLDER_RPC.get, {})
  })

  it('answers the default folder too, when that is the one in effect', async () => {
    answerWith(devFolderState({ path: '/Users/me/hive-projects', isDefault: true }))

    await expect(readExistingDevFolder()).resolves.toBe('/Users/me/hive-projects')
  })

  it('answers null when the folder is not on disk', async () => {
    answerWith(devFolderState({ exists: false }))

    await expect(readExistingDevFolder()).resolves.toBeNull()
  })

  it('answers null under the default test client, which answers undefined', async () => {
    setRendererRpcClient(defaultClient)

    await expect(readExistingDevFolder()).resolves.toBeNull()
  })

  it.each([
    ['null', null],
    ['a truthy object of another shape', { ok: true }],
    ['a bare path', '/Users/me/code'],
    ['a list', [devFolderState()]],
    ['a state whose `exists` is not a boolean', { ...devFolderState(), exists: 'yes' }],
    ['a state whose path is not a string', { ...devFolderState(), path: 42 }],
    ['a state with an empty path', devFolderState({ path: '' })],
    ['a state without the left-behind count', { ...devFolderState(), leftBehind: undefined }]
  ])('answers null for %s', async (_label, answer) => {
    answerWith(answer)

    await expect(readExistingDevFolder()).resolves.toBeNull()
  })

  it('answers null when the call is refused', async () => {
    const request = vi.fn(async (method: string) => {
      throw new Error(`unexpected method ${method}`)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    await expect(readExistingDevFolder()).resolves.toBeNull()
    expect(request).toHaveBeenCalledWith(DEV_FOLDER_RPC.get, {})
  })

  it('answers null when the client throws instead of answering with a promise', async () => {
    const request = vi.fn(() => {
      throw new Error('socket closed')
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    await expect(readExistingDevFolder()).resolves.toBeNull()
  })

  it('answers null when the window has no RPC client', async () => {
    resetRendererRpcClientForTests()

    await expect(readExistingDevFolder()).resolves.toBeNull()
  })
})
