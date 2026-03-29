import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'

interface ImagePreviewProps {
  src: string
  fileName: string
  className?: string
}

export function ImagePreview({ src, fileName, className }: ImagePreviewProps): React.JSX.Element {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)

  // Reset dimensions when image source changes to avoid stale values flashing
  useEffect(() => {
    setDimensions(null)
  }, [src])

  return (
    <div className={cn('flex flex-col items-center gap-2 p-4', className)}>
      <div
        className="rounded-md overflow-hidden border border-border"
        style={{
          backgroundColor: '#1a1a2e',
          backgroundImage: [
            'linear-gradient(45deg, #2a2a3e 25%, transparent 25%)',
            'linear-gradient(-45deg, #2a2a3e 25%, transparent 25%)',
            'linear-gradient(45deg, transparent 75%, #2a2a3e 75%)',
            'linear-gradient(-45deg, transparent 75%, #2a2a3e 75%)'
          ].join(', '),
          backgroundSize: '20px 20px',
          backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px'
        }}
      >
        <img
          src={src}
          alt={fileName}
          className="max-w-full max-h-[70vh] object-contain"
          onLoad={(e) => {
            const img = e.currentTarget
            setDimensions({ width: img.naturalWidth, height: img.naturalHeight })
          }}
          draggable={false}
        />
      </div>
      {dimensions && (
        <span className="text-xs text-muted-foreground">
          {dimensions.width} &times; {dimensions.height}
        </span>
      )}
    </div>
  )
}
