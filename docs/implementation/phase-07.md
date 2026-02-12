# Hive Phase 7 Implementation Plan

This document outlines the implementation plan for Hive Phase 7, focusing on project filtering, branch duplication, code review triggers, inline diff viewing, running-process animations, UX polish, and model variant selection.

---

## Overview

The implementation is divided into **8 focused sessions**, each with:
- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 7 builds upon Phase 6** — all Phase 6 infrastructure (rich tool rendering, context indicator, notifications, queued messages, image attachments, slash commands, tab persistence, session badges) is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 7)
```
test/
├── phase-7/
│   ├── session-1/
│   │   └── quick-wins.test.ts
│   ├── session-2/
│   │   └── project-filter.test.ts
│   ├── session-3/
│   │   └── branch-duplication.test.ts
│   ├── session-4/
│   │   └── code-review.test.ts
│   ├── session-5/
│   │   └── inline-diff-viewer.test.ts
│   ├── session-6/
│   │   └── model-variants.test.ts
│   ├── session-7/
│   │   └── integration-polish.test.ts
│   └── session-8/
│       └── e2e-verification.test.ts
```

### New Dependencies
```json
// No new dependencies required
```

All features use existing packages: React, Zustand, diff2html, simple-git, lucide-react, sonner.

---

## Session 1: Quick Wins — Auto-Focus, Clear Button, Pulse Animation

### Objectives
- Auto-focus the session textarea when entering/switching sessions
- Add a clear button to the run pane output
- Show an ECG pulse animation on worktrees with a live running process

### Tasks

#### Auto-Focus Session Input
1. In `src/renderer/src/components/sessions/SessionView.tsx`:
   - Locate the existing `textareaRef` ref
   - Add a `useEffect` that focuses the textarea when the active session changes:
     ```typescript
     useEffect(() => {
       if (textareaRef.current) {
         requestAnimationFrame(() => {
           textareaRef.current?.focus()
         })
       }
     }, [activeSessionId])
     ```
   - `requestAnimationFrame` ensures the DOM is settled after tab switch animations

#### Clear Button in Run Pane
2. In `src/renderer/src/components/layout/RunTab.tsx`:
   - Import `Trash2` from `lucide-react`
   - Add a Clear button in the status bar (the `<div>` with `items-center justify-between`):
     ```typescript
     {runOutput.length > 0 && (
       <button
         onClick={() => clearRunOutput(worktreeId!)}
         className="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent transition-colors"
         data-testid="clear-button"
       >
         <Trash2 className="h-3 w-3" />
         Clear
       </button>
     )}
     ```
   - Place it in the right side button group, before the Run/Stop/Restart buttons
   - `clearRunOutput` is already destructured from `useScriptStore.getState()` on line 29

#### Pulse Animation
3. Create `src/renderer/src/components/worktrees/PulseAnimation.tsx`:
   - Small SVG component rendering an ECG-style sine wave:
     ```typescript
     import { cn } from '@/lib/utils'

     interface PulseAnimationProps {
       className?: string
     }

     export function PulseAnimation({ className }: PulseAnimationProps): React.JSX.Element {
       return (
         <svg
           className={cn('overflow-hidden', className)}
           viewBox="0 0 24 12"
           width="16"
           height="12"
         >
           <path
             d="M0,6 Q3,6 4,2 Q5,-2 6,6 Q7,14 8,6 Q9,6 12,6 Q15,6 16,2 Q17,-2 18,6 Q19,14 20,6 Q21,6 24,6"
             fill="none"
             stroke="currentColor"
             strokeWidth="1.5"
             className="animate-ecg-travel"
           />
         </svg>
       )
     }
     ```
   - Add the CSS keyframes — either inline via Tailwind `@keyframes` in the component or in a global CSS snippet:
     ```css
     @keyframes ecg-travel {
       to { stroke-dashoffset: -24; }
     }
     .animate-ecg-travel {
       stroke-dasharray: 24;
       stroke-dashoffset: 0;
       animation: ecg-travel 2s linear infinite;
     }
     ```
   - May need to add the animation to Tailwind config or use a `<style>` tag

4. In `src/renderer/src/components/worktrees/WorktreeItem.tsx`:
   - Import `useScriptStore` and `PulseAnimation`
   - Subscribe to the run state for this worktree:
     ```typescript
     const isRunProcessAlive = useScriptStore(
       (s) => s.scriptStates[worktree.id]?.runRunning ?? false
     )
     ```
   - In the icon section (lines 136-142), add a condition for `isRunProcessAlive`:
     ```typescript
     {isRunProcessAlive ? (
       <PulseAnimation className="h-3.5 w-3.5 text-green-500 shrink-0" />
     ) : worktreeStatus === 'working' ? (
       <Loader2 className="h-3.5 w-3.5 text-primary shrink-0 animate-spin" />
     ) : worktree.is_default ? (
       <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
     ) : (
       <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
     )}
     ```
   - Run process takes priority over AI working status visually

### Key Files
- `src/renderer/src/components/sessions/SessionView.tsx` — auto-focus
- `src/renderer/src/components/layout/RunTab.tsx` — clear button
- `src/renderer/src/components/worktrees/PulseAnimation.tsx` — **NEW**
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — pulse integration

### Definition of Done
- [ ] Entering a session auto-focuses the textarea (cursor ready for typing)
- [ ] Switching session tabs auto-focuses the new session's textarea
- [ ] Clear button appears in the run pane status bar when there is output
- [ ] Clear button hidden when there is no output
- [ ] Clicking Clear removes all run output from the pane
- [ ] ECG pulse animation renders as a smooth traveling sine wave at 60fps
- [ ] Pulse animation shown on worktree items where the run process is alive
- [ ] Pulse animation disappears when the run process stops
- [ ] AI session "working" spinner still shows when no run process is active
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

### How to Test
1. **Auto-focus**: Open the app → select a worktree → verify cursor is in the textarea. Switch session tabs → verify cursor is in the new tab's textarea.
2. **Clear button**: Run a project script → verify output appears → click Clear → verify output is gone. Verify Clear button is hidden when no output exists.
3. **Pulse animation**: Configure a run script on a project → run it → verify the worktree icon changes to a pulsing ECG animation. Stop the script → verify the icon returns to the normal branch icon.

