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
// The tabs opened, by address. Chrome's and Firefox's APIs are separate objects, as in the
// browsers, each with its own permissions.request, so a test sees which one was asked.
const tabs: string[] = []
const shared = {
    storage: { local: area(store.local), sync: area(store.sync) },
    runtime: { getManifest: () => ({ version: '0.0.6' }) },
    tabs: { create: ({ url }: { url: string }) => (tabs.push(url), Promise.resolve({})) },
}
const chromeAsks = vi.fn()
const firefoxAsks = vi.fn()
;(globalThis as any).chrome = { ...shared, permissions: { request: chromeAsks } }
;(globalThis as any).browser = { ...shared, permissions: { request: firefoxAsks } }
;(globalThis as any).navigator = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
}

import {
    browserName,
    newestLines,
    reportUrl,
    buildReportDetails,
    openReport,
    reportProblem,
    FEEDBACK_URL,
    type ReportDetails,
} from '../report'

// what the feedback form does with the link: base64url JSON after #r=
function decode(url: string): ReportDetails {
    const b64 = url.split('#r=')[1].replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64)
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
}

beforeEach(() => {
    for (const k of Object.keys(store.local)) delete store.local[k]
    for (const k of Object.keys(store.sync)) delete store.sync[k]
    tabs.length = 0
    chromeAsks.mockReset()
    firefoxAsks.mockReset()
})
afterEach(() => {
    vi.unstubAllGlobals() // back to the Chrome build vitest.config.ts defines
})

describe('a problem report', () => {
    it('names the browser and system', () => {
        expect(browserName((globalThis as any).navigator.userAgent)).toBe('Chrome 142, macOS')
        expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0')).toBe(
            'Edge 142, Windows',
        )
        expect(browserName('Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0')).toBe('Firefox 145, Linux')
        expect(browserName('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/142.0.0.0 Safari/537.36')).toBe('Headless Chrome 142, Linux')
        expect(browserName('curl/8')).toBe('unknown browser')
    })

    it('keeps the newest log lines that fit, and says when older ones were left out', () => {
        expect(newestLines(['a1', 'b2', 'c3'], 100)).toBe('a1\nb2\nc3')
        expect(newestLines(['a1', 'b2', 'c3'], 6)).toBe('(1 older line left out)\nb2\nc3')
    })

    it('carries its details in the link, whatever the text', () => {
        const d: ReportDetails = { v: '0.0.6', b: 'Chrome 142, macOS', s: 'status ✓', l: 'log 😀 line', t: 1 }
        const url = reportUrl(d)
        expect(url.startsWith(`${FEEDBACK_URL}#r=`)).toBe(true)
        expect(url.split('#r=')[1]).toMatch(/^[A-Za-z0-9_-]+$/) // base64url: safe in a link as it is
        expect(decode(url)).toEqual(d)
    })

    it('never names the account, its session, or who and what is watched', async () => {
        store.local.auth = { user: 'alice', origin: 'https://patriots.win', apiKey: 'key-123', apiSecret: 'secret-456' }
        store.local.watch_sources = {
            'user:bobby': { key: 'user:bobby', kind: 'user', name: 'bobby', added: 1, items: {} },
            'feed:SomeCommunity': { key: 'feed:SomeCommunity', kind: 'feed', name: 'SomeCommunity', added: 1, items: {} },
        }
        store.local.diag_log = ['11-14 10:05 check · removed: #456']
        const d = await buildReportDetails()
        expect(d.v).toBe('0.0.6')
        expect(d.s).toContain('Connected (patriots.win)')
        expect(d.s).toContain('1 user · 1 feed')
        expect(d.l).toBe('11-14 10:05 check · removed: #456')
        const all = JSON.stringify(d)
        for (const secret of ['alice', 'key-123', 'secret-456', 'bobby', 'SomeCommunity']) expect(all).not.toContain(secret)
    })

    it('opens the bare form, with nothing in its link, when the browser’s setting keeps the details', async () => {
        store.local.diag_log = ['11-14 10:05 a line that must not leave']
        await openReport(false)
        expect(tabs).toEqual([FEEDBACK_URL])
    })
})

describe('Report a problem', () => {
    const LINE = '11-14 10:05 check · removed: #456'
    const withDetails = () => {
        expect(tabs).toHaveLength(1)
        expect(tabs[0].startsWith(`${FEEDBACK_URL}#r=`)).toBe(true)
        expect(decode(tabs[0]).l).toBe(LINE)
    }
    beforeEach(() => {
        store.local.diag_log = [LINE]
    })

    it('never asks on Chrome and Edge, where the details always come along', async () => {
        await reportProblem()
        expect(chromeAsks).not.toHaveBeenCalled()
        expect(firefoxAsks).not.toHaveBeenCalled()
        withDetails()
    })

    describe('on Firefox', () => {
        beforeEach(() => {
            vi.stubGlobal('__BUILT_FOR__', 'firefox')
        })

        it('asks first, before anything waits, and with a yes the form has the details', async () => {
            firefoxAsks.mockResolvedValue(true)
            const done = reportProblem()
            // still in the click, which Firefox must count as the person's own action to ask
            expect(firefoxAsks).toHaveBeenCalledWith({ data_collection: ['technicalAndInteraction'] })
            expect(chromeAsks).not.toHaveBeenCalled()
            await done
            withDetails()
        })

        it('opens the bare form after a no', async () => {
            firefoxAsks.mockResolvedValue(false)
            await reportProblem()
            expect(tabs).toEqual([FEEDBACK_URL])
        })

        it('sends the details on a Firefox from before the setting (109 to 139), which has nothing to ask', async () => {
            firefoxAsks.mockImplementation(() => {
                throw new Error('Type error for parameter permissions (Unexpected property "data_collection") for permissions.request.')
            })
            await reportProblem()
            withDetails()
        })

        it('opens the bare form when asking fails any other way', async () => {
            firefoxAsks.mockRejectedValue(new Error('permissions.request may only be called from a user input handler'))
            await reportProblem()
            expect(tabs).toEqual([FEEDBACK_URL])
        })
    })
})
