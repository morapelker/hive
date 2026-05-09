import { Effect } from 'effect'
import { app } from 'electron'

import { withLogComponent } from '../src/main/effect/_shared/logger'
import { disposeRuntime, getRuntime } from '../src/main/effect/bash/runtime'

const main = async (): Promise<void> => {
  await getRuntime().runPromise(
    Effect.logInfo('logger-probe', { ts: Date.now() }).pipe(withLogComponent('LoggerProbe'))
  )
  await disposeRuntime()
  app.quit()
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
