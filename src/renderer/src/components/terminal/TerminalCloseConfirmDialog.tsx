import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction
} from '@/components/ui/alert-dialog'

interface TerminalCloseConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  terminalName: string
  description?: string
  onConfirm: () => void
}

export function TerminalCloseConfirmDialog({
  open,
  onOpenChange,
  terminalName,
  description,
  onConfirm
}: TerminalCloseConfirmDialogProps): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close Terminal?</AlertDialogTitle>
          <AlertDialogDescription>
            {description ?? <>Terminal &ldquo;{terminalName}&rdquo; has a running process. Close anyway?</>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Close Terminal
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
