import { describe, it, expect, beforeEach } from 'vitest'

// In-memory chrome.storage that hands out copies, as the real one does, so a missing
// write can't pass by mutating the stored object itself.
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

// fetch stand-in for apiGet: `respond` answers each request by URL
let respond: (url: string) => Promise<unknown> = async () => ({})
const requested: string[] = []
;(globalThis as any).fetch = async (url: string) => {
    requested.push(url)
    const body = await respond(url)
    return { ok: true, status: 200, json: async () => body }
}

import { runOtherCycle, runSourceCycle, watchOtherFromPage } from '../other'
import {
    addOtherItem,
    removeOtherItem,
    addSource,
    removeSource,
    getOtherItems,
    getOtherIds,
    getSources,
    capOtherItems,
    MAX_OTHER,
    MAX_AUTO_PER_POST,
    MAX_AUTO_TOTAL,
    REMOVAL_CONFIRM_THRESHOLD,
    REAPPROVAL_CONFIRM_THRESHOLD,
    type OtherItem,
} from '../storage'

const ORIGIN = 'https://patriots.win'

const item = (over: Partial<OtherItem> = {}): OtherItem => ({
    id: 5,
    uuid: 'u5',
    type: 'comment',
    post_id: 1,
    post_uuid: 'p1',
    author: 'someone',
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

// a post.json answer for post `postId` with the given comments
const thread = (postId: number, comments: Array<{ id: number; is_removed?: boolean; removal_source?: string }>) => ({
    posts: [{ id: postId, title: 't', community: 'TheDonald', author: 'op', is_removed: false }],
    comments: comments.map(c => ({ uuid: `c${c.id}`, author: 'someone', created: 1, raw_content: 'words', ...c })),
})

// Hold every request until release(), to act while a cycle is in its network part.
function holdRequests(answer: (url: string) => unknown) {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    respond = async url => {
        await gate
        return answer(url)
    }
    return release
}
async function untilRequested(): Promise<void> {
    while (requested.length === 0) await new Promise(r => setTimeout(r, 0))
}

beforeEach(() => {
    for (const k of Object.keys(store.local)) delete store.local[k]
    for (const k of Object.keys(store.sync)) delete store.sync[k]
    requested.length = 0
    respond = async () => ({})
})

describe('watching while a check is running', () => {
    it("keeps a watch added during the cycle's fetches", async () => {
        store.local.other_items = { 5: item() }
        const release = holdRequests(() => thread(1, [{ id: 5 }]))
        const cycle = runOtherCycle(ORIGIN)
        await untilRequested()
        await addOtherItem({ id: 9, uuid: 'u9', type: 'comment', post_id: 2, post_uuid: 'p2', author: 'a', community: 'c', created: 1, title: '', text: 't' })
        release()
        await cycle
        const items = await getOtherItems()
        expect(Object.keys(items).sort()).toEqual(['5', '9'])
    })

    it("keeps an unwatch made during the cycle's fetches", async () => {
        store.local.other_items = { 5: item(), 6: item({ id: 6, uuid: 'u6' }) }
        const release = holdRequests(() => thread(1, [{ id: 5 }, { id: 6 }]))
        const cycle = runOtherCycle(ORIGIN)
        await untilRequested()
        await removeOtherItem(6)
        release()
        await cycle
        expect(Object.keys(await getOtherItems())).toEqual(['5'])
    })

    it('keeps a source added, and one removed, during the cycle', async () => {
        await addSource('user', 'alice')
        await addSource('user', 'carol')
        const release = holdRequests(() => ({ content: [] }))
        const cycle = runSourceCycle(ORIGIN)
        await untilRequested()
        await addSource('user', 'bob')
        await removeSource('user:carol')
        release()
        await cycle
        expect(Object.keys(await getSources()).sort()).toEqual(['user:alice', 'user:bob'])
    })
})

describe('whole-post watches and the watch cap', () => {
    it("caps the user's own watches; a post's auto-added comments don't count and go with it", () => {
        const map: Record<string, OtherItem> = {}
        // the whole-post watch, made first (oldest), and 250 of its comments
        map['1000'] = item({ id: 1000, type: 'post', post_id: 1000, watched_at: 1, watch_comments: true })
        for (let i = 0; i < 250; i++) map[String(5000 + i)] = item({ id: 5000 + i, post_id: 1000, watched_at: 100, auto: true })
        // MAX_OTHER more watches, all newer than the post
        for (let i = 0; i < MAX_OTHER; i++) map[String(10 + i)] = item({ id: 10 + i, post_id: 2, watched_at: 10 + i })
        const out = capOtherItems(map)
        expect(Object.values(out).filter(w => !w.auto)).toHaveLength(MAX_OTHER)
        // the oldest watch (the post) is the one dropped, and its comments leave with it
        expect(out['1000']).toBeUndefined()
        expect(Object.values(out).some(w => w.auto)).toBe(false)

        // under the cap, nothing of the post goes
        delete map['10']
        const kept = capOtherItems(map)
        expect(kept['1000']).toBeDefined()
        expect(Object.values(kept).filter(w => w.auto)).toHaveLength(250)
    })

    it('a new explicit watch never evicts the whole-post watch for its auto comments', async () => {
        store.local.other_items = { 1000: item({ id: 1000, uuid: 'P', type: 'post', post_id: 1000, post_uuid: 'P', watched_at: 1, watch_comments: true }) }
        respond = async () => thread(1000, Array.from({ length: 250 }, (_, i) => ({ id: 5000 + i })))
        await runOtherCycle(ORIGIN)
        respond = async () => ({})
        await addOtherItem({ id: 9, uuid: 'u9', type: 'comment', post_id: 2, post_uuid: 'p2', author: 'a', community: 'c', created: 1, title: '', text: 't' })
        const items = await getOtherItems()
        expect(items['1000']).toBeDefined()
        expect(items['9']).toBeDefined()
    })

    it('follows at most MAX_AUTO_PER_POST comments of one thread', async () => {
        store.local.other_items = { 1000: item({ id: 1000, uuid: 'P', type: 'post', post_id: 1000, post_uuid: 'P', watch_comments: true }) }
        respond = async () => thread(1000, Array.from({ length: MAX_AUTO_PER_POST + 25 }, (_, i) => ({ id: 5000 + i })))
        await runOtherCycle(ORIGIN)
        expect(Object.values(await getOtherItems()).filter(w => w.auto)).toHaveLength(MAX_AUTO_PER_POST)
    })

    it('follows at most MAX_AUTO_TOTAL comments across all whole-post watches (storage.local quota)', async () => {
        // a whole-post watch that already follows the whole budget, and a new one
        const map: Record<string, OtherItem> = {
            2: item({ id: 2, uuid: 'P2', type: 'post', post_id: 2, post_uuid: 'P2', watched_at: 1, watch_comments: true }),
            1: item({ id: 1, uuid: 'P1', type: 'post', post_id: 1, post_uuid: 'P1', watched_at: 2, watch_comments: true }),
        }
        for (let i = 0; i < MAX_AUTO_TOTAL; i++) map[String(100000 + i)] = item({ id: 100000 + i, post_id: 2, auto: true })
        store.local.other_items = map
        respond = async url =>
            /id=1&/.test(url)
                ? thread(1, Array.from({ length: 10 }, (_, i) => ({ id: 50 + i })))
                : { ...thread(2, []), has_more_entries: true }
        await runOtherCycle(ORIGIN)
        const items = Object.values(await getOtherItems())
        expect(items.filter(w => w.auto && w.post_id === 1)).toHaveLength(0)
        expect(items.filter(w => w.auto)).toHaveLength(MAX_AUTO_TOTAL)
    })

    it("unwatching one of a whole-post watch's comments sticks: muted, not re-added or alerted", async () => {
        store.local.other_items = { 1000: item({ id: 1000, uuid: 'P', type: 'post', post_id: 1000, post_uuid: 'P', watch_comments: true }) }
        respond = async () => thread(1000, [{ id: 7 }])
        await runOtherCycle(ORIGIN) // auto-adds comment 7
        expect(await getOtherIds()).toContain(7)

        await removeOtherItem(7)
        expect(await getOtherIds()).not.toContain(7)

        respond = async () => thread(1000, [{ id: 7, is_removed: true, removal_source: 'moderator' }])
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD + 1; i++) {
            expect((await runOtherCycle(ORIGIN)).removed).toHaveLength(0)
        }
        const w = (await getOtherItems())['7']
        expect(w.muted).toBe(true)
        expect(w.recorded).toBe(false)

        // watching it again makes it the user's own watch
        await addOtherItem({ id: 7, uuid: 'c7', type: 'comment', post_id: 1000, post_uuid: 'P', author: 'a', community: 'c', created: 1, title: '', text: '' })
        const again = (await getOtherItems())['7']
        expect(again.muted).toBe(false)
        expect(again.auto).toBe(false)
        expect(await getOtherIds()).toContain(7)
    })
})

describe('watching an item that is already removed', () => {
    const watch = (removedOnPage: boolean) =>
        watchOtherFromPage(ORIGIN, { id: 7, uuid: 'c7', type: 'comment', post_id: 1, post_uuid: 'p1', removed: removedOnPage })

    it('reports no removal, then alerts on the re-approval it was watched for', async () => {
        respond = async () => thread(1, [{ id: 7, is_removed: true, removal_source: 'moderator' }])
        await watch(true)
        expect((await getOtherItems())['7'].recorded).toBe(true)
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD + 1; i++) {
            expect((await runOtherCycle(ORIGIN)).removed).toHaveLength(0)
        }
        respond = async () => thread(1, [{ id: 7 }])
        const reapprovals: number[] = []
        for (let i = 0; i < REAPPROVAL_CONFIRM_THRESHOLD; i++) {
            reapprovals.push(...(await runOtherCycle(ORIGIN)).reapproved.map(w => w.id))
        }
        expect(reapprovals).toEqual([7])
    })

    it('still reports a removal the page had not shown yet when the user clicked', async () => {
        respond = async () => thread(1, [{ id: 7, is_removed: true, removal_source: 'moderator' }])
        await watch(false)
        const removals: number[] = []
        for (let i = 0; i < REMOVAL_CONFIRM_THRESHOLD; i++) removals.push(...(await runOtherCycle(ORIGIN)).removed.map(w => w.id))
        expect(removals).toEqual([7])
    })
})
