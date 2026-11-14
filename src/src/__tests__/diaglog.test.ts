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
;(globalThis as any).chrome = { storage: { local: area(store.local), sync: area(store.sync) } }

import {
    beginCheck,
    endCheck,
    note,
    noteRequest,
    noteNoSession,
    logEvent,
    getLogLines,
    errorText,
    MAX_LINES,
} from '../diaglog'

let now = 0
const at = (hhmm: string) => (now = Date.parse(`2026-11-14T${hhmm}:00Z`))
async function check(fn: () => void = () => {}) {
    beginCheck()
    fn()
    await endCheck()
}

beforeEach(() => {
    for (const k of Object.keys(store.local)) delete store.local[k]
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    at('10:05')
})
afterEach(() => vi.restoreAllMocks())

describe('the diagnostic log', () => {
    it('folds an hour of quiet checks into one line, written once the hour is over', async () => {
        for (const t of ['10:05', '10:20', '10:59']) {
            at(t)
            await check(() => noteRequest('content/profile.json?user=alice'))
        }
        expect(await getLogLines()).toEqual(['11-14 10:00–10:59 · 3 checks · requests: profile 3 so far'])
        at('11:02')
        await check(() => noteRequest('content/profile.json?user=alice'))
        expect(await getLogLines()).toEqual([
            '11-14 10:00–10:59 · 3 checks · requests: profile 3',
            '11-14 11:00–11:59 · 1 check · requests: profile 1 so far',
        ])
    })

    it('gives anything else a line of its own at once', async () => {
        await check(() => {
            noteRequest('content/profile.json?user=alice')
            noteRequest('post/post.json?id=123&comments=true', 'HTTP 503')
            note('removed: #456')
        })
        const [line] = await getLogLines()
        expect(line).toBe('11-14 10:05 check · post: HTTP 503 · removed: #456')
    })

    it('never holds the username, even in an error from a request', async () => {
        await check(() => {
            noteRequest('content/profile.json?user=alice&post=0&comment=25', 'no answer')
            note(`own-content check failed: ${errorText(new Error('win-api 500 for content/profile.json?user=alice'))}`)
        })
        const text = (await getLogLines()).join('\n')
        expect(text).not.toContain('alice')
        expect(text).toContain('profile: no answer')
        expect(text).toContain('win-api 500 for content/profile.json')
    })

    it('counts checks made with no session', async () => {
        await check(noteNoSession)
        await check()
        expect(await getLogLines()).toEqual(['11-14 10:00–10:59 · 2 checks (1 with no session) so far'])
    })

    it('counts a request made between checks toward the next one', async () => {
        noteRequest('post/post.json?id=9&comments=true') // a Watch click's lookup
        await check()
        expect((await getLogLines())[0]).toContain('requests: post 1')
    })

    it('keeps the newest lines', async () => {
        for (let i = 0; i < MAX_LINES + 5; i++) await logEvent(`event ${i}`)
        const lines = await getLogLines()
        expect(lines).toHaveLength(MAX_LINES)
        expect(lines[0]).toBe('11-14 10:05 event 5')
    })
})