### Testing Criteria
```typescript
// test/phase-7/session-1/quick-wins.test.ts
describe('Session 1: Quick Wins', () => {
  describe('Auto-Focus', () => {
    test('Textarea focused on session mount', () => {
      // Render SessionView with activeSessionId
      // Verify textareaRef.current === document.activeElement
    })

    test('Textarea focused on session switch', () => {
      // Render with session-A, then change to session-B
      // Verify textarea focused after switch
    })
  })

  describe('Clear Button', () => {
    test('Clear button visible when output exists', () => {
      // Set runOutput = ['line1', 'line2']
      // Render RunTab
      // Verify clear-button element present
    })

    test('Clear button hidden when no output', () => {
      // Set runOutput = []
      // Render RunTab
      // Verify clear-button element NOT present
    })

    test('Clear button clears output', () => {
      // Set runOutput = ['line1']
      // Click clear button
      // Verify clearRunOutput called with worktreeId
    })
  })

  describe('Pulse Animation', () => {
    test('PulseAnimation renders SVG', () => {
      // Render PulseAnimation
      // Verify SVG element with path present
    })

    test('Pulse shown when run process alive', () => {
      // Set scriptStates[worktreeId].runRunning = true
      // Render WorktreeItem
      // Verify PulseAnimation component rendered
      // Verify Loader2 NOT rendered
    })

    test('Spinner shown when AI working (no run process)', () => {
      // Set runRunning = false, worktreeStatus = 'working'
      // Render WorktreeItem
      // Verify Loader2 rendered, PulseAnimation NOT rendered
    })

    test('Normal icon when idle', () => {
      // Set runRunning = false, worktreeStatus = null
      // Render WorktreeItem
      // Verify GitBranch icon rendered
    })
  })
})
```

---

## Session 2: Project Filter with Subsequence Matching

### Objectives
- Create a subsequence matching utility that returns matched character indices
- Build a search input in the project sidebar
- Filter projects by name and path with match highlighting

### Tasks

1. Create `src/renderer/src/lib/subsequence-match.ts`:
   ```typescript
   export interface SubsequenceMatch {
     matched: boolean
     indices: number[]
     score: number  // lower is better (sum of gaps between consecutive matches)
   }

   export function subsequenceMatch(query: string, target: string): SubsequenceMatch {
     const q = query.toLowerCase()
     const t = target.toLowerCase()
     const indices: number[] = []
     let qi = 0
     for (let ti = 0; ti < t.length && qi < q.length; ti++) {
       if (t[ti] === q[qi]) {
         indices.push(ti)
         qi++
       }
     }
     if (qi < q.length) return { matched: false, indices: [], score: Infinity }
     let score = 0
     for (let i = 1; i < indices.length; i++) {
       score += indices[i] - indices[i - 1] - 1
     }
     return { matched: true, indices, score }
   }
   ```

2. Create `src/renderer/src/components/projects/HighlightedText.tsx`:
   ```typescript
   interface HighlightedTextProps {
     text: string
     indices: number[]
     className?: string
   }

   export function HighlightedText({ text, indices, className }: HighlightedTextProps) {
     const set = new Set(indices)
     return (
       <span className={className}>
         {text.split('').map((char, i) =>
           set.has(i)
             ? <span key={i} className="text-primary font-semibold">{char}</span>
             : <span key={i}>{char}</span>
         )}
       </span>
     )
   }
   ```

3. Create `src/renderer/src/components/projects/ProjectFilter.tsx`:
   ```typescript
   interface ProjectFilterProps {
     value: string
     onChange: (value: string) => void
   }
   ```
   - Render a text input with a `Search` icon (from lucide) and a clear button (`X` icon)
   - Placeholder: "Filter projects..."
   - Pressing Escape clears the input and blurs
   - Compact styling: `h-7 text-xs px-2` matching the sidebar aesthetic

4. In `src/renderer/src/components/projects/ProjectList.tsx`:
   - Add state: `const [filterQuery, setFilterQuery] = useState('')`
   - Render `<ProjectFilter value={filterQuery} onChange={setFilterQuery} />` above the project list
   - Compute filtered projects:
     ```typescript
     const filteredProjects = useMemo(() => {
       if (!filterQuery.trim()) return projects.map(p => ({ project: p, nameMatch: null, pathMatch: null }))

       return projects
         .map(project => ({
           project,
           nameMatch: subsequenceMatch(filterQuery, project.name),
           pathMatch: subsequenceMatch(filterQuery, project.path)
         }))
         .filter(({ nameMatch, pathMatch }) => nameMatch.matched || pathMatch.matched)
         .sort((a, b) => {
           const aScore = a.nameMatch.matched ? a.nameMatch.score : a.pathMatch.score + 1000
           const bScore = b.nameMatch.matched ? b.nameMatch.score : b.pathMatch.score + 1000
           return aScore - bScore
         })
     }, [projects, filterQuery])
     ```
   - Pass match data to `ProjectItem`:
     ```typescript
     <ProjectItem
       key={item.project.id}
       project={item.project}
       nameMatchIndices={item.nameMatch?.matched ? item.nameMatch.indices : undefined}
       pathMatchIndices={item.pathMatch?.matched && !item.nameMatch?.matched ? item.pathMatch.indices : undefined}
     />
     ```

5. In `src/renderer/src/components/projects/ProjectItem.tsx`:
   - Add optional props:
     ```typescript
     interface ProjectItemProps {
       project: Project
       nameMatchIndices?: number[]
       pathMatchIndices?: number[]
     }
     ```
   - When `nameMatchIndices` is provided, render the project name using `<HighlightedText>` instead of plain text
   - When `pathMatchIndices` is provided (matched on path but not name), show the path below the name in a small muted font with highlighted characters

### Key Files
- `src/renderer/src/lib/subsequence-match.ts` — **NEW**
- `src/renderer/src/components/projects/HighlightedText.tsx` — **NEW**
- `src/renderer/src/components/projects/ProjectFilter.tsx` — **NEW**
- `src/renderer/src/components/projects/ProjectList.tsx` — filter integration
- `src/renderer/src/components/projects/ProjectItem.tsx` — highlight rendering

### Definition of Done
- [ ] Search input visible at top of project sidebar
- [ ] Empty input shows all projects (no filtering)
- [ ] Typing filters projects using subsequence matching (not substring)
- [ ] Matched characters highlighted in project name with `text-primary font-semibold`
- [ ] If match is on path only, path shown below name with highlighted characters
- [ ] Matching is case-insensitive
- [ ] Results sorted by match quality (name matches first, then by contiguity score)
- [ ] Pressing Escape clears the filter and blurs the input
- [ ] Filter updates immediately per keystroke (no debounce)
- [ ] "orders" matches "tedooo-orders" (contiguous subsequence)
- [ ] "orders" matches "ordjjrekekqerjskjs" (spread subsequence)
- [ ] "xyz" does NOT match "tedooo-orders" (no subsequence match)
- [ ] Worktree names/paths are NOT searched
- [ ] `pnpm lint` passes

### How to Test
1. Open the app with 3+ projects added
2. Type a few letters in the filter → verify only matching projects shown
3. Type "orders" → verify projects with those letters in order are shown
4. Verify highlighted characters in matched names
5. Type something that matches a path but not a name → verify path shown below name
6. Press Escape → verify filter cleared, all projects shown
7. Verify non-matching projects are hidden

