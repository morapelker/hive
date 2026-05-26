import { Data, Effect } from 'effect'
import { z } from 'zod'

import { updaterService } from '../services/updater'
import { defineHandler } from './_shared/define-handler'

class UpdaterHandlerFailed extends Data.TaggedError('UpdaterHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const updaterFailed = (operation: string, cause: unknown): UpdaterHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new UpdaterHandlerFailed({ operation, reason, message: reason })
}

const updaterCheckSchema = z.union([
  z.object({ manual: z.boolean().optional() }),
  z.undefined(),
  z.tuple([]).transform(() => undefined)
])

export function registerUpdaterHandlers(): void {
  defineHandler('updater:check', updaterCheckSchema, (options) =>
    Effect.tryPromise({
      try: () => updaterService.checkForUpdates(options),
      catch: (cause) => updaterFailed('updater:check', cause)
    })
  )

  defineHandler('updater:download', z.tuple([]), () =>
    Effect.tryPromise({
      try: () => updaterService.downloadUpdate(),
      catch: (cause) => updaterFailed('updater:download', cause)
    })
  )

  defineHandler('updater:install', z.tuple([]), () =>
    Effect.try({
      try: () => updaterService.quitAndInstall(),
      catch: (cause) => updaterFailed('updater:install', cause)
    })
  )

  defineHandler('updater:setChannel', z.enum(['stable', 'canary']), (channel) =>
    Effect.try({
      try: () => updaterService.setChannel(channel),
      catch: (cause) => updaterFailed('updater:setChannel', cause)
    })
  )

  defineHandler('updater:getVersion', z.tuple([]), () =>
    Effect.try({
      try: () => updaterService.getVersion(),
      catch: (cause) => updaterFailed('updater:getVersion', cause)
    })
  )
}
