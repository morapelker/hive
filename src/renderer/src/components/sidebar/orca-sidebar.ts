/**
 * Orca left-sidebar visual kit — class-string constants copied VERBATIM from
 * orca (`/Users/mor/Documents/dev/orca/src/renderer/src/...`). Each constant
 * names its source file/line. Consumers (LeftSidebar, ProjectItem, WorktreeItem,
 * PinnedList, RecentList, ConnectionItem/List, WorktreeList) should compose these
 * with `cn()` instead of re-typing the recipes.
 *
 * Full spec with vertical rhythm + token tables:
 * design/redesign/inventory/ORCA-SIDEBAR-SPEC.md
 */

// ───────────────────────────────────────────────────────────────────────────
// Numeric constants
// ───────────────────────────────────────────────────────────────────────────

/** worktree-list/viewport/virtual-rows.ts:7 — group header row height (px). */
export const GROUP_HEADER_H = 28
/** worktree-list/viewport/virtual-rows.ts:8 — host (tier-1) header row height (px). */
export const HOST_HEADER_H = 32
/** worktree-list/viewport/virtual-rows.ts:9 — virtualizer gap between EVERY row (px). */
export const ROW_GAP = 6
/** worktree-list/viewport/virtual-rows.ts:10 — 'pt-1' on non-first group headers (px). */
export const GROUP_HEADER_TOP_MARGIN = 4
/** worktree-list/viewport/virtual-rows.ts:11-14 — misc row estimates (px). */
export const NOTICE_ROW_H = 36
export const PENDING_CREATION_ROW_H = 56
export const FOLDER_WORKSPACE_ROW_H = 64
export const CARD_ROW_ESTIMATE_H = 116
/** worktree-sidebar-reveal.ts:3-5 — GROUP_HEADER_H + 6 clearance. */
export const REVEAL_TOP_INSET = GROUP_HEADER_H + 6
/** worktree-list/viewport/virtual-rows.ts:243 — pinned host card (h-8) + pt-1 wrapper. */
export const HOST_STICKY_PINNED_HEIGHT = 36
/** components/sidebar/index.tsx:27-28 — sidebar width bounds. */
export const SIDEBAR_MIN_WIDTH = 220
export const SIDEBAR_MAX_WIDTH = 500

/** worktree-list/rows/indentation.ts:1 — one tree step (px). */
export const SIDEBAR_TREE_INDENT = 18
/** indentation.ts:3 — extra card indent under a project header. */
export const PROJECT_WORKTREE_CARD_EXTRA_INDENT = 2
/** indentation.ts:5 — flush-card content pull-back. */
export const FLUSH_CARD_CONTENT_PULLBACK = 4
/** indentation.ts:7 — extra pull-back when the 20px status lane is present. */
export const NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK = 6
/** indentation.ts:9 — minimum flush-card content inset. */
export const FLUSH_CARD_MIN_CONTENT_INSET = 2
/** indentation.ts:10 — card surface `ml-1`. */
export const WORKTREE_CARD_SURFACE_MARGIN = 4
/** indentation.ts:12-13 — lineage step. */
export const LINEAGE_IMMEDIATE_PARENT_STEP =
  SIDEBAR_TREE_INDENT + PROJECT_WORKTREE_CARD_EXTRA_INDENT
/** indentation.ts:16-17 */
export const LINEAGE_CHILDREN_INLINE_OFFSET =
  LINEAGE_IMMEDIATE_PARENT_STEP - WORKTREE_CARD_SURFACE_MARGIN - FLUSH_CARD_MIN_CONTENT_INSET
/** indentation.ts:19 — grouped card surface inset per group depth. */
export const GROUPED_WORKTREE_CARD_SURFACE_INDENT = 14
/** indentation.ts:20-24 — section/project header padding-left ladder. */
export const PROJECT_GROUP_HEADER_BASE_PADDING = 10
export const SECTION_HEADER_PADDING_LEFT = PROJECT_GROUP_HEADER_BASE_PADDING
export const PROJECT_GROUP_HEADER_INDENT = 10
export const MAX_PROJECT_GROUP_HEADER_DEPTH = 6

/** indentation.ts:31-36 */
export function getProjectGroupHeaderPaddingLeft(depth: number): number {
  const clamped = Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0))
  return (
    PROJECT_GROUP_HEADER_BASE_PADDING +
    Math.min(clamped, MAX_PROJECT_GROUP_HEADER_DEPTH) * PROJECT_GROUP_HEADER_INDENT
  )
}

/** indentation.ts:38-46 — content indent for a card under a group header. */
export function getWorktreeCardContentIndent(args: {
  isGrouped: boolean
  groupDepth: number
  lineageDepth: number
}): number {
  const clamp = (d: number): number => Math.max(0, Math.floor(Number.isFinite(d) ? d : 0))
  const groupSteps = args.isGrouped ? clamp(args.groupDepth) + 1 : 0
  const projectCardIndent = args.isGrouped ? PROJECT_WORKTREE_CARD_EXTRA_INDENT : 0
  return (groupSteps + clamp(args.lineageDepth)) * SIDEBAR_TREE_INDENT + projectCardIndent
}

/** indentation.ts:186-197 — flush card padding-left CSS value. */
export function getFlushWorktreeCardPaddingLeft(
  contentIndent: number,
  applyStatusLaneOffset = false
): string {
  const pullback =
    FLUSH_CARD_CONTENT_PULLBACK +
    (applyStatusLaneOffset ? NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK : 0)
  return contentIndent > 0
    ? `max(${FLUSH_CARD_MIN_CONTENT_INSET}px, calc(${contentIndent}px - ${pullback}px))`
    : `${FLUSH_CARD_MIN_CONTENT_INSET}px`
}

// ───────────────────────────────────────────────────────────────────────────
// Shell (components/sidebar/index.tsx)
// ───────────────────────────────────────────────────────────────────────────

/** index.tsx:110 — sidebar root column. */
export const SIDEBAR_SHELL =
  'relative min-h-0 flex-shrink-0 bg-worktree-sidebar flex flex-col overflow-hidden scrollbar-sleek-parent'
/** index.tsx:31-32 — resize handle straddling the seam. */
export const SIDEBAR_RESIZE_HANDLE =
  'group absolute -right-1.5 top-0 z-10 flex h-full w-3 cursor-col-resize items-stretch justify-center'
