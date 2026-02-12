import { useState, useCallback, useRef } from 'react'
import { LayoutGrid, Plus, Pencil, Palette, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores'
import { getSpaceIcon } from './SpaceIconPicker'
import { SpaceIconPicker } from './SpaceIconPicker'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'

export function SpacesTabBar(): React.JSX.Element {
  const spaces = useSpaceStore((s) => s.spaces)
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId)
  const setActiveSpace = useSpaceStore((s) => s.setActiveSpace)
  const createSpace = useSpaceStore((s) => s.createSpace)
  const updateSpace = useSpaceStore((s) => s.updateSpace)
  const deleteSpace = useSpaceStore((s) => s.deleteSpace)
  const reorderSpaces = useSpaceStore((s) => s.reorderSpaces)

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createIconType, setCreateIconType] = useState('default')
  const [createIconValue, setCreateIconValue] = useState('Folder')

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false)
  const [editSpaceId, setEditSpaceId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editIconType, setEditIconType] = useState('default')
  const [editIconValue, setEditIconValue] = useState('Folder')

  // Drag state
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const dragCounterRef = useRef(0)

  const handleCreate = useCallback(async () => {
    const name = createName.trim()
    if (!name) return
    await createSpace(name, createIconType, createIconValue)
    setCreateOpen(false)
    setCreateName('')
    setCreateIconType('default')
    setCreateIconValue('Folder')
  }, [createName, createIconType, createIconValue, createSpace])

  const handleOpenEdit = useCallback((space: Space) => {
    setEditSpaceId(space.id)
    setEditName(space.name)
    setEditIconType(space.icon_type)
    setEditIconValue(space.icon_value)
    setEditOpen(true)
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (!editSpaceId) return
    const name = editName.trim()
    if (!name) return
    await updateSpace(editSpaceId, {
      name,
      icon_type: editIconType,
      icon_value: editIconValue
    })
    setEditOpen(false)
  }, [editSpaceId, editName, editIconType, editIconValue, updateSpace])

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteSpace(id)
    },
    [deleteSpace]
  )

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (draggedIndex !== null && draggedIndex !== index) {
        setDragOverIndex(index)
      }
    },
    [draggedIndex]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent, targetIndex: number) => {
      e.preventDefault()
      if (draggedIndex !== null && draggedIndex !== targetIndex) {
        reorderSpaces(draggedIndex, targetIndex)
      }
      setDraggedIndex(null)
      setDragOverIndex(null)
      dragCounterRef.current = 0
    },
    [draggedIndex, reorderSpaces]
  )

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null)
    setDragOverIndex(null)
    dragCounterRef.current = 0
  }, [])

  return (
    <>
      <div
        className="border-t flex items-center gap-0.5 px-1.5 py-1 overflow-x-auto scrollbar-none"
        data-testid="spaces-tab-bar"
      >
        {/* "All" tab */}
        <button
          type="button"
          className={cn(
            'flex items-center justify-center h-6 w-6 rounded-md transition-colors cursor-pointer shrink-0',
            activeSpaceId === null
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
          )}
          onClick={() => setActiveSpace(null)}
          title="All projects"
          data-testid="space-tab-all"
        >
          <LayoutGrid className="h-3 w-3" />
        </button>

        {/* Space tabs */}
        {spaces.map((space, index) => {
          const Icon = getSpaceIcon(space.icon_value)
          const isActive = activeSpaceId === space.id
          return (
            <ContextMenu key={space.id}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex items-center justify-center h-6 w-6 rounded-md transition-colors cursor-pointer shrink-0',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    draggedIndex === index && 'opacity-50',
                    dragOverIndex === index && 'ring-1 ring-primary'
                  )}
                  onClick={() => setActiveSpace(space.id)}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  title={space.name}
                  data-testid={`space-tab-${space.id}`}
                >
                  <Icon className="h-3 w-3" />
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-40">
                <ContextMenuItem onClick={() => handleOpenEdit(space)}>
                  <Pencil className="h-4 w-4 mr-2" />
                  Rename
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleOpenEdit(space)}>
                  <Palette className="h-4 w-4 mr-2" />
                  Change Icon
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() => handleDelete(space.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}

        {/* Add space button */}
        <button
          type="button"
          className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors cursor-pointer shrink-0"
          onClick={() => setCreateOpen(true)}
          title="Create space"
          data-testid="space-add-button"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>

      {/* Create Space Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Space</DialogTitle>
            <DialogDescription>Organize your projects into spaces.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. Work, Side Projects"
                className="mt-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate()
                }}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Icon</label>
              <div className="mt-1">
                <SpaceIconPicker
                  selectedValue={createIconValue}
                  onSelect={(type, value) => {
                    setCreateIconType(type)
                    setCreateIconValue(value)
                  }}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={!createName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Space Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit Space</DialogTitle>
            <DialogDescription>Update the space name or icon.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="mt-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveEdit()
                }}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Icon</label>
              <div className="mt-1">
                <SpaceIconPicker
                  selectedValue={editIconValue}
                  onSelect={(type, value) => {
                    setEditIconType(type)
                    setEditIconValue(value)
                  }}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveEdit} disabled={!editName.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
