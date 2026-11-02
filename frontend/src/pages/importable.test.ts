import { describe, expect, it } from 'vitest'
import type { ImportCandidates } from '@/api'
import { importableCount } from './Import'

describe('importableCount', () => {
  it('skips Komodo and Harbor itself', () => {
    const candidates = {
      stacks: [
        { is_komodo: false, is_harbor: false },
        { is_komodo: true, is_harbor: false },
        { is_komodo: false, is_harbor: true },
      ],
      containers: [
        { is_komodo: false, is_harbor: false },
        { is_komodo: true, is_harbor: false },
      ],
    } as ImportCandidates

    expect(importableCount(undefined)).toBe(0)
    expect(importableCount(candidates)).toBe(2)
  })
})