import {
  WORKTREE_BRANCH_RENAMED_CHANNEL,
  type WorktreeBranchRenamedEvent
} from '../../shared/worktree-events'

type WorktreeEventPublisher = (channel: string, payload: unknown) => void | Promise<void>

let worktreeEventPublisher: WorktreeEventPublisher | null = null

export const setWorktreeEventPublisher = (publisher: WorktreeEventPublisher | null): void => {
  worktreeEventPublisher = publisher
}

const publishWorktreeEvent = (channel: string, payload: unknown): void => {
  if (worktreeEventPublisher) {
    void Promise.resolve(worktreeEventPublisher(channel, payload))
    return
  }

  void import('../desktop/backend-event-publisher').then(({ publishDesktopBackendEvent }) =>
    publishDesktopBackendEvent(channel, payload)
  )
}

export const emitWorktreeBranchRenamed = (payload: WorktreeBranchRenamedEvent): void => {
  publishWorktreeEvent(WORKTREE_BRANCH_RENAMED_CHANNEL, payload)
}
