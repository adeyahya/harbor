import { describe, expect, it } from 'vitest'
import type { DeploymentListItem } from '@/api'
import { isBehind } from './promote'

function item(artifact: string | null): DeploymentListItem {
  return { artifact } as DeploymentListItem
}

describe('isBehind', () => {
  it('is true only when the upstream has a different artifact', () => {
    expect(isBehind(item('sha256:aaa'), item('sha256:bbb'))).toBe(true)
    expect(isBehind(item('sha256:aaa'), item('sha256:aaa'))).toBe(false)
    expect(isBehind(item('sha256:aaa'), undefined)).toBe(false)
    expect(isBehind(item(null), item(null))).toBe(false)
    expect(isBehind(item('sha256:aaa'), item(null))).toBe(false)
  })
})
