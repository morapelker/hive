function KanbanIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      {/* Column 1 (Todo) - 2 cards */}
      <rect x="1" y="2" width="4" height="8" rx="1" opacity="0.9" />
      <rect x="1" y="12" width="4" height="6" rx="1" opacity="0.9" />
      {/* Column 2 (In Progress) - 1 tall card */}
      <rect x="7" y="2" width="4" height="12" rx="1" />
      {/* Column 3 (Review) - 2 cards */}
      <rect x="13" y="2" width="4" height="5" rx="1" opacity="0.7" />
      <rect x="13" y="9" width="4" height="7" rx="1" opacity="0.7" />
      {/* Column 4 (Done) - 3 small cards */}
      <rect x="19" y="2" width="4" height="4" rx="1" opacity="0.45" />
      <rect x="19" y="8" width="4" height="4" rx="1" opacity="0.45" />
      <rect x="19" y="14" width="4" height="4" rx="1" opacity="0.45" />
    </svg>
  )
}

export { KanbanIcon }
