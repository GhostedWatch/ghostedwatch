import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// In-memory chrome.storage that hands out copies, as the real one does.
const store: { local: Record<string, unknown>; sync: Record<string, unknown> } = { local: {}, sync: {} }
const area = (bag: Record<string, unknown>) => ({
    get: (keys: string[]) => {
        const out: Record<string, unknown> = {}
        for (const k of keys) if (k in bag) out[k] = structuredClone(bag[k])
        return Promise.resolve(out)
    },
    set: (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) bag[k] = structuredClone(v)
        return Promise.resolve()
    },
})
;(globalThis as any).chrome = {
    storage: { local: area(store.local), sync: area(store.sync) },
    action: { setBadgeBackgroundColor() {}, setBadgeText() {} },
}

// A profile of 100 comments, newest first, 25 to a page (as the site pages it, by the
// count of posts and comments already seen).
const BASE = Date.UTC(2026, 10, 10)
const TOTAL = 100
let removedIdx = new Set<number>()
let shift = 0 // page 2 onward starts this many items early (you posted while it was read)
let failFrom = Infinity // pages starting at or past this offset get a server error
let latency = 0 // how long each request takes
const comment = (i: number) => ({
    id: 1000 + i,
    uuid: `u${i}`,
    comment_parent_id: 1,
    parent_id: 1,
    parent_uuid: 'p',
    community: 'TheDonald',
    created: BASE - i * 60_000,
    is_removed: removedIdx.has(i),
    removal_source: removedIdx.has(i) ? 'moderator' : '',
    raw_content: removedIdx.has(i) ? '' : `comment ${i}`,
})
const requested: string[] = []
;(globalThis as any).fetch = async (url: string) => {
    requested.push(url)
    now += latency
    let body: unknown = {}
    let status = 200
    if (url.includes('user/about.json')) body = { users: [{ username: 'me' }] }
    else if (url.includes('content/profile.json')) {
        const m = url.match(/post=(\d+)&comment=(\d+)/)
        const offset = m ? Math.max(0, Number(m[1]) + Number(m[2]) - shift) : 0
        if (offset >= failFrom) status = 500
        const content = Array.from({ length: Math.max(0, Math.min(25, TOTAL - offset)) }, (_, k) => comment(offset + k))
        body = { content, has_more_entries: offset + 25 < TOTAL }
    }
    return { ok: status >= 200 && status < 300, status, json: async () => body }
}

import { runCycle, DEEP_EVERY_MS, DUE_SLACK_MS } from '../poller'
import { getRemoved } from '../storage'

const auth = { user: 'me', origin: 'https://patriots.win', apiKey: 'k', apiSecret: 's' }
const pagesRead = () => requested.filter(u => u.includes('content/profile.json')).length
const id = (i: number) => 1000 + i
let now = 0

// run one check, letting the pauses between pages pass at once
async function check() {
    const done = runCycle()
    await vi.runAllTimersAsync()
    return done
}
async function after(ms: number) {
    now += ms
    requested.length = 0
    return check()
}

