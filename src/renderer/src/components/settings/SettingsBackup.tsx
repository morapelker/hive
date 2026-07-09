import { useState } from 'react'
import { DatabaseBackup, FolderDown, Loader2 } from 'lucide-react'

import type { BackupFile } from '@shared/types/backup'
import { Button } from '@/components/ui/button'
import { backupApi } from '@/api/backup-api'
import { toast } from '@/lib/toast'
import { RestoreWizard } from './backup/RestoreWizard'

export function SettingsBackup(): React.JSX.Element {
  const [exporting, setExporting] = useState(false)
  const [opening, setOpening] = useState(false)
  const [pendingBackup, setPendingBackup] = useState<BackupFile | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const result = await backupApi.exportBackup()
      if (result.canceled) return
      if (result.success) {
        const base = `${result.projectCount} projects → ${result.path}`
        const description =
          result.warnings && result.warnings.length > 0
            ? `${base}\n${result.warnings.join('\n')}`
            : base
        toast.success('Backup exported', { description })
      } else {
        toast.error('Failed to export backup', { description: result.error })
      }
    } catch (error) {
      toast.error('Failed to export backup', {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setExporting(false)
    }
  }

  const handleOpenBackupFile = async (): Promise<void> => {
    setOpening(true)
    try {
      const result = await backupApi.openBackupFile()
      if (result.canceled) return
      if (result.backup) {
        setPendingBackup(result.backup)
        setWizardOpen(true)
      } else {
        toast.error('Could not read backup file', { description: result.error })
      }
    } catch (error) {
      toast.error('Could not read backup file', {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Backup</h3>
        <p className="text-sm text-muted-foreground">Back up and restore your projects</p>
      </div>

      <div className="space-y-3">
        <div>
          <div className="text-sm font-medium">Back up</div>
          <p className="text-xs text-muted-foreground">
            Export all projects, their worktrees, and boards to a YAML file. Sessions, account
            credentials, and ticket attachments are not included. Markdown-mode boards export
            their configuration only — their cards live in the repo&apos;s .md files.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={exporting}
          data-testid="backup-export"
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <DatabaseBackup className="h-3.5 w-3.5" />
          )}
          {exporting ? 'Exporting...' : 'Export backup…'}
        </Button>
      </div>

      <div className="border-t pt-4 space-y-3">
        <div>
          <div className="text-sm font-medium">Restore</div>
          <p className="text-xs text-muted-foreground">
            Load a backup file and choose which projects to restore.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleOpenBackupFile}
          disabled={opening}
          data-testid="backup-restore"
        >
          {opening ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderDown className="h-3.5 w-3.5" />
          )}
          {opening ? 'Reading...' : 'Restore from backup…'}
        </Button>
      </div>

      {pendingBackup && (
        <RestoreWizard backup={pendingBackup} open={wizardOpen} onOpenChange={setWizardOpen} />
      )}
    </div>
  )
}
