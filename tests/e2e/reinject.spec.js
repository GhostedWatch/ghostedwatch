// One live content-script copy per .win tab. The background injects the script into
// open tabs (on every service-worker start, and after an update or re-enable), so a
// second run must not stack another copy, and the new copy must take over from one
// orphaned by an update. Each live copy answers a 'refresh' with its own 'list-removed' message, so
// counting those counts copies. Offline: the .win thread is a fake served via route.
import { test, expect } from './fixtures.js'

// id <-> uuid pairs in the site's encoding (see win-api.test.ts)
const POST = 'tqd3A' // id 1000
const COMMENT_A = { id: 12345, uuid: '3idarWH' }
const COMMENT_B = { id: 1000, uuid: 'tqd3A' }
const THREAD = `https://patriots.win/p/${POST}/a-thread`

const commentHtml = c => `
  <div class="comment" style="display:flex">
    <div class="body">
      <div class="content">a comment</div>
      <div class="actions"><a href="/p/${POST}/a-thread/c/${c.uuid}">permalink</a></div>
    </div>
  </div>`
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="thread">${commentHtml(COMMENT_A)}</div></body></html>`

// Both comments are already watched, so their buttons read "Watching ✓" and a click
// just unwatches (storage only, nothing goes to the network).
const watched = c => ({
    id: c.id, uuid: c.uuid, type: 'comment', post_id: 1000, post_uuid: POST, author: 'someone',
    community: 'TheDonald', created: Date.now(), title: '', text: 'a comment', watched_at: Date.now(),
    is_removed: false, removal_source: '', removal_count: 0, visible_count: 0, recorded: false,
})

async function openThread(context, extensionId) {
    await context.route(/^https:\/\/([a-z0-9-]+\.)*patriots\.win\//, route =>
        route.request().resourceType() === 'document'
            ? route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
            : route.fulfill({ status: 404, body: '' }),
    )
    const ext = await context.newPage()
    await ext.goto(`chrome-extension://${extensionId}/src/options.html`)
    await ext.evaluate(d => new Promise(r => chrome.storage.local.set(d, () => r(1))), {
        other_items: { [COMMENT_A.id]: watched(COMMENT_A), [COMMENT_B.id]: watched(COMMENT_B) },
    })
    await ext.close()
    const page = await context.newPage()
    await page.goto(THREAD)
    await expect(page.locator('.ghostedwatch-watch')).toHaveText('Watching ✓')
    return page
}

// count the messages the background receives, by action
const listen = sw =>
    sw.evaluate(() => {
        self.__seen = {}
        chrome.runtime.onMessage.addListener(m => {
            if (m && m.action) self.__seen[m.action] = (self.__seen[m.action] || 0) + 1
        })
    })
const seen = (sw, action) => sw.evaluate(a => self.__seen[a] || 0, action)

async function liveCopies(sw, page) {
    await sw.evaluate(() => (self.__seen['list-removed'] = 0))
    await sw.evaluate(async url => {
        const [t] = await chrome.tabs.query({ url })
        await chrome.tabs.sendMessage(t.id, { action: 'refresh' }).catch(() => {})
    }, THREAD)
    await page.waitForTimeout(1000)
    return seen(sw, 'list-removed')
}

test('re-injecting the content script keeps one live copy', async ({ context, extensionId }) => {
    const page = await openThread(context, extensionId)
    const sw = context.serviceWorkers()[0]
    await listen(sw)
    expect(await liveCopies(sw, page)).toBe(1)
    const button = await page.locator('.ghostedwatch-watch').elementHandle()

    // what the background's injectIntoOpenTabs() does, e.g. on a service-worker start
    for (let i = 0; i < 2; i++) {
        await sw.evaluate(async url => {
            const [t] = await chrome.tabs.query({ url })
            await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/content.js'] })
        }, THREAD)
    }
    expect(await liveCopies(sw, page)).toBe(1)
    await expect(page.locator('.ghostedwatch-watch')).toHaveCount(1)
    expect(await button.evaluate(b => b.isConnected)).toBe(true) // the live copy's button is kept
})

test('after the extension restarts, the tab gets one live copy with working Watch buttons', async ({ context, extensionId }) => {
    const page = await openThread(context, extensionId)
    const oldButton = await page.locator('.ghostedwatch-watch').elementHandle()

    // Disable + re-enable the extension: this orphans the tab's copy the same way an
    // update does. (Reloading doesn't bring back a --load-extension extension in the
    // test browser, so that path can't be driven here.)
    const nextWorker = context.waitForEvent('serviceworker')
    const extensions = await context.newPage()
    await extensions.goto('chrome://extensions')
    await extensions.evaluate(async id => {
        await chrome.management.setEnabled(id, false)
        await new Promise(r => setTimeout(r, 500))
        await chrome.management.setEnabled(id, true)
    }, extensionId)
    const sw = await nextWorker
    await listen(sw)

    // the new version's copy answers the ping and replaces the dead copy's button
    const ping = () =>
        sw.evaluate(async url => {
            const [t] = await chrome.tabs.query({ url })
            try {
                return (await chrome.tabs.sendMessage(t.id, { action: 'ping' }))?.ok === true
            } catch {
                return false
            }
        }, THREAD)
    await expect.poll(ping).toBe(true)
    await expect.poll(() => oldButton.evaluate(b => b.isConnected)).toBe(false)
    expect(await liveCopies(sw, page)).toBe(1)

    // its Watch button reaches the new background (a watched item's click unwatches)
    await expect(page.locator('.ghostedwatch-watch')).toHaveCount(1)
    await page.locator('.ghostedwatch-watch').click()
    await expect.poll(() => seen(sw, 'unwatch-other')).toBe(1)

    // so does the button on a comment loaded afterwards (not a dead one from the orphan)
    await page.evaluate(html => document.getElementById('thread').insertAdjacentHTML('beforeend', html), commentHtml(COMMENT_B))
    await expect(page.locator('.ghostedwatch-watch')).toHaveCount(2)
    await page.locator('.ghostedwatch-watch').nth(1).click()
    await expect.poll(() => seen(sw, 'unwatch-other')).toBe(2)
})
