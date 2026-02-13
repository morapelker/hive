import { cn } from '@/lib/utils'

// Git status codes
type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'C' | ''

interface GitStatusIndicatorProps {
  status: GitStatusCode
  staged?: boolean
  className?: string
}

// Status colors per the IMPLEMENTATION-P2.md spec
const statusColors: Record<GitStatusCode, string> = {
  M: 'text-yellow-500', // Modified - yellow
  A: 'text-green-500', // Added/Staged - green
  D: 'text-red-500', // Deleted - red
  '?': 'text-gray-500', // Untracked - gray
  C: 'text-red-600 font-bold', // Conflicted - red bold
  '': ''
}

const statusTitles: Record<GitStatusCode, string> = {
  M: 'Modified',
  A: 'Staged',
  D: 'Deleted',
  '?': 'Untracked',
  C: 'Conflicted',
  '': ''
}

export function GitStatusIndicator({
  status,
  staged,
  className
}: GitStatusIndicatorProps): React.JSX.Element | null {
  if (!status) return null

  // If the file is staged, show as green regardless of type
  const displayStatus = staged && status !== 'C' ? 'A' : status
  const colorClass = statusColors[displayStatus]
  const title = statusTitles[status] + (staged ? ' (staged)' : '')

  return (
    <span
      className={cn('text-[10px] font-mono ml-auto flex-shrink-0', colorClass, className)}
      title={title}
    >
      {status}
    </span>
  )
}

export type { GitStatusCode }
