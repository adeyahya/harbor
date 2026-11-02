import { describe, expect, it } from 'vitest'
import { gitHost, repoLabel, shortArtifact } from './api'

describe('repoLabel', () => {
  it('shows owner/repo for GitHub URLs and leaves other URLs intact', () => {
    expect(repoLabel('https://github.com/adeyahya/harbor.git')).toBe('adeyahya/harbor')
    expect(repoLabel('git@github.com:adeyahya/harbor.git')).toBe('adeyahya/harbor')
    expect(repoLabel('https://github.com/adeyahya/harbor/')).toBe('adeyahya/harbor')
    expect(repoLabel('https://gitlab.com/a/b.git')).toBe('https://gitlab.com/a/b')
  })
})

describe('gitHost', () => {
  it('reads the host from https, ssh, scp-style, and owner/repo URLs', () => {
    expect(gitHost('')).toBeNull()
    expect(gitHost('   ')).toBeNull()
    expect(gitHost('adeyahya/harbor')).toBe('github.com')
    expect(gitHost('https://GitHub.com/adeyahya/harbor.git')).toBe('github.com')
    expect(gitHost('git@gitlab.example.com:a/b.git')).toBe('gitlab.example.com')
    expect(gitHost('ssh://git@host.io:2222/a/b')).toBe('host.io')
  })
})

describe('shortArtifact', () => {
  it('shortens image ids and keeps tags as they are', () => {
    expect(shortArtifact('sha256:abcdef1234567890ffff')).toBe('abcdef123456')
    expect(shortArtifact('harbor/api:abc1234')).toBe('harbor/api:abc1234')
  })
})