### Testing Criteria
```typescript
// test/phase-7/session-2/project-filter.test.ts
describe('Session 2: Project Filter', () => {
  describe('subsequenceMatch', () => {
    test('exact match returns indices', () => {
      const result = subsequenceMatch('abc', 'abc')
      expect(result.matched).toBe(true)
      expect(result.indices).toEqual([0, 1, 2])
      expect(result.score).toBe(0)
    })

    test('subsequence match with gaps', () => {
      const result = subsequenceMatch('ace', 'abcde')
      expect(result.matched).toBe(true)
      expect(result.indices).toEqual([0, 2, 4])
      expect(result.score).toBe(2) // gaps: (2-0-1) + (4-2-1) = 1+1
    })

    test('no match returns matched=false', () => {
      const result = subsequenceMatch('xyz', 'abcde')
      expect(result.matched).toBe(false)
      expect(result.indices).toEqual([])
    })

    test('case insensitive', () => {
      const result = subsequenceMatch('ABC', 'abcdef')
      expect(result.matched).toBe(true)
    })

    test('"orders" matches "tedooo-orders"', () => {
      const result = subsequenceMatch('orders', 'tedooo-orders')
      expect(result.matched).toBe(true)
    })

    test('"orders" matches "ordjjrekekqerjskjs"', () => {
      const result = subsequenceMatch('orders', 'ordjjrekekqerjskjs')
      expect(result.matched).toBe(true)
    })

    test('empty query matches everything', () => {
      const result = subsequenceMatch('', 'anything')
      expect(result.matched).toBe(true)
    })

    test('query longer than target does not match', () => {
      const result = subsequenceMatch('abcdef', 'abc')
      expect(result.matched).toBe(false)
    })
  })

  describe('HighlightedText', () => {
    test('renders highlighted characters at correct indices', () => {
      // Render HighlightedText with text="hello" indices=[1,3]
      // Verify chars at index 1 and 3 have text-primary class
      // Verify other chars do NOT have text-primary class
    })

    test('renders all chars normal when indices empty', () => {
      // Render HighlightedText with text="hello" indices=[]
      // Verify no chars have text-primary class
    })
  })

  describe('ProjectFilter', () => {
    test('renders search input with placeholder', () => {
      // Verify input with placeholder "Filter projects..."
    })

    test('calls onChange on input', () => {
      // Type "test", verify onChange called with "test"
    })

    test('Escape clears input', () => {
      // Type "test", press Escape
      // Verify onChange called with ""
    })
  })

  describe('ProjectList filtering', () => {
    test('all projects shown when filter empty', () => {
      // 3 projects, empty filter
      // Verify all 3 ProjectItem components rendered
    })

    test('only matching projects shown', () => {
      // Projects: ["alpha", "beta", "gamma"]
      // Filter: "al"
      // Verify only "alpha" shown
    })

    test('name match indices passed to ProjectItem', () => {
      // Filter matches project name
      // Verify ProjectItem receives nameMatchIndices prop
    })

    test('path match shown when name doesnt match', () => {
      // Project name "my-project", path "/users/test/orders-app"
      // Filter "orders"
      // Verify pathMatchIndices passed, path shown below name
    })

    test('results sorted by match quality', () => {
      // Project A: name match with score 0 (exact)
      // Project B: name match with score 5 (gaps)
      // Verify A appears before B
    })
  })
})
```

---

## Session 3: Branch Duplication

### Objectives
- Add a `duplicateWorktree()` method to the git service that clones a branch with uncommitted state
- Implement auto-versioning logic (`-v2`, `-v3`, etc.)
- Add "Duplicate" to the worktree context menu

### Tasks

