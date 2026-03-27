# Search Mode Force-Expand Design

**Date:** 2026-03-17
**Status:** Approved
**Scope:** Single file, two-line change

## Problem

When the sidebar filter is active (`filterQuery.length > 0`), the hint system assigns 2-char keyboard
codes to visible worktrees and project plus buttons. However, if a project is collapsed, its worktrees
are not rendered — so they receive no hint badges and cannot be keyboard-navigated. Keyboard users
lose access to worktrees in collapsed projects while searching.

## Solution

Force all projects to appear expanded while search mode is active, then silently restore their
previous collapsed/expanded state when the filter clears.

## Design

### Approach: Computed expansion via `useHintStore`

`ProjectItem` already computes `isExpanded` locally from `expandedProjectIds.has(project.id)`.
We add a second condition: if hint mode is active (search mode), the project is always expanded.

`useHintStore.hintMap.size > 0` is a reliable proxy for "filter is active" — hints are populated
by `ProjectList`'s effect when `filterQuery` is non-empty, and cleared when it empties or on unmount.

```ts
// ProjectItem.tsx — two lines added/changed
const isSearchMode = useHintStore(s => s.hintMap.size > 0)
const isExpanded = isSearchMode || expandedProjectIds.has(project.id)
```

### Why this approach

- **Zero store mutations:** `expandedProjectIds` is never touched during search. The user's
  preferred collapsed/expanded layout is preserved untouched.
- **Restoration is implicit:** When `clearHints()` fires (filter emptied or component unmounts),
  `hintMap.size` drops to 0, `isSearchMode` becomes false, and each project immediately reflects
  its actual `expandedProjectIds` state — no snapshot, no restore action needed.
- **No prop drilling:** `useHintStore` is already imported in `ProjectItem` for badge rendering.
  The new selector costs one extra subscription, which Zustand batches efficiently.
- **Chevron behaviour while searching:** Clicking collapse while the filter is active calls
  `toggleProjectExpanded` (which removes the id from `expandedProjectIds`), but `isSearchMode`
  overrides it so the project stays visually open. This is intentional — collapsing during search
  would hide worktrees and break the hint system.

## Files Changed

| File | Change |
|------|--------|
| `src/renderer/src/components/projects/ProjectItem.tsx` | Add `isSearchMode` selector; update `isExpanded` computation |

## Files NOT Changed

- `useProjectStore.ts` — no new actions needed
- `useHintStore.ts` — no changes needed
- `ProjectList.tsx` — no changes needed
- `ProjectFilter.tsx` — no changes needed

## Behaviour Summary

| State | `hintMap.size` | `isExpanded` result |
|-------|---------------|---------------------|
| No filter | 0 | `expandedProjectIds.has(id)` (user's saved state) |
| Filter active, project was expanded | > 0 | `true` (already was) |
| Filter active, project was collapsed | > 0 | `true` (forced open) |
| Filter cleared | 0 | `expandedProjectIds.has(id)` (restored automatically) |

## Testing

1. Collapse one or more projects in the sidebar
2. Press ⌘G, type filter text — all projects should expand and show worktree hint badges
3. Clear the filter (Escape or backspace) — collapsed projects should snap back to collapsed
4. Verify hint badges appear on worktrees that were previously hidden in collapsed projects
