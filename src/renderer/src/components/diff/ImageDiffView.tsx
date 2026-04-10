import { useState, useEffect, useCallback } from 'react'
import { X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImagePreview, SvgPreview } from '@/components/file-viewer/ImagePreview'
import { isSvgFile, getImageMimeType } from '@shared/types/file-utils'

interface ImageDiffViewProps {
  worktreePath: string
  filePath: string
  fileName: string
  staged: boolean
  isUntracked: boolean
  isNewFile?: boolean
  compareBranch?: string
  onClose: () => void
}

export function ImageDiffView({
  worktreePath,
  filePath,
  fileName,
  staged,
  isUntracked,
  isNewFile,
  compareBranch,
  onClose
}: ImageDiffViewProps): React.JSX.Element {
  // Data URIs for binary images (PNG, JPG, etc.)
  const [originalUri, setOriginalUri] = useState<string | null>(null)
  const [modifiedUri, setModifiedUri] = useState<string | null>(null)
  // Raw SVG text content (rendered via SvgPreview instead of <img>)
  const [originalSvg, setOriginalSvg] = useState<string | null>(null)
  const [modifiedSvg, setModifiedSvg] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const statusLabel = compareBranch
    ? `vs ${compareBranch}`
    : staged
      ? 'Staged'
      : isUntracked
        ? 'New file'
        : 'Unstaged'

  const buildDataUri = useCallback(
    (base64Data: string, mimeType?: string): string => {
      const mime = mimeType || getImageMimeType(filePath) || 'application/octet-stream'
      return `data:${mime};base64,${base64Data}`
    },
    [filePath]
  )

  const fetchContent = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    setOriginalSvg(null)
    setModifiedSvg(null)

    try {
      const isSvg = isSvgFile(filePath)

      if (isNewFile || isUntracked) {
        // New/untracked: only show "After"
        if (isSvg) {
          const modResult = await window.gitOps.getFileContent(worktreePath, filePath)
          if (modResult.success && modResult.content) {
            setModifiedSvg(modResult.content)
          }
        } else {
          const modResult = await window.gitOps.getFileContentBase64(worktreePath, filePath)
          if (modResult.success && modResult.data) {
            setModifiedUri(buildDataUri(modResult.data, modResult.mimeType))
          }
        }
        setOriginalUri(null)
        return
      }

      if (compareBranch) {
        // Branch diff: original = merge-base content, modified = working tree.
        if (isSvg) {
          const [origResult, modResult] = await Promise.all([
            window.gitOps.getBranchBaseContent(worktreePath, compareBranch, filePath),
            window.gitOps.getFileContent(worktreePath, filePath)
          ])
          setOriginalSvg(origResult.success && origResult.content ? origResult.content : null)
          setModifiedSvg(modResult.success && modResult.content ? modResult.content : null)
        } else {
          const [origResult, modResult] = await Promise.all([
            window.gitOps.getBranchBaseContentBase64(worktreePath, compareBranch, filePath),
            window.gitOps.getFileContentBase64(worktreePath, filePath)
          ])
          setOriginalUri(
            origResult.success && origResult.data
              ? buildDataUri(origResult.data, origResult.mimeType)
              : null
          )
          setModifiedUri(
            modResult.success && modResult.data
              ? buildDataUri(modResult.data, modResult.mimeType)
              : null
          )
        }
      } else if (staged) {
        // Staged diff: original = HEAD, modified = Index (staged)
        if (isSvg) {
          const [origResult, modResult] = await Promise.all([
            window.gitOps.getRefContent(worktreePath, 'HEAD', filePath),
            window.gitOps.getRefContent(worktreePath, '', filePath)
          ])
          setOriginalSvg(origResult.success && origResult.content ? origResult.content : null)
          setModifiedSvg(modResult.success && modResult.content ? modResult.content : null)
        } else {
          const [origResult, modResult] = await Promise.all([
            window.gitOps.getRefContentBase64(worktreePath, 'HEAD', filePath),
            window.gitOps.getRefContentBase64(worktreePath, '', filePath)
          ])
          setOriginalUri(
            origResult.success && origResult.data
              ? buildDataUri(origResult.data, origResult.mimeType)
              : null
          )
          setModifiedUri(
            modResult.success && modResult.data
              ? buildDataUri(modResult.data, modResult.mimeType)
              : null
          )
        }
      } else {
        // Unstaged diff: original = Index (or HEAD), modified = working tree
        if (isSvg) {
          const [origResult, modResult] = await Promise.all([
            window.gitOps.getRefContent(worktreePath, '', filePath),
            window.gitOps.getFileContent(worktreePath, filePath)
          ])
          setOriginalSvg(origResult.success && origResult.content ? origResult.content : null)
          setModifiedSvg(modResult.success && modResult.content ? modResult.content : null)
        } else {
          const [origResult, modResult] = await Promise.all([
            window.gitOps.getRefContentBase64(worktreePath, '', filePath),
            window.gitOps.getFileContentBase64(worktreePath, filePath)
          ])
          setOriginalUri(
            origResult.success && origResult.data
              ? buildDataUri(origResult.data, origResult.mimeType)
              : null
          )
          setModifiedUri(
            modResult.success && modResult.data
              ? buildDataUri(modResult.data, modResult.mimeType)
              : null
          )
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load image diff')
    } finally {
      setIsLoading(false)
    }
  }, [
    worktreePath,
    filePath,
    staged,
    isUntracked,
    isNewFile,
    compareBranch,
    buildDataUri
  ])

  useEffect(() => {
    fetchContent()
  }, [fetchContent])

  // Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const toolbar = (
    <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium truncate">{fileName}</span>
        <span className="text-xs text-muted-foreground shrink-0">{statusLabel}</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onClose}
          title="Close (Esc)"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        {toolbar}
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        {toolbar}
        <div className="flex-1 flex items-center justify-center text-destructive">{error}</div>
      </div>
    )
  }

  const isSvg = isSvgFile(filePath)
  const hasOriginal = isSvg ? !!originalSvg : !!originalUri
  const hasModified = isSvg ? !!modifiedSvg : !!modifiedUri

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {toolbar}
      <div className="flex-1 flex min-h-0 overflow-auto">
        {hasOriginal && (
          <div className="flex-1 flex flex-col min-w-0 border-r border-border">
            <div className="px-3 py-1 text-xs text-muted-foreground bg-muted/20 border-b border-border">
              Before
            </div>
            <div className="flex-1 overflow-auto">
              {isSvg ? (
                <SvgPreview svgContent={originalSvg!} fileName={fileName} />
              ) : (
                <ImagePreview src={originalUri!} fileName={fileName} />
              )}
            </div>
          </div>
        )}
        {hasModified && (
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-3 py-1 text-xs text-muted-foreground bg-muted/20 border-b border-border">
              After
            </div>
            <div className="flex-1 overflow-auto">
              {isSvg ? (
                <SvgPreview svgContent={modifiedSvg!} fileName={fileName} />
              ) : (
                <ImagePreview src={modifiedUri!} fileName={fileName} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
