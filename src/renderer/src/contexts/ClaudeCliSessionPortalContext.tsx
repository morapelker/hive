import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

interface ClaudeCliSessionPortalContextValue {
  registerTarget: (sessionId: string, el: HTMLDivElement | null) => void
  getTarget: (sessionId: string) => HTMLDivElement | null
  revision: number
}

const ClaudeCliSessionPortalContext = createContext<ClaudeCliSessionPortalContextValue | null>(null)

export function ClaudeCliSessionPortalProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const targetsRef = useRef(new Map<string, HTMLDivElement>())
  const [revision, setRevision] = useState(0)

  const registerTarget = useCallback((sessionId: string, el: HTMLDivElement | null) => {
    if (el) {
      targetsRef.current.set(sessionId, el)
      setRevision((r) => r + 1)
    } else {
      const hadTarget = targetsRef.current.delete(sessionId)
      if (hadTarget) {
        setRevision((r) => r + 1)
      }
    }
  }, [])

  const getTarget = useCallback((sessionId: string): HTMLDivElement | null => {
    return targetsRef.current.get(sessionId) ?? null
  }, [])

  // registerTarget/getTarget are stable, so the value identity changes only when
  // `revision` does — preventing a parent re-render from re-rendering every
  // portal consumer when nothing they depend on actually changed.
  const value = useMemo(
    () => ({ registerTarget, getTarget, revision }),
    [registerTarget, getTarget, revision]
  )

  return (
    <ClaudeCliSessionPortalContext.Provider value={value}>
      {children}
    </ClaudeCliSessionPortalContext.Provider>
  )
}

export function useClaudeCliSessionPortal(): ClaudeCliSessionPortalContextValue {
  const ctx = useContext(ClaudeCliSessionPortalContext)
  if (!ctx) {
    throw new Error(
      'useClaudeCliSessionPortal must be used within a ClaudeCliSessionPortalProvider'
    )
  }
  return ctx
}