/** index.tsx:33-34 */
export const SIDEBAR_RESIZE_HANDLE_LINE =
  'h-full w-px bg-transparent transition-colors group-hover:bg-ring/50 group-active:bg-ring'
/** index.tsx:145 — drop affordance overlay (+ tone border below). */
export const SIDEBAR_DROP_AFFORDANCE =
  'pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-1.5 rounded-md border bg-worktree-sidebar-accent/95 px-4 text-center text-worktree-sidebar-accent-foreground shadow-xs'
/** index.tsx:146-148 */
export const SIDEBAR_DROP_AFFORDANCE_BLOCKED = 'border-destructive/70'
export const SIDEBAR_DROP_AFFORDANCE_READY = 'border-worktree-sidebar-ring/70'

// ───────────────────────────────────────────────────────────────────────────
// Nav rows (SidebarNav.tsx / SidebarTaskNavButton.tsx / SetupGuideSidebarEntry.tsx)
// ───────────────────────────────────────────────────────────────────────────

/** SidebarNav.tsx:94 — nav list container. */
export const NAV_LIST = 'flex flex-col gap-0.5 px-2 pt-2 pb-1'
/** SidebarNav.tsx:107 — nav row button base. */
export const NAV_ROW =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors'
/** SidebarNav.tsx:196 — nav row as a group container (Mobile row hosts an inner button). */
export const NAV_ROW_GROUP =
  'group flex w-full items-center rounded-md text-[13px] font-medium tracking-tight transition-colors'
/** SidebarNav.tsx:209 — inner button when the row is a group container. */
export const NAV_ROW_GROUP_INNER_BUTTON =
  'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left'
/** SidebarNav.tsx:109 */
export const NAV_ROW_ACTIVE = 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
/** Active nav row tinted with the AI action accent (violet) instead of the neutral sidebar accent. */
export const NAV_ROW_ACTIVE_PRIMARY =
  'bg-violet-500/15 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300'
/** SidebarNav.tsx:110 */
export const NAV_ROW_INACTIVE =
  'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
/** SidebarTaskNavButton.tsx:203 — disabled (no repos). */
export const NAV_ROW_DISABLED = 'cursor-not-allowed opacity-50 hover:bg-transparent'
/** SidebarNav.tsx:115 — nav icon base. */
export const NAV_ICON = 'size-4 shrink-0'
/** SidebarNav.tsx:116 — added when the row is NOT active. */
export const NAV_ICON_INACTIVE = 'text-worktree-sidebar-foreground/30'
/** SidebarNav.tsx:118 — lucide strokeWidth per state. */
export const NAV_ICON_STROKE_ACTIVE = 2.25
export const NAV_ICON_STROKE_INACTIVE = 1.75
/** SidebarNav.tsx:120 / 218 */
export const NAV_LABEL = 'flex-1'
export const NAV_LABEL_TRUNCATE = 'min-w-0 flex-1 truncate'
/** SidebarNav.tsx:185 — unread count pill on a nav row. */
export const NAV_COUNT_BADGE =
  'rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground'
/** SidebarNav.tsx:222 — "New" pill. */
export const NAV_NEW_PILL =
  'shrink-0 rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground'
/** SidebarNav.tsx:235 — row-hosted hide (EyeOff) ghost icon-xs button. */
export const NAV_ROW_HIDE_BUTTON =
  'mr-1 text-worktree-sidebar-foreground/55 hover:bg-worktree-sidebar-foreground/10 hover:text-worktree-sidebar-foreground'
/** SidebarNav.tsx:236-237 */
export const NAV_ROW_HIDE_BUTTON_ACTIVE =
  'text-worktree-sidebar-accent-foreground/70 hover:text-worktree-sidebar-accent-foreground'
/** SidebarTaskNavButton.tsx:208 — hover-revealed provider shortcut cluster. */
export const NAV_HOVER_SHORTCUTS =
  'hidden items-center gap-1 group-hover:flex group-focus-within:flex'
/** SidebarTaskNavButton.tsx:55-58 */
export const NAV_HOVER_SHORTCUT = 'rounded p-0.5 text-muted-foreground/70'
export const NAV_HOVER_SHORTCUT_ENABLED = 'transition-colors hover:text-foreground'
export const NAV_HOVER_SHORTCUT_DISABLED = 'cursor-default'

// ───────────────────────────────────────────────────────────────────────────
// Search field (SidebarNav.tsx:264-292)
// ───────────────────────────────────────────────────────────────────────────

/** SidebarNav.tsx:271 */
export const SEARCH_FIELD =
  'group relative flex h-7 w-full items-center rounded-md border border-worktree-sidebar-border/70 bg-worktree-sidebar-foreground/5 pl-7 pr-1.5 text-left text-[12px] font-medium tracking-tight text-worktree-sidebar-foreground/45 transition-colors hover:border-worktree-sidebar-border hover:bg-worktree-sidebar-foreground/8 hover:text-worktree-sidebar-foreground/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-worktree-sidebar-ring/50'
/** SidebarNav.tsx:274 — Search icon (strokeWidth 1.75). */
export const SEARCH_FIELD_ICON =
  'pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-worktree-sidebar-foreground/30'
export const SEARCH_FIELD_ICON_STROKE = 1.75
/** SidebarNav.tsx:277 */
export const SEARCH_FIELD_LABEL = 'min-w-0 flex-1 truncate'
/** SidebarNav.tsx:280 — keycap cluster revealed on hover/focus. */
export const SEARCH_FIELD_KEYCAPS =
  'pointer-events-none ml-1.5 hidden shrink-0 items-center gap-1.5 group-hover:inline-flex group-focus-within:inline-flex'
/** SidebarNav.tsx:286 — ShortcutKeyCombo className. */
export const SEARCH_FIELD_KEYCOMBO = 'inline-flex gap-0.5'
/** ShortcutKeyCombo.tsx:9 (KeyCap base) merged with SidebarNav.tsx:287 (keyCapClassName). */
export const SEARCH_FIELD_KEYCAP =
  'inline-flex min-w-4 items-center justify-center rounded border border-worktree-sidebar-border/80 bg-worktree-sidebar-foreground/8 px-1 py-px text-[9px] font-medium text-worktree-sidebar-foreground/55 shadow-none'
