interface CheckeredFlagIconProps {
  className?: string
  size?: number | string
}

// Simple 4x3 checkered flag with a thin pole. The flag uses explicit
// black and white cells so it reads differently from the status icons.
export function CheckeredFlagIcon({ className, size = 24 }: CheckeredFlagIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      width={size}
      height={size}
      aria-hidden="true"
    >
      <line x1="5" y1="3" x2="5" y2="21" stroke="black" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="5" y="4" width="15" height="9" fill="white" />
      <rect x="5" y="4" width="3.75" height="3" fill="black" />
      <rect x="12.5" y="4" width="3.75" height="3" fill="black" />
      <rect x="8.75" y="7" width="3.75" height="3" fill="black" />
      <rect x="16.25" y="7" width="3.75" height="3" fill="black" />
      <rect x="5" y="10" width="3.75" height="3" fill="black" />
      <rect x="12.5" y="10" width="3.75" height="3" fill="black" />
      <rect x="5" y="4" width="15" height="9" stroke="black" strokeWidth="1.25" fill="none" />
    </svg>
  )
}
