import { describe, it, expect } from 'vitest'
import { cn } from './utils'

describe('cn (className merge)', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })
  it('lets the last conflicting tailwind class win', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })
  it('drops falsy values', () => {
    expect(cn('a', false && 'x', null, undefined, 'c')).toBe('a c')
  })
})