/** SidebarNav.tsx:288 */
export const SEARCH_FIELD_KEYCAP_SEPARATOR = 'text-[9px] text-worktree-sidebar-foreground/45'

// ───────────────────────────────────────────────────────────────────────────
// Workspaces header (SidebarHeader.tsx:25-38)
// ───────────────────────────────────────────────────────────────────────────

/** SidebarHeader.tsx:25 */
export const SIDEBAR_HEADER = 'mt-2 flex h-8 items-center justify-between px-2 gap-2'
/** SidebarHeader.tsx:26 */
export const SIDEBAR_HEADER_LEFT = 'flex min-w-0 items-center gap-1'
/** SidebarHeader.tsx:28 */
export const SIDEBAR_HEADER_LABEL =
  'pl-2 pr-0.5 text-xs font-semibold text-muted-foreground/80 select-none'
/** SidebarHeader.tsx:34 */
export const SIDEBAR_HEADER_ACTIONS = 'flex items-center gap-1.5 shrink-0'
/** SidebarHeader.tsx:46 — Button variant="ghost" size="icon-xs" className. */
export const SIDEBAR_HEADER_ACTION_BUTTON = 'text-muted-foreground'
/** SidebarHeader.tsx:53 / 79 — icon inside header buttons (strokeWidth 2.25). */
export const SIDEBAR_HEADER_ACTION_ICON = 'size-3.5'
export const SIDEBAR_HEADER_ACTION_ICON_STROKE = 2.25
/** ui/button.tsx (orca) icon-xs — the 24px ghost icon button recipe used across header/toolbar. */
export const ICON_XS_BUTTON =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md cursor-pointer text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 size-6 [&_svg:not([class*='size-'])]:size-3 hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
/** SidebarWorkspaceOptionsMenu.tsx:117 — active-filter count dot on the options button. */
export const SIDEBAR_HEADER_FILTER_DOT =
  'absolute -top-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium leading-none text-primary-foreground'

// ───────────────────────────────────────────────────────────────────────────
// Section headers (worktree-list/rows/SectionHeader.tsx, ProjectHeaderActions.tsx)
// ───────────────────────────────────────────────────────────────────────────

/** SectionHeader.tsx:227 — the h-7 header row. */
export const SECTION_HEADER_ROW =
  'group relative flex h-7 w-full items-center gap-1.5 pr-2 text-left transition-all'
/** SectionHeader.tsx:228 */
export const SECTION_HEADER_ROW_CLICKABLE = 'cursor-pointer'
/** SectionHeader.tsx:230 — reveal highlight. */
export const SECTION_HEADER_ROW_REVEAL =
  'rounded-md bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/50'
/** SectionHeader.tsx:232 — header being dragged. */
export const SECTION_HEADER_ROW_DRAGGING =
  'bg-accent/80 ring-1 ring-ring/40 shadow-md rounded-md scale-[1.01]'
/** SectionHeader.tsx:235 / 238 — status/pin drop-over. */
export const SECTION_HEADER_ROW_DROP_OVER =
  'rounded-md bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/40'
/** SectionHeader.tsx:183-192 — sticky wrapper (virtual row). */
export const SECTION_HEADER_WRAPPER = 'left-0 right-0'
export const SECTION_HEADER_WRAPPER_TOP_SPACING = 'pt-1'
export const SECTION_HEADER_WRAPPER_STICKY = 'sticky z-20 bg-worktree-sidebar'
export const SECTION_HEADER_WRAPPER_STICKY_TOP = '-top-px'
export const SECTION_HEADER_WRAPPER_STICKY_TOP_UNDER_HOST = 'top-[35px]'
export const SECTION_HEADER_WRAPPER_ABSOLUTE = 'absolute top-0'
/** SectionHeader.tsx:298 — icon+title surface. */
export const SECTION_HEADER_TITLE_SURFACE = 'flex min-w-0 flex-1 items-center gap-1.5 self-stretch'
/** SectionHeader.tsx:300 */
export const SECTION_HEADER_TITLE_SURFACE_GRAB = 'cursor-grab active:cursor-grabbing'
/** SectionHeader.tsx:306 — 16px icon box; add tone class (e.g. 'text-foreground'). */
export const SECTION_HEADER_ICON_BOX =
  'flex size-4 shrink-0 items-center justify-center rounded-[4px]'
/** SectionHeader.tsx:318 — generic lucide glyph inside the box. */
export const SECTION_HEADER_ICON = 'size-3'
/** SectionHeader.tsx:314-315 — repo glyph inside the box. */
export const SECTION_HEADER_REPO_ICON = 'size-4'
export const SECTION_HEADER_REPO_ICON_INNER = 'size-3.5'
/** SectionHeader.tsx:323-324 */
export const SECTION_HEADER_LABEL_WRAP = 'min-w-0 flex-1'
export const SECTION_HEADER_LABEL_ROW = 'flex min-w-0 items-center gap-1.5'
/** SectionHeader.tsx:325 */
export const SECTION_HEADER_LABEL = 'min-w-0 truncate text-[13px] font-semibold leading-none'
/** ProjectHeaderActions.tsx:10-18 — hover-reveal actions cluster (absolute on hover-capable devices). */
export const SECTION_HEADER_ACTIONS =
  'flex shrink-0 cursor-pointer items-center gap-0.5 self-stretch can-hover:absolute can-hover:right-1 can-hover:top-1/2 can-hover:z-10 can-hover:-translate-y-1/2 can-hover:rounded-md can-hover:bg-worktree-sidebar can-hover:pl-1 can-hover:pointer-events-none can-hover:opacity-0 can-hover:transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 has-[button[data-state=open]]:pointer-events-auto has-[button[data-state=open]]:opacity-100'
/** SectionHeader.tsx:337 — chevron hit box. */
export const SECTION_HEADER_CHEVRON_BOX =
  'flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground'
/** SectionHeader.tsx:348 — ChevronDown; add SECTION_HEADER_CHEVRON_COLLAPSED when collapsed. */
export const SECTION_HEADER_CHEVRON = 'size-3.5 transition-transform'
export const SECTION_HEADER_CHEVRON_COLLAPSED = '-rotate-90'
/** repo-header-action-button-class.ts:1-2 — width-collapsing reveal for header action buttons. */
export const SECTION_HEADER_ACTION_REVEAL =
  'min-w-0 max-w-0 -ml-1.5 overflow-hidden opacity-0 focus:ml-0 focus:max-w-5 focus:opacity-100 group-hover:ml-0 group-hover:max-w-5 group-hover:opacity-100'
