import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

interface ImagePreviewProps {
  src: string
  fileName: string
  className?: string
  onError?: () => void
}

export function ImagePreview({
  src,
  fileName,
  className,
  onError
}: ImagePreviewProps): React.JSX.Element {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [loadError, setLoadError] = useState(false)

  // Reset dimensions and error state when image source changes
  useEffect(() => {
    setDimensions(null)
    setLoadError(false)
  }, [src])

  if (loadError) {
    return (
      <div className={cn('flex flex-col items-center gap-2 p-4', className)}>
        <div className="rounded-md border border-border bg-muted/30 p-8 text-center">
          <p className="text-sm text-muted-foreground">Failed to render image</p>
          <p className="text-xs text-muted-foreground/70 mt-1">{fileName}</p>
        </div>
      </div>
    )
  }

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
          onError={() => {
            setLoadError(true)
            onError?.()
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

// ── SVG-specific preview ────────────────────────────────────────────
// Renders SVG content directly in a sandboxed iframe instead of relying
// on <img src="data:..."> which silently fails in many environments.

interface SvgPreviewProps {
  svgContent: string
  fileName: string
  className?: string
}

export function SvgPreview({ svgContent, fileName, className }: SvgPreviewProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)

  // Reset dimensions when content changes
  useEffect(() => {
    setDimensions(null)
  }, [svgContent])

  // Build a minimal HTML document that renders the SVG centered on a
  // checkerboard transparency background — same visual as ImagePreview.
  const srcdoc = `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    background-color: #1a1a2e;
    background-image:
      linear-gradient(45deg, #2a2a3e 25%, transparent 25%),
      linear-gradient(-45deg, #2a2a3e 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #2a2a3e 75%),
      linear-gradient(-45deg, transparent 75%, #2a2a3e 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
    display: flex; align-items: center; justify-content: center;
    overflow: auto;
  }
  svg {
    max-width: 100%;
    max-height: 100%;
  }
</style>
</head>
<body>${svgContent}</body>
</html>`

  const handleLoad = (): void => {
    try {
      const doc = iframeRef.current?.contentDocument
      const svg = doc?.querySelector('svg')
      if (svg) {
        const bbox = svg.getBoundingClientRect()
        if (bbox.width > 0 && bbox.height > 0) {
          setDimensions({ width: Math.round(bbox.width), height: Math.round(bbox.height) })
        }
      }
    } catch {
      // cross-origin restrictions — ignore
    }
  }

  return (
    <div className={cn('flex flex-col items-center gap-2 p-4', className)}>
      <div className="rounded-md overflow-hidden border border-border w-full max-w-[90%]">
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          title={fileName}
          sandbox="allow-same-origin"
          className="w-full border-0"
          style={{ minHeight: '200px', height: '70vh', maxHeight: '70vh' }}
          onLoad={handleLoad}
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
