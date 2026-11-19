import { useConnectionStore } from '@/stores/useConnectionStore'
import { RecentConnectionsDialog } from './RecentConnectionsDialog'

/** App-level mount for the Recent Connections dialog, driven by the connection store. */
export function RecentConnectionsDialogHost(): React.JSX.Element {
  const open = useConnectionStore((s) => s.recentConnectionsDialogOpen)
  const setOpen = useConnectionStore((s) => s.setRecentConnectionsDialogOpen)
  return <RecentConnectionsDialog open={open} onOpenChange={setOpen} />
}
