# Project Reordering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add drag-and-drop reordering of projects in the sidebar with localStorage persistence, following the exact same pattern already used for worktree reordering.

**Architecture:** Store a `projectOrder: string[]` (array of project IDs) in the project store, persisted to localStorage via the existing Zustand `persist` middleware. When a custom order exists, `loadProjects` applies it instead of the default `last_accessed_at` sort. The UI uses native HTML5 drag-and-drop on `ProjectList` / `ProjectItem`, identical to `WorktreeList` / `WorktreeItem`.

**Tech Stack:** React 19, Zustand 5 (persist middleware), native HTML5 DnD, TypeScript

---

### Task 1: Add ordering state and `reorderProjects` action to the store

**Files:**

- Modify: `src/renderer/src/stores/useProjectStore.ts`

**Step 1: Add state fields and action signatures to the interface**

Add these fields to the `ProjectState` interface (after `editingProjectId`, around line 28):

```ts
// Ordering
projectOrder: string[] // persisted custom order of project IDs
```

Add this action signature (after `refreshLanguage`, around line 40):

```ts
reorderProjects: (fromIndex: number, toIndex: number) => void
```

**Step 2: Add initial state**

In the store creation block (after `editingProjectId: null`, around line 52), add:

```ts
projectOrder: [],
```

**Step 3: Modify `loadProjects` to apply custom order**

Replace the current sorting logic in `loadProjects` (lines 58-63) with:

```ts
const projects = await window.db.project.getAll()
const customOrder = get().projectOrder

if (customOrder.length > 0) {
  // Apply custom order: ordered projects first, then any new ones at the end
  const ordered: typeof projects = []
  for (const id of customOrder) {
    const p = projects.find((proj) => proj.id === id)
    if (p) ordered.push(p)
  }
  // Append projects not in custom order (newly added)
  for (const p of projects) {
    if (!customOrder.includes(p.id)) ordered.push(p)
  }
  set({ projects: ordered, isLoading: false })
} else {
  // Default: sort by last_accessed_at descending
  const sortedProjects = projects.sort(
    (a, b) => new Date(b.last_accessed_at).getTime() - new Date(a.last_accessed_at).getTime()
  )
  set({ projects: sortedProjects, isLoading: false })
}
```

**Step 4: Implement `reorderProjects` action**

Add before the closing `})` of the store actions (before `})` around line 235):

```ts
// Reorder projects via drag-and-drop
reorderProjects: (fromIndex: number, toIndex: number) => {
  set((state) => {
    const currentProjects = state.projects

    // Build order array from current state or existing custom order
    let order: string[]
    if (state.projectOrder.length > 0) {
      order = [...state.projectOrder]
      // Add any new projects not in order
      for (const p of currentProjects) {
        if (!order.includes(p.id)) order.push(p.id)
      }
      // Remove stale IDs
      order = order.filter((id) => currentProjects.some((p) => p.id === id))
    } else {
      order = currentProjects.map((p) => p.id)
    }

    if (fromIndex < 0 || fromIndex >= order.length || toIndex < 0 || toIndex >= order.length) {
      return state
    }

    // Splice move
    const [removed] = order.splice(fromIndex, 1)
    order.splice(toIndex, 0, removed)

    // Reorder the projects array to match
    const reordered: typeof currentProjects = []
    for (const id of order) {
      const p = currentProjects.find((proj) => proj.id === id)
      if (p) reordered.push(p)
    }

    return { projectOrder: order, projects: reordered }
  })
},
```

**Step 5: Persist `projectOrder` via the existing Zustand persist config**

Update the `partialize` function (around line 241) to also include `projectOrder`:

```ts
partialize: (state) => ({
  expandedProjectIds: Array.from(state.expandedProjectIds),
  projectOrder: state.projectOrder
}),
```

Update the `merge` function (around line 245) to restore `projectOrder`:

```ts
merge: (persistedState, currentState) => ({
  ...currentState,
  expandedProjectIds: new Set(
    (persistedState as { expandedProjectIds?: string[] })?.expandedProjectIds ?? []
  ),
  projectOrder: (persistedState as { projectOrder?: string[] })?.projectOrder ?? []
})
```

