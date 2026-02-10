interface ChangesViewProps {
  worktreePath: string
  onFileClick: (filePath: string) => void
}

export function ChangesView({ worktreePath: _worktreePath }: ChangesViewProps): React.JSX.Element {
  return <div className="p-4 text-sm text-muted-foreground">Changes view — coming next session</div>
}
