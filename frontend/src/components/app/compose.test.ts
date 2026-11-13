import { describe, expect, it } from 'vitest'
import { defaultService, overrideCandidates, summarize, type ServiceSettings } from './CreateDialog'

const svc = (over: Partial<ServiceSettings>): ServiceSettings => ({
  service: 'web',
  build: true,
  build_context: '.',
  dockerfile: 'Dockerfile',
  build_args: '',
  image: '',
  ports: '',
  env: '',
  volumes: '',
  network: '',
  restart: 'unless-stopped',
  command: '',
  labels: '',
  devices: '',
  group_add: '',
  security_opt: '',
  warnings: [],
  ...over,
})

describe('overrideCandidates', () => {
  it('lists files next to the main one first and leaves the main one out', () => {
    const files = ['deploy/compose.yaml', 'docker-compose.rockchip.yml', 'docker-compose.yml', 'examples/compose.yaml']
    expect(overrideCandidates(files, 'docker-compose.yml')).toEqual(['docker-compose.rockchip.yml', 'deploy/compose.yaml', 'examples/compose.yaml'])
  })
})

describe('defaultService', () => {
  it('prefers the service built from the repository', () => {
    expect(defaultService([svc({ service: 'db', build: false, image: 'postgres' }), svc({ service: 'app' })])).toBe('app')
    expect(defaultService([svc({ service: 'db', build: false })])).toBe('db')
    expect(defaultService([])).toBe('')
  })
})

describe('summarize', () => {
  it('lists what the compose file fills in', () => {
    const rows = summarize(svc({ build_context: 'app', ports: '8080:80', devices: '/dev/dri\n/dev/rga', env: 'A=1\nB=2\n', group_add: 'video' }))
    expect(rows).toEqual([
      ['Build', 'app/Dockerfile'],
      ['Ports', '8080:80'],
      ['Devices', '/dev/dri, /dev/rga'],
      ['Groups', 'video'],
      ['Variables', '2 variables'],
      ['Restart', 'unless-stopped'],
    ])
  })
})