**Step 6: Update `removeProject` to clean up order**

In the `removeProject` action (around line 128), add to the state update:

```ts
projectOrder: state.projectOrder.filter((pid) => pid !== id),
```

**Step 7: Run lint**

Run: `pnpm lint`
Expected: No errors related to the store changes.

**Step 8: Commit**

```bash
git add src/renderer/src/stores/useProjectStore.ts
git commit -m "feat: add project reorder state and action with localStorage persistence"
```

---

### Task 2: Add drag-and-drop to `ProjectList`

**Files:**

- Modify: `src/renderer/src/components/projects/ProjectList.tsx`

**Step 1: Add drag state and handlers**

Import `useCallback` (it's not currently imported). Add drag state and handlers inside the component:

```ts
const { projects, isLoading, error, loadProjects, reorderProjects } = useProjectStore()
const [filterQuery, setFilterQuery] = useState('')

// Drag state for project reordering
const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null)
const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null)

const handleDragStart = useCallback((e: React.DragEvent, projectId: string) => {
  setDraggedProjectId(projectId)
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', projectId)
}, [])

const handleDragOver = useCallback(
  (e: React.DragEvent, projectId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (draggedProjectId && draggedProjectId !== projectId) {
      setDragOverProjectId(projectId)
    }
  },
  [draggedProjectId]
)

const handleDrop = useCallback(
  (e: React.DragEvent, targetProjectId: string) => {
    e.preventDefault()
    if (!draggedProjectId || draggedProjectId === targetProjectId) return

    const fromIndex = projects.findIndex((p) => p.id === draggedProjectId)
    const toIndex = projects.findIndex((p) => p.id === targetProjectId)

    if (fromIndex !== -1 && toIndex !== -1) {
      reorderProjects(fromIndex, toIndex)
    }

    setDraggedProjectId(null)
    setDragOverProjectId(null)
  },
  [draggedProjectId, projects, reorderProjects]
)

const handleDragEnd = useCallback(() => {
  setDraggedProjectId(null)
  setDragOverProjectId(null)
}, [])
```

**Step 2: Pass drag props to `ProjectItem`**

Update the `ProjectItem` render call (around line 80) to pass drag props:

```tsx
{
  filteredProjects.map((item) => (
    <ProjectItem
      key={item.project.id}
      project={item.project}
      nameMatchIndices={item.nameMatch?.matched ? item.nameMatch.indices : undefined}
      pathMatchIndices={
        item.pathMatch?.matched && !item.nameMatch?.matched ? item.pathMatch.indices : undefined
      }
      isDragging={draggedProjectId === item.project.id}
      isDragOver={dragOverProjectId === item.project.id}
      onDragStart={(e) => handleDragStart(e, item.project.id)}
      onDragOver={(e) => handleDragOver(e, item.project.id)}
      onDrop={(e) => handleDrop(e, item.project.id)}
      onDragEnd={handleDragEnd}
    />
  ))
}
```

**Step 3: Disable drag during filtering**

Drag-and-drop should be disabled when the user is filtering (reordering a filtered subset doesn't make sense). Gate the drag props:

```tsx
const isDraggable = !filterQuery.trim()
```

And conditionally pass drag props:

```tsx
isDragging={isDraggable && draggedProjectId === item.project.id}
isDragOver={isDraggable && dragOverProjectId === item.project.id}
onDragStart={isDraggable ? (e) => handleDragStart(e, item.project.id) : undefined}
onDragOver={isDraggable ? (e) => handleDragOver(e, item.project.id) : undefined}
onDrop={isDraggable ? (e) => handleDrop(e, item.project.id) : undefined}
onDragEnd={isDraggable ? handleDragEnd : undefined}
```

**Step 4: Commit**

```bash
git add src/renderer/src/components/projects/ProjectList.tsx
git commit -m "feat: add drag-and-drop handlers to ProjectList for project reordering"
```

---

### Task 3: Accept drag props in `ProjectItem`

**Files:**

- Modify: `src/renderer/src/components/projects/ProjectItem.tsx`

**Step 1: Extend `ProjectItemProps` interface**

Add drag-related props to the interface (around line 46):

```ts
interface ProjectItemProps {
  project: Project
  nameMatchIndices?: number[]
  pathMatchIndices?: number[]
  isDragging?: boolean
  isDragOver?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
}
```

**Step 2: Destructure new props in the component**

Update the destructuring (around line 52):

```ts
export function ProjectItem({
  project,
  nameMatchIndices,
  pathMatchIndices,
  isDragging,
  isDragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: ProjectItemProps): React.JSX.Element {
```

**Step 3: Add drag attributes and visual feedback to the root div**

Update the inner clickable div (the one with the `cn()` call around line 192) to include drag attributes and visual cues:

```tsx
<div
  className={cn(
    'group flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer transition-colors',
    isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
    isDragging && 'opacity-50',
    isDragOver && 'border-t-2 border-primary'
  )}
  draggable={!!onDragStart && !isEditing}
  onDragStart={onDragStart}
  onDragOver={onDragOver}
  onDrop={onDrop}
  onDragEnd={onDragEnd}
  onClick={handleClick}
  data-testid={`project-item-${project.id}`}
>
```

Key details:

- `draggable` is only true when drag handlers are provided AND the project isn't being renamed
- `isDragging` gives 50% opacity to the dragged item
- `isDragOver` shows a top border indicator where the drop will place the item

**Step 4: Run lint and verify**

Run: `pnpm lint`
Expected: No errors.

**Step 5: Commit**

```bash
git add src/renderer/src/components/projects/ProjectItem.tsx
git commit -m "feat: add drag attributes and visual feedback to ProjectItem"
```

---

### Task 4: Manual testing and edge-case verification

**Step 1: Start dev server**

Run: `pnpm dev`

**Step 2: Test basic drag-and-drop**

1. Ensure you have 2+ projects in the sidebar
2. Drag a project and drop it on another — verify the order changes
3. Refresh the app (Cmd+R) — verify the order persists
4. Quit and relaunch — verify the order still persists

**Step 3: Test edge cases**

1. **Filter active:** Type in the project filter — verify items are NOT draggable (no drag cursor, no reorder)
2. **Editing name:** Start editing a project name — verify the item is NOT draggable
3. **Add new project:** Add a new project — verify it appears at the top of the list (prepended)
4. **Remove project:** Remove a project — verify remaining order is preserved, no gaps or errors
5. **Single project:** With only 1 project, verify no drag cursor appears (nothing to reorder)

**Step 4: Verify localStorage**

Open DevTools > Application > Local Storage > look for `hive-projects` key. Verify it contains a `projectOrder` array with the correct IDs in the reordered sequence.

**Step 5: Commit any fixes**

If any issues were found and fixed, commit them.

---

## Design Decisions

### Why localStorage (Zustand persist) instead of a database column?

1. **Consistency with existing patterns** — worktree reordering and session tab reordering both use localStorage. Using the same approach keeps the codebase consistent.
2. **No schema migration needed** — avoids adding a v8 migration for a `sort_order` column, avoids needing new IPC channels or database methods.
3. **Simpler** — order is purely a UI preference, not business data. localStorage is the right tier for this.
4. **Already wired up** — the project store already uses Zustand `persist` with `partialize`/`merge`, so we just add one more field.

### Why disable drag during filtering?

Reordering a filtered subset would produce confusing results — the user sees 3 of 10 projects and drags to reorder, but the other 7 are invisible. The resulting order would be unpredictable. Better to disable it.

### New projects go to the top

When `addProject` prepends to the `projects` array (`[project, ...state.projects]`), it naturally appears at position 0. The custom order is only established when the user first drags. Until then, the default `last_accessed_at` sort applies. Once a custom order exists, new projects are appended at the end by `loadProjects` (the "append projects not in custom order" logic).
