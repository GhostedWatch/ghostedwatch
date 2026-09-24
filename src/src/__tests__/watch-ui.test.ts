import { describe, it, expect } from 'vitest'
import { watchTooltip } from '../watch-ui'

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
