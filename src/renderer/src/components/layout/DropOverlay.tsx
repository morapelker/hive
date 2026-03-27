import { AlertTriangle, Download } from 'lucide-react'

interface DropOverlayProps {
  variant: 'normal' | 'warning'
}

export function DropOverlay({ variant }: DropOverlayProps) {
  const isWarning = variant === 'warning'

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${
        isWarning
          ? 'bg-amber-500/10 border-2 border-dashed border-amber-400/50'
          : 'bg-blue-500/10 border-2 border-dashed border-blue-400/50'
      } animate-in fade-in duration-150`}
    >
      <div className="pointer-events-none flex flex-col items-center gap-3">
        {isWarning ? (
          <>
            <AlertTriangle className="h-12 w-12 text-amber-400" />
            <p className="text-lg font-medium text-amber-300">
              Open a session to attach files
            </p>
          </>
        ) : (
          <>
            <Download className="h-12 w-12 text-blue-400" />
            <p className="text-lg font-medium text-blue-300">
              Drop files to attach
            </p>
          </>
        )}
      </div>
    </div>
  )
}
