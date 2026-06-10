export interface GhosttyTerminalConfig {
  /** Primary font family (first `font-family` line in the Ghostty config) */
  fontFamily?: string
  /** All `font-family` lines in order: primary first, then fallback fonts */
  fontFamilies?: string[]
  fontSize?: number
  background?: string
  foreground?: string
  cursorStyle?: 'block' | 'bar' | 'underline'
  cursorColor?: string
  shell?: string
  scrollbackLimit?: number
  palette?: Record<number, string>
  selectionBackground?: string
  selectionForeground?: string
}
