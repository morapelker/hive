import { createContext, useContext, useRef, useCallback, useState, type ReactNode } from 'react'

type TerminalPositionTarget = 'sidebar' | 'bottom'

interface TerminalPortalContextValue {
  registerTarget: (position: TerminalPositionTarget, el: HTMLDivElement | null) => void
  getTarget: (position: TerminalPositionTarget) => HTMLDivElement | null
  revision: number
}

const TerminalPortalContext = createContext<TerminalPortalContextValue | null>(null)

export function TerminalPortalProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const sidebarRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const [revision, setRevision] = useState(0)

  const registerTarget = useCallback((position: TerminalPositionTarget, el: HTMLDivElement | null) => {
    if (position === 'sidebar') {
      sidebarRef.current = el
    } else {
      bottomRef.current = el
    }
    if (el !== null) {
      setRevision((r) => r + 1)
    }
  }, [])

  const getTarget = useCallback((position: TerminalPositionTarget): HTMLDivElement | null => {
    return position === 'sidebar' ? sidebarRef.current : bottomRef.current
  }, [])

  return (
    <TerminalPortalContext.Provider value={{ registerTarget, getTarget, revision }}>
      {children}
    </TerminalPortalContext.Provider>
  )
}

export function useTerminalPortal(): TerminalPortalContextValue {
  const ctx = useContext(TerminalPortalContext)
  if (!ctx) {
    throw new Error('useTerminalPortal must be used within a TerminalPortalProvider')
  }
  return ctx
}
