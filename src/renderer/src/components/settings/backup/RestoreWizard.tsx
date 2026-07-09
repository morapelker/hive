import type { BackupFile } from '@shared/types/backup'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

export interface RestoreWizardProps {
  backup: BackupFile
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Minimal stub — Task 6 replaces the internals (classification, restore loop,
// per-project review UI) but should not need to touch this props contract or
// SettingsBackup's wiring of it.
export function RestoreWizard({ backup, open, onOpenChange }: RestoreWizardProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="restore-wizard">
        <DialogHeader>
          <DialogTitle>Restore from backup</DialogTitle>
          <DialogDescription>
            {backup.projects.length} project{backup.projects.length === 1 ? '' : 's'} found in this
            backup.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
