import { useEffect } from 'react'
import { terminalApi } from '@/api/terminal-api'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import {
  applyShellCommandRunStatus,
  markRunningShellCommandsWorking
} from '@/lib/shell-command-status'

/**
 * App-wide listener for `shell-command:status` (run-state changes of shell-command
 * sessions, published by the main process). Mounted once in AppLayout, next to
 * useClaudeCliStatusListener. Also loads the run index on mount so ticket cards and
 * session views know which sessions are shell commands before any event arrives, and
 * seeds the 'working' status of runs that were already going (window reload).
 */
export function useShellCommandStatusListener(): void {
  useEffect(() => {
    void useShellCommandRunStore
      .getState()
      .loadAll()
      .then(markRunningShellCommandsWorking)
      .catch(() => undefined)
    return terminalApi.onShellCommandStatus(applyShellCommandRunStatus)
  }, [])
}
