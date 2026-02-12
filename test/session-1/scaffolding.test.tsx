import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '@/App'

describe('Session 1: Project Scaffolding', () => {
  test('React app renders correctly', () => {
    render(<App />)
    expect(screen.getByText('Hive')).toBeInTheDocument()
  })

  test('App layout container is rendered', () => {
    render(<App />)
    expect(screen.getByTestId('app-layout')).toBeInTheDocument()
  })

  test('shadcn/ui Button component renders correctly', () => {
    render(<App />)
    // Theme toggle button is a shadcn button
    const themeButton = screen.getByTestId('theme-toggle')
    expect(themeButton).toBeInTheDocument()
    expect(themeButton.tagName).toBe('BUTTON')
  })

  test('Theme toggle button is present', () => {
    render(<App />)
    const themeButton = screen.getByTestId('theme-toggle')
    expect(themeButton).toBeInTheDocument()
  })

  test('App renders without errors', () => {
    // This test verifies that the full app including Toaster renders without throwing errors
    expect(() => render(<App />)).not.toThrow()
  })
})
