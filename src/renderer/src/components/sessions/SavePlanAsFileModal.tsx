import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { fileApi } from '@/api/file-api'

interface SavePlanAsFileModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  planContent: string
  directoryPath: string
  defaultFileName: string
}

export function SavePlanAsFileModal({
  open,
  onOpenChange,
  planContent,
  directoryPath,
  defaultFileName
}: SavePlanAsFileModalProps): React.JSX.Element {
  const [fileName, setFileName] = useState(defaultFileName)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false)

  const fileNameInputRef = useRef<HTMLInputElement>(null)

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setFileName(defaultFileName)
      setErrorMessage(null)
      setIsSaving(false)
      setConfirmingOverwrite(false)
      // Auto-focus the input after dialog animation
      setTimeout(() => {
        fileNameInputRef.current?.focus()
        fileNameInputRef.current?.select()
      }, 50)
    }
  }, [open, defaultFileName])

  const handleSave = useCallback(
    async (overwrite: boolean) => {
      const trimmed = fileName.trim()
      if (!trimmed || isSaving) return
      if (trimmed.includes('/') || trimmed.includes('\\')) {
        setErrorMessage('File name cannot contain slashes')
        return
      }
      const finalName = trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`

      setIsSaving(true)
      setErrorMessage(null)
      try {
        const envelope = await fileApi.createFile(directoryPath, finalName, planContent, overwrite)
        if (envelope.success) {
          toast.success(`Saved ${finalName}`)
          onOpenChange(false)
          return
        }
        if (envelope.errorCode === 'FileAlreadyExists') {
          setConfirmingOverwrite(true)
          return
        }
        toast.error(envelope.error ?? 'Failed to save plan file')
      } catch {
        toast.error('Failed to save plan file')
      } finally {
        setIsSaving(false)
      }
    },
    [fileName, isSaving, directoryPath, planContent, onOpenChange]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && fileName.trim()) {
        e.preventDefault()
        handleSave(confirmingOverwrite)
      }
    },
    [handleSave, fileName, confirmingOverwrite]
  )

  const isFileNameEmpty = !fileName.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="save-plan-file-modal"
        className="sm:max-w-md"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Save plan as md file</DialogTitle>
          <DialogDescription>
            The plan will be saved in the worktree root directory.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label htmlFor="save-plan-file-name" className="text-sm font-medium text-foreground">
            File name
          </label>
          <Input
            id="save-plan-file-name"
            ref={fileNameInputRef}
            data-testid="save-plan-file-input"
            value={fileName}
            onChange={(e) => {
              setFileName(e.target.value)
              setErrorMessage(null)
              setConfirmingOverwrite(false)
            }}
            autoFocus
          />
          {errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}
          {confirmingOverwrite && (
            <p className="text-xs text-destructive" data-testid="save-plan-file-overwrite-warning">
              A file with this name already exists. Overwrite it?
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="save-plan-file-cancel-btn"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {confirmingOverwrite ? (
            <Button
              type="button"
              variant="destructive"
              data-testid="save-plan-file-overwrite-btn"
              disabled={isFileNameEmpty || isSaving}
              onClick={() => handleSave(true)}
            >
              Overwrite
            </Button>
          ) : (
            <Button
              type="button"
              data-testid="save-plan-file-ok-btn"
              disabled={isFileNameEmpty || isSaving}
              onClick={() => handleSave(false)}
            >
              Ok
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
