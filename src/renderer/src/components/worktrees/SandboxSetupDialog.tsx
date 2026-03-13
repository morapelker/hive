import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Loader2, Shield, CheckCircle, AlertCircle } from 'lucide-react'

interface SandboxSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onTokenGenerated: () => void
}

type SetupState = 'idle' | 'generating' | 'success' | 'error'

export function SandboxSetupDialog({
  open,
  onOpenChange,
  onTokenGenerated
}: SandboxSetupDialogProps): React.JSX.Element {
  const [state, setState] = useState<SetupState>('idle')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear auto-close timer on unmount
  useEffect(() => {
    return () => {
      if (autoCloseTimer.current) {
        clearTimeout(autoCloseTimer.current)
      }
    }
  }, [])

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setState('idle')
      setErrorMessage('')
    }
  }, [open])

  const handleGenerate = useCallback(async (): Promise<void> => {
    setState('generating')
    setErrorMessage('')

    try {
      const result = await window.worktreeOps.generateSetupToken()
      if (result.success) {
        setState('success')
        autoCloseTimer.current = setTimeout(() => {
          onOpenChange(false)
          onTokenGenerated()
          setState('idle')
        }, 1500)
      } else {
        setState('error')
        setErrorMessage(result.error || 'Failed to generate setup token')
      }
    } catch (err) {
      setState('error')
      setErrorMessage(err instanceof Error ? err.message : 'Failed to generate setup token')
    }
  }, [onOpenChange, onTokenGenerated])

  const handleClose = useCallback((newOpen: boolean): void => {
    if (state === 'generating') return
    onOpenChange(newOpen)
    if (!newOpen) {
      if (autoCloseTimer.current) {
        clearTimeout(autoCloseTimer.current)
        autoCloseTimer.current = null
      }
      setState('idle')
      setErrorMessage('')
    }
  }, [state, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Docker Sandbox Setup
          </DialogTitle>
          <DialogDescription>
            A setup token is required to authenticate Claude Code inside Docker Sandbox. This token
            is valid for 1 year.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {state === 'idle' && (
            <p className="text-sm text-muted-foreground">
              Clicking &quot;Generate Setup Token&quot; will open your browser for authentication.
              Once complete, the token will be stored securely and sandbox mode will be enabled.
            </p>
          )}

          {state === 'generating' && (
            <div className="flex items-center gap-3 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>Waiting for browser authentication...</span>
            </div>
          )}

          {state === 'success' && (
            <div className="flex items-center gap-3 text-sm text-green-500">
              <CheckCircle className="h-4 w-4" />
              <span>Setup token generated successfully!</span>
            </div>
          )}

          {state === 'error' && (
            <div className="flex items-center gap-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          {state === 'idle' && (
            <Button onClick={handleGenerate}>Generate Setup Token</Button>
          )}
          {state === 'generating' && (
            <Button disabled>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Waiting...
            </Button>
          )}
          {state === 'error' && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button onClick={handleGenerate}>Try Again</Button>
            </div>
          )}
          {state === 'success' && (
            <Button disabled variant="outline">
              <CheckCircle className="h-4 w-4 mr-2" />
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
