import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'

interface ErrorFallbackProps {
  error?: Error | null
  resetError?: () => void
  title?: string
  message?: string
  compact?: boolean
}

export function ErrorFallback({
  error,
  resetError,
  title = 'Something went wrong',
  message,
  compact = false
}: ErrorFallbackProps): JSX.Element {
  const errorMessage = message || error?.message || 'An unexpected error occurred'

  if (compact) {
    return (
      <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded text-sm">
        <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
        <span className="text-muted-foreground flex-1 truncate">{errorMessage}</span>
        {resetError && (
          <Button variant="ghost" size="sm" onClick={resetError} className="h-6 px-2">
            <RefreshCw className="h-3 w-3" />
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center p-6 text-center">
      <AlertTriangle className="h-8 w-8 text-destructive mb-3" />
      <h3 className="font-medium mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground mb-4 max-w-sm">{errorMessage}</p>
      {resetError && (
        <Button variant="outline" size="sm" onClick={resetError}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Try Again
        </Button>
      )}
    </div>
  )
}

export default ErrorFallback
