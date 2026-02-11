import { Copy, Check, FolderOpen } from 'lucide-react'
import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

function CursorIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 466.73 532.09" className={className} fill="currentColor">
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </svg>
  )
}

function GhosttyIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 27 32" className={className} fill="none">
      <path
        fill="#3551F3"
        d="M20.395 32a6.35 6.35 0 0 1-3.516-1.067A6.355 6.355 0 0 1 13.362 32c-1.249 0-2.48-.375-3.516-1.067A6.265 6.265 0 0 1 6.372 32h-.038a6.255 6.255 0 0 1-4.5-1.906 6.377 6.377 0 0 1-1.836-4.482v-12.25C0 5.995 5.994 0 13.362 0c7.369 0 13.363 5.994 13.363 13.363v12.253c0 3.393-2.626 6.192-5.978 6.375-.117.007-.234.009-.352.009Z"
      />
      <path
        fill="#000"
        d="M20.395 30.593a4.932 4.932 0 0 1-3.08-1.083.656.656 0 0 0-.42-.145.784.784 0 0 0-.487.176 4.939 4.939 0 0 1-3.046 1.055 4.939 4.939 0 0 1-3.045-1.055.751.751 0 0 0-.942 0 4.883 4.883 0 0 1-3.01 1.055h-.033a4.852 4.852 0 0 1-3.49-1.482 4.982 4.982 0 0 1-1.436-3.498V13.367c0-6.597 5.364-11.96 11.957-11.96 6.592 0 11.956 5.363 11.956 11.956v12.253c0 2.645-2.042 4.827-4.65 4.97a5.342 5.342 0 0 1-.274.007Z"
      />
      <path
        fill="#fff"
        d="M23.912 13.363v12.253c0 1.876-1.447 3.463-3.32 3.566a3.503 3.503 0 0 1-2.398-.769c-.778-.626-1.873-.598-2.658.021a3.5 3.5 0 0 1-2.176.753 3.494 3.494 0 0 1-2.173-.753 2.153 2.153 0 0 0-2.684 0 3.498 3.498 0 0 1-2.15.753c-1.948.014-3.54-1.627-3.54-3.575v-12.25c0-5.825 4.724-10.549 10.55-10.549 5.825 0 10.549 4.724 10.549 10.55Z"
      />
      <path
        fill="#000"
        d="m11.28 12.437-3.93-2.27a1.072 1.072 0 0 0-1.463.392 1.072 1.072 0 0 0 .391 1.463l2.326 1.343-2.326 1.343a1.072 1.072 0 0 0 1.071 1.855l3.932-2.27a1.071 1.071 0 0 0 0-1.854v-.002ZM20.182 12.291h-5.164a1.071 1.071 0 1 0 0 2.143h5.164a1.071 1.071 0 1 0 0-2.143Z"
      />
    </svg>
  )
}

export function QuickActions(): React.JSX.Element | null {
  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()
  const [copied, setCopied] = useState(false)

  const worktreePath = (() => {
    if (!selectedWorktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const worktree = worktrees.find((w) => w.id === selectedWorktreeId)
      if (worktree) return worktree.path
    }
    return null
  })()

  const disabled = !worktreePath

  const handleAction = useCallback(
    async (actionId: string) => {
      if (!worktreePath) return
      try {
        if (actionId === 'copy-path') {
          await window.projectOps.copyToClipboard(worktreePath)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } else if (actionId === 'finder') {
          await window.projectOps.showInFolder(worktreePath)
        } else {
          await window.systemOps.openInApp(actionId, worktreePath)
        }
      } catch (error) {
        console.error('Quick action failed:', error)
      }
    },
    [worktreePath]
  )

  return (
    <div className="flex items-center gap-3" data-testid="quick-actions">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
        disabled={disabled}
        onClick={() => handleAction('cursor')}
        title="Open in Cursor"
        data-testid="quick-action-cursor"
      >
        <CursorIcon className="h-3.5 w-3.5" />
        <span>Cursor</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
        disabled={disabled}
        onClick={() => handleAction('ghostty')}
        title="Open in Ghostty"
        data-testid="quick-action-ghostty"
      >
        <GhosttyIcon className="h-3.5 w-3.5" />
        <span>Ghostty</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
        disabled={disabled}
        onClick={() => handleAction('copy-path')}
        title="Copy Path"
        data-testid="quick-action-copy-path"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        <span>{copied ? 'Copied' : 'Copy Path'}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1.5 text-xs cursor-pointer"
        disabled={disabled}
        onClick={() => handleAction('finder')}
        title="Reveal in Finder"
        data-testid="quick-action-finder"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        <span>Finder</span>
      </Button>
    </div>
  )
}
