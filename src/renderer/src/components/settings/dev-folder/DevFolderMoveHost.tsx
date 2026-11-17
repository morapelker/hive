// The one place the "Move projects" dialog is drawn. Settings › General only opens it
// (lib/dev-folder/move-projects): a run goes on when Settings is closed, so the dialog cannot
// hang off the Settings modal.

import { useDevFolderMoveStore } from '@/lib/dev-folder/store'
import { DevFolderMoveDialog } from './DevFolderMoveDialog'

/** Mount once (AppLayout). Shows the dialog while it is open. */
export function DevFolderMoveHost(): React.JSX.Element | null {
  const open = useDevFolderMoveStore((state) => state.phase !== 'closed')
  if (!open) return null
  return <DevFolderMoveDialog />
}
