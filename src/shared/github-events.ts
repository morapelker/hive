export const GITHUB_CLONE_PROGRESS_CHANNEL = 'github:cloneProgress'

export type GithubCloneProgressEventType = 'progress' | 'done' | 'error'

export interface GithubCloneProgressEvent {
  readonly operationId: string
  readonly type: GithubCloneProgressEventType
  readonly stage?: string
  readonly percent?: number
  readonly path?: string
  readonly error?: string
}

export const isGithubCloneProgressEvent = (value: unknown): value is GithubCloneProgressEvent => {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Record<string, unknown>
  return (
    typeof event.operationId === 'string' &&
    (event.type === 'progress' || event.type === 'done' || event.type === 'error')
  )
}