1. In `src/main/services/git-service.ts`:
   - Add `duplicateWorktree()` method:
     ```typescript
     async duplicateWorktree(
       sourceBranch: string,
       sourceWorktreePath: string,
       projectName: string
     ): Promise<CreateWorktreeResult> {
       // 1. Extract base name (strip -vN suffix)
       const baseName = sourceBranch.replace(/-v\d+$/, '')

       // 2. Find next version number
       const allBranches = await this.getAllBranches()
       const versionPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-v(\\d+)$`)
       let maxVersion = 1  // means first dup will be v2
       for (const branch of allBranches) {
         const match = branch.match(versionPattern)
         if (match) {
           maxVersion = Math.max(maxVersion, parseInt(match[1], 10))
         }
       }
       const newBranchName = `${baseName}-v${maxVersion + 1}`

       // 3. Create worktree directory
       const projectWorktreesDir = this.ensureWorktreesDir(projectName)
       const worktreePath = join(projectWorktreesDir, newBranchName)

       // 4. Create worktree from source branch
       await this.git.raw(['worktree', 'add', '-b', newBranchName, worktreePath, sourceBranch])

       // 5. Capture uncommitted state via stash create (non-destructive)
       const sourceGit = simpleGit(sourceWorktreePath)
       const stashRef = (await sourceGit.raw(['stash', 'create'])).trim()

       if (stashRef) {
         // 6. Apply stash in new worktree
         const newGit = simpleGit(worktreePath)
         try {
           await newGit.raw(['stash', 'apply', stashRef])
         } catch {
           // stash apply may fail if changes conflict — log but continue
         }
       }

       // 7. Copy untracked files
       const untrackedRaw = await sourceGit.raw(['ls-files', '--others', '--exclude-standard'])
       const untrackedFiles = untrackedRaw.trim().split('\n').filter(Boolean)
       for (const file of untrackedFiles) {
         const srcPath = join(sourceWorktreePath, file)
         const destPath = join(worktreePath, file)
         // Ensure destination directory exists, then copy
         mkdirSync(dirname(destPath), { recursive: true })
         cpSync(srcPath, destPath)
       }

       return { success: true, name: newBranchName, branchName: newBranchName, path: worktreePath }
     }
     ```
   - Import `cpSync`, `mkdirSync` from `fs` and `dirname` from `path`

2. In `src/main/ipc/worktree-handlers.ts`:
   - Add `worktree:duplicate` IPC handler:
     ```typescript
     ipcMain.handle('worktree:duplicate', async (_, params: {
       projectId: string
       projectPath: string
       projectName: string
       sourceBranch: string
       sourceWorktreePath: string
     }) => {
       const gitService = createGitService(params.projectPath)
       const result = await gitService.duplicateWorktree(
         params.sourceBranch,
         params.sourceWorktreePath,
         params.projectName
       )
       if (!result.success) return { success: false, error: result.error }

       // Create database entry
       const worktree = getDatabase().createWorktree({
         project_id: params.projectId,
         name: result.name!,
         branch_name: result.branchName!,
         path: result.path!
       })

       return { success: true, worktree }
     })
     ```

3. In `src/preload/index.ts`:
   - Add `duplicate` method to `worktreeOps`:
     ```typescript
     duplicate: (params: {
       projectId: string
       projectPath: string
       projectName: string
       sourceBranch: string
       sourceWorktreePath: string
     }) => ipcRenderer.invoke('worktree:duplicate', params)
     ```

4. In `src/preload/index.d.ts`:
   - Add type declaration for `duplicate` in the `worktreeOps` interface

5. In `src/renderer/src/stores/useWorktreeStore.ts`:
   - Add `duplicateWorktree` action:
     ```typescript
     duplicateWorktree: async (
       projectId: string,
       projectPath: string,
       projectName: string,
       sourceBranch: string,
       sourceWorktreePath: string
     ) => {
       const result = await window.worktreeOps.duplicate({
         projectId, projectPath, projectName, sourceBranch, sourceWorktreePath
       })
       if (result.success && result.worktree) {
         // Reload worktrees for the project
         get().loadWorktrees(projectId)
       }
       return result
     }
     ```

6. In `src/renderer/src/components/worktrees/WorktreeItem.tsx`:
   - Add `handleDuplicate` callback:
     ```typescript
     const handleDuplicate = useCallback(async () => {
       const project = useProjectStore.getState().projects.find(p => p.id === worktree.project_id)
       if (!project) return
       const result = await useWorktreeStore.getState().duplicateWorktree(
         project.id, project.path, project.name,
         worktree.branch_name, worktree.path
       )
       if (result.success) {
         toast.success(`Duplicated to ${result.worktree?.name || 'new branch'}`)
       } else {
         toast.error(result.error || 'Failed to duplicate worktree')
       }
     }, [worktree])
     ```
   - Add "Duplicate" to both the `DropdownMenuContent` and `ContextMenuContent`:
     - Place it after "Copy Path" and before the separator/Unbranch section
     - Use `Copy` or `GitBranchPlus` icon
     - Only show for non-default worktrees (`!worktree.is_default`)

### Key Files
- `src/main/services/git-service.ts` — `duplicateWorktree()` method
- `src/main/ipc/worktree-handlers.ts` — `worktree:duplicate` handler
- `src/preload/index.ts` — expose `duplicate`
- `src/preload/index.d.ts` — types
- `src/renderer/src/stores/useWorktreeStore.ts` — store action
- `src/renderer/src/components/worktrees/WorktreeItem.tsx` — menu items

### Definition of Done
- [ ] "Duplicate" appears in worktree context menu and dropdown (for non-default worktrees)
- [ ] First duplication of `feature-auth` creates `feature-auth-v2`
- [ ] Second duplication (from any version) creates `feature-auth-v3`
- [ ] Version number scans all existing branches to find the next number
- [ ] Base name extraction strips existing `-vN` suffix correctly
- [ ] New worktree created at the correct path under the project's worktrees directory
- [ ] Uncommitted changes (staged + unstaged) copied to new worktree via `git stash create` + `git stash apply`
- [ ] Untracked files (not in .gitignore) copied to new worktree
- [ ] Database entry created for the new worktree
- [ ] Worktree list refreshes after duplication
- [ ] Success toast shown with new branch name
- [ ] Error toast shown on failure
- [ ] Default worktree does not show "Duplicate" option
- [ ] `pnpm lint` passes

### How to Test
1. Create a project with a worktree `feature-auth`
2. Make some uncommitted changes (edit a file, add a new untracked file)
3. Right-click the worktree → select "Duplicate"
4. Verify a new worktree `feature-auth-v2` appears in the list
5. Click into `feature-auth-v2` → open in terminal → verify uncommitted changes are present
6. Verify untracked files are present in the new worktree
7. Duplicate again → verify `feature-auth-v3` is created (not `feature-auth-v2-v2`)
8. Duplicate from `feature-auth-v2` → verify `feature-auth-v4` is created

### Testing Criteria
```typescript
// test/phase-7/session-3/branch-duplication.test.ts
describe('Session 3: Branch Duplication', () => {
  describe('Version naming', () => {
    test('first duplication creates -v2', () => {
      // Existing branches: ['feature-auth', 'main']
      // Duplicate feature-auth → expect 'feature-auth-v2'
    })

    test('second duplication creates -v3', () => {
      // Existing branches: ['feature-auth', 'feature-auth-v2', 'main']
      // Duplicate feature-auth → expect 'feature-auth-v3'
    })

    test('duplication from versioned branch increments globally', () => {
      // Existing branches: ['feature-auth', 'feature-auth-v2', 'main']
      // Duplicate feature-auth-v2 → expect 'feature-auth-v3'
    })

    test('base name extraction strips -vN suffix', () => {
      // 'feature-auth-v2' → base name 'feature-auth'
      // 'feature-auth-v10' → base name 'feature-auth'
      // 'my-v2-project' → base name 'my-v2-project' (v2 not at end)
    })

    test('handles branch names with special regex chars', () => {
      // Branch 'fix/auth+login' → no regex error
    })
  })

  describe('Worktree creation', () => {
    test('worktree created from source branch', () => {
      // Verify git worktree add called with sourceBranch as start point
    })

    test('database entry created', () => {
      // Verify createWorktree called with correct project_id, name, branch_name, path
    })

    test('worktree list refreshed after creation', () => {
      // Verify loadWorktrees called for the project
    })
  })

  describe('Uncommitted state', () => {
    test('stash create called on source worktree', () => {
      // Verify git stash create executed in source path
    })

    test('stash applied in new worktree when stash ref exists', () => {
      // stash create returns a ref
      // Verify git stash apply called in new worktree with ref
    })

    test('no stash apply when working tree clean', () => {
      // stash create returns empty string
      // Verify stash apply NOT called
    })

    test('untracked files copied to new worktree', () => {
      // Source has untracked files: ['new-file.ts', 'src/util.ts']
      // Verify files copied to new worktree preserving paths
    })
  })

  describe('UI', () => {
    test('Duplicate shown in context menu for non-default worktree', () => {
      // Render WorktreeItem with is_default=false
      // Verify "Duplicate" in context menu
    })

    test('Duplicate NOT shown for default worktree', () => {
      // Render WorktreeItem with is_default=true
      // Verify "Duplicate" NOT in context menu
    })

    test('success toast shown', () => {
      // Duplicate succeeds
      // Verify toast.success called
    })

    test('error toast shown on failure', () => {
      // Duplicate fails
      // Verify toast.error called
    })
  })
})
```

---

## Session 4: Code Review Button

### Objectives
- Add a "Review" button to the git status panel header
- Read the review prompt from `prompts/review.md`
- Create a new session, send the review prompt with file change context

### Tasks

1. In `src/renderer/src/components/git/GitStatusPanel.tsx`:
   - Import `FileSearch` (or `MessageSquareCode`) icon from lucide-react
   - Add a "Review" button next to the refresh button in the header:
     ```typescript
     <Button
       variant="ghost"
       size="icon"
       className="h-5 w-5"
       onClick={handleReview}
       disabled={!hasChanges || isReviewing}
       title="Review changes with AI"
       data-testid="git-review-button"
     >
       {isReviewing ? (
         <Loader2 className="h-3 w-3 animate-spin" />
       ) : (
         <FileSearch className="h-3 w-3" />
       )}
     </Button>
     ```
   - Add `isReviewing` state
   - Implement `handleReview`:
     ```typescript
     const handleReview = async () => {
       if (!worktreePath) return
       setIsReviewing(true)
       try {
         // 1. Read review prompt template
         const promptResult = await window.fileOps.readFile(
           join(/* app root */, 'prompts', 'review.md')
         )
         // Alternatively, use a dedicated IPC handler or hardcode the path

         // 2. Build file list from current git status
         const fileList = [...stagedFiles, ...modifiedFiles, ...untrackedFiles]
           .map(f => `- ${f.status}  ${f.relativePath}`)
           .join('\n')

         // 3. Construct prompt
         const prompt = `${promptResult.content || ''}\n\n---\n\nPlease review the following uncommitted changes in this worktree:\n\nChanged files:\n${fileList}\n\nFocus on: bugs, logic errors, and code quality.`

         // 4. Create new session
         // (Need worktree info and project info)
         const worktree = useWorktreeStore.getState()...
         const session = await useSessionStore.getState().createSession(...)

         // 5. Send prompt
         await window.opencodeOps.prompt(worktreePath, session.opencode_session_id, prompt)

         // 6. Navigate to new session
         useSessionStore.getState().setActiveSession(session.id)
       } finally {
         setIsReviewing(false)
       }
     }
     ```
   - The exact flow depends on how session creation and OpenCode connection work — need to connect first, then prompt
   - Use existing patterns from how sessions are created elsewhere in the app

2. Need to resolve how to read `prompts/review.md` — options:
   - Use `window.fileOps.readFile()` with the app's resource path
   - Add a dedicated IPC handler that reads from the app's `prompts/` directory
   - The path should be relative to the project root, not the worktree
   - On dev: `prompts/review.md` relative to repo root
   - On production: bundled in app resources

### Key Files
- `src/renderer/src/components/git/GitStatusPanel.tsx` — review button and handler
- `src/renderer/src/stores/useSessionStore.ts` — may need a helper for creating review sessions

### Definition of Done
- [ ] "Review" button visible in git panel header next to refresh
- [ ] Button disabled when no changes exist
- [ ] Button shows spinner while review is being set up
- [ ] Clicking creates a new session in the current worktree
- [ ] Session name is "Code Review — {branch}"
- [ ] Prompt includes contents of `prompts/review.md`
- [ ] Prompt includes list of changed files with their statuses
- [ ] New session tab activates automatically
- [ ] AI begins reviewing the changes
- [ ] `pnpm lint` passes

### How to Test
1. Open a worktree with some uncommitted changes
2. Verify the "Review" button is visible in the git panel
3. Click "Review"
4. Verify a new session tab opens with name "Code Review — {branch}"
5. Verify the AI starts analyzing the changes
6. Verify no button shown when there are zero changes

### Testing Criteria
```typescript
// test/phase-7/session-4/code-review.test.ts
describe('Session 4: Code Review', () => {
  test('Review button rendered when changes exist', () => {
    // Render GitStatusPanel with changes
    // Verify git-review-button present
  })

  test('Review button disabled when no changes', () => {
    // Render GitStatusPanel with no changes
    // Verify button disabled
  })

  test('Review button shows spinner during creation', () => {
    // Click review, during async operation
    // Verify Loader2 spinner visible
  })

  test('New session created with review name', () => {
    // Click review
    // Verify createSession called with name "Code Review — {branch}"
  })

  test('Prompt includes review template', () => {
    // Click review
    // Verify prompt sent includes review.md content
  })

  test('Prompt includes changed file list', () => {
    // Changed files: M App.tsx, A New.tsx, ? util.ts
    // Verify prompt contains file list with statuses
  })

  test('New session becomes active', () => {
    // Click review
    // Verify setActiveSession called with new session ID
  })
})
```

---

## Session 5: Inline Diff Viewer

### Objectives
- Replace the diff modal with an inline diff viewer in the main pane
- Add context expansion (show more lines around hunks)
- Add up/down navigation between diff hunks

### Tasks

1. Create `src/renderer/src/components/diff/InlineDiffViewer.tsx`:
   ```typescript
   interface InlineDiffViewerProps {
     worktreePath: string
     filePath: string
     fileName: string
     staged: boolean
     isUntracked: boolean
     onClose: () => void
   }
   ```
   - Toolbar at top: hunk nav (▲▼), view mode toggle (Unified/Split), copy button, close button
   - Main area: renders `DiffViewer` component
   - Context expansion: "Show more" buttons between hunks
   - Manages `contextLines` state (default: 3, increases by 10 on each click)
   - Fetches diff via `window.gitOps.getDiff(worktreePath, filePath, staged, isUntracked, contextLines)`

2. Add hunk navigation:
   - After diff renders, find all `.d2h-info` or `@@` marker elements
   - Store refs to each hunk marker
   - ▼ button: scroll to next hunk relative to current scroll position
   - ▲ button: scroll to previous hunk
   - Keyboard: `Alt+↓` / `Alt+↑` bindings

3. Add context expansion:
   - Maintain `contextLines` state starting at 3
   - "Show more context" button in the toolbar
   - On click: increment contextLines by 10, re-fetch diff
   - Re-renders the DiffViewer with new data

4. In `src/main/ipc/git-file-handlers.ts`:
   - Update the `getDiff` handler to accept optional `contextLines`:
     ```typescript
     ipcMain.handle('git:getDiff', async (_, { worktreePath, filePath, staged, isUntracked, contextLines }) => {
       // Use contextLines in the diff command
       const contextArg = contextLines ? `-U${contextLines}` : ''
       // Pass to git diff command
     })
     ```

5. In `src/preload/index.ts` and `src/preload/index.d.ts`:
   - Update `getDiff` signature to include optional `contextLines?: number` parameter

6. In `src/renderer/src/components/git/GitStatusPanel.tsx`:
   - Change `handleViewDiff` to open an inline diff tab instead of `DiffModal`:
     - Either use `useFileViewerStore` to set a "diff" tab
     - Or emit an event that the main pane listens for
   - Remove the `DiffModal` component rendering (or keep as fallback)

7. In `src/renderer/src/stores/useFileViewerStore.ts`:
   - Add diff tab state:
     ```typescript
     activeDiff: {
       worktreePath: string
       filePath: string
       fileName: string
       staged: boolean
       isUntracked: boolean
     } | null
     setActiveDiff: (diff: ...) => void
     clearActiveDiff: () => void
     ```

### Key Files
- `src/renderer/src/components/diff/InlineDiffViewer.tsx` — **NEW**
- `src/main/ipc/git-file-handlers.ts` — contextLines support
- `src/preload/index.ts` — update getDiff
- `src/preload/index.d.ts` — update types
- `src/renderer/src/components/git/GitStatusPanel.tsx` — open inline diff instead of modal
- `src/renderer/src/stores/useFileViewerStore.ts` — diff tab state

### Definition of Done
- [ ] Clicking a changed file in git panel opens an inline diff viewer (not a modal)
- [ ] Diff viewer renders in the main pane area
- [ ] Toolbar shows: ▲▼ nav arrows, Unified/Split toggle, Copy, Close
- [ ] ▼ scrolls to next diff hunk, ▲ scrolls to previous
- [ ] "Show more context" re-fetches diff with increased `-U{n}` context
- [ ] Default context is 3 lines, each expansion adds 10
- [ ] Unified and Split view modes work
- [ ] Copy button copies diff to clipboard
- [ ] Close button returns to the session view
- [ ] `contextLines` parameter passed through IPC to git diff command
- [ ] `pnpm lint` passes

### How to Test
1. Make changes to a file in a worktree
2. Click the file in the git status panel
3. Verify diff opens inline in the main pane (not as a modal popup)
4. Verify hunk navigation: click ▼ to jump to next change, ▲ to go back
5. Click "Show more context" → verify more lines appear around the changes
6. Toggle between Unified and Split view
7. Click Close → verify you return to the session/file view

### Testing Criteria
```typescript
// test/phase-7/session-5/inline-diff-viewer.test.ts
describe('Session 5: Inline Diff Viewer', () => {
  test('InlineDiffViewer renders diff content', () => {
    // Provide diff string
    // Verify DiffViewer rendered with content
  })

  test('toolbar shows nav arrows', () => {
    // Render InlineDiffViewer
    // Verify ▲ and ▼ buttons present
  })

  test('down arrow scrolls to next hunk', () => {
    // Diff with 3 hunks
    // Click ▼ → verify scroll position moved to hunk 2
  })

  test('up arrow scrolls to previous hunk', () => {
    // At hunk 3
    // Click ▲ → verify scroll position moved to hunk 2
  })

  test('context expansion increases contextLines', () => {
    // Initial contextLines = 3
    // Click "Show more context"
    // Verify getDiff called with contextLines=13
  })

  test('contextLines passed to IPC handler', () => {
    // Call getDiff with contextLines=20
    // Verify git command includes -U20
  })

  test('unified/split toggle works', () => {
    // Click split button
    // Verify DiffViewer receives viewMode='split'
  })

  test('copy button copies diff to clipboard', () => {
    // Click copy
    // Verify copyToClipboard called with diff string
  })

  test('close button calls onClose', () => {
    // Click close
    // Verify onClose callback called
  })

  test('file click in GitStatusPanel opens inline diff', () => {
    // Click a file in GitStatusPanel
    // Verify setActiveDiff called (not DiffModal opened)
  })
})
```

---

## Session 6: Model Variant Selection

### Objectives
- Group models by base name (stripping date suffixes) within each provider
- Show variant indicators in the dropdown
- Add Alt+T keyboard shortcut to cycle between variants of the selected model

### Tasks

1. In `src/renderer/src/components/sessions/ModelSelector.tsx`:
   - Add variant grouping utility:
     ```typescript
     function getBaseName(modelId: string): string {
       return modelId.replace(/(-\d{8,})$/, '')
     }

     function getVariantSuffix(modelId: string): string | null {
       const match = modelId.match(/(-\d{8,})$/)
       return match ? match[1].slice(1) : null  // e.g. "20251101"
     }

     interface ModelGroup {
       baseName: string
       displayName: string
       models: ModelInfo[]  // all variants, sorted by date descending
       providerID: string
     }
     ```
   - In `parseProviders`, after building the flat model list per provider, group by base name:
     ```typescript
     const groups: ModelGroup[] = []
     const groupMap = new Map<string, ModelInfo[]>()
     for (const model of models) {
       const base = getBaseName(model.id)
       if (!groupMap.has(base)) groupMap.set(base, [])
       groupMap.get(base)!.push(model)
     }
     for (const [baseName, variants] of groupMap) {
       variants.sort((a, b) => b.id.localeCompare(a.id))  // newest first
       groups.push({ baseName, displayName: baseName, models: variants, providerID })
     }
     ```
   - Update the dropdown rendering:
     - For each group, show the base name as the primary item
     - If the group has multiple variants, show variant date chips below:
       ```typescript
       {group.models.length > 1 && isActive(group) && (
         <div className="flex gap-1 pl-6 pb-1">
           {group.models.map(variant => (
             <button
               key={variant.id}
               className={cn(
                 'text-[10px] px-1.5 py-0.5 rounded',
                 isActiveModel(variant) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'
               )}
               onClick={() => handleSelect(variant)}
             >
               {getVariantSuffix(variant.id) || variant.id}
             </button>
           ))}
         </div>
       )}
       ```
   - Clicking the base name selects the first (latest) variant
   - Clicking a variant chip selects that specific variant

2. Add Alt+T keyboard shortcut:
   - In `ModelSelector.tsx` or via `useKeyboardShortcut`:
     ```typescript
     useEffect(() => {
       const handleKeyDown = (e: KeyboardEvent) => {
         if (e.altKey && e.key === 't') {
           e.preventDefault()
           cycleVariant()
         }
       }
       window.addEventListener('keydown', handleKeyDown)
       return () => window.removeEventListener('keydown', handleKeyDown)
     }, [selectedModel, providers])
     ```
   - `cycleVariant()`:
     - Find the current model's base name
     - Find all variants for that base name from the same provider
     - Find current index, select the next one (wrap around)
     - Call `setSelectedModel({ providerID, modelID: nextVariant.id })`
     - Show toast: `toast.success(\`Switched to ${shortenModelName(nextVariant.id)}\`)`
   - If only one variant exists, do nothing

3. Update the pill display to show a variant indicator when multiple variants exist:
   - Show a small `↻` icon or "(2 variants)" text when the current model has siblings

### Key Files
- `src/renderer/src/components/sessions/ModelSelector.tsx` — variant grouping, UI, Alt+T

### Definition of Done
- [ ] Models with same base name grouped in dropdown
- [ ] Active model group shows variant date chips below
- [ ] Clicking base name selects the latest variant
- [ ] Clicking a variant chip selects that specific variant
- [ ] Active variant highlighted in chips
- [ ] Alt+T cycles to next variant of current model
- [ ] Alt+T wraps around to first variant after last
- [ ] Alt+T does nothing if only one variant exists
- [ ] Toast shown on variant switch via Alt+T
- [ ] Single-variant models display normally (no chips)
- [ ] Pill shows correct display name for selected variant
- [ ] `pnpm lint` passes

### How to Test
1. Open the model selector dropdown
2. Verify models with multiple date variants are grouped (e.g., `claude-opus-4-5` with date chips below)
3. Click a different date chip → verify model changes
4. Close dropdown → press Alt+T → verify model cycles to next variant with a toast
5. Press Alt+T again → verify cycles to the next, wrapping around
6. Select a model with only one variant → press Alt+T → verify nothing happens

### Testing Criteria
```typescript
// test/phase-7/session-6/model-variants.test.ts
describe('Session 6: Model Variants', () => {
  describe('Grouping', () => {
    test('getBaseName strips date suffix', () => {
      expect(getBaseName('claude-opus-4-5-20251101')).toBe('claude-opus-4-5')
      expect(getBaseName('claude-opus-4-5-20250514')).toBe('claude-opus-4-5')
      expect(getBaseName('gpt-4o')).toBe('gpt-4o')
    })

    test('getVariantSuffix extracts date', () => {
      expect(getVariantSuffix('claude-opus-4-5-20251101')).toBe('20251101')
      expect(getVariantSuffix('gpt-4o')).toBeNull()
    })

    test('models grouped by base name', () => {
      // Models: ['claude-opus-4-5-20251101', 'claude-opus-4-5-20250514', 'claude-haiku-4-5-20251001']
      // Verify 2 groups: claude-opus-4-5 (2 variants), claude-haiku-4-5 (1 variant)
    })

    test('variants sorted newest first', () => {
      // Group with ['20250514', '20251101']
      // Verify order: 20251101 first, then 20250514
    })
  })

  describe('Dropdown UI', () => {
    test('variant chips shown for active multi-variant group', () => {
      // Select claude-opus-4-5-20251101 (group has 2 variants)
      // Verify date chips visible
    })

    test('no chips for single-variant group', () => {
      // Select gpt-4o (only 1 variant)
      // Verify no chips shown
    })

    test('clicking base name selects latest variant', () => {
      // Click "claude-opus-4-5" group
      // Verify selected model is 20251101 (latest)
    })

    test('clicking variant chip selects that variant', () => {
      // Click "20250514" chip
      // Verify selected model is claude-opus-4-5-20250514
    })

    test('active variant chip highlighted', () => {
      // Selected: 20251101
      // Verify 20251101 chip has primary styling
      // Verify 20250514 chip has muted styling
    })
  })

  describe('Alt+T shortcut', () => {
    test('Alt+T cycles to next variant', () => {
      // Selected: claude-opus-4-5-20251101 (2 variants)
      // Press Alt+T
      // Verify selected model is claude-opus-4-5-20250514
    })

    test('Alt+T wraps around', () => {
      // Selected: claude-opus-4-5-20250514 (last variant)
      // Press Alt+T
      // Verify selected model is claude-opus-4-5-20251101 (first)
    })

    test('Alt+T does nothing for single variant', () => {
      // Selected: gpt-4o (only 1 variant)
      // Press Alt+T
      // Verify model unchanged
    })

    test('toast shown on variant switch', () => {
      // Press Alt+T, variant changes
      // Verify toast.success called
    })

    test('no toast when no change', () => {
      // Single variant, press Alt+T
      // Verify no toast
    })
  })
})
```

---

## Session 7: Integration & Polish

### Objectives
- Verify all Phase 7 features work correctly together
- Fix edge cases, visual inconsistencies, and regressions
- Run lint and tests

### Tasks

1. **Project Filter integration**:
   - Filter projects → expand a matching project → verify worktrees still show
   - Clear filter → verify all projects return
   - Filter while a project is selected → verify selection preserved if project still visible
   - Test with projects that have special characters in names/paths

2. **Branch Duplication integration**:
   - Duplicate a branch → verify the new branch appears in the sidebar
   - Select the duplicated branch → verify it loads correctly
   - Verify the run script state is independent (not shared with source)

3. **Code Review integration**:
   - Trigger review → verify session appears in tab list
   - Verify AI response streams correctly
   - Trigger review when already reviewing → verify graceful handling (button disabled)

4. **Inline Diff integration**:
   - Open a diff → switch to a session tab → switch back → verify diff still shown
   - Open a diff → make more changes → refresh git status → verify diff updates
   - Open a diff for a staged file vs unstaged file → verify correct diff

5. **Pulse Animation integration**:
   - Start run process → verify pulse appears
   - Start AI session while run is active → verify pulse takes priority over spinner
   - Stop run process → verify pulse disappears, AI spinner shows if still working

6. **Auto-Focus integration**:
   - Open inline diff → close diff → verify session textarea refocuses
   - Open command palette → close → verify textarea refocuses

7. **Model Variants integration**:
   - Switch model → send a message → verify correct model used
   - Alt+T during streaming → verify model change applies to next message

8. Run `pnpm lint` — fix any errors
9. Run `pnpm test` — fix any failures
10. Check for console errors during normal operation

### Key Files
- All files modified in sessions 1-6
- Focus on cross-cutting concerns

### Definition of Done
- [ ] All 8 features from sessions 1-6 work correctly in isolation
- [ ] No regressions in Phase 6 features
- [ ] Cross-feature interactions work correctly (listed above)
- [ ] No console errors during normal operation
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Performance targets met (filter < 16ms, diff render < 100ms, etc.)

### How to Test
Run through each integration scenario listed in Tasks above. Focus on transitions between features — switching from diff view to session, filtering while working, duplicating while running, etc.

### Testing Criteria
```typescript
// test/phase-7/session-7/integration-polish.test.ts
describe('Session 7: Integration & Polish', () => {
  test('Filter preserves project selection', () => {
    // Select project-A, type filter that includes project-A
    // Verify project-A still selected and expanded
  })

  test('Filter hides non-matching and shows matching', () => {
    // 3 projects, filter matches 1
    // Verify 1 shown, 2 hidden
  })

  test('Duplicated worktree appears in sidebar', () => {
    // Duplicate feature-auth
    // Verify feature-auth-v2 in worktree list
  })

  test('Review session streams correctly', () => {
    // Trigger review
    // Verify session created and message sent
  })

  test('Inline diff updates on git changes', () => {
    // Open diff, make more changes
    // Verify diff reflects new changes after refresh
  })

  test('Pulse priority over AI spinner', () => {
    // runRunning=true, worktreeStatus='working'
    // Verify PulseAnimation shown, not Loader2
  })

  test('No console errors during full workflow', () => {
    // Navigate through all features
    // Verify zero console.error calls
  })

  test('Lint passes', () => {
    // pnpm lint exit code 0
  })

  test('Tests pass', () => {
    // pnpm test exit code 0
  })
})
```

---

## Session 8: End-to-End Verification

### Objectives
- Full manual verification of all Phase 7 features with real data
- Performance validation against NFR targets
- Final cleanup

### Tasks

1. **Full feature walkthrough** (with the app running via `pnpm dev`):
   - Add 5+ projects with varying names
   - Test project filter with subsequence queries
   - Create worktrees, make changes, duplicate them
   - Trigger code review on uncommitted changes
   - View diffs inline with context expansion
   - Run project scripts, verify pulse animation
   - Verify auto-focus on session switch
   - Test model variant selection with Alt+T
   - Clear run output

2. **Edge cases**:
   - Filter with empty projects list
   - Duplicate a clean worktree (no uncommitted changes)
   - Review when no changes exist (button should be disabled)
   - Diff for a deleted file
   - Diff for a new (untracked) file
   - Alt+T when no model loaded yet
   - Pulse animation when switching between worktrees rapidly

3. **Performance check**:
   - Project filter: type rapidly in filter → verify no lag (< 16ms per keystroke)
   - Branch duplication: measure time for typical worktree (< 5 seconds)
   - Inline diff: open large file diff (> 1000 lines) → verify render < 100ms
   - Pulse animation: verify 60fps (no jank in dev tools performance tab)

4. Final `pnpm lint` and `pnpm test`

### Definition of Done
- [ ] All features demonstrated working with real data
- [ ] Edge cases handled gracefully
- [ ] Performance targets met
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] No visual regressions from Phase 6

