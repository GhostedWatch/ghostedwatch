// The in-page "Restored text" box shows only where the page doesn't already show the
// original: logged in, the author still sees their own removed content (banner only),
// while others, or a view the site blanks, get the site's placeholder (banner + box).
// Offline: the .win thread is a fake served via route.
import { test, expect } from './fixtures.js'

const THREAD = 'https://patriots.win/p/Pp1/a-thread'
const comment = (uuid, content) => `
  <div class="comment" style="display:flex">
    <div class="body">
      <div class="meta">someuser · 1 points · 3 months ago</div>
      <div class="content" id="content-${uuid}">${content}</div>
      <div class="actions"><a href="/p/Pp1/a-thread/c/${uuid}">permalink</a> <span>save</span></div>
    </div>
  </div>`
const post = (uuid, title) => `
  <div class="post">
    <div class="title"><a href="/p/${uuid}/a-thread">${title}</a></div>
    <div class="actions"><a href="/p/${uuid}/a-thread">0 comments</a> <span>share</span></div>
  </div>`
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  ${post('Pp1', 'My own post title')}
  ${post('Pq1', 'Post removed by community filter.')}
  ${comment('Ca1', 'what I said, <em>as I still</em> see it')}
  ${comment('Cb1', 'Comment removed by community filter.')}
  ${comment('Cc1', 'Comment removed by community moderators.')}
</body></html>`

const rec = o => ({
    id: 1, uuid: 'x', type: 'comment', post_uuid: 'Pp1', community: 'TheDonald', title: '', text: '',
    text_loading: false, status: 'publicly_removed', removal_source: 'communityFilter', created: 0,
    observed_utc: Date.now(), unseen: false, source: 'own', ...o,
})

test('restored text appears only where the page does not show the original', async ({ context, extensionId }) => {
    await context.route(/^https:\/\/([a-z0-9-]+\.)*patriots\.win\//, route =>
        route.request().resourceType() === 'document'
            ? route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
            : route.fulfill({ status: 404, body: '' }),
    )
    const ext = await context.newPage()
    await ext.goto(`chrome-extension://${extensionId}/src/options.html`)
    await ext.evaluate(d => new Promise(r => chrome.storage.local.set(d, () => r(1))), {
        removed: {
            1: rec({ id: 1, uuid: 'Pp1', type: 'post', title: 'My own post title' }),
            2: rec({ id: 2, uuid: 'Pq1', type: 'post', title: 'Their post title', source: 'other' }),
            3: rec({ id: 3, uuid: 'Ca1', text: 'what I said, *as I still* see it' }),
            4: rec({ id: 4, uuid: 'Cb1', text: 'their words, only saved by us', source: 'other' }),
            5: rec({ id: 5, uuid: 'Cc1', text: 'words that show up later' }),
        },
    })
    await ext.close()

    const page = await context.newPage()
    await page.goto(THREAD)
    await expect(page.locator('.ghostedwatch-banner')).toHaveCount(5)
    const restored = uuid => page.locator(`[data-ghostedwatch="${uuid}"] .ghostedwatch-recovered`)

    // the author's own view: the text is on the page, so just the banner
    await expect(restored('Pp1')).toHaveCount(0)
    await expect(restored('Ca1')).toHaveCount(0)
    // a placeholder instead of the content: the saved original comes back
    await expect(restored('Pq1')).toContainText('Their post title')
    await expect(restored('Cb1')).toContainText('their words, only saved by us')
    await expect(restored('Cc1')).toContainText('words that show up later')

    // the page fills the real content in later: the box goes away
    await page.evaluate(() => (document.getElementById('content-Cc1').textContent = 'words that show up later'))
    await expect(restored('Cc1')).toHaveCount(0)
    await expect(page.locator('[data-ghostedwatch="Cc1"] .ghostedwatch-banner')).toHaveCount(1)
})
