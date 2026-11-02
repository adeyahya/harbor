import { describe, expect, it } from 'vitest'
import { bytes, containerName, duration, percent, shortId, timeAgo, uptime } from './format'

describe('bytes', () => {
  it('treats non-positive and non-finite sizes as zero', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(-1)).toBe('0 B')
    expect(bytes(Number.NaN)).toBe('0 B')
    expect(bytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })

  it('picks a unit and keeps one decimal past bytes', () => {
    expect(bytes(512)).toBe('512 B')
    expect(bytes(1024)).toBe('1.0 KB')
    expect(bytes(1.5 * 1024 ** 2)).toBe('1.5 MB')
    expect(bytes(1024 ** 4)).toBe('1.0 TB')
  })
})

describe('percent', () => {
  it('is a share of the total, or zero when the total is empty', () => {
    expect(percent(50, 200)).toBe(25)
    expect(percent(1, 0)).toBe(0)
    expect(percent(0, -1)).toBe(0)
  })
})

describe('duration', () => {
  it('formats milliseconds, seconds, and minutes', () => {
    expect(duration('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.400Z')).toBe('400ms')
    expect(duration('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:02.500Z')).toBe('2.5s')
    expect(duration('2020-01-01T00:00:00.000Z', '2020-01-01T00:01:05.000Z')).toBe('1m 5s')
  })
})

describe('uptime', () => {
  it('drops the larger units until one is non-zero', () => {
    expect(uptime(30)).toBe('0m')
    expect(uptime(90)).toBe('1m')
    expect(uptime(3600 + 120)).toBe('1h 2m')
    expect(uptime(86400 + 2 * 3600)).toBe('1d 2h')
  })
})

describe('names and ids', () => {
  it('strips the docker name prefix and shortens image ids', () => {
    expect(containerName(['/web'])).toBe('web')
    expect(containerName([])).toBe('')
    expect(shortId('sha256:0123456789abcdef')).toBe('0123456789ab')
    expect(shortId('abc')).toBe('abc')
  })
})

describe('timeAgo', () => {
  it('returns a relative phrase for a past instant', () => {
    const past = new Date(Date.now() - 90_000).toISOString()
    expect(timeAgo(past).length).toBeGreaterThan(0)
    expect(timeAgo(Math.floor(Date.now() / 1000) - 10).length).toBeGreaterThan(0)
  })
})
