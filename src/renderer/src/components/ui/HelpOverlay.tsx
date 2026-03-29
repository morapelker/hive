import { useMemo } from 'react'
import { useVimModeStore } from '@/stores/useVimModeStore'
import { useHintStore } from '@/stores/useHintStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { DEFAULT_SHORTCUTS, formatBinding, shortcutCategoryOrder } from '@/lib/keyboard-shortcuts'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Mnemonic highlighting helper
// ---------------------------------------------------------------------------

function MnemonicLabel({ letter, label }: { letter: string; label: string }): React.JSX.Element {
  const index = label.toLowerCase().indexOf(letter.toLowerCase())
  if (index === -1) return <span>{label}</span>
  return (
    <span>
      {label.slice(0, index)}
      <span className="text-primary font-bold bg-primary/15 px-0.5 rounded-sm underline underline-offset-2 decoration-primary decoration-2">
        {label[index]}
      </span>
      {label.slice(index + 1)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Key badge — renders a single keyboard key visually
// ---------------------------------------------------------------------------

function KeyBadge({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 font-mono text-[11px] font-medium rounded border border-border/60 bg-muted/40 text-foreground">
      {children}
    </kbd>
  )
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
      {children}
    </h3>
  )
}

// ---------------------------------------------------------------------------
// Shortcut row — key + label
// ---------------------------------------------------------------------------

function ShortcutRow({
  keyContent,
  label
}: {
  keyContent: React.ReactNode
  label: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="shrink-0">{keyContent}</span>
      <span className="text-[12px] text-muted-foreground truncate">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function HelpOverlay(): React.JSX.Element | null {
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const helpOverlayOpen = useVimModeStore((s) => s.helpOverlayOpen)
  const mode = useVimModeStore((s) => s.mode)
  const hintMap = useHintStore((s) => s.hintMap)
  const hintTargetMap = useHintStore((s) => s.hintTargetMap)
  const sessionHintMap = useHintStore((s) => s.sessionHintMap)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const sessionsByWorktree = useSessionStore((s) => s.sessionsByWorktree)
  const projects = useProjectStore((s) => s.projects)
  const connections = useConnectionStore((s) => s.connections)

  // Build flat lookup maps for resolving names
  const worktreeNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const worktrees of worktreesByProject.values()) {
      for (const wt of worktrees) {
        map.set(wt.id, wt.name)
      }
    }
    return map
  }, [worktreesByProject])

  const sessionNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const sessions of sessionsByWorktree.values()) {
      for (const session of sessions) {
        map.set(session.id, session.name ?? session.id)
      }
    }
    return map
  }, [sessionsByWorktree])

  const projectNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const project of projects) {
      map.set(project.id, project.name)
    }
    return map
  }, [projects])

  const connectionNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const conn of connections) {
      const projectNames = [...new Set(conn.members?.map((m) => m.project_name) || [])].join(' + ')
      const name = conn.custom_name || projectNames || conn.name || 'Connection'
      map.set(conn.id, name)
    }
    return map
  }, [connections])

  // Build sidebar hint entries for display
  const sidebarHintEntries = useMemo(() => {
    const entries: Array<{ code: string; label: string }> = []
    for (const [key, code] of hintMap.entries()) {
      const target = hintTargetMap.get(key)
      if (!target) continue

      if (target.kind === 'worktree' && target.worktreeId) {
        const name = worktreeNameMap.get(target.worktreeId) ?? target.worktreeId
        entries.push({ code, label: name })
      } else if (target.kind === 'project') {
        const name = projectNameMap.get(target.projectId) ?? target.projectId
        entries.push({ code, label: name })
      } else if (target.kind === 'pinned-worktree' && target.worktreeId) {
        const name = worktreeNameMap.get(target.worktreeId) ?? target.worktreeId
        entries.push({ code, label: `[pin] ${name}` })
      } else if (target.kind === 'pinned-connection' && target.connectionId) {
        const name = connectionNameMap.get(target.connectionId) ?? target.connectionId
        entries.push({ code, label: `[pin] ${name}` })
      } else if (target.kind === 'connection' && target.connectionId) {
        const name = connectionNameMap.get(target.connectionId) ?? target.connectionId
        entries.push({ code, label: name })
      }
    }
    return entries.sort((a, b) => a.code.localeCompare(b.code))
  }, [hintMap, hintTargetMap, worktreeNameMap, projectNameMap, connectionNameMap])

  // Build session hint entries for display
  const sessionHintEntries = useMemo(() => {
    const entries: Array<{ code: string; label: string }> = []
    for (const [sessionId, code] of sessionHintMap.entries()) {
      const name = sessionNameMap.get(sessionId) ?? sessionId
      entries.push({ code, label: name })
    }
    return entries.sort((a, b) => a.code.localeCompare(b.code))
  }, [sessionHintMap, sessionNameMap])

  // Group system shortcuts by category
  const groupedShortcuts = useMemo(() => {
    const groups = new Map<string, Array<{ label: string; binding: string }>>()
    for (const shortcut of DEFAULT_SHORTCUTS) {
      const binding = formatBinding(shortcut.defaultBinding)
      const group = groups.get(shortcut.category) ?? []
      group.push({ label: shortcut.label, binding })
      groups.set(shortcut.category, group)
    }
    return groups
  }, [])

  if (!vimModeEnabled || !helpOverlayOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        data-testid="help-overlay-backdrop"
        className="fixed inset-0 z-50 bg-black/60"
        onClick={() => useVimModeStore.getState().setHelpOverlayOpen(false)}
      />

      {/* Overlay card */}
      <div
        data-testid="help-overlay"
        className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
      >
        <div className="pointer-events-auto w-[640px] max-h-[80vh] overflow-y-auto rounded-lg border border-border bg-background shadow-2xl p-5">
          {/* Header with mode pill */}
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground">Keyboard Shortcuts</h2>
            <span
              className={cn(
                'text-[10px] font-mono px-1.5 py-0.5 rounded border select-none',
                mode === 'normal'
                  ? 'text-muted-foreground bg-muted/50 border-border/50'
                  : 'text-primary bg-primary/10 border-primary/30'
              )}
            >
              {mode === 'normal' ? 'NORMAL' : 'INSERT'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            {/* ---- Vim Navigation ---- */}
            <div>
              <SectionTitle>Vim Navigation</SectionTitle>
              <ShortcutRow
                keyContent={
                  <span className="flex gap-1">
                    <KeyBadge>j</KeyBadge>
                    <KeyBadge>k</KeyBadge>
                  </span>
                }
                label="Navigate worktrees"
              />
              <ShortcutRow
                keyContent={
                  <span className="flex gap-1">
                    <KeyBadge>h</KeyBadge>
                    <KeyBadge>l</KeyBadge>
                  </span>
                }
                label="Navigate session tabs"
              />
              <ShortcutRow
                keyContent={<KeyBadge>I</KeyBadge>}
                label="Filter projects (insert mode)"
              />
              <ShortcutRow keyContent={<KeyBadge>Esc</KeyBadge>} label="Return to normal mode" />
              <ShortcutRow keyContent={<KeyBadge>?</KeyBadge>} label="Toggle this help" />
            </div>

            {/* ---- Panel Shortcuts ---- */}
            <div>
              <SectionTitle>Panel Shortcuts</SectionTitle>

              {/* Right sidebar tabs */}
              <ShortcutRow
                keyContent={<KeyBadge>c</KeyBadge>}
                label={<MnemonicLabel letter="c" label="Changes" />}
              />
              <ShortcutRow
                keyContent={<KeyBadge>f</KeyBadge>}
                label={<MnemonicLabel letter="f" label="Files" />}
              />
              <ShortcutRow
                keyContent={<KeyBadge>d</KeyBadge>}
                label={<MnemonicLabel letter="d" label="Diffs" />}
              />

              {/* Bottom panel tabs */}
              <ShortcutRow
                keyContent={<KeyBadge>s</KeyBadge>}
                label={<MnemonicLabel letter="s" label="Setup" />}
              />
              <ShortcutRow
                keyContent={<KeyBadge>u</KeyBadge>}
                label={<MnemonicLabel letter="u" label="Run" />}
              />
              <ShortcutRow
                keyContent={<KeyBadge>t</KeyBadge>}
                label={<MnemonicLabel letter="t" label="Terminal" />}
              />

              {/* File tab cycling */}
              <ShortcutRow
                keyContent={
                  <span className="flex gap-1">
                    <KeyBadge>[</KeyBadge>
                    <KeyBadge>]</KeyBadge>
                  </span>
                }
                label="Prev / Next file tab"
              />
            </div>

            {/* ---- Action Shortcuts ---- */}
            <div>
              <SectionTitle>Action Shortcuts</SectionTitle>
              <ShortcutRow
                keyContent={<KeyBadge>r</KeyBadge>}
                label={<MnemonicLabel letter="r" label="Review" />}
              />
              <ShortcutRow
                keyContent={<KeyBadge>p</KeyBadge>}
                label={<MnemonicLabel letter="p" label="PR" />}
              />
              <ShortcutRow
                keyContent={<KeyBadge>m</KeyBadge>}
                label={<MnemonicLabel letter="m" label="Merge PR" />}
              />
              <ShortcutRow
                keyContent={<KeyBadge>a</KeyBadge>}
                label={<MnemonicLabel letter="a" label="Archive" />}
              />
            </div>

            {/* ---- Dynamic Sidebar Hints ---- */}
            {sidebarHintEntries.length > 0 && (
              <div>
                <SectionTitle>Sidebar Hints</SectionTitle>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {sidebarHintEntries.map(({ code, label }) => (
                    <ShortcutRow
                      key={code}
                      keyContent={<KeyBadge>{code}</KeyBadge>}
                      label={label}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ---- Dynamic Session Hints ---- */}
            {sessionHintEntries.length > 0 && (
              <div>
                <SectionTitle>Session Hints</SectionTitle>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {sessionHintEntries.map(({ code, label }) => (
                    <ShortcutRow
                      key={code}
                      keyContent={<KeyBadge>{code}</KeyBadge>}
                      label={label}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ---- System Shortcuts ---- */}
            <div className="col-span-2 border-t border-border/50 pt-3 mt-1">
              <SectionTitle>System Shortcuts</SectionTitle>
              <div className="grid grid-cols-3 gap-x-4 gap-y-0.5">
                {shortcutCategoryOrder.map((category) => {
                  const shortcuts = groupedShortcuts.get(category)
                  if (!shortcuts?.length) return null
                  return shortcuts.map(({ label, binding }) => (
                    <ShortcutRow
                      key={label}
                      keyContent={<KeyBadge>{binding}</KeyBadge>}
                      label={label}
                    />
                  ))
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
