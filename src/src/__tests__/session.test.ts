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

// The site's answers, as seen 2026-11-14: a refused session still gets the PUBLIC profile
// (HTTP 200), while user/about.json?user=me says plainly that the tokens are no good.
const REFUSED = { error: 'invalid user', status: false }
const PROFILE = { content: [], has_more_entries: false, error: '', status: true }
let about: [number, unknown] = [200, { users: [{ username: 'me' }] }]
const requested: string[] = []
;(globalThis as any).fetch = async (url: string) => {
    requested.push(url)
    const [status, body] = url.includes('user/about.json') ? about : [200, PROFILE]
    return { ok: status >= 200 && status < 300, status, json: async () => body }
}

import { runCycle, SESSION_CHECK_MS, SESSION_RETRY_MS, DUE_SLACK_MS } from '../poller'
import { getAuth, getLastCheck, isBackfilled, setAuth, forgetAuth } from '../storage'

const auth = { user: 'me', origin: 'https://patriots.win', apiKey: 'k', apiSecret: 's' }
const asked = (part: string) => requested.filter(u => u.includes(part)).length
let now = 0

beforeEach(() => {
    for (const k of Object.keys(store.local)) delete store.local[k]
    requested.length = 0
    about = [200, { users: [{ username: 'me' }] }]
    store.local.auth = auth
    now = Date.UTC(2026, 10, 14, 12)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => vi.restoreAllMocks())

describe('the session check', () => {
    it('a refused session is forgotten and its public-view answer is not used', async () => {
        about = [200, REFUSED]
        expect(await runCycle()).toBeNull()
        expect(await getAuth()).toBeNull() // the popup now says Disconnected
        expect(await getLastCheck()).toBe(0)
        expect(await isBackfilled('me')).toBe(false)
    })

    it('an accepted session is asked about once an hour, not every check', async () => {
        expect(await runCycle()).not.toBeNull()
        now += 60_000
        expect(await runCycle()).not.toBeNull()
        expect(asked('user/about.json')).toBe(1)
        expect(asked('content/profile.json')).toBe(2)
        now += SESSION_CHECK_MS
        await runCycle()
        expect(asked('user/about.json')).toBe(2)
        expect(await getAuth()).toEqual(auth)
    })

    it('no answer, or one it does not recognise, keeps the session', async () => {
        about = [503, {}]
        expect(await runCycle()).not.toBeNull()
        expect(await getAuth()).toEqual(auth)
        now += SESSION_RETRY_MS
        about = [200, { error: 'something else', status: false }]
        expect(await runCycle()).not.toBeNull() // asked again: the 503 confirmed nothing
        expect(await getAuth()).toEqual(auth)
        expect(asked('user/about.json')).toBe(2)
    })

    it('after no answer it asks again in about 10 minutes, not at every check', async () => {
        about = [503, {}]
        const start = now
        while (now - start < SESSION_RETRY_MS - DUE_SLACK_MS) {
            await runCycle() // the default 1-minute interval
            now += 60_000
        }
        expect(asked('user/about.json')).toBe(1)
        await runCycle()
        expect(asked('user/about.json')).toBe(2)
    })

    it('a clock set back does not stop the check', async () => {
        store.local.session_checks = { k: now + 3 * 24 * 60 * 60_000 } // saved before the clock went back 3 days
        about = [200, REFUSED]
        expect(await runCycle()).toBeNull()
        expect(await getAuth()).toBeNull()
    })

    it('at a 60-minute interval, a session refused since the last check is caught at the next', async () => {
        await runCycle()
        // the next alarm, an hour on; this time the profile answered a second sooner
        now += 60 * 60_000 - 1000
        about = [200, REFUSED]
        expect(await runCycle()).toBeNull()
        expect(await getAuth()).toBeNull()
    })

    it('two signed-in sites trading the stored session each keep an hourly turn', async () => {
        const other = { user: 'me', origin: 'https://scored.co', apiKey: 'k2', apiSecret: 's2' }
        for (let i = 0; i < 3; i++) {
            await setAuth(auth)
            await runCycle()
            now += 5 * 60_000 // each tab sends its session every 5 minutes
            await setAuth(other)
            await runCycle()
            now += 5 * 60_000
        }
        expect(asked('patriots.win/api/v2/user/about.json')).toBe(1)
        expect(asked('scored.co/api/v2/user/about.json')).toBe(1)
    })

    it('a session stored while the check was out is not thrown away', async () => {
        about = [200, REFUSED]
        const newer = { ...auth, apiKey: 'k2', apiSecret: 's2' }
        const realFetch = (globalThis as any).fetch
        ;(globalThis as any).fetch = async (url: string) => {
            if (url.includes('user/about.json')) await setAuth(newer) // you logged in again meanwhile
            return realFetch(url)
        }
        try {
            expect(await runCycle()).toBeNull()
        } finally {
            ;(globalThis as any).fetch = realFetch
        }
        expect(await getAuth()).toEqual(newer)
    })

    it('a session stored while a refused one is being forgotten is kept', async () => {
        const newer = { ...auth, apiKey: 'k2', apiSecret: 's2' }
        const local = (globalThis as any).chrome.storage.local
        const realGet = local.get
        // storage answers a moment later, as the real one can
        local.get = (keys: string[]) => {
            const read = realGet(keys)
            return new Promise(r => setTimeout(() => r(read), 5))
        }
        try {
            const forgetting = forgetAuth(auth) // has read the refused session...
            await new Promise(r => setTimeout(r, 1))
            await Promise.all([forgetting, setAuth(newer)]) // ...when you log in again
        } finally {
            local.get = realGet
        }
        expect(await getAuth()).toEqual(newer)
    })

    it('a refused session is told apart from a newer one by its secret too', async () => {
        const sameKey = { ...auth, apiSecret: 's-new' }
        store.local.auth = sameKey
        await forgetAuth(auth)
        expect(await getAuth()).toEqual(sameKey)
        await forgetAuth(sameKey)
        expect(await getAuth()).toBeNull()
    })
})
