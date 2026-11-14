import { describe, it, expect, beforeEach } from 'vitest'

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

// fetch stand-in for apiGet: `respond` returns [status, body] for each request
let respond: (url: string) => [number, unknown] = () => [200, {}]
const requested: string[] = []
;(globalThis as any).fetch = async (url: string) => {
    requested.push(url)
    const [status, body] = respond(url)
    return { ok: status >= 200 && status < 300, status, json: async () => body }
}

import { runCycle } from '../poller'
import {
    getRemovedMissingTextIds,
    noteTextAttempt,
    getRemoved,
    getLastCheck,
    isBackfilled,
    MAX_TEXT_ATTEMPTS,
    type RemovedRecord,
} from '../storage'

const auth = { user: 'me', origin: 'https://patriots.win', apiKey: 'k', apiSecret: 's' }

const rec = (over: Partial<RemovedRecord>): RemovedRecord => ({
    id: 1,
    uuid: 'u',
    type: 'comment',
    post_uuid: 'p',
    community: 'TheDonald',
    title: '',
    text: '',
    text_loading: true,
    status: 'publicly_removed',
    removal_source: 'communityFilter',
    created: 0,
    observed_utc: 1000,
    unseen: false,
    ...over,
})

beforeEach(() => {
    for (const k of Object.keys(store.local)) delete store.local[k]
    for (const k of Object.keys(store.sync)) delete store.sync[k]
    requested.length = 0
    respond = () => [200, {}]
})

describe('runCycle when the profile does not answer', () => {
    it('records nothing: no last check, and the history scan stays due', async () => {
        store.local.auth = auth
        respond = () => [429, {}]
        expect(await runCycle()).toBeNull()
        expect(await isBackfilled('me')).toBe(false)
        expect(await getLastCheck()).toBe(0)
        expect(requested).toHaveLength(1) // and nothing else is asked this cycle

        respond = url => (url.includes('content/profile.json') ? [200, { content: [], has_more_entries: false }] : [200, {}])
        expect(await runCycle()).not.toBeNull()
        expect(await isBackfilled('me')).toBe(true)
        expect(await getLastCheck()).toBeGreaterThan(0)
    })

    it('marks records the history scan finds, so stats can leave their timing out', async () => {
        store.local.auth = auth
        respond = url =>
            url.includes('content/profile.json')
                ? [200, { content: [{ id: 7, uuid: 'u7', comment_parent_id: 1, parent_id: 1, is_removed: true, raw_content: '' }] }]
                : [200, {}]
        await runCycle()
        expect((await getRemoved())['7'].backfill).toBe(true)
    })
})

describe('text recovery queue', () => {
    it("skips other people's records and takes the newest of yours first", async () => {
        const removed: Record<string, RemovedRecord> = {}
        // ten older watched comments that the author view can never fill in
        for (let i = 1; i <= 10; i++) removed[i] = rec({ id: i, source: 'other', text_loading: false, observed_utc: i })
        removed[50] = rec({ id: 50, observed_utc: 100 })
        removed[40] = rec({ id: 40, observed_utc: 200 })
        store.local.removed = removed
        expect(await getRemovedMissingTextIds()).toEqual([40, 50])
    })

    it('gives up after MAX_TEXT_ATTEMPTS and stops showing the record as loading', async () => {
        store.local.removed = { 7: rec({ id: 7 }) }
        for (let i = 0; i < MAX_TEXT_ATTEMPTS - 1; i++) await noteTextAttempt(7)
        expect(await getRemovedMissingTextIds()).toEqual([7])
        await noteTextAttempt(7)
        expect(await getRemovedMissingTextIds()).toEqual([])
        expect((await getRemoved())['7'].text_loading).toBe(false)
    })

    it('a cycle counts a recovery that comes back blank as a try', async () => {
        store.local.auth = auth
        store.local.backfilled_users = { me: true }
        store.local.removed = { 7: rec({ id: 7, audited: true }) }
        respond = url => {
            if (url.includes('content/profile.json')) return [200, { content: [] }]
            if (url.includes('comment/thread')) return [200, { comments: [{ id: 7, raw_content: '' }] }]
            return [200, {}]
        }
        await runCycle()
        expect((await getRemoved())['7'].text_attempts).toBe(1)
    })
})
