import { cn } from '@/lib/utils'
import { getFileIconInfo } from '@/lib/file-icons'

interface FileIconProps {
  name: string
  extension: string | null
  isDirectory: boolean
  isExpanded?: boolean
  className?: string
}

export function FileIcon({
  name,
  extension,
  isDirectory,
  isExpanded = false,
  className
}: FileIconProps): React.JSX.Element {
  const info = getFileIconInfo(name, extension, isDirectory, isExpanded)

  if (info.type === 'svg') {
    return (
      <img
        src={info.src}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn('h-4 w-4 flex-shrink-0', className)}
      />
    )
  }

  const Icon = info.icon
  return <Icon className={cn('h-4 w-4 flex-shrink-0', info.colorClass, className)} />
}
