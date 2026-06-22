import { describe, it, expect } from 'vitest'
import { applyOtherObservation } from '../other'
import { REMOVAL_CONFIRM_THRESHOLD, REAPPROVAL_CONFIRM_THRESHOLD, type OtherItem } from '../storage'

const base = (over: Partial<OtherItem> = {}): OtherItem => ({
    id: 5,
    uuid: 'u5',
    type: 'comment',
    post_id: 1,
    post_uuid: 'p1',
    author: 'Someone',
    community: 'TheDonald',
    created: 1,
    title: '',
    text: 'hi',
    watched_at: 1,
    is_removed: false,
    removal_source: '',
    removal_count: 0,
    visible_count: 0,
    recorded: false,
    ...over,
})

describe('applyOtherObservation (watched-comment transition)', () => {
    it('confirms a removal after REMOVAL_CONFIRM_THRESHOLD consecutive "removed"', () => {
        let w = base()
        let fired = 0
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD; i++) {
            const r = applyOtherObservation(w, 'removed', 'communityFilter')
            w = r.next
            if (r.newlyRemoved) fired++
        }
        expect(fired).toBe(1)
        expect(w.recorded).toBe(true)
        expect(w.removal_source).toBe('communityFilter')
    })

    it('treats "absent" (gone from a complete tree) as removed', () => {
        let w = base()
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD; i++) w = applyOtherObservation(w, 'absent').next
        expect(w.recorded).toBe(true)
    })

    it('"unknown" (incomplete tree / fetch failed) is inconclusive — no change, no fire', () => {
        const w = base({ removal_count: 1 })
        const r = applyOtherObservation(w, 'unknown')
        expect(r.newlyRemoved).toBe(false)
        expect(r.next).toBe(w) // same reference, untouched
        expect(r.next.removal_count).toBe(1)
    })

    it('a "live" observation abandons an unconfirmed removal streak', () => {
        let w = applyOtherObservation(base(), 'removed').next
        expect(w.removal_count).toBe(1)
        w = applyOtherObservation(w, 'live').next
        expect(w.removal_count).toBe(0)
        expect(w.recorded).toBe(false)
    })

    it('re-approval needs REAPPROVAL_CONFIRM_THRESHOLD consecutive "live" after a recorded removal', () => {
        let w = base()
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD; i++) w = applyOtherObservation(w, 'removed').next
        expect(w.recorded).toBe(true)
        const first = applyOtherObservation(w, 'live')
        expect(first.newlyReapproved).toBe(false) // not yet
        let r = first
        for (let i = 1; i < REAPPROVAL_CONFIRM_THRESHOLD; i++) r = applyOtherObservation(r.next, 'live')
        expect(r.newlyReapproved).toBe(true)
        expect(r.next.recorded).toBe(false)
    })

    it('a transient "live" blip then removed does NOT flap a recorded removal (anti-flap)', () => {
        let w = base()
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD; i++) w = applyOtherObservation(w, 'removed').next
        const blip = applyOtherObservation(w, 'live')
        expect(blip.newlyReapproved).toBe(false)
        const back = applyOtherObservation(blip.next, 'removed')
        expect(back.newlyRemoved).toBe(false) // already recorded → no duplicate notification
        expect(back.next.recorded).toBe(true)
        expect(back.next.visible_count).toBe(0)
    })
})
