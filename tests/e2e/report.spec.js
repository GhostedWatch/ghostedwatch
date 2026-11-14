// "Report a problem" opens the feedback form with the version, a status summary and the
// diagnostic log in the link's #fragment, never naming the account.
// Offline: the form is a stub served via route.
import { test, expect } from './fixtures.js'

const auth = { user: 'gw_tester', origin: 'https://patriots.win', apiKey: 'k-secret', apiSecret: 's-secret' }
const url = (id, p) => `chrome-extension://${id}/src/${p}`
const details = link => JSON.parse(Buffer.from(link.split('#r=')[1], 'base64url').toString('utf8'))

async function seed(context, extensionId, data) {
    const page = await context.newPage()
    await page.goto(url(extensionId, 'options.html'))
    await page.evaluate(d => new Promise(r => chrome.storage.local.set(d, () => r(1))), data)
    return page
}

for (const [where, page, label] of [
    ['the popup', 'popup.html', 'Report a problem'],
    ['the Help page', 'help.html', 'Report a problem or send feedback'],
]) {
    test(`${where}'s report link fills in the form, without the account`, async ({ context, extensionId }) => {
        await context.route('https://ghostedwatch.com/**', route =>
            route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>feedback</title>' }),
        )
        const ext = await seed(context, extensionId, {
            auth,
            last_check: Date.now() - 60_000,
            diag_log: ['11-14 10:05 check · post: HTTP 503 · removed: #456'],
        })
        await ext.goto(url(extensionId, page))
        const errors = []
        ext.on('pageerror', e => errors.push(String(e)))
        const opened = context.waitForEvent('page') // a new tab starts blank, then gets its address
        await ext.getByText(label, { exact: true }).click()
        const form = await opened
        await form.waitForURL(/^https:\/\/ghostedwatch\.com\//)
        expect(errors).toEqual([])
        expect(form.url().startsWith('https://ghostedwatch.com/feedback.html#r=')).toBe(true)
        const d = details(form.url())
        expect(d.v).toMatch(/^\d+\.\d+\.\d+/)
        expect(d.b).toMatch(/Chrom/)
        expect(d.s).toContain('Connected (patriots.win)')
        expect(d.l).toContain('11-14 10:05 check · post: HTTP 503 · removed: #456')
        for (const secret of ['gw_tester', 'k-secret', 's-secret']) expect(JSON.stringify(d)).not.toContain(secret)
    })
}
