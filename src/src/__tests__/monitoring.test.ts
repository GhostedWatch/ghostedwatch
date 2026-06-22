import { describe, it, expect } from 'vitest'
import { applyProfileObservation } from '../monitoring'
import { REMOVAL_CONFIRM_THRESHOLD, REAPPROVAL_CONFIRM_THRESHOLD, type OwnItem } from '../storage'
import type { ProfileComment } from '../win-api'

const item = (over: Partial<ProfileComment> = {}): ProfileComment => ({
    id: 1,
    uuid: 'x',
    type: 'comment',
    post_id: 100,
    post_uuid: 'p',
    community: 'TheDonald',
    created: 1,
    is_removed: false,
    removal_source: '',
    title: '',
    text: '',
    ...over,
})

describe('applyProfileObservation', () => {
    it('starts tracking a live comment with no removal', () => {
        const { next, newlyRemoved } = applyProfileObservation(undefined, item({ text: 'hi' }))
        expect(newlyRemoved).toBe(false)
        expect(next.is_removed).toBe(false)
        expect(next.text).toBe('hi') // keeps live text the profile exposes
    })

    it('fires once after REMOVAL_CONFIRM_THRESHOLD consecutive removed observations', () => {
        let prev: OwnItem | undefined
        let fired = 0
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD; i++) {
            const r = applyProfileObservation(prev, item({ is_removed: true, removal_source: 'communityFilter' }))
            prev = r.next
            if (r.newlyRemoved) fired++
        }
        expect(prev!.removal_count).toBe(REMOVAL_CONFIRM_THRESHOLD)
        expect(prev!.recorded).toBe(true)
        expect(fired).toBe(1)
    })

    it('does not fire again on continued removed observations', () => {
        let prev: OwnItem | undefined
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD; i++) prev = applyProfileObservation(prev, item({ is_removed: true })).next
        const again = applyProfileObservation(prev, item({ is_removed: true }))
        expect(again.newlyRemoved).toBe(false)
    })

    it('resets when the comment becomes visible again (content returns)', () => {
        let prev = applyProfileObservation(undefined, item({ is_removed: true })).next
        expect(prev.removal_count).toBe(1)
        // a re-approved comment has its content back; empty content would itself read as removed
        prev = applyProfileObservation(prev, item({ is_removed: false, text: 'back' })).next
        expect(prev.removal_count).toBe(0)
        expect(prev.recorded).toBe(false)
        expect(prev.is_removed).toBe(false)
    })

    it('treats blanked content as removed ONLY when we had its text before', () => {
        // resilience: if the site drops is_removed, a once-seen item being blanked still triggers
        const live = applyProfileObservation(undefined, item({ text: 'hello' })).next
        const r1 = applyProfileObservation(live, item({ is_removed: false, text: '' }))
        const r2 = applyProfileObservation(r1.next, item({ is_removed: false, text: '' }))
        expect(r2.newlyRemoved).toBe(true)
    })

    it('does NOT flag an always-empty item (no false positive)', () => {
        const r = applyProfileObservation(undefined, item({ is_removed: false, text: '' }))
        expect(r.next.is_removed).toBe(false)
        expect(r.newlyRemoved).toBe(false)
    })

    it('backfill threshold of 1 confirms a removal on first sight', () => {
        const r = applyProfileObservation(undefined, item({ is_removed: true }), 1)
        expect(r.newlyRemoved).toBe(true)
    })

    it('preserves previously captured text across observations', () => {
        const seeded: OwnItem = applyProfileObservation(undefined, item({ text: 'my words' })).next
        const r = applyProfileObservation(seeded, item({ is_removed: true, text: '' }))
        expect(r.next.text).toBe('my words') // profile blanks removed text; we keep ours
    })
})

describe('re-approval hysteresis (anti-flap)', () => {
    // a tracked comment with a confirmed, recorded removal
    const recorded = (): OwnItem => {
        let prev: OwnItem | undefined
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD; i++) prev = applyProfileObservation(prev, item({ is_removed: true })).next
        expect(prev!.recorded).toBe(true)
        return prev!
    }
    const visible = () => item({ is_removed: false, text: 'back' })

    it('requires REAPPROVAL_CONFIRM_THRESHOLD consecutive visible observations', () => {
        let r = applyProfileObservation(recorded(), visible())
        // first visible: not yet confirmed, still recorded as removed
        expect(r.newlyReapproved).toBe(false)
        expect(r.next.recorded).toBe(true)
        expect(r.next.visible_count).toBe(1)
        for (let i = 1; i < REAPPROVAL_CONFIRM_THRESHOLD; i++) r = applyProfileObservation(r.next, visible())
        expect(r.newlyReapproved).toBe(true)
        expect(r.next.recorded).toBe(false)
        expect(r.next.visible_count).toBe(0)
    })

    it('a transient visible blip then removed does NOT flap (no re-approval, no re-notify)', () => {
        const blip = applyProfileObservation(recorded(), visible())
        expect(blip.newlyReapproved).toBe(false)
        const back = applyProfileObservation(blip.next, item({ is_removed: true }))
        expect(back.newlyRemoved).toBe(false) // already recorded → no duplicate notification
        expect(back.next.recorded).toBe(true)
        expect(back.next.visible_count).toBe(0) // streak reset by the removed observation
    })
})
