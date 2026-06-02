import { existsSync, statSync } from 'fs'
import { Effect } from 'effect'
import { z } from 'zod'
import { isDesktopCommandResult, makeDesktopCommandRequest } from '../../../shared/desktop-command'
import { scanDirectory, scanFlat, scanSingleDirectory } from '../../../shared/file-tree-scan'
import type { FileTreeNode, FlatFile } from '../../../shared/types/file-tree'
import type { RpcHandler } from '../router'

export interface FileTreeScanResult {
  readonly success: boolean
  readonly tree?: FileTreeNode[]
  readonly error?: string
}

export interface FileTreeScanFlatResult {
  readonly success: boolean
  readonly files?: FlatFile[]
  readonly error?: string
}

export interface FileTreeLoadChildrenResult {
  readonly success: boolean
  readonly children?: FileTreeNode[]
  readonly error?: string
}

export interface FileTreeMutationResult {
  readonly success: boolean
  readonly error?: string
}

export interface FileTreeOpsRpcService {
  readonly scan: (dirPath: string) => Effect.Effect<FileTreeScanResult, unknown, never>
  readonly scanFlat: (dirPath: string) => Effect.Effect<FileTreeScanFlatResult, unknown, never>
  readonly loadChildren: (
    dirPath: string,
    rootPath: string
  ) => Effect.Effect<FileTreeLoadChildrenResult, unknown, never>
  readonly watch: (worktreePath: string) => Effect.Effect<FileTreeMutationResult, unknown, never>
  readonly unwatch: (worktreePath: string) => Effect.Effect<FileTreeMutationResult, unknown, never>
}

const scanParamsSchema = z.object({ dirPath: z.string().min(1) }).strict()
const watchParamsSchema = z.object({ worktreePath: z.string().min(1) }).strict()
const loadChildrenParamsSchema = z
  .object({
    dirPath: z.string().min(1),
    rootPath: z.string().min(1)
  })
  .strict()

export const makeLiveFileTreeOpsRpcService = (): FileTreeOpsRpcService => ({
  scan: (dirPath) =>
    Effect.tryPromise({
      try: async () => {
        if (!existsSync(dirPath)) {
          return { success: false, error: 'Directory does not exist' }
        }

        const stat = statSync(dirPath)
        if (!stat.isDirectory()) {
          return { success: false, error: 'Path is not a directory' }
        }

        const tree = await scanDirectory(dirPath, dirPath)
        return { success: true, tree }
      },
      catch: (cause) => cause
    }),
  scanFlat: (dirPath) =>
    Effect.tryPromise({
      try: async () => {
        if (!existsSync(dirPath)) {
          return { success: false, error: 'Directory does not exist' }
        }

        const stat = statSync(dirPath)
        if (!stat.isDirectory()) {
          return { success: false, error: 'Path is not a directory' }
        }

        const files = await scanFlat(dirPath)
        return { success: true, files }
      },
      catch: (cause) => cause
    }),
  loadChildren: (dirPath, rootPath) =>
    Effect.tryPromise({
      try: async () => {
        if (!existsSync(dirPath)) {
          return { success: false, error: 'Directory does not exist' }
        }

        const children = await scanSingleDirectory(dirPath, rootPath)
        return { success: true, children }
      },
      catch: (cause) => cause
    }),
  watch: (worktreePath) =>
    Effect.tryPromise({
      try: () => requestFileTreeMutationCommand('watchFileTree', worktreePath),
      catch: (cause) => cause
    }),
  unwatch: (worktreePath) =>
    Effect.tryPromise({
      try: () => requestFileTreeMutationCommand('unwatchFileTree', worktreePath),
      catch: (cause) => cause
    })
})

export const makeFileTreeOpsRpcHandlers = (
  service: FileTreeOpsRpcService = makeLiveFileTreeOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'fileTreeOps.scan',
      (params) =>
        Effect.gen(function* () {
          const { dirPath } = yield* Effect.try({
            try: () => scanParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.scan(dirPath)
        })
    ],
    [
      'fileTreeOps.scanFlat',
      (params) =>
        Effect.gen(function* () {
          const { dirPath } = yield* Effect.try({
            try: () => scanParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.scanFlat(dirPath)
        })
    ],
    [
      'fileTreeOps.loadChildren',
      (params) =>
        Effect.gen(function* () {
          const { dirPath, rootPath } = yield* Effect.try({
            try: () => loadChildrenParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.loadChildren(dirPath, rootPath)
        })
    ],
    [
      'fileTreeOps.watch',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => watchParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.watch(worktreePath)
        })
    ],
    [
      'fileTreeOps.unwatch',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => watchParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.unwatch(worktreePath)
        })
    ]
  ])

const requestFileTreeMutationCommand = (
  command: 'watchFileTree' | 'unwatchFileTree',
  worktreePath: string
): Promise<FileTreeMutationResult> => {
  const send = process.send
  if (typeof send !== 'function') {
    return import('../../../main/services/file-tree-watcher').then(
      ({ startFileTreeWatcher, stopFileTreeWatcher }) => {
        if (command === 'watchFileTree') return startFileTreeWatcher(worktreePath)
        return stopFileTreeWatcher(worktreePath)
      }
    )
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<FileTreeMutationResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        if (isFileTreeMutationResult(message.value)) {
          resolve(message.value)
          return
        }
        reject(new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    const request =
      command === 'watchFileTree'
        ? makeDesktopCommandRequest(id, 'watchFileTree', { worktreePath })
        : makeDesktopCommandRequest(id, 'unwatchFileTree', { worktreePath })
    send.call(process, request, (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const isFileTreeMutationResult = (value: unknown): value is FileTreeMutationResult =>
  typeof value === 'object' &&
  value !== null &&
  'success' in value &&
  typeof value.success === 'boolean' &&
  (!('error' in value) || typeof value.error === 'string')
