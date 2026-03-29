import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WebFetchToolView } from '../../../src/renderer/src/components/sessions/tools/WebFetchToolView'

describe('Session 5: WebFetchToolView', () => {
  test('shows response size in bytes for small responses', () => {
    render(
      <WebFetchToolView
        name="WebFetch"
        input={{ url: 'https://example.com' }}
        output="hello world"
        status="success"
      />
    )

    expect(screen.getByText('11 bytes')).toBeTruthy()
  })

  test('shows response size in KB for medium responses', () => {
    render(
      <WebFetchToolView
        name="WebFetch"
        input={{ url: 'https://example.com' }}
        output={'a'.repeat(1536)}
        status="success"
      />
    )

    expect(screen.getByText('1.5 KB')).toBeTruthy()
  })

  test('shows response size in MB for large responses', () => {
    render(
      <WebFetchToolView
        name="WebFetch"
        input={{ url: 'https://example.com' }}
        output={'a'.repeat(2 * 1024 * 1024)}
        status="success"
      />
    )

    expect(screen.getByText('2.0 MB')).toBeTruthy()
  })
})
