import { Effect } from 'effect'
import { z } from 'zod'
import { createFile, readFile, readFileAsBase64, writeFile } from '../../../main/services/file-ops'
import { RpcRouteError } from '../../../shared/rpc/errors'
import type { RpcHandler } from '../router'

export interface FileReadResult {
  readonly success: boolean
  readonly content?: string
  readonly error?: string
}

export interface FileImageReadResult {
  readonly data: string
  readonly mimeType?: string
}

export interface FileOpsRpcService {
  readonly readFile: (filePath: string) => Effect.Effect<FileReadResult, unknown, never>
  readonly writeFile: (filePath: string, content: string) => Effect.Effect<null, unknown, never>
  readonly createFile: (filePath: string, content: string) => Effect.Effect<null, unknown, never>
  readonly readImageAsBase64: (
    filePath: string
  ) => Effect.Effect<FileImageReadResult, unknown, never>
}

const readFileParamsSchema = z.object({ filePath: z.string().min(1) }).strict()
const writeFileParamsSchema = z
  .object({ filePath: z.string().min(1), content: z.string() })
  .strict()
const readImageAsBase64ParamsSchema = z.object({ filePath: z.string().min(1) }).strict()

export const makeLiveFileOpsRpcService = (): FileOpsRpcService => ({
  readFile: (filePath) =>
    Effect.sync(() => {
      return readFile(filePath)
    }),
  writeFile: (filePath, content) =>
    Effect.suspend(() => {
      const result = writeFile(filePath, content)
      if (result.success) return Effect.succeed(null)
      return Effect.fail(new Error(result.error ?? 'Unknown error'))
    }),
  createFile: (filePath, content) =>
    Effect.suspend(() => {
      const result = createFile(filePath, content)
      if (result.success) return Effect.succeed(null)
      return Effect.fail(new Error(result.error ?? 'Unknown error'))
    }),
  readImageAsBase64: (filePath) =>
    Effect.suspend(() => {
      const result = readFileAsBase64(filePath)
      if (result.success && result.data) {
        return Effect.succeed({
          data: result.data,
          mimeType: result.mimeType
        })
      }
      return Effect.fail(
        new RpcRouteError('FileReadFailed', result.error ?? 'Unknown error', { filePath })
      )
    })
})

export const makeFileOpsRpcHandlers = (
  service: FileOpsRpcService = makeLiveFileOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'fileOps.readFile',
      (params) =>
        Effect.gen(function* () {
          const { filePath } = yield* Effect.try({
            try: () => readFileParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.readFile(filePath)
        })
    ],
    [
      'fileOps.writeFile',
      (params) =>
        Effect.gen(function* () {
          const { filePath, content } = yield* Effect.try({
            try: () => writeFileParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.writeFile(filePath, content)
        })
    ],
    [
      'fileOps.createFile',
      (params) =>
        Effect.gen(function* () {
          const { filePath, content } = yield* Effect.try({
            try: () => writeFileParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createFile(filePath, content)
        })
    ],
    [
      'fileOps.readImageAsBase64',
      (params) =>
        Effect.gen(function* () {
          const { filePath } = yield* Effect.try({
            try: () => readImageAsBase64ParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.readImageAsBase64(filePath)
        })
    ]
  ])
