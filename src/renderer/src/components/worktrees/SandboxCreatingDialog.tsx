import { useEffect, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Loader2, CheckCircle, AlertCircle, Container } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface SandboxCreatingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode?: 'creating' | 'deleting'
  status: 'creating' | 'deleting' | 'success' | 'error'
  errorMessage?: string | null
}

export function SandboxCreatingDialog({
  open,
  onOpenChange,
  mode = 'creating',
  status,
  errorMessage
}: SandboxCreatingDialogProps): React.JSX.Element {
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isActive = status === 'creating' || status === 'deleting'

  // Auto-close on success after 1s
  useEffect(() => {
    if (status === 'success') {
      autoCloseTimer.current = setTimeout(() => {
        onOpenChange(false)
      }, 1000)
    }
    return () => {
      if (autoCloseTimer.current) {
        clearTimeout(autoCloseTimer.current)
        autoCloseTimer.current = null
      }
    }
  }, [status, onOpenChange])

  const handleClose = (newOpen: boolean): void => {
    if (isActive) return
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => {
        if (isActive) e.preventDefault()
      }} onEscapeKeyDown={(e) => {
        if (isActive) e.preventDefault()
      }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Container className="h-5 w-5" />
            Docker Sandbox
          </DialogTitle>
          <DialogDescription>
            {isActive && mode === 'creating' && 'Preparing the Docker sandbox for this session...'}
            {isActive && mode === 'deleting' && 'Removing the Docker sandbox...'}
            {status === 'success' && mode === 'creating' && 'Sandbox is ready.'}
            {status === 'success' && mode === 'deleting' && 'Sandbox has been removed.'}
            {status === 'error' && mode === 'creating' && 'Failed to create the Docker sandbox.'}
            {status === 'error' && mode === 'deleting' && 'Failed to remove the Docker sandbox.'}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {isActive && (
            <div className="flex items-center gap-3 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>{mode === 'creating' ? 'Creating Claude Sandbox...' : 'Removing Claude Sandbox...'}</span>
            </div>
          )}

          {status === 'success' && (
            <div className="flex items-center gap-3 text-sm text-green-500">
              <CheckCircle className="h-4 w-4" />
              <span>{mode === 'creating' ? 'Sandbox created successfully!' : 'Sandbox removed successfully!'}</span>
            </div>
          )}

          {status === 'error' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMessage || 'An unknown error occurred'}</span>
              </div>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => handleClose(false)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
