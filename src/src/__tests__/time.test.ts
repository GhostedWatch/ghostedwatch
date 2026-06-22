import { describe, it, expect } from 'vitest'
import { getPrettyTimeLength, prettyDuration, prettyAgo, fullTimestamp } from '../time'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('getPrettyTimeLength (seconds → compact two-unit, abbreviated)', () => {
    it('shows seconds under a minute', () => {
        expect(getPrettyTimeLength(5)).toBe('5s')
    })
    it('shows a single whole unit with no remainder', () => {
        expect(getPrettyTimeLength(3600)).toBe('1h')
    })
    it('shows the two most-significant units when there is a remainder', () => {
        expect(getPrettyTimeLength(2 * 3600 + 30 * 60)).toBe('2h 30m') // 2h30m
        expect(getPrettyTimeLength(6 * 3600 + 4 * 60)).toBe('6h 4m')
    })
    it('does not append sub-units below the hour (minutes show alone)', () => {
        expect(getPrettyTimeLength(45 * 60 + 30)).toBe('45m')
    })
    it('carries a rounded-up remainder instead of "1h 60m"', () => {
        expect(getPrettyTimeLength(3600 + 3599)).toBe('2h')
    })
    it('handles days', () => {
        expect(getPrettyTimeLength(2 * 86400)).toBe('2d')
    })
})

describe('prettyDuration (ms → length)', () => {
    it('converts a millisecond duration', () => {
        expect(prettyDuration(3 * HOUR)).toBe('3h')
        expect(prettyDuration(DAY + 6 * HOUR)).toBe('1d 6h')
    })
    it('never goes negative', () => {
        expect(prettyDuration(-5000)).toBe('0s')
    })
})

describe('prettyAgo (ms timestamp → "… ago")', () => {
    it('appends " ago" to a past timestamp', () => {
        expect(prettyAgo(Date.now() - 2 * HOUR)).toBe('2h ago')
    })
})

describe('fullTimestamp', () => {
    it('renders an absolute local string for the tooltip', () => {
        const s = fullTimestamp(Date.UTC(2026, 5, 14, 12, 0, 0))
        expect(typeof s).toBe('string')
        expect(s.length).toBeGreaterThan(0)
    })
})