/** repo-header-action-button-class.ts:4 */
export const SECTION_HEADER_ACTION_BUTTON = `size-5 shrink-0 ${SECTION_HEADER_ACTION_REVEAL} rounded-md text-muted-foreground transition-[margin,max-width,opacity,background-color,color] hover:bg-accent/70 hover:text-foreground data-[state=open]:ml-0 data-[state=open]:max-w-5 data-[state=open]:opacity-100`
/** group-keys.ts:70-90 / workspace-status.ts — header icon tones. */
export const SECTION_TONE_NEUTRAL = 'text-foreground'
export const SECTION_TONE_MUTED = 'text-muted-foreground'
export const SECTION_TONE_PROGRESS = 'text-[#d4a300]'
export const SECTION_TONE_REVIEW = 'text-[#16a34a]'
export const SECTION_TONE_DONE = 'text-[#c7a594]'

// ───────────────────────────────────────────────────────────────────────────
// Count pill (WorktreeList.tsx@18bdef9ed0^:526-545, HostSectionHeader.tsx:13-32)
// ───────────────────────────────────────────────────────────────────────────

/** HostSectionHeader.tsx:18 — outer pill. */
export const COUNT_PILL =
  'inline-flex h-4 shrink-0 overflow-hidden rounded-full border border-worktree-sidebar-border bg-worktree-sidebar-accent text-[9px] font-medium leading-none text-muted-foreground/90'
/** HostSectionHeader.tsx:23 — inner number cell. */
export const COUNT_PILL_INNER = 'inline-flex h-full min-w-4 items-center justify-center px-1.5'

// ───────────────────────────────────────────────────────────────────────────
// Host header (worktree-list/rows/HostSectionHeader.tsx:99-160)
// ───────────────────────────────────────────────────────────────────────────

/** HostSectionHeader.tsx:99 */
export const HOST_HEADER_WRAPPER = 'px-2 pt-1'
/** HostSectionHeader.tsx:107 */
export const HOST_HEADER_CARD =
  'group/host-header flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border px-2 text-left transition-all'
/** HostSectionHeader.tsx:109-113 */
export const HOST_HEADER_CARD_HEALTHY =
  'border-worktree-sidebar-border bg-worktree-sidebar-accent/70'
export const HOST_HEADER_CARD_DISCONNECTED =
  'border-worktree-sidebar-border/70 bg-worktree-sidebar-accent/35 text-muted-foreground'
export const HOST_HEADER_CARD_BLOCKED = 'border-destructive/40 bg-destructive/10'
/** HostSectionHeader.tsx:130 */
export const HOST_HEADER_LABEL = 'min-w-0 truncate text-[12px] font-semibold leading-none'
/** HostSectionHeader.tsx:139 */
export const HOST_HEADER_DETAIL = 'shrink-0 truncate text-[10px] leading-none'
/** HostSectionHeader.tsx:150 */
export const HOST_HEADER_CHEVRON_BOX =
  'flex size-4 shrink-0 items-center justify-center text-muted-foreground/60 can-hover:opacity-0 transition-opacity group-hover/host-header:opacity-100'
/** virtual-row-dispatch.tsx:87 */
export const HOST_HEADER_WRAPPER_STICKY = 'sticky -top-px z-30 bg-worktree-sidebar'

// ───────────────────────────────────────────────────────────────────────────
// List viewport (worktree-list/viewport/VirtualizedWorktreeViewport.tsx:321-358)
// ───────────────────────────────────────────────────────────────────────────

/** VirtualizedWorktreeViewport.tsx:324 */
export const LIST_CONTAINER = 'relative min-h-0 flex-1'
/** VirtualizedWorktreeViewport.tsx:352 — the scroll root (add style overflowAnchor:'none'). */
export const LIST_SCROLL =
  'worktree-sidebar-scrollbar h-full overflow-y-auto overflow-x-hidden pl-1 scrollbar-sleek outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset pt-px'
/** VirtualizedWorktreeViewport.tsx:357 */
export const LIST_INNER = 'relative w-full'
/** virtual-row-dispatch.tsx:225 — plain item virtual row. */
export const LIST_ITEM_ROW = 'absolute left-0 right-0 top-0'
/** virtual-row-dispatch.tsx:227 — while any card drags. */
export const LIST_ITEM_ROW_DRAGGING =
  'transition-transform duration-150 ease-out will-change-transform'
/** item-row.tsx:154-159 — item wrapper inside the virtual row. */
export const LIST_ITEM_WRAPPER = 'relative transition-[opacity,filter] duration-150 ease-out'
export const LIST_ITEM_WRAPPER_DRAG_SOURCE = 'pointer-events-none opacity-0'

// ───────────────────────────────────────────────────────────────────────────
// Card surface (worktree-card-surface.tsx:119-156)
// ───────────────────────────────────────────────────────────────────────────

/** worktree-card-surface.tsx:122 — card body base (no padding-y/inset/border). */
export const CARD_SURFACE =
  'relative flex cursor-pointer flex-col pr-1.5 transition-[background-color,border-color,opacity,box-shadow] duration-200 outline-none select-none'
/** worktree-card-surface.tsx:123 — vertical padding variants. */
export const CARD_SURFACE_PY = 'pt-1.25 pb-1.5'
export const CARD_SURFACE_PY_TITLE_ONLY = 'py-2'
/** worktree-card-surface.tsx:124 — horizontal inset. */
export const CARD_SURFACE_FLUSH = 'ml-1 w-[calc(100%-0.25rem)]'
export const CARD_SURFACE_INSET = 'ml-1'
/** worktree-card-surface.tsx:125 */
export const CARD_SURFACE_RADIUS = 'rounded-lg'
/** worktree-card-surface.tsx:128-134 — border/state variants (exactly one applies). */
export const CARD_SURFACE_IDLE = 'border border-transparent worktree-sidebar-card-hover'
export const CARD_SURFACE_ACTIVE = 'border border-transparent'
export const CARD_SURFACE_MULTI_SELECTED =
  'border border-worktree-sidebar-ring/35 bg-worktree-sidebar-accent/70 ring-1 ring-worktree-sidebar-ring/30'
