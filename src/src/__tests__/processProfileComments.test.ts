import { describe, it, expect, beforeEach } from 'vitest'

// Minimal in-memory chrome.storage so the storage-backed orchestration can run in
// node. storage.ts only touches chrome.* lazily (inside functions), so installing
// the global before the tests call anything is enough.
const store: { local: Record<string, unknown>; sync: Record<string, unknown> } = { local: {}, sync: {} }
const area = (bag: Record<string, unknown>) => ({
    get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {}
        for (const k of keys) if (k in bag) out[k] = bag[k]
        cb(out)
    },
    set: (obj: Record<string, unknown>, cb: () => void) => {
        Object.assign(bag, obj)
        cb()
    },
})
;(globalThis as any).chrome = {
    storage: { local: area(store.local), sync: area(store.sync) },
    action: { setBadgeBackgroundColor() {}, setBadgeText() {} },
}

import { processProfileComments } from '../monitoring'
import { getRemoved, REMOVAL_CONFIRM_THRESHOLD } from '../storage'
import type { ProfileComment } from '../win-api'

const item = (over: Partial<ProfileComment> = {}): ProfileComment => ({
    id: 7,
    uuid: 'u7',
    type: 'comment',
    post_id: 1,
    post_uuid: 'p1',
    community: 'TheDonald',
    created: 1,
    is_removed: false,
    removal_source: '',
    title: '',
    text: '',
    ...over,
})

beforeEach(() => {
    for (const k of Object.keys(store.local)) delete store.local[k]
    for (const k of Object.keys(store.sync)) delete store.sync[k]
})

const removedItem = (over = {}) => item({ is_removed: true, ...over })
const visibleItem = (over = {}) => item({ is_removed: false, text: 'back', ...over })

// confirm a recorded removal (REMOVAL_CONFIRM_THRESHOLD consecutive removed obs)
async function recordRemoval() {
    for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD; i++) await processProfileComments([removedItem()])
}

describe('processProfileComments', () => {
    it('notifies once after the confirmation threshold, then never again', async () => {
        // not yet confirmed before the threshold
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD - 1; i++) {
            expect((await processProfileComments([removedItem({ removal_source: 'communityFilter' })])).removed).toHaveLength(0)
        }
        // the confirming observation fires exactly one notification
        const fired = await processProfileComments([removedItem()])
        expect(fired.removed.map(t => t.id)).toEqual([7])
        // it's now in the removed store
        expect(await getRemoved()).toHaveProperty('7')

        // subsequent observations of the same removal never re-notify
        expect((await processProfileComments([removedItem()])).removed).toHaveLength(0)
        expect((await processProfileComments([removedItem()])).removed).toHaveLength(0)
    })

    it('backfill (threshold 1) records a pre-existing removal on first sight', async () => {
        const fired = await processProfileComments([removedItem()], 1)
        expect(fired.removed.map(t => t.id)).toEqual([7])
    })

    it('does not re-notify an id already in the removed store (idempotency guard)', async () => {
        await processProfileComments([removedItem()], 1) // record via backfill
        await processProfileComments([removedItem()])
        const again = await processProfileComments([removedItem()])
        expect(again.removed).toHaveLength(0)
    })

    it('ignores live items (no removal, no notification)', async () => {
        const fired = await processProfileComments([item({ text: 'hello' })])
        expect(fired.removed).toHaveLength(0)
        expect(await getRemoved()).toEqual({})
    })

    it('detects a re-approval (after confirmation) and stamps the record', async () => {
        await recordRemoval()
        expect(await getRemoved()).toHaveProperty('7')

        // one visible observation is not yet a confirmed re-approval
        expect((await processProfileComments([visibleItem()])).reapproved).toHaveLength(0)
        // the next consecutive visible observation confirms it
        const r = await processProfileComments([visibleItem()])
        expect(r.reapproved.map(t => t.id)).toEqual([7])

        const rec = (await getRemoved())['7']
        expect(rec.reapproved_utc).toBeTruthy()
        expect(rec.status).toBe('live')

        // does not re-fire on continued visible observations
        expect((await processProfileComments([visibleItem()])).reapproved).toHaveLength(0)
    })

    it('a single visible blip mid-removal does not notify (anti-flap)', async () => {
        await recordRemoval()
        // a lone "visible" then back to "removed" — no re-approval, no new removal
        const blip = await processProfileComments([visibleItem()])
        expect(blip.reapproved).toHaveLength(0)
        const back = await processProfileComments([removedItem()])
        expect(back.removed).toHaveLength(0)
        expect(back.reapproved).toHaveLength(0)
        expect((await getRemoved())['7'].reapproved_utc).toBeFalsy()
    })

    it('a genuine re-removal after a re-approval notifies again', async () => {
        await recordRemoval()
        await processProfileComments([visibleItem()])
        await processProfileComments([visibleItem()]) // confirmed re-approved
        // it truly gets removed again → fresh confirmed removal notifies
        await processProfileComments([removedItem()])
        const r = await processProfileComments([removedItem()])
        expect(r.removed.map(t => t.id)).toEqual([7])
    })
})
