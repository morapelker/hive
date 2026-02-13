interface HighlightedTextProps {
  text: string
  indices: number[]
  className?: string
}

export function HighlightedText({
  text,
  indices,
  className
}: HighlightedTextProps): React.JSX.Element {
  const set = new Set(indices)
  return (
    <span className={className}>
      {text.split('').map((char, i) =>
        set.has(i) ? (
          <span key={i} className="text-primary font-semibold">
            {char}
          </span>
        ) : (
          <span key={i}>{char}</span>
        )
      )}
    </span>
  )
}
