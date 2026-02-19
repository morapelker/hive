import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Default color quad when connection has no color: gray */
const DEFAULT_COLOR_QUAD: ConnectionColorQuad = ['#e5e7eb', '#6b7280', '#374151', '#ffffff']

/**
 * Parse a connection's `color` field (JSON string) into a quad.
 * Returns a safe gray default if null or malformed.
 */
export function parseColorQuad(color: string | null): ConnectionColorQuad {
  if (!color) return DEFAULT_COLOR_QUAD
  try {
    const parsed = JSON.parse(color)
    if (Array.isArray(parsed) && parsed.length === 4 && parsed.every((c) => typeof c === 'string')) {
      return parsed as ConnectionColorQuad
    }
    // Legacy single-color string (e.g. "#3b82f6") — treat as activeBg with white text
    if (typeof color === 'string' && color.startsWith('#') && !color.startsWith('[')) {
      return [`${color}33`, color, '#1f2937', '#ffffff']
    }
  } catch {
    // Legacy single-color string fallback
    if (typeof color === 'string' && color.startsWith('#')) {
      return [`${color}33`, color, '#1f2937', '#ffffff']
    }
  }
  return DEFAULT_COLOR_QUAD
}
