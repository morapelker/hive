import { Data } from 'effect'

export class BashAlreadyRunning extends Data.TaggedError('BashAlreadyRunning')<{
  readonly sessionId: string
}> {}

export class BashSpawnFailed extends Data.TaggedError('BashSpawnFailed')<{
  readonly sessionId: string
  readonly command: string
  readonly cause: unknown
}> {}

export class BashOutputCapReached extends Data.TaggedError('BashOutputCapReached')<{
  readonly sessionId: string
  readonly bytes: number
}> {}

export class BashAborted extends Data.TaggedError('BashAborted')<{
  readonly sessionId: string
  readonly escalatedToKill: boolean
}> {}

export type BashError = BashAlreadyRunning | BashSpawnFailed | BashOutputCapReached | BashAborted
