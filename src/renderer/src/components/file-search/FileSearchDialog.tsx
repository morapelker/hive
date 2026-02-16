import { useEffect, useCallback, useMemo, useRef } from 'react'
import { Command } from 'cmdk'
import { Search } from 'lucide-react'
import { useFileSearchStore } from '@/stores/useFileSearchStore'
import { useFileTreeStore } from '@/stores'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useWorktreeStore } from '@/stores'
import { FileIcon } from '@/components/file-tree/FileIcon'
import { flattenTree, scoreMatch } from '@/lib/file-search-utils'
import type { FileTreeNode } from '@/lib/file-search-utils'

const MAX_RESULTS = 50
const EMPTY_TREE: FileTreeNode[] = []

export function FileSearchDialog() {
  const { isOpen, searchQuery, selectedIndex, close, setSearchQuery, setSelectedIndex } =
    useFileSearchStore()

  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Get the selected worktree path
  const selectedWorktreePath = useMemo(() => {
    if (!selectedWorktreeId) return null
    for (const [, worktrees] of worktreesByProject) {
      const worktree = worktrees.find((w) => w.id === selectedWorktreeId)
      if (worktree) return worktree.path
    }
    return null
  }, [selectedWorktreeId, worktreesByProject])

  // Get file tree for current worktree
  const fileTree = useFileTreeStore(
    (state) =>
      (selectedWorktreePath ? state.fileTreeByWorktree.get(selectedWorktreePath) : undefined) ??
      EMPTY_TREE
  )

  // Flatten the file tree into a searchable list
  const allFiles = useMemo(() => flattenTree(fileTree), [fileTree])

  const loadFileTree = useFileTreeStore((state) => state.loadFileTree)

  // Load file tree on open if not already loaded
  useEffect(() => {
    if (isOpen && selectedWorktreePath && fileTree === EMPTY_TREE) {
      loadFileTree(selectedWorktreePath)
    }
  }, [isOpen, selectedWorktreePath, fileTree, loadFileTree])

  // Filter and score files based on search query
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) {
      // Show first N files sorted alphabetically when no query
      return allFiles
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        .slice(0, MAX_RESULTS)
    }

    return allFiles
      .map((file) => ({ ...file, score: scoreMatch(searchQuery, file) }))
      .filter((file) => file.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
  }, [allFiles, searchQuery])

  // Auto-focus input on open
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure DOM is ready
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [isOpen])

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen || !listRef.current) return
    const selectedItem = listRef.current.querySelector('[data-selected="true"]')
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' })
    }
  }, [isOpen, selectedIndex])

  // Handle keyboard navigation
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        const maxIndex = Math.max(0, filteredFiles.length - 1)
        useFileSearchStore.getState().moveSelection('down', maxIndex)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const maxIndex = Math.max(0, filteredFiles.length - 1)
        useFileSearchStore.getState().moveSelection('up', maxIndex)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const file = filteredFiles[selectedIndex]
        if (file) {
          handleFileSelect(file.path, file.name)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, filteredFiles, selectedIndex, close])

  // Open file in file viewer
  const handleFileSelect = useCallback(
    (path: string, name: string) => {
      if (!selectedWorktreeId) return
      useFileViewerStore.getState().openFile(path, name, selectedWorktreeId)
      close()
    },
    [selectedWorktreeId, close]
  )

  // Close on overlay click
  const handleOverlayClick = useCallback(() => {
    close()
  }, [close])

  if (!isOpen) return null

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/50 z-50"
        onClick={handleOverlayClick}
        data-testid="file-search-overlay"
      />

      {/* File search dialog */}
      <div
        className="fixed left-1/2 top-[20%] -translate-x-1/2 w-full max-w-xl z-50"
        data-testid="file-search-dialog"
        role="dialog"
        aria-label="File search"
        aria-modal="true"
      >
        <Command
          className="rounded-lg border border-border bg-popover shadow-xl overflow-hidden"
          shouldFilter={false}
          label="File search"
        >
          {/* Search input */}
          <div className="flex items-center border-b border-border px-3">
            <Search className="w-4 h-4 text-muted-foreground mr-2" />
            <Command.Input
              ref={inputRef}
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder="Search files by name or path..."
              className="flex-1 h-12 bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground"
              autoFocus
              data-testid="file-search-input"
            />
          </div>

          {/* Results list */}
          <Command.List ref={listRef} className="max-h-[300px] overflow-y-auto p-2">
            {filteredFiles.length === 0 && (
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                No files found.
              </Command.Empty>
            )}

            {filteredFiles.map((file, index) => {
              const isSelected = index === selectedIndex
              return (
                <Command.Item
                  key={file.path}
                  value={file.path}
                  onSelect={() => handleFileSelect(file.path, file.name)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-sm transition-colors duration-100 ${
                    isSelected ? 'bg-accent' : ''
                  }`}
                  data-selected={isSelected}
                  data-testid="file-search-item"
                >
                  <FileIcon
                    name={file.name}
                    extension={file.extension}
                    isDirectory={false}
                    className="flex-shrink-0"
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate font-medium">{file.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {file.relativePath}
                    </span>
                  </div>
                </Command.Item>
              )
            })}
          </Command.List>

          {/* Footer with keyboard hints */}
          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-4">
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">↑↓</kbd>{' '}
                navigate
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">↵</kbd> open
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">esc</kbd>{' '}
                close
              </span>
            </div>
            <span>{filteredFiles.length} files</span>
          </div>
        </Command>
      </div>
    </>
  )
}
