export interface GhosttyTerminalConfig {
  fontFamily?: string
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
