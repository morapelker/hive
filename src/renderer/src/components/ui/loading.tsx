import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizeClasses = {
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-8 w-8'
}

export function LoadingSpinner({ size = 'md', className }: LoadingSpinnerProps): JSX.Element {
  return (
    <Loader2 className={cn('animate-spin text-muted-foreground', sizeClasses[size], className)} />
  )
}

interface LoadingOverlayProps {
  message?: string
  className?: string
}

export function LoadingOverlay({ message, className }: LoadingOverlayProps): JSX.Element {
  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm z-50',
        className
      )}
    >
      <LoadingSpinner size="lg" />
      {message && <p className="mt-2 text-sm text-muted-foreground">{message}</p>}
    </div>
  )
}

interface LoadingPlaceholderProps {
  height?: string
  message?: string
  className?: string
}

export function LoadingPlaceholder({
  height = 'h-32',
  message = 'Loading...',
  className
}: LoadingPlaceholderProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-muted-foreground',
        height,
        className
      )}
    >
      <LoadingSpinner />
      <p className="mt-2 text-sm">{message}</p>
    </div>
  )
}

interface LoadingButtonProps {
  isLoading: boolean
  loadingText?: string
  children: React.ReactNode
}

export function LoadingButton({
  isLoading,
  loadingText,
  children
}: LoadingButtonProps): JSX.Element {
  if (isLoading) {
    return (
      <span className="flex items-center gap-2">
        <LoadingSpinner size="sm" />
        {loadingText && <span>{loadingText}</span>}
      </span>
    )
  }
  return <>{children}</>
}
