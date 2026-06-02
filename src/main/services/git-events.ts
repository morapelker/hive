import { GIT_BRANCH_CHANGED_CHANNEL, GIT_STATUS_CHANGED_CHANNEL } from '../../shared/git-events'
import type { GitBranchChangedEvent, GitStatusChangedEvent } from '../../shared/types/git'

type GitEventPublisher = (channel: string, payload: unknown) => void | Promise<void>

let gitEventPublisher: GitEventPublisher | null = null

export const setGitEventPublisher = (publisher: GitEventPublisher | null): void => {
  gitEventPublisher = publisher
}

const publishGitEvent = (channel: string, payload: unknown): void => {
  if (gitEventPublisher) {
    void Promise.resolve(gitEventPublisher(channel, payload))
    return
  }

  void import('../desktop/backend-manager').then(({ publishDesktopBackendEvent }) =>
    publishDesktopBackendEvent(channel, payload)
  )
}

export const emitGitStatusChanged = (payload: GitStatusChangedEvent): void => {
  publishGitEvent(GIT_STATUS_CHANGED_CHANNEL, payload)
}

export const emitGitBranchChanged = (payload: GitBranchChangedEvent): void => {
  publishGitEvent(GIT_BRANCH_CHANGED_CHANNEL, payload)
}