export const CARD_SURFACE_LINEAGE_DROP_TARGET = 'border border-accent-foreground/20 bg-accent/80'
/** worktree-card-surface.tsx:135 — active AND multi-selected. */
export const CARD_SURFACE_ACTIVE_MULTI_RING = 'ring-1 ring-worktree-sidebar-ring/35'
/** worktree-card-surface.tsx:136-139 — reveal glow classes. */
export const CARD_SURFACE_REVEAL = 'scroll-to-current-workspace-reveal-highlight'
export const CARD_SURFACE_REVEAL_AI = 'scroll-to-current-workspace-reveal-highlight--ai'
/** worktree-card-surface.tsx:140 — while inline-renaming the title. */
export const CARD_SURFACE_RENAMING = '!border-transparent !bg-transparent !shadow-none !ring-0'
/** worktree-card-surface.tsx:141 */
export const CARD_SURFACE_DELETING = 'opacity-50 grayscale cursor-not-allowed'
/** worktree-card-surface.tsx:145 */
export const CARD_SURFACE_DISCONNECTED = 'opacity-60'
/** worktree-card-surface.tsx:158-159 — deleting overlay + label pill. */
export const CARD_DELETING_OVERLAY =
  'absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]'
export const CARD_DELETING_PILL =
  'inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-[11px] font-medium text-foreground shadow-sm border border-border/50'
/** worktree-card-surface.tsx:70 — hover-details trigger body wrapping the parent content. */
export const CARD_HOVER_TRIGGER = 'group/worktree-card w-full min-w-0'
/** worktree-card-surface.tsx:171 — nested lineage children (new card style). */
export const CARD_LINEAGE_CHILDREN = 'mt-1.5 space-y-1'
/** worktree-card-secondary-rows.tsx:117 — legacy lineage children. */
export const CARD_LINEAGE_CHILDREN_LEGACY =
  '-ml-[1.125rem] mt-1.5 w-[calc(100%+1.125rem)] space-y-1'

// ───────────────────────────────────────────────────────────────────────────
// Card parent content + status lane (worktree-card-parent-content.tsx:35-82)
// ───────────────────────────────────────────────────────────────────────────

/** worktree-card-parent-content.tsx:37 — status lane + content column row. */
export const CARD_PARENT_ROW = 'flex w-full min-w-0 gap-0.5 pl-0'
export const CARD_PARENT_ROW_ALIGN_TITLE_ONLY = 'items-center'
export const CARD_PARENT_ROW_ALIGN = 'items-start'
/** worktree-card-parent-content.tsx:47-49 — 20px status lane (new card style). */
export const CARD_LANE = 'flex shrink-0 justify-center mr-1 w-5 items-center'
/** worktree-card-parent-content.tsx:48 — legacy lane alignment. */
export const CARD_LANE_LEGACY = 'flex shrink-0 justify-center items-start pt-[2px]'
/** WorktreeCardStatusSlot.tsx:169 — glyph slot inside the lane. */
export const CARD_LANE_SLOT = 'inline-flex size-5 items-center justify-center'
/** StatusIndicator.tsx:34 — 12px glyph box. */
export const STATUS_GLYPH_BOX = 'inline-flex h-3 w-3 shrink-0 items-center justify-center'
/** StatusIndicator.tsx:60-66 — 8px dots. */
export const STATUS_DOT = 'block size-2 rounded-full'
export const STATUS_DOT_DONE = 'bg-emerald-500'
export const STATUS_DOT_IDLE = 'bg-neutral-500/40'
/** StatusIndicator.tsx:39 — working spinner size inside the box. */
export const STATUS_SPINNER = 'size-2'
/** StatusIndicator.tsx:51 — question glyph size inside the box. */
export const STATUS_QUESTION_ICON = 'size-3'
/** WorktreeCardStatusSlot.tsx:38-39 — unread dot overlaid on the lane glyph. */
export const CARD_LANE_UNREAD_WRAP =
  'relative inline-flex size-5 shrink-0 items-center justify-center'
export const CARD_LANE_UNREAD_DOT =
  'pointer-events-none absolute left-0 top-1/2 size-[6px] -translate-y-1/2 rounded-full bg-amber-500 ring-2 ring-sidebar'
/** WorktreeCardStatusSlot.tsx:34-35 — review/branch passive glyphs in the lane. */
export const CARD_LANE_PASSIVE_SLOT = 'inline-flex size-5 items-center justify-center p-0.5'
export const CARD_LANE_PASSIVE_ICON = 'size-[13px] translate-x-px'
export const CARD_LANE_BRANCH_ICON = 'size-[13px] translate-x-px text-muted-foreground/70'
/** worktree-card-parent-content.tsx:69 — content column. */
export const CARD_CONTENT_COLUMN = 'flex min-w-0 flex-1 flex-col gap-1.5'
export const CARD_CONTENT_COLUMN_OVERFLOW_VISIBLE = 'overflow-visible'
export const CARD_CONTENT_COLUMN_OVERFLOW_HIDDEN = 'overflow-hidden'

// ───────────────────────────────────────────────────────────────────────────
// Title row + micro badges (worktree-card-header.tsx, WorktreeTitleInlineRename.tsx, ui/badge.tsx)
// ───────────────────────────────────────────────────────────────────────────

/** worktree-card-header.tsx:98 */
export const CARD_TITLE_ROW = 'flex min-w-0 items-center justify-between gap-2'
/** worktree-card-header.tsx:99 */
export const CARD_TITLE_ROW_LEFT = 'flex min-w-0 flex-1 items-center gap-1.5'
/** WorktreeTitleInlineRename.tsx:385 + header.tsx:174 (className "text-[13px] leading-5") — read title. */
export const CARD_TITLE_BASE =
  'block min-w-0 leading-tight focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring truncate text-[13px] leading-5'
