// What you post is captured as you post it, and the page's session connects the extension.
// Offline: the .win page and its API answers are fakes served via route.
import { test, expect } from './fixtures.js'

const THREAD = 'https://patriots.win/p/Pp1/a-thread'
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div class="post"><div class="title"><a href="/p/Pp1/a-thread">A thread</a></div></div>
</body></html>`

const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

async function storage(context, extensionId, keys) {
    const ext = await context.newPage()
    await ext.goto(`chrome-extension://${extensionId}/src/options.html`)
    const got = await ext.evaluate(k => new Promise(r => chrome.storage.local.get(k, r)), keys)
    await ext.close()
    return got
}

test('posting a comment or a post saves its text, and the page session connects', async ({ context, extensionId }) => {
    await context.route(/^https:\/\/([a-z0-9-]+\.)*patriots\.win\//, route => {
        const url = route.request().url()
        if (route.request().resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
        if (url.includes('/api/v2/user/about.json')) return route.fulfill(json({ users: [{ username: 'tester' }] }))
        if (url.includes('/api/v2/action/create_comment'))
            return route.fulfill(json({
                comments: [{
                    id: 501, uuid: 'c501', comment_parent_id: 0, parent_id: 1000, parent_uuid: 'Pp1',
                    community: 'TheDonald', created: 1700000000000, raw_content: '', author: 'tester',
                }],
            }))
        if (url.includes('/api/v2/action/create_post'))
            return route.fulfill(json({
                posts: [{ id: 77, uuid: 'Pn77', title: 'My new post', community: 'TheDonald', created: 1700000001000, raw_content: 'post body', author: 'tester' }],
            }))
        return route.fulfill({ status: 404, body: '' })
    })
    // the site keeps the session's tokens in localStorage
    await context.addInitScript(() => {
        if (location.hostname.endsWith('patriots.win')) {
            localStorage.setItem('api_key', 'test-key')
            localStorage.setItem('api_secret', 'test-secret')
        }
    })

    const page = await context.newPage()
    await page.goto(THREAD)
    await page.waitForFunction(() => window.__ghostedwatch_inject === true)

    await expect.poll(async () => (await storage(context, extensionId, ['auth'])).auth?.user).toBe('tester')

    // a comment through fetch, whose response blanks the text: the typed text is kept
    await page.evaluate(() =>
        fetch('/api/v2/action/create_comment', { method: 'POST', body: JSON.stringify({ content: 'what I typed', parentId: 1000 }) }),
    )
    // a post through XHR
    await page.evaluate(
        () =>
            new Promise(resolve => {
                const xhr = new XMLHttpRequest()
                xhr.open('POST', '/api/v2/action/create_post')
                xhr.onload = resolve
                xhr.send(JSON.stringify({ title: 'My new post', content: 'post body' }))
            }),
    )

    await expect
        .poll(async () => {
            const own = (await storage(context, extensionId, ['own_items'])).own_items || {}
            return Object.values(own)
                .map(o => `${o.type}:${o.id}:${o.uuid}:${o.post_uuid}:${o.title}:${o.text}`)
                .sort()
        })
        .toEqual(['comment:501:c501:Pp1::what I typed', 'post:77:Pn77:Pn77:My new post:post body'])
})

// The site's pop-up login sets the tokens without a page load. The page's first 18 s of
// session polling are over by then; before the token watch, the next try was 5 minutes away.
test('logging in without a page load connects within seconds', async ({ context, extensionId }) => {
    await context.route(/^https:\/\/([a-z0-9-]+\.)*patriots\.win\//, route => {
        if (route.request().resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
        if (route.request().url().includes('/api/v2/user/about.json')) return route.fulfill(json({ users: [{ username: 'tester' }] }))
        return route.fulfill({ status: 404, body: '' })
    })
    const page = await context.newPage()
    await page.goto(THREAD)
    await page.waitForTimeout(19000) // the start-up polling gives up
    expect((await storage(context, extensionId, ['auth'])).auth ?? null).toBeNull()

    await page.evaluate(() => {
        localStorage.setItem('api_key', 'popup-key')
        localStorage.setItem('api_secret', 'popup-secret')
    })
    await expect.poll(async () => (await storage(context, extensionId, ['auth'])).auth?.user, { timeout: 6000 }).toBe('tester')
})
