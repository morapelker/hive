import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

interface GitInitDialogProps {
  open: boolean
  path: string
  onCancel: () => void
  onConfirm: () => void
}

export function GitInitDialog({ open, path, onCancel, onConfirm }: GitInitDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Not a Git Repository</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>The selected folder is not a Git repository:</p>
              <p className="font-mono text-xs bg-muted rounded px-2 py-1 break-all">{path}</p>
              <p>Would you like to initialize a new Git repository?</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Initialize Repository</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