### How to Test
Follow the full walkthrough in task 1 above. Use Chrome DevTools Performance tab to verify animation FPS and measure render times.

### Testing Criteria
```typescript
// test/phase-7/session-8/e2e-verification.test.ts
describe('Session 8: E2E Verification', () => {
  test('Project filter end-to-end', () => {
    // Type in filter, verify results, clear, verify all shown
  })

  test('Branch duplication end-to-end', () => {
    // Duplicate, verify new worktree, verify uncommitted files
  })

  test('Code review end-to-end', () => {
    // Make changes, click review, verify session with review prompt
  })

  test('Inline diff end-to-end', () => {
    // Click file, verify inline diff, expand context, navigate hunks
  })

  test('Pulse animation end-to-end', () => {
    // Run script, verify pulse, stop, verify gone
  })

  test('Auto-focus end-to-end', () => {
    // Switch sessions, verify textarea focused each time
  })

  test('Model variants end-to-end', () => {
    // Open selector, click variant, Alt+T cycle, verify toast
  })

  test('Clear button end-to-end', () => {
    // Run script, produce output, click clear, verify empty
  })
})
```

---

## Dependencies & Order

```
Session 1 (Quick Wins: Auto-Focus, Clear, Pulse)
    |
    ├── Session 2 (Project Filter)          ── independent
    ├── Session 3 (Branch Duplication)      ── independent
    ├── Session 4 (Code Review)             ── independent
    ├── Session 5 (Inline Diff Viewer)      ── independent
    ├── Session 6 (Model Variants)          ── independent
    |
Session 7 (Integration & Polish)           ── requires sessions 1-6
    |
Session 8 (E2E Verification)              ── requires session 7
```