/** WorktreeTitleInlineRename.tsx:370-374 — emphasis variants (pick one). */
export const CARD_TITLE_NORMAL = 'font-normal text-foreground'
export const CARD_TITLE_UNREAD = 'font-semibold text-foreground'
export const CARD_TITLE_DIM = 'font-normal text-foreground/80'
/** Composed: CARD_TITLE_BASE + variant. */
export const CARD_TITLE = `${CARD_TITLE_BASE} ${CARD_TITLE_NORMAL}`
export const CARD_TITLE_IS_UNREAD = `${CARD_TITLE_BASE} ${CARD_TITLE_UNREAD}`
export const CARD_TITLE_IS_DIM = `${CARD_TITLE_BASE} ${CARD_TITLE_DIM}`
/** WorktreeTitleInlineRename.tsx:299-305 — inline rename root (text presentation). */
export const CARD_TITLE_EDITING_ROOT =
  'relative grid min-w-0 truncate leading-tight text-foreground'
/** WorktreeTitleInlineRename.tsx:309 — invisible width ghost. */
export const CARD_TITLE_EDITING_GHOST =
  'invisible col-start-1 row-start-1 min-w-0 truncate whitespace-pre'
/** WorktreeTitleInlineRename.tsx:334-336 + :131 — text-mode rename input. */
export const CARD_TITLE_EDITING_INPUT =
  'col-start-1 row-start-1 min-w-0 select-text truncate text-foreground outline-none h-[1lh] rounded-none border-0 !border-transparent !bg-transparent p-0 !shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none dark:!bg-transparent'
/** WorktreeTitleInlineRename.tsx:130 — field-mode rename input (hover card). */
export const CARD_TITLE_EDITING_INPUT_FIELD =
  'h-6 rounded-sm border border-input bg-input/40 px-1.5 py-0 shadow-xs selection:bg-[Highlight] selection:text-[HighlightText] focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50 dark:bg-input/30'
/** worktree-card-header.tsx:30 — 16px repo identity chip (pinned / inline). */
export const IDENTITY_CHIP =
  'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-worktree-sidebar-border bg-worktree-sidebar-accent/55'
/** worktree-card-header.tsx:104-105 — glyph inside IDENTITY_CHIP. */
export const IDENTITY_CHIP_ICON = 'size-full'
export const IDENTITY_CHIP_ICON_INNER = 'size-3'
/** ui/badge.tsx:8 (orca base) merged with header.tsx:225 — "primary" micro badge. */
export const MICRO_BADGE_BASE =
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap transition-[color,box-shadow] [&>svg]:pointer-events-none [&>svg]:size-3 h-[16px] px-1.5 py-0.5 text-[10px] font-medium rounded leading-none border'
/** worktree-card-header.tsx:225 */
export const MICRO_BADGE_PRIMARY = `${MICRO_BADGE_BASE} text-foreground/70 border-foreground/20 bg-foreground/[0.06]`
/** worktree-card-header.tsx:245 */
export const MICRO_BADGE_SPARSE = `${MICRO_BADGE_BASE} text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/5`
/** worktree-card-meta-row.tsx:97 — conflict/rebase micro badge. */
export const MICRO_BADGE_CONFLICT = `${MICRO_BADGE_BASE} gap-1 text-amber-600 border-amber-500/30 bg-amber-500/5 dark:text-amber-400 dark:border-amber-400/30 dark:bg-amber-400/5`
/** worktree-card-meta-row.tsx:61 — host-context secondary badge. */
export const MICRO_BADGE_HOST = `${MICRO_BADGE_BASE} max-w-[7rem] border-border bg-accent text-muted-foreground dark:bg-accent/80 dark:border-border/50`
/** worktree-card-header.tsx:187 — "rename failed" destructive pill (Button ghost). */
export const MICRO_BADGE_RENAME_FAILED =
  'h-4 shrink-0 gap-0.5 rounded !px-0.5 text-[10px] font-medium leading-none text-destructive border border-destructive/40 bg-destructive/10 hover:bg-destructive/15 hover:text-destructive has-[>svg]:!px-0.5'
/** worktree-card-header.tsx:274 — compact "primary" star. */
export const CARD_TITLE_PRIMARY_STAR = 'size-3 fill-amber-400 text-amber-400'
/** worktree-card-header.tsx:126-127 — runtime host glyphs. */
export const CARD_TITLE_HOST_ICON = 'size-3 text-muted-foreground'
export const CARD_TITLE_HOST_ICON_DISCONNECTED = 'size-3 text-destructive'
export const CARD_TITLE_HOST_ICON_WRAP = 'shrink-0 inline-flex items-center'
/** worktree-card-presentation.tsx:253 — title-row trailing indicators. */
export const CARD_TITLE_INDICATORS = 'ml-auto flex shrink-0 items-center gap-1 pr-1.5'
/** worktree-card-header.tsx:262 — title-row trailing actions. */
export const CARD_TITLE_ACTIONS = 'ml-auto flex shrink-0 items-center justify-center gap-1 pr-1.5'
/** worktree-card-header.tsx:294-297 — hover-revealed delete quick action. */
export const CARD_TITLE_DELETE_ACTION =
  'inline-flex size-4 items-center justify-center rounded bg-transparent opacity-0 transition-colors transition-opacity group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive'
export const CARD_TITLE_DELETE_ICON = 'size-3.5'

// ───────────────────────────────────────────────────────────────────────────
// Meta row (worktree-card-meta-row.tsx, repo/RepoBadgeLabel.tsx, truncated-sidebar-label.tsx)
// ───────────────────────────────────────────────────────────────────────────

/** worktree-card-meta-row.tsx:47 */
export const META_ROW = 'flex items-center gap-1.5 min-w-0'
/** worktree-card-meta-row.tsx:48 */
export const META_ROW_LEFT = 'flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden'
/** worktree-card-meta-row.tsx:50 — repo chip (colored mark + lowercase name). */
export const REPO_CHIP =
  'flex items-center gap-1.5 shrink-0 px-1.5 py-0.5 rounded-[4px] bg-accent border border-border dark:bg-accent/50 dark:border-border/60'
/** RepoBadgeLabel.tsx:13 — 6px square color mark (style backgroundColor). */
export const REPO_CHIP_MARK = 'block size-1.5 shrink-0'
/** worktree-card-meta-row.tsx:52 */
export const REPO_CHIP_TEXT =
  'text-[10px] font-semibold text-foreground truncate max-w-[6rem] leading-none lowercase'
