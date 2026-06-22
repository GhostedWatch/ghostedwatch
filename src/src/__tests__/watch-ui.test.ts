import { describe, it, expect } from 'vitest'
import { watchTooltip, isRemovalPlaceholder } from '../watch-ui'

describe('isRemovalPlaceholder (the site shows it as removed)', () => {
    it('matches the placeholder regardless of the removal reason', () => {
        for (const s of [
            'Comment removed by community filter.',
            'Comment removed by community moderators.',
            'Comment removed upon the user being banned.',
            'Comment removed for spam.',
            'Post removed by admins.',
            '   Comment removed by the author.',
        ]) {
            expect(isRemovalPlaceholder(s)).toBe(true)
        }
    })
    it('does not match real content that merely mentions removal', () => {
        for (const s of [
            'This is my actual comment.',
            'I think this comment removed by mods was unfair',
            'removed by community filter',
            '',
        ]) {
            expect(isRemovalPlaceholder(s)).toBe(false)
        }
    })
})

describe('watchTooltip', () => {
    it('watching a still-visible item → it will alert on removal', () => {
        const t = watchTooltip(true, 'comment', false)
        expect(t).toContain("alert you if it's removed")
        expect(t).toContain('Click to stop')
        expect(t).not.toContain('re-approved')
    })
    it('watching an already-removed item → it will alert on re-approval', () => {
        const t = watchTooltip(true, 'comment', true)
        expect(t).toContain("alert you if it's re-approved")
        expect(t).toContain('Click to stop')
    })
    it('not watching, still visible → Watch … removed', () => {
        const t = watchTooltip(false, 'post', false)
        expect(t).toContain('Watch this post')
        expect(t).toContain("alert you if it's removed")
        expect(t).not.toContain('Click to stop')
    })
    it('not watching, already removed → Watch … re-approved', () => {
        const t = watchTooltip(false, 'post', true)
        expect(t).toContain('Watch this post')
        expect(t).toContain("alert you if it's re-approved")
    })
})