### Parallel Tracks

After Session 1 (quick wins), Sessions 2-6 can all run in parallel since they touch independent areas:

- **Track A**: Session 2 — Project sidebar (ProjectList, ProjectItem, new filter components)
- **Track B**: Session 3 — Worktree operations (git-service, worktree-handlers, WorktreeItem)
- **Track C**: Session 4 — Git panel (GitStatusPanel, session creation)
- **Track D**: Session 5 — Diff infrastructure (InlineDiffViewer, git-file-handlers, FileViewerStore)
- **Track E**: Session 6 — Model selector (ModelSelector only)

**Minimum critical path**: Session 1 → Session 7 → Session 8

**Maximum parallelism**: Sessions 2, 3, 4, 5, 6 all in parallel after Session 1.

Session 7 and 8 require all previous sessions complete.

---

## Notes

### Assumed Phase 6 Infrastructure
- Rich tool rendering (ReadToolView, EditToolView, etc.)
- Context indicator with token tracking
- Native notifications on session completion
- Queued messages during streaming
- Image/file attachments via 📎 and paste
- Slash command popover
- "+" worktree button on project items
- Tab persistence and session tab badges
- Subagent/reasoning/compaction part rendering

### Out of Scope (Phase 7)
Per PRD Phase 7:
- Fuzzy matching (Levenshtein) — subsequence only
- Filtering worktrees by name
- Branch duplication across projects
- Branch duplication preserving stash entries
- Custom review prompts
- Diff for arbitrary commits (working tree vs HEAD only)
- Diff syntax highlighting beyond diff2html defaults
- Multi-file diff view
- Pulse animation customization
- Model variant sorting preferences
- Model variant pinning/favorites

