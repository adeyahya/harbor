import { describe, expect, it } from 'vitest'
import { splitDetail } from './updates'

describe('splitDetail', () => {
  it('splits a deploy line into the commit and its message', () => {
    expect(splitDetail('a1b2c3d Fix the port editor')).toEqual({
      sha: 'a1b2c3d',
      message: 'Fix the port editor',
    })
  })

  it('strips the rollback marker and keeps a message that is not a sha', () => {
    expect(splitDetail('↩ deadbee Restored staging')).toEqual({
      sha: 'deadbee',
      message: 'Restored staging',
    })
    expect(splitDetail('pulled nginx:alpine')).toEqual({
      sha: '',
      message: 'pulled nginx:alpine',
    })
  })
})