beforeEach(() => {
    for (const k of Object.keys(store.local)) delete store.local[k]
    requested.length = 0
    removedIdx = new Set()
    shift = 0
    failFrom = Infinity
    latency = 0
    store.local.auth = auth
    store.local.backfilled_users = { me: true } // past the first-run scan
    now = Date.UTC(2026, 10, 14, 12)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('reading past page 1 every 6 hours', () => {
    it('reads pages 2 to 4 every 6 hours, and only page 1 in between', async () => {
        const start = now
        const pagesAt = async (t: number) => {
            now = start + t
            requested.length = 0
            await check()
            return pagesRead()
        }
        expect(await pagesAt(0)).toBe(4)
        expect(await pagesAt(60_000)).toBe(1)
        expect(await pagesAt(DEEP_EVERY_MS - DUE_SLACK_MS - 60_000)).toBe(1)
        expect(await pagesAt(DEEP_EVERY_MS - DUE_SLACK_MS)).toBe(4) // due a little early: see DUE_SLACK_MS
    })

    it('a removal past page 1 is caught on one sighting, alerted, and left out of timings', async () => {
        await check() // everything visible
        removedIdx.add(40) // on page 2
        expect((await after(60_000))?.removed).toEqual([]) // page 1 can't see it
        const res = await after(DEEP_EVERY_MS)
        expect(res?.removed.map(r => r.id)).toEqual([id(40)])
        expect(res?.backfill).toBe(false) // an ordinary alert, not the first-run summary
        const rec = (await getRemoved())[String(id(40))]
        expect(rec.backfill).toBe(true) // when it was removed is known only to within 6 hours
    })

    it('a re-approval past page 1 is caught on one sighting', async () => {
        removedIdx.add(60) // on page 3
        await check()
        expect(Object.keys(await getRemoved())).toEqual([String(id(60))])
        removedIdx.delete(60) // a moderator approves it
        const res = await after(DEEP_EVERY_MS)
        expect(res?.reapproved.map(r => r.id)).toEqual([id(60)])
        expect((await getRemoved())[String(id(60))].reapproved_utc).toBe(now)
    })

    it('page 1 keeps the usual two sightings, even in a 6-hourly read', async () => {
        removedIdx.add(3)
        expect((await check())?.removed).toEqual([])
        expect((await after(60_000))?.removed.map(r => r.id)).toEqual([id(3)])
        expect((await getRemoved())[String(id(3))].backfill).toBeUndefined() // timed: seen within a minute
    })

    it('an item that shifts from page 1 onto page 2 while they are read counts once', async () => {
        removedIdx.add(24) // last on page 1
        shift = 1 // so page 2 starts with it again
        expect((await check())?.removed).toEqual([]) // one sighting on page 1, not confirmed twice
    })

    it('the first-run scan counts as the 6-hourly read', async () => {
        delete store.local.backfilled_users
        await check()
        expect(pagesRead()).toBe(4) // the whole history: 100 items
        await after(60_000)
        expect(pagesRead()).toBe(1)
    })

    it('a 6-hourly read that fails part-way still counts, so the next check reads page 1 only', async () => {
        failFrom = 50 // page 3 fails
        await check()
        expect(pagesRead()).toBe(3)
        await after(60_000)
        expect(pagesRead()).toBe(1)
    })

    it('at a 60-minute interval it still reads further back every 6 hours', async () => {
        latency = 500 // each request takes half a second, so each read ends a little after its alarm
        const start = now
        const readAt: number[] = []
        for (let h = 0; h <= 12; h++) {
            now = start + h * 60 * 60_000 // the hourly alarm
            requested.length = 0
            await check()
            if (pagesRead() === 4) readAt.push(h)
        }
        expect(readAt).toEqual([0, 6, 12])
    })

    it('a clock set back does not stop the read further back', async () => {
        store.local.deep_checked = { me: now + 3 * 24 * 60 * 60_000 } // saved before the clock went back 3 days
        await check()
        expect(pagesRead()).toBe(4)
    })

    it("page 1's alerts still go out when a later write fails", async () => {
        removedIdx.add(3)
        await check() // page 1's first sighting
        const local = (globalThis as any).chrome.storage.local
        const realSet = local.set
        let ownWrites = 0
        for (const failing of ['deep_checked', 'own_items']) {
            // the 6-hourly time can't be saved; or the later pages' items can't
            local.set = (obj: Record<string, unknown>) =>
                failing in obj && (failing !== 'own_items' || ++ownWrites === 2) ? Promise.reject(new Error('quota')) : realSet(obj)
            try {
                const res = await after(DEEP_EVERY_MS) // a 6-hourly read, with page 1's second sighting
                expect(res?.removed.map(r => r.id)).toEqual([id(3)])
            } finally {
                local.set = realSet
            }
            // start over for the next case
            for (const k of Object.keys(store.local)) delete store.local[k]
            Object.assign(store.local, { auth, backfilled_users: { me: true } })
            await check()
        }
    })

    it('a refused session records nothing, and the 6-hourly read stays due', async () => {
        const realFetch = (globalThis as any).fetch
        ;(globalThis as any).fetch = async (url: string) =>
            url.includes('user/about.json')
                ? { ok: true, status: 200, json: async () => ({ error: 'invalid user', status: false }) }
                : realFetch(url)
        try {
            expect(await check()).toBeNull()
        } finally {
            ;(globalThis as any).fetch = realFetch
        }
        expect(store.local.deep_checked).toBeUndefined()
    })
})
