import { Effect } from 'effect'
import { startHiveServer } from './server'

export const main = (): Promise<void> =>
  Effect.runPromise(startHiveServer()).then((server) => {
    process.stdout.write(
      JSON.stringify({
        event: 'hive-server-ready',
        httpBaseUrl: server.httpBaseUrl,
        wsBaseUrl: server.wsBaseUrl
      }) + '\n'
    )

    const shutdown = (): void => {
      void server.close().finally(() => process.exit(0))
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })

const entryArg = process.argv[1] ?? ''

if (
  entryArg.endsWith('src/server/bin.ts') ||
  entryArg.endsWith('server/bin.js') ||
  entryArg.endsWith('server.js')
) {
  void main()
}
