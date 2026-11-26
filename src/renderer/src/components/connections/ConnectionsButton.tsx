import { Link } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  SIDEBAR_HEADER_ACTION_BUTTON,
  SIDEBAR_HEADER_ACTION_ICON,
  SIDEBAR_HEADER_ACTION_ICON_STROKE
} from '@/components/sidebar'
import { useConnectionStore } from '@/stores/useConnectionStore'

export function ConnectionsButton(): React.JSX.Element {
  const setDialogOpen = useConnectionStore((s) => s.setRecentConnectionsDialogOpen)

  // The dialog itself is mounted once in AppLayout, so the `connection:recent` shortcut
  // works even while the sidebar is collapsed.
  // Orca SidebarHeader action: ghost icon-xs (24px, rounded-md), muted 14px glyph
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={SIDEBAR_HEADER_ACTION_BUTTON}
      title="Recent connections"
      onClick={() => setDialogOpen(true)}
      data-testid="connections-button"
    >
      <Link
        className={SIDEBAR_HEADER_ACTION_ICON}
        strokeWidth={SIDEBAR_HEADER_ACTION_ICON_STROKE}
      />
    </Button>
  )
}
