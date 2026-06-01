import {
  WORKTREE_BRANCH_RENAMED_CHANNEL,
  type WorktreeBranchRenamedEvent
} from '../../shared/worktree-events'
import { publishDesktopBackendEvent } from '../desktop/backend-manager'

export const emitWorktreeBranchRenamed = (payload: WorktreeBranchRenamedEvent): void => {
  void publishDesktopBackendEvent(WORKTREE_BRANCH_RENAMED_CHANNEL, payload)
}