/** truncated-sidebar-label.tsx:73 + meta-row.tsx:71/85 — branch / identity text. */
export const META_TEXT = 'block min-w-0 truncate text-[11px] text-muted-foreground leading-none'
/** worktree-card-meta-row.tsx:77 — folder path (mono). */
export const META_TEXT_MONO =
  'min-w-0 truncate font-mono text-[11px] leading-none text-muted-foreground'
/** worktree-card-meta-row.tsx:108 — trailing details/ports cluster. */
export const META_ROW_TRAILING = 'ml-auto flex shrink-0 items-center gap-1 pr-1.5'
/** truncated-sidebar-label.tsx:88 — tooltip content for truncated meta text. */
export const META_TOOLTIP_CONTENT = 'max-w-80 whitespace-normal break-all text-left'

// ───────────────────────────────────────────────────────────────────────────
// Secondary rows (worktree-card-secondary-rows.tsx)
// ───────────────────────────────────────────────────────────────────────────

/** worktree-card-secondary-rows.tsx:39 — remote-branch conflict notice. */
export const CARD_CONFLICT_NOTICE =
  'mt-0.5 flex items-start gap-1.5 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-300'
export const CARD_CONFLICT_NOTICE_ICON = 'mt-[1px] size-3 shrink-0'
/** worktree-card-secondary-rows.tsx:74 — lineage child chip wrapper (color set inline). */
export const CARD_LINEAGE_CHIP_WRAP = 'relative mt-1 flex min-w-0 justify-start'
export const CARD_LINEAGE_CHIP_COLOR =
  'color-mix(in srgb, var(--muted-foreground) 42%, var(--worktree-sidebar))'
/** worktree-card-secondary-rows.tsx:85 */
export const CARD_LINEAGE_CHIP =
  'relative z-10 h-[18px] max-w-[8rem] gap-1 rounded-md border border-worktree-sidebar-border bg-worktree-sidebar px-1.5 text-[10px] font-medium leading-none text-muted-foreground shadow-none hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring'

// ───────────────────────────────────────────────────────────────────────────
// Agent rows (worktree-card-compact-agent-row.tsx, worktree-card-compact-agents.tsx, WorktreeCardAgents.tsx)
// ───────────────────────────────────────────────────────────────────────────

/** WorktreeCardAgents.tsx:366 — compact list root (data-compact-agent-list="true"). */
export const AGENT_LIST = 'flex flex-col mt-1 gap-0.5'
/** worktree-card-secondary-rows.tsx:63 — list margin depending on preceding rows. */
export const AGENT_LIST_AFTER_META = 'mt-0'
export const AGENT_LIST_AFTER_TITLE = '-mt-1'
/** worktree-card-compact-agent-row.tsx:251-255 — h-6 compact agent row shell. */
export const AGENT_ROW =
  'compact-agent-row group/compact-agent-row min-w-0 overflow-hidden cursor-pointer rounded-sm px-1 text-[11px] leading-none text-muted-foreground worktree-agent-row-hover flex h-6 items-center gap-1'
/** worktree-card-compact-agent-row.tsx:256 — focused/selected pane. */
export const AGENT_ROW_SELECTED = 'bg-worktree-sidebar-accent'
/** worktree-card-compact-agent-row.tsx:253-254 */
export const AGENT_ROW_LINEAGE_PARENT = 'worktree-agent-lineage-parent-row'
export const AGENT_ROW_LINEAGE_CHILD = 'worktree-agent-lineage-child-row'
/** worktree-card-compact-agent-row.tsx:257-258 */
export const AGENT_ROW_SENDING = 'cursor-progress opacity-75'
export const AGENT_ROW_DISABLED = 'cursor-default opacity-60'
/** worktree-card-compact-agent-row.tsx:169 — child disclosure chevron button. */
export const AGENT_ROW_DISCLOSURE =
  'compact-agent-child-disclosure-button flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring'
export const AGENT_ROW_DISCLOSURE_ICON = 'size-3 transition-transform duration-150'
export const AGENT_ROW_DISCLOSURE_ICON_OPEN = 'rotate-90'
/** worktree-card-compact-agent-row.tsx:194 — gutter spacer when siblings have disclosures. */
export const AGENT_ROW_GUTTER = 'size-4 shrink-0'
/** worktree-card-compact-agent-row.tsx:198 — identity icon wrap (AgentIcon size 13). */
export const AGENT_ROW_ICON_WRAP = 'inline-flex shrink-0'
export const AGENT_ROW_ICON_SIZE = 13
/** worktree-card-compact-agent-row.tsx:203 — label container. */
export const AGENT_ROW_LABEL = 'min-w-0 flex-1 truncate'
/** worktree-card-compact-agent-row.tsx:206 / 210 — primary + secondary text tones. */
export const AGENT_ROW_PRIMARY = 'text-muted-foreground/90'
export const AGENT_ROW_PRIMARY_SELECTED = 'text-foreground'
export const AGENT_ROW_SECONDARY = 'text-muted-foreground/65'
export const AGENT_ROW_SECONDARY_SELECTED = 'text-foreground/70'
/** worktree-card-compact-agent-row.tsx:218-220 — mono model chip. */
export const AGENT_MODEL_CHIP =
  'min-w-0 max-w-24 truncate font-mono text-[10px] text-muted-foreground/70'
export const AGENT_MODEL_CHIP_SELECTED =
  'min-w-0 max-w-24 truncate font-mono text-[10px] text-foreground/70'
/** worktree-card-compact-agent-row.tsx:228-230 — "+N" collapsed children count. */
export const AGENT_ROW_CHILD_COUNT = 'shrink-0 text-[10px] tabular-nums text-muted-foreground/70'
export const AGENT_ROW_CHILD_COUNT_SELECTED = 'shrink-0 text-[10px] tabular-nums text-foreground/70'
/** worktree-card-compact-agent-row.tsx:238-241 — relative time. */
export const AGENT_TIME = 'shrink-0 text-[10px] tabular-nums text-muted-foreground/60'
export const AGENT_TIME_SELECTED = 'shrink-0 text-[10px] tabular-nums text-foreground/70'
/** WorktreeCardAgents.tsx:342 — indented children container (CSS: margin-left .75rem, padding-left .25rem, border-left). */
export const AGENT_CHILDREN_INDENT = 'worktree-agent-lineage-children flex flex-col gap-0.5'
/** worktree-card-compact-agents.tsx:53-66 — grid-track expansion. */
export const AGENT_EXPANSION_GRID = 'compact-agent-expansion-grid'
export const AGENT_EXPANSION_GRID_EXPANDED = 'compact-agent-expansion-grid-expanded'
export const AGENT_EXPANSION_INNER = 'min-h-0 overflow-hidden'
export const AGENT_EXPANSION_CONTENT =
  'compact-agent-expansion-content flex flex-col gap-0.5 pt-0.5'
