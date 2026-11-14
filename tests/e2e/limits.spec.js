// When the 3,000-comment limit for whole-post watches is reached, the in-page post menu
// and the Watching page say so, instead of a new thread watch quietly following nothing.
// Offline: the .win page is a fake served via route.
import { test, expect } from './fixtures.js'

const THREAD = 'https://patriots.win/p/Pp1/a-thread'
// a post with an action bar: a "share" action and a /p/ link, which get a Watch button
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div class="post"><div class="title"><a href="/p/Pp1/a-thread">A thread</a></div>
    <div class="actions"><a href="/p/Pp1/a-thread">5 comments</a> <span>share</span></div></div>
</body></html>`

const oi = o => ({
    post_id: 1, author: 'someone', community: 'TheDonald', created: Date.now(), title: '', text: '',
    watched_at: Date.now(), is_removed: false, removal_source: '', removal_count: 0, visible_count: 0,
    recorded: false, ...o,
})

// ten watched threads following 300 comments each: 3,000, the limit
function fullWatches() {
    const items = {}
    for (let p = 0; p < 10; p++) {
        const postId = 20 + p
        items[postId] = oi({ id: postId, uuid: `t${p}`, type: 'post', post_id: postId, post_uuid: `t${p}`, title: `Busy thread ${p}`, watch_comments: true })
        for (let c = 0; c < 300; c++) {
            const id = 100000 + p * 1000 + c
            items[id] = oi({ id, uuid: `c${id}`, type: 'comment', post_id: postId, post_uuid: `t${p}`, auto: true })
        }
    }
    return items
}

async function setLocal(context, extensionId, data) {
    const ext = await context.newPage()
    await ext.goto(`chrome-extension://${extensionId}/src/options.html`)
    await ext.evaluate(d => new Promise(r => chrome.storage.local.set(d, () => r(1))), data)
    await ext.close()
}

test('the post menu says when a thread watch could follow no more comments', async ({ context, extensionId }) => {
    await context.route(/^https:\/\/([a-z0-9-]+\.)*patriots\.win\//, route =>
        route.request().resourceType() === 'document'
            ? route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
            : route.fulfill({ status: 404, body: '' }),
    )
    const items = fullWatches()
    await setLocal(context, extensionId, { other_items: items })

    const page = await context.newPage()
    await page.goto(THREAD)
    const watch = page.locator('.ghostedwatch-watch:not(.ghostedwatch-watch-own)').first()
    await watch.click()
    await expect(page.getByText('Watch post + all comments')).toBeVisible()
    await expect(page.locator('.ghostedwatch-watch-note')).toHaveText(
        "Comments won't be followed: the 3,000-comment limit is reached. Make room on the Watching page.",
    )

    // one thread fewer: the note goes, without reloading the page
    for (const [id, w] of Object.entries(items)) if (w.post_id === 29) delete items[id]
    await setLocal(context, extensionId, { other_items: items })
    await page.mouse.click(5, 5) // a click elsewhere closes the menu
    await expect(page.locator('.ghostedwatch-watch-menu')).toHaveCount(0)
    await watch.click()
    await expect(page.getByText('Watch post + all comments')).toBeVisible()
    await expect(page.locator('.ghostedwatch-watch-note')).toHaveCount(0)
})

test('the Watching page says when the limit stops a thread watch', async ({ context, extensionId }) => {
    const items = fullWatches()
    items[10] = oi({ id: 10, uuid: 'a10', type: 'post', post_id: 10, post_uuid: 'a10', title: 'A new thread watch', watch_comments: true })
    await setLocal(context, extensionId, { last_origin: 'https://patriots.win', other_items: items })

    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/src/manage.html`)
    const fresh = page.locator('.wrow', { hasText: 'A new thread watch' })
    await expect(fresh.locator('.wrow-limit')).toHaveText(
        "Its comments aren't followed: the 3,000-comment limit is reached. Turn off All comments on another post to make room.",
    )
    // a thread at its own 300 cap gets that reason, not advice to make room elsewhere
    const busy = page.locator('.wrow', { hasText: 'Busy thread 0' })
    await expect(busy.locator('.wrow-limit')).toHaveText("New comments aren't followed: 300 is the most for one post.")
})
