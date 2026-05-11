import type { Duration } from 'effect'

export type SpawnOptions = {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: string
  readonly timeout?: Duration.DurationInput
  readonly maxOutputBytes?: number
  readonly collectStderr?: boolean
  readonly shell?: boolean | string
  readonly detached?: boolean
  readonly signal?: AbortSignal
}

export type RunOnceResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type StreamChunk = {
  readonly source: 'stdout' | 'stderr'
  readonly data: string
}
