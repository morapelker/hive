import { Data } from 'effect'

export class SpawnFailed extends Data.TaggedError('SpawnFailed')<{
  readonly command: string
  readonly cause: unknown
}> {}

export class SpawnTimeout extends Data.TaggedError('SpawnTimeout')<{
  readonly command: string
  readonly durationMs: number
  readonly stdoutPreview: string
  readonly stderrPreview: string
}> {}

export class SpawnNonZeroExit extends Data.TaggedError('SpawnNonZeroExit')<{
  readonly command: string
  readonly exitCode: number
  readonly stdoutPreview: string
  readonly stderrPreview: string
}> {}

export class SpawnSignalled extends Data.TaggedError('SpawnSignalled')<{
  readonly command: string
  readonly signal: NodeJS.Signals | null
  readonly stdoutPreview: string
  readonly stderrPreview: string
}> {}

export class SpawnOutputCapExceeded extends Data.TaggedError('SpawnOutputCapExceeded')<{
  readonly command: string
  readonly stream: 'stdout' | 'stderr'
  readonly bytes: number
  readonly limit: number
}> {}

export type SpawnError =
  | SpawnFailed
  | SpawnTimeout
  | SpawnNonZeroExit
  | SpawnSignalled
  | SpawnOutputCapExceeded
