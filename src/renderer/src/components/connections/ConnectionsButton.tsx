import { useState } from 'react'
import { Link } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RecentConnectionsDialog } from './RecentConnectionsDialog'

export function ConnectionsButton(): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        title="Recent connections"
        onClick={() => setDialogOpen(true)}
        data-testid="connections-button"
      >
        <Link className="h-4 w-4" />
      </Button>
      <RecentConnectionsDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
