import { useCallback, useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut
} from '@/components/ui/context-menu'
import {
  GitBranch,
  FileCode,
  FolderOpen,
  Copy,
  Trash2,
  AlertCircle,
  EyeOff,
  FileDiff
} from 'lucide-react'
import { useGitStore, type GitStatusCode } from '@/stores/useGitStore'
import { DiffModal } from '@/components/diff'

interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  extension: string | null
}

interface FileContextMenuProps {
  children: React.ReactNode
  node: FileTreeNode
  worktreePath: string
  gitStatus?: GitStatusCode
  staged?: boolean
  onClose?: () => void
}

export function FileContextMenu({
  children,
  node,
  worktreePath,
  gitStatus,
  staged,
  onClose
}: FileContextMenuProps): React.JSX.Element {
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [showDiffModal, setShowDiffModal] = useState(false)
  const { stageFile, unstageFile, discardChanges, addToGitignore } = useGitStore()

  // Handle stage file
  const handleStage = useCallback(async () => {
    await stageFile(worktreePath, node.relativePath)
    onClose?.()
  }, [stageFile, worktreePath, node.relativePath, onClose])

  // Handle unstage file
  const handleUnstage = useCallback(async () => {
    await unstageFile(worktreePath, node.relativePath)
    onClose?.()
  }, [unstageFile, worktreePath, node.relativePath, onClose])

  // Handle discard changes
  const handleDiscard = useCallback(async () => {
    if (!showDiscardConfirm) {
      setShowDiscardConfirm(true)
      return
    }
    await discardChanges(worktreePath, node.relativePath)
    setShowDiscardConfirm(false)
    onClose?.()
  }, [showDiscardConfirm, discardChanges, worktreePath, node.relativePath, onClose])

  // Handle add to .gitignore
  const handleAddToGitignore = useCallback(async () => {
    await addToGitignore(worktreePath, node.relativePath)
    onClose?.()
  }, [addToGitignore, worktreePath, node.relativePath, onClose])

  // Handle open in editor
  const handleOpenInEditor = useCallback(async () => {
    await window.gitOps.openInEditor(node.path)
    onClose?.()
  }, [node.path, onClose])

  // Handle open in Finder
  const handleOpenInFinder = useCallback(async () => {
    await window.gitOps.showInFinder(node.path)
    onClose?.()
  }, [node.path, onClose])

  // Handle copy absolute path
  const handleCopyPath = useCallback(async () => {
    await window.projectOps.copyToClipboard(node.path)
    onClose?.()
  }, [node.path, onClose])

  // Handle copy relative path
  const handleCopyRelativePath = useCallback(async () => {
    await window.projectOps.copyToClipboard(node.relativePath)
    onClose?.()
  }, [node.relativePath, onClose])

  // Handle view changes (diff)
  const handleViewChanges = useCallback(() => {
    setShowDiffModal(true)
    onClose?.()
  }, [onClose])

  // Determine which git actions to show
  const showStage = gitStatus && !staged && gitStatus !== 'C'
  const showUnstage = staged
  const showDiscard = gitStatus && gitStatus !== '?' && gitStatus !== 'C'
  const showGitignore = gitStatus === '?'
  const showViewChanges = gitStatus && gitStatus !== 'C' && !node.isDirectory

  return (
    <>
      <ContextMenu onOpenChange={(open) => !open && setShowDiscardConfirm(false)}>
        {children}
        <ContextMenuContent className="w-56">
          {/* Git actions */}
          {(showStage || showUnstage || showDiscard || showGitignore || showViewChanges) && (
            <>
              {showViewChanges && (
                <ContextMenuItem onClick={handleViewChanges}>
                  <FileDiff className="mr-2 h-4 w-4 text-blue-500" />
                  View Changes
                </ContextMenuItem>
              )}
              {showStage && (
                <ContextMenuItem onClick={handleStage}>
                  <GitBranch className="mr-2 h-4 w-4 text-green-500" />
                  Stage File
                </ContextMenuItem>
              )}
              {showUnstage && (
                <ContextMenuItem onClick={handleUnstage}>
                  <GitBranch className="mr-2 h-4 w-4 text-yellow-500" />
                  Unstage File
                </ContextMenuItem>
              )}
              {showDiscard && (
                <ContextMenuItem
                  onClick={handleDiscard}
                  className={showDiscardConfirm ? 'text-red-500' : ''}
                >
                  <Trash2 className="mr-2 h-4 w-4 text-red-500" />
                  {showDiscardConfirm ? 'Click again to confirm' : 'Discard Changes'}
                  {showDiscardConfirm && (
                    <AlertCircle className="ml-auto h-4 w-4 text-red-500" />
                  )}
                </ContextMenuItem>
              )}
              {showGitignore && (
                <ContextMenuItem onClick={handleAddToGitignore}>
                  <EyeOff className="mr-2 h-4 w-4 text-gray-500" />
                  Add to .gitignore
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
            </>
          )}

        {/* File actions */}
        <ContextMenuItem onClick={handleOpenInEditor}>
          <FileCode className="mr-2 h-4 w-4" />
          Open in Editor
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInFinder}>
          <FolderOpen className="mr-2 h-4 w-4" />
          {node.isDirectory ? 'Open in Finder' : 'Reveal in Finder'}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Copy actions */}
        <ContextMenuItem onClick={handleCopyPath}>
          <Copy className="mr-2 h-4 w-4" />
          Copy Path
          <ContextMenuShortcut>Abs</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyRelativePath}>
          <Copy className="mr-2 h-4 w-4" />
          Copy Relative Path
          <ContextMenuShortcut>Rel</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>

      {/* Diff Modal */}
      {showViewChanges && (
        <DiffModal
          isOpen={showDiffModal}
          onClose={() => setShowDiffModal(false)}
          worktreePath={worktreePath}
          filePath={node.relativePath}
          fileName={node.name}
          staged={staged || false}
          isUntracked={gitStatus === '?'}
        />
      )}
    </>
  )
}