### Performance Targets
| Operation | Target |
|-----------|--------|
| Project filter per keystroke | < 16ms |
| Subsequence match per project | < 5ms |
| Branch duplication | < 5 seconds |
| Review session creation | < 500ms |
| Inline diff render | < 100ms (< 5000 lines) |
| Context expansion re-render | < 200ms |
| Hunk navigation scroll | < 16ms |
| Pulse animation | 60fps |
| Auto-focus textarea | < 50ms |
| Model variant cycle (Alt+T) | < 100ms |

### Key Architecture Decisions
1. **Subsequence matching (not fuzzy/Levenshtein)**: Simpler, faster, and more predictable. Letters must appear in order. Score favors contiguous matches.
2. **Branch duplication via `git stash create` + `git stash apply`**: Non-destructive to source worktree. `stash create` doesn't modify the working tree or stash list. Untracked files copied separately via `fs.cpSync`.
3. **Review prompt reads `prompts/review.md` at runtime**: Allows updating the prompt without rebuilding. Falls back gracefully if file missing.
4. **Inline diff replaces modal (not alongside)**: Modal blocks interaction. Inline diff as a tab allows side-by-side work with sessions.
5. **Context expansion via re-fetch with `-U{n}`**: Simpler than parsing and inserting lines client-side. Slight re-render cost is acceptable.
6. **Pulse animation via SVG + CSS**: No JS animation loop needed. CSS handles the traveling wave effect at 60fps with zero layout cost.
7. **Model variant grouping is client-side only**: No backend changes needed. Grouping logic strips date suffixes and compares base names.
8. **Alt+T is a global keyboard shortcut**: Works regardless of focus. Uses `window.addEventListener` for reliability.