/** worktree-card-compact-agents.tsx:104-115 — collapsed multi-agent summary pill. */
export const AGENT_SUMMARY_BUTTON =
  'compact-agent-summary-button group/agent-summary flex h-6 w-full min-w-0 items-center gap-1 rounded-sm px-1 text-left text-[11px] leading-none text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring hover:bg-worktree-sidebar-accent/55 dark:hover:bg-worktree-sidebar-foreground/[0.035]'
export const AGENT_SUMMARY_BUTTON_COLLAPSED =
  'border border-worktree-sidebar-border/70 bg-worktree-sidebar-accent/35'
export const AGENT_SUMMARY_BUTTON_EXPANDED = 'compact-agent-summary-button-expanded'
/** worktree-card-compact-agents.tsx:139 — expanded label. */
export const AGENT_SUMMARY_LABEL = 'min-w-0 flex-1 truncate px-1 font-medium text-muted-foreground'
/** worktree-card-compact-agents.tsx:151 — per-state cluster. */
export const AGENT_SUMMARY_GROUP =
  'inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-sm bg-worktree-sidebar/70 px-1 py-0.5'
/** worktree-card-compact-agents.tsx:157 / 161 — overlapping avatars. */
export const AGENT_SUMMARY_AVATARS = 'inline-flex shrink-0 items-center -space-x-0.5 pl-0.5'
export const AGENT_SUMMARY_AVATAR =
  'inline-flex size-4 items-center justify-center rounded-full border border-worktree-sidebar-border/70 bg-worktree-sidebar'
/** worktree-card-compact-agents.tsx:168 / 179 — "+N" counters. */
export const AGENT_SUMMARY_MORE = 'shrink-0 text-[10px] tabular-nums text-muted-foreground/70'
/** worktree-card-compact-agents.tsx:186 — chevron. */
export const AGENT_SUMMARY_CHEVRON = 'size-3 shrink-0 transition-transform duration-150'
export const AGENT_SUMMARY_CHEVRON_COLLAPSED = '-rotate-90'
/** worktree-card-compact-agents.tsx:127 — summary panel wrapper. */
export const AGENT_SUMMARY_PANEL = 'compact-agent-summary-panel'
export const AGENT_SUMMARY_PANEL_EXPANDED = 'compact-agent-summary-panel-expanded'

// ───────────────────────────────────────────────────────────────────────────
// Agent state glyphs (AgentStateDot.tsx, AgentWorkingSpinner.tsx, StatusIndicator.tsx)
// ───────────────────────────────────────────────────────────────────────────

/** AgentWorkingSpinner.tsx:44 — smoothly rotating ring (size via className). */
export const AGENT_WORKING_SPINNER =
  'agent-working-spinner block rounded-full border-2 border-yellow-500 border-t-transparent motion-reduce:border-t-yellow-500'
/** AgentStateDot.tsx:70-72 — sizes. */
export const AGENT_DOT_BOX_SM = 'h-2.5 w-2.5'
export const AGENT_DOT_BOX_MD = 'h-3 w-3'
export const AGENT_DOT_INNER_SM = 'size-1.5'
export const AGENT_DOT_INNER_MD = 'size-2'
export const AGENT_DOT_ICON_SM = 'size-2.5'
export const AGENT_DOT_ICON_MD = 'size-3'
/** AgentStateDot.tsx:77 — wrapper. */
export const AGENT_DOT_WRAP = 'inline-flex shrink-0 items-center justify-center'
/** AgentStateDot.tsx:95 / 118-121 */
export const AGENT_DOT_DONE = 'text-emerald-500'
export const AGENT_DOT_BLOCKED = 'bg-red-500'
export const AGENT_DOT_IDLE = 'bg-neutral-500/40'
/** AgentQuestionIcon.tsx:19 — orca uses text-agent-question (orange-600/500); Hive: orange-500. */
export const AGENT_DOT_QUESTION = 'text-orange-500'

// ───────────────────────────────────────────────────────────────────────────
// Footer toolbar (SidebarToolbar.tsx:71-124, SidebarSettingsHelpMenu.tsx)
// ───────────────────────────────────────────────────────────────────────────

/** SidebarToolbar.tsx:71 */
export const FOOTER_TOOLBAR_OUTER = 'mt-auto shrink-0'
/** SidebarToolbar.tsx:72 */
export const FOOTER_TOOLBAR =
  'flex items-center justify-between border-t border-worktree-sidebar-border px-2 py-1.5'
/** SidebarToolbar.tsx:73 / 76 */
export const FOOTER_TOOLBAR_LEFT = 'flex min-w-0 items-center gap-1'
export const FOOTER_TOOLBAR_RIGHT = 'flex items-center gap-1'
/** SidebarSettingsHelpMenu.tsx:186 */
export const FOOTER_TOOLBAR_GROUP = 'flex items-center gap-1'
/** SidebarToolbar.tsx:98 — Button variant="ghost" size="icon-xs" className. */
export const FOOTER_TOOLBAR_BUTTON = 'text-muted-foreground'
/** SidebarToolbar.tsx:100 — icon inside footer buttons. */
export const FOOTER_TOOLBAR_ICON = 'size-3.5'
/** SidebarSettingsHelpMenu.tsx:238 — help dropdown content. */
export const FOOTER_HELP_MENU_CONTENT = 'w-52'

// ───────────────────────────────────────────────────────────────────────────
// Misc sidebar surfaces
// ───────────────────────────────────────────────────────────────────────────

/** main.css:1264 — one-shot notice card class (CSS recipe in globals.css). */
export const SIDEBAR_NOTICE_CARD = 'worktree-sidebar-notice-card'
export const SIDEBAR_NOTICE_CARD_TO_SECTION_TITLE = 'worktree-sidebar-notice-card--to-section-title'
