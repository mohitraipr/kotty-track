import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

// Smoke test proving the jsdom + React Testing Library wiring works. Real component
// tests will replace this as features are migrated (Plan 05).
function Hello({ name }: { name: string }) {
  return <h1>Hello {name}</h1>
}

describe('RTL smoke', () => {
  it('renders a component into jsdom', () => {
    render(<Hello name="QC" />)
    expect(screen.getByRole('heading')).toHaveTextContent('Hello QC')
  })
})
